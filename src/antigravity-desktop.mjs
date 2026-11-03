import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SURFACES = { desktop: "antigravity", cli: "antigravity-cli" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TRANSCRIPT_ROW_LIMIT = 4096;
const TRANSCRIPT_BYTE_LIMIT = 32 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const RESTART_NOTICE = "[Notice] All your subagents and background tasks have been stopped due to server restart. If you want a subagent to continue working, it needs to be revived by sending it a new message. If resuming work, please check on status and restart as needed.";

function transcriptFailure(code = "ANTIGRAVITY_TRANSCRIPT_UNSUPPORTED") {
  return Object.assign(new Error("Native Antigravity reply observation is unavailable; retain the original receipt and do not resend."), { code });
}

function protobufFields(value) {
  if (!(value instanceof Uint8Array) || value.length > 2 * 1024 * 1024) throw transcriptFailure();
  const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const fields = [];
  let offset = 0;
  const integer = () => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= buffer.length) throw transcriptFailure();
      const byte = buffer[offset++];
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw transcriptFailure();
        return Number(result);
      }
    }
    throw transcriptFailure();
  };
  while (offset < buffer.length) {
    if (fields.length >= 4096) throw transcriptFailure();
    const tag = integer();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (!field || field > 536870911) throw transcriptFailure();
    if (wire === 0) fields.push({ field, wire, value: integer() });
    else {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (length < 0 || length > buffer.length - offset) throw transcriptFailure();
      fields.push({ field, wire, value: buffer.subarray(offset, offset + length) });
      offset += length;
    }
  }
  return fields;
}

function protobufField(fields, number, wire) {
  const matches = fields.filter((field) => field.field === number);
  if (matches.length > 1 || matches.length && matches[0].wire !== wire) throw transcriptFailure();
  return matches[0]?.value;
}

function protobufText(fields, number) {
  const value = protobufField(fields, number, 2);
  return value === undefined ? "" : utf8.decode(value);
}

function protobufTime(fields, number) {
  const value = protobufField(fields, number, 2);
  if (!value) return null;
  const timestamp = protobufFields(value);
  const seconds = protobufField(timestamp, 1, 0) ?? 0;
  const nanos = protobufField(timestamp, 2, 0) ?? 0;
  if (nanos >= 1e9 || seconds > 253402300799) throw transcriptFailure();
  return seconds * 1000 + nanos / 1e6;
}

function decodeNativeStep(row) {
  if (!Number.isSafeInteger(row.idx) || row.idx < 0 || row.step_format !== 0) throw transcriptFailure();
  const fields = protobufFields(row.step_payload);
  if (protobufField(fields, 1, 0) !== row.step_type || protobufField(fields, 4, 0) !== row.status) throw transcriptFailure();
  const rawMetadata = protobufField(fields, 5, 2);
  if (!rawMetadata || !Buffer.from(row.metadata ?? []).equals(rawMetadata)) throw transcriptFailure();
  const metadata = protobufFields(rawMetadata);
  const step = { index: row.idx, type: row.step_type, status: row.status, executionId: protobufText(metadata, 12), createdAt: protobufTime(metadata, 1), completedAt: protobufTime(metadata, 8) };
  if (step.type === 101) {
    const system = protobufFields(protobufField(fields, 114, 2));
    const rawAgent = protobufField(system, 4, 2);
    if (rawAgent) {
      const agent = protobufFields(rawAgent);
      step.message = { id: protobufText(agent, 1), recipient: protobufText(agent, 2), sender: protobufText(agent, 3), content: protobufText(agent, 4), hidden: protobufField(agent, 11, 0) === 1 };
    }
  }
  if (step.type === 15) {
    const response = protobufFields(protobufField(fields, 20, 2));
    step.response = protobufText(response, 8) || protobufText(response, 1);
    step.hasTools = response.some((field) => field.field === 7);
    step.stopReason = protobufField(response, 12, 0);
    step.finishedAt = protobufTime(metadata, 7);
  }
  return step;
}

