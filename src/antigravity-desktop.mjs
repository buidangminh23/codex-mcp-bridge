import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SURFACES = { desktop: "antigravity", cli: "antigravity-cli" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

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

async function executeAgentApi({ command, conversationId, prompt, expectedCwd, home = os.homedir(), env = process.env, executable = env.ANTIGRAVITY_AGENTAPI_EXE, run = execute, list = listAntigravityConversations }) {
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
  await invoke(["send-message", conversationId, prompt]);
  return { conversationId, status: "accepted", completed: false, surface: "desktop" };
}