async function readNativeSteps({ home, conversationId, boundaryOnly = false, afterStepIndex = -1, findRoot }) {
  if (!UUID.test(conversationId ?? "")) throw transcriptFailure();
  let directory = fs.realpathSync.native(home);
  for (const segment of [".gemini", "antigravity", "conversations"]) {
    directory = path.join(directory, segment);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw transcriptFailure();
  }
  const filename = path.join(directory, `${conversationId}.db`);
  const before = fs.lstatSync(filename, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 512n * 1024n * 1024n) throw transcriptFailure();
  for (const suffix of ["-wal", "-shm"]) {
    try {
      const stat = fs.lstatSync(`${filename}${suffix}`);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw transcriptFailure();
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const trajectory = db.prepare("SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 2").all();
    if (trajectory.length !== 1 || trajectory[0].cascade_id !== conversationId || !UUID.test(trajectory[0].trajectory_id ?? "")) throw transcriptFailure();
    const maximum = db.prepare("SELECT MAX(idx) AS lastStepIndex FROM steps").get().lastStepIndex ?? -1;
    if (!Number.isSafeInteger(maximum) || maximum < -1) throw transcriptFailure();
    const readSteps = (lowerBound, rootsOnly = false) => {
      const selector = rootsOnly ? "step_type = 101" : "idx > ?";
      const parameters = rootsOnly ? [] : [lowerBound];
      const rows = db.prepare(`SELECT idx, step_type, status, step_format, length(metadata) AS metadata_bytes, length(step_payload) AS payload_bytes FROM steps WHERE ${selector} ORDER BY idx LIMIT ?`).all(...parameters, TRANSCRIPT_ROW_LIMIT + 1);
      if (rows.length > TRANSCRIPT_ROW_LIMIT || rows.some((row) => row.metadata_bytes > 2 * 1024 * 1024 || row.payload_bytes > 2 * 1024 * 1024)
          || rows.reduce((sum, row) => sum + row.metadata_bytes + row.payload_bytes, 0) > TRANSCRIPT_BYTE_LIMIT) throw transcriptFailure("ANTIGRAVITY_TRANSCRIPT_LIMIT");
      return rows.length ? db.prepare(`SELECT idx, step_type, status, step_format, metadata, step_payload FROM steps WHERE idx >= ? AND idx <= ?${rootsOnly ? " AND step_type = 101" : ""} ORDER BY idx`).all(rows[0].idx, rows.at(-1).idx).map(decodeNativeStep) : [];
    };
    let steps = [];
    let roots;
    if (!boundaryOnly) {
      if (findRoot) {
        roots = readSteps(-1, true).filter(findRoot);
        if (roots.length === 1) steps = readSteps(roots[0].index - 1);
      } else steps = readSteps(afterStepIndex);
    }
    const after = fs.lstatSync(filename, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs) throw transcriptFailure();
    return { trajectoryId: trajectory[0].trajectory_id, lastStepIndex: maximum, steps, ...(roots ? { roots } : {}) };
  } finally { db.close(); }
}

export async function captureAntigravityObservation({ home = os.homedir(), conversationId, prompt, projectId }) {
  const promptSha256 = crypto.createHash("sha256").update(prompt).digest("hex");
  try {
    const snapshot = await readNativeSteps({ home, conversationId, boundaryOnly: true });
    return { version: 1, status: "ready", trajectoryId: snapshot.trajectoryId, beforeStepIndex: snapshot.lastStepIndex, promptSha256, projectId };
  } catch {
    return { version: 1, status: "unavailable", code: "ANTIGRAVITY_TRANSCRIPT_UNAVAILABLE", promptSha256, projectId };
  }
}

export async function observeAntigravityDelivery(record, { home = os.homedir(), list = listAntigravityConversations } = {}) {
  if (record?.surface !== "desktop" || !["accepted", "unknown", "sent_unconfirmed"].includes(record.status)) return record;
  const observation = (status, code) => ({ ...record, replyObservation: { status, code, source: "native-transcript", retrySafe: false } });
  try {
    if (!UUID.test(record.conversationId ?? "") || !/^[a-f0-9]{64}$/.test(record.digest ?? "") || !["codex", "claude"].includes(record.sender?.provider)
        || typeof record.sender.id !== "string" || !record.sender.id) throw transcriptFailure();
    const matches = (await list({ home, surface: "desktop", limit: 1000 })).filter((row) => row.conversationId === record.conversationId);
    if (matches.length !== 1 || matches[0].surface !== "desktop" || canonicalCwd(matches[0].cwd) !== canonicalCwd(record.cwd)) throw transcriptFailure("ANTIGRAVITY_REPLY_SCOPE_CHANGED");
    const boundary = record.nativeObservation;
    if (boundary && (boundary.version !== 1 || !["ready", "unavailable"].includes(boundary.status) || !/^[a-f0-9]{64}$/.test(boundary.promptSha256 ?? "") || boundary.projectId !== matches[0].projectId)) throw transcriptFailure();
    if (boundary?.status === "ready" && (!Number.isSafeInteger(boundary.beforeStepIndex) || boundary.beforeStepIndex < -1 || !UUID.test(boundary.trajectoryId ?? ""))) throw transcriptFailure();
    const createdAt = Date.parse(record.createdAt);
    const finishedAt = Date.parse(record.finishedAt);
    if (!Number.isFinite(createdAt) || boundary?.status !== "ready" && !Number.isFinite(finishedAt)) throw transcriptFailure();
    const matchesRoot = (step) => {
      if (step.type !== 101 || !step.message || step.status !== 3 || !UUID.test(step.message.id) || step.message.recipient !== record.conversationId
          || step.createdAt === null || step.createdAt < createdAt - (boundary?.status === "ready" ? 2000 : 0) || !step.executionId) return false;
      if (boundary?.status !== "ready" && step.createdAt > Math.min(createdAt + 120000, finishedAt + 30000)) return false;
      const prompt = step.message.content;
      if (boundary?.promptSha256 && crypto.createHash("sha256").update(prompt).digest("hex") !== boundary.promptSha256) return false;
      const digest = crypto.createHash("sha256").update(JSON.stringify({ surface: "desktop", conversationId: record.conversationId, cwd: record.cwd, sender: record.sender, prompt })).digest("hex");
      return digest === record.digest;
    };
    const snapshot = await readNativeSteps({ home, conversationId: record.conversationId, ...(boundary?.status === "ready" ? { afterStepIndex: boundary.beforeStepIndex } : { findRoot: matchesRoot }) });
    if (boundary?.status === "ready" && (boundary.trajectoryId !== snapshot.trajectoryId || snapshot.lastStepIndex < boundary.beforeStepIndex)) throw transcriptFailure("ANTIGRAVITY_TRANSCRIPT_REPLACED");
    const roots = snapshot.roots ?? snapshot.steps.filter(matchesRoot);
    if (!roots.length) return observation("pending", "ANTIGRAVITY_MESSAGE_NOT_OBSERVED");
    if (roots.length !== 1) return observation("ambiguous", "ANTIGRAVITY_REPLY_AMBIGUOUS");
    const root = roots[0];
    let reply;
    for (const step of snapshot.steps.filter((step) => step.index > root.index)) {
      if (step.type === 14 || step.executionId !== root.executionId) break;
      if (step.type === 101) {
        if (step.message?.hidden && step.message.sender === "system" && step.message.content === RESTART_NOTICE) continue;
        if (!reply) return observation("ambiguous", "ANTIGRAVITY_REPLY_INTERLEAVED");
        break;
      }
      reply = step.type === 15 && step.status === 3 && step.response && !step.hasTools && step.stopReason === 2
        && step.finishedAt !== null && step.completedAt !== null && step.finishedAt >= root.createdAt && step.completedAt >= step.finishedAt ? step : null;
    }
    if (!reply) return observation("pending", "ANTIGRAVITY_REPLY_NOT_OBSERVED");
    const current = (await list({ home, surface: "desktop", limit: 1000 })).filter((row) => row.conversationId === record.conversationId);
    if (current.length !== 1 || current[0].surface !== "desktop" || current[0].projectId !== matches[0].projectId || canonicalCwd(current[0].cwd) !== canonicalCwd(record.cwd)) throw transcriptFailure("ANTIGRAVITY_REPLY_SCOPE_CHANGED");
    if (current[0].status !== "CASCADE_RUN_STATUS_IDLE") return observation("pending", "ANTIGRAVITY_REPLY_STILL_RUNNING");
    if (Buffer.byteLength(reply.response) > 256 * 1024) throw transcriptFailure("ANTIGRAVITY_REPLY_LIMIT");
    const evidence = { source: "native-transcript", nativeMessageId: root.message.id, rootStepIndex: root.index, replyStepIndex: reply.index,
      executionId: root.executionId, trajectoryId: snapshot.trajectoryId, replySha256: crypto.createHash("sha256").update(reply.response).digest("hex") };
    return { ...record, status: "reply_received", replyObservation: { status: "reply_received", retrySafe: false, ...evidence },
      result: { ...record.result, status: "reply_received", completed: true, response: reply.response, reply: reply.response, ...evidence } };
  } catch (error) {
    return observation("unavailable", /^ANTIGRAVITY_(?:TRANSCRIPT|REPLY)_[A-Z_]+$/.test(error.code ?? "") ? error.code : "ANTIGRAVITY_TRANSCRIPT_UNAVAILABLE");
  }
}

function failure(code, message) {
  return Object.assign(new Error(message), { code, deliveryState: "not_sent" });
}

function nativeDiagnostic(error, env, args) {
  const exitCode = Number.isInteger(error.code) ? String(error.code) : /^[A-Z_]{2,40}$/.test(error.code ?? "") ? error.code : "unknown";
  let detail = "";
  try {
    const parsed = JSON.parse(error.stdout);
    if (typeof parsed.error === "string") detail = parsed.error;
  } catch {}
  for (const value of [...Object.entries(env).filter(([key]) => /ANTIGRAVITY|TOKEN|SECRET|PASSWORD|AUTH|KEY/i.test(key)).map(([, value]) => value), ...args.slice(1)]) {
    if (typeof value === "string" && value) detail = detail.split(value).join("[redacted]");
  }
  detail = detail.replace(/https?:\/\/[^\s"']+/gi, "[endpoint]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 400);
  return `exit ${exitCode}${detail ? `: ${detail}` : ""}`;
}

function canonicalCwd(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw failure("ANTIGRAVITY_CWD_INVALID", "An absolute existing workspace directory is required");
  const resolved = fs.realpathSync.native(value);
  if (!fs.statSync(resolved).isDirectory()) throw failure("ANTIGRAVITY_CWD_INVALID", "Workspace is not a directory");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function workspaceCwd(uris) {
  if (typeof uris === "string") uris = JSON.parse(uris);
  if (!Array.isArray(uris) || uris.length !== 1 || typeof uris[0] !== "string") throw failure("ANTIGRAVITY_WORKSPACE_AMBIGUOUS", "Conversation must have exactly one workspace");
  const uri = new URL(uris[0]);
  if (uri.protocol !== "file:" || uri.search || uri.hash) throw failure("ANTIGRAVITY_CWD_INVALID", "Conversation workspace must be a local file URI");
  return canonicalCwd(fileURLToPath(uri));
}

export async function listAntigravityConversations({ home = os.homedir(), surface = "all", limit = 100 } = {}) {
  if (surface !== "all" && !Object.hasOwn(SURFACES, surface)) throw failure("ANTIGRAVITY_SURFACE_INVALID", "Surface must be desktop, cli, or all");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Conversation limit must be between 1 and 1000");
  const { DatabaseSync } = await import("node:sqlite");
  const rows = [];
  for (const [kind, directory] of Object.entries(SURFACES)) {
    if (surface !== "all" && surface !== kind) continue;
    const filename = path.join(home, ".gemini", directory, "conversation_summaries.db");
    if (!fs.existsSync(filename)) continue;
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const records = db.prepare("SELECT conversation_id, title, workspace_uris, project_id, status, not_fully_idle, killed, app_data_dir, source FROM conversation_summaries WHERE app_data_dir = ? ORDER BY last_modified_time DESC LIMIT ?").all(directory, limit);
      for (const row of records) {
        if (!UUID.test(row.conversation_id) || row.killed) continue;
        if (kind === "desktop" && ["CORTEX_TRAJECTORY_SOURCE_CLI", "CORTEX_TRAJECTORY_SOURCE_VSCODE", "CORTEX_TRAJECTORY_SOURCE_VISUAL_STUDIO", "CORTEX_TRAJECTORY_SOURCE_SDK", "CORTEX_TRAJECTORY_SOURCE_PYTHON_SDK"].includes(row.source)) continue;
        let cwd;
        try { cwd = workspaceCwd(row.workspace_uris); } catch { continue; }
        rows.push({ conversationId: row.conversation_id, cwd, projectId: row.project_id, title: row.title, status: row.not_fully_idle ? "busy" : row.status || "unknown", surface: kind });
      }
    } finally { db.close(); }
  }
  return rows;
}

function nativeMetadata(result) {
  return result.metadata ?? result.response?.conversationMetadata?.metadata ?? result.response?.conversation_metadata?.metadata ?? result.payload?.conversationMetadata?.metadata ?? result.payload?.conversation_metadata?.metadata ?? result.conversationMetadata?.metadata ?? result.conversation_metadata?.metadata;
}

function metadataShape(result) {
  const rows = [];
  const visit = (value, prefix, depth) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return;
    for (const key of Object.keys(value).slice(0, 20)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
      const field = prefix ? `${prefix}.${key}` : key;
      rows.push(field);
      visit(value[key], field, depth + 1);
    }
  };
  visit(result, "", 0);
  return rows.join(", ").slice(0, 800);
}

export function sanitizeAntigravityMetadata(result, conversationId) {
  const metadata = nativeMetadata(result);
  if (!metadata || typeof metadata !== "object") throw failure("ANTIGRAVITY_METADATA_UNSUPPORTED", `Native Antigravity metadata is missing or unsupported (fields: ${metadataShape(result)})`);
  const returnedId = result.conversationId ?? result.conversation_id ?? result.response?.conversationId ?? result.response?.conversation_id ?? metadata.conversationId ?? metadata.conversation_id;
  if (returnedId !== undefined && returnedId !== conversationId) throw failure("ANTIGRAVITY_METADATA_MISMATCH", "Native metadata identifies a different conversation");
  return {
    conversationId,
    cwd: workspaceCwd(metadata.workspaceUris ?? metadata.workspace_uris),
    projectId: metadata.projectId ?? metadata.project_id ?? "",
    surface: "desktop",
  };
}

export async function runAgentApi(options) {
  try { return await executeAgentApi(options); } catch (error) {
    error.deliveryState ??= "not_sent";
    throw error;
  }
}

async function executeAgentApi({ command, conversationId, prompt, expectedCwd, home = os.homedir(), env = process.env, executable = env.ANTIGRAVITY_AGENTAPI_EXE, run = execute, list = listAntigravityConversations, beforeDispatch }) {
  if (!UUID.test(conversationId)) throw failure("ANTIGRAVITY_ID_INVALID", "An exact conversation UUID is required");
  if (!["metadata", "send"].includes(command)) throw new Error("Unsupported Antigravity agentapi command");
  if (!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN) throw failure("ANTIGRAVITY_SIDECAR_REQUIRED", "Antigravity must launch the bridge sidecar before native requests are available");
  if (executable && (!path.isAbsolute(executable) || /\.(bat|cmd|ps1)$/i.test(executable))) throw failure("ANTIGRAVITY_EXECUTABLE_INVALID", "Antigravity agentapi executable must be an absolute native executable path");
  if (!executable && process.platform === "win32") throw failure("ANTIGRAVITY_EXECUTABLE_MISSING", "The Antigravity sidecar must provide ANTIGRAVITY_AGENTAPI_EXE on Windows");
  const invoke = async (args) => {
    let output;
    try {
      output = await run(executable || "agentapi", executable ? ["agentapi", ...args] : args, { env, encoding: "utf8", timeout: 30000, maxBuffer: 1048576, windowsHide: true, shell: false });
    } catch (error) {
      const nativeError = failure(error.killed || error.code === "ETIMEDOUT" ? "ANTIGRAVITY_OUTCOME_UNKNOWN" : "ANTIGRAVITY_NATIVE_FAILED", `Native Antigravity request failed (${nativeDiagnostic(error, env, args)}); inspect the original conversation before resending`);
      nativeError.deliveryState = args[0] === "send-message" ? "unknown" : "not_sent";
      throw nativeError;
    }
    let result;
    try { result = JSON.parse(output.stdout); } catch { throw Object.assign(failure("ANTIGRAVITY_RESPONSE_INVALID", "Native Antigravity returned invalid JSON; do not automatically resend"), { deliveryState: args[0] === "send-message" ? "unknown" : "not_sent" }); }
    if (!result || typeof result !== "object" || Array.isArray(result) || result.error || result.success === false) throw Object.assign(failure("ANTIGRAVITY_NATIVE_REJECTED", "Native Antigravity rejected the request"), { deliveryState: args[0] === "send-message" ? "unknown" : "not_sent" });
    return result;
  };
  if (command === "metadata") return invoke(["get-conversation-metadata", conversationId]);
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 32768 || prompt.includes("\0")) throw new Error("Prompt must contain between 1 and 32768 characters without NUL");
  const cwd = canonicalCwd(expectedCwd);
  const select = async () => {
    const records = (await list({ home, surface: "desktop", limit: 1000 })).filter((row) => row.conversationId === conversationId);
    if (records.length !== 1) throw failure("ANTIGRAVITY_RECIPIENT_MISSING", "Exact desktop conversation is unavailable or has an ambiguous workspace");
    const row = records[0];
    if (row.surface !== "desktop" || canonicalCwd(row.cwd) !== cwd) throw failure("ANTIGRAVITY_WORKSPACE_MISMATCH", "Conversation workspace does not match the authorized workspace");
    if (row.status !== "CASCADE_RUN_STATUS_IDLE") throw failure("ANTIGRAVITY_RECIPIENT_BUSY", "Conversation is busy or its idle state cannot be verified");
    return row;
  };
  const before = await select();
  const metadata = sanitizeAntigravityMetadata(await invoke(["get-conversation-metadata", conversationId]), conversationId);
  if (metadata.cwd !== cwd || metadata.projectId !== before.projectId) throw failure("ANTIGRAVITY_METADATA_MISMATCH", "Native metadata does not match the selected conversation workspace and project");
  const current = await select();
  if (current.projectId !== before.projectId) throw failure("ANTIGRAVITY_METADATA_MISMATCH", "Conversation project changed during delivery preflight");
  const nativeObservation = await captureAntigravityObservation({ home, conversationId, prompt, projectId: current.projectId });
  await beforeDispatch?.(nativeObservation);
  await invoke(["send-message", conversationId, prompt]);
  return { conversationId, status: "accepted", completed: false, surface: "desktop", nativeObservation };
}
