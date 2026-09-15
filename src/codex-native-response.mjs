import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_DIRECTORIES = 4096;
const MAX_REPLY_BYTES = 1024 * 1024;
const COMPLETED = new Set(["task_complete", "task_completed", "turn_complete", "turn_completed"]);
const STARTED = new Set(["task_started", "turn_started"]);
const FAILED = new Set(["task_aborted", "turn_aborted", "task_failed", "turn_failed"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable(reason) {
  return { status: "unavailable", reason: reason?.message ?? String(reason) };
}

function configuredSessions(env) {
  const configuredHome = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
  if (!path.isAbsolute(configuredHome)) throw new Error("The configured Codex home must be absolute");
  const homeStatus = fs.lstatSync(configuredHome);
  if (!homeStatus.isDirectory() || homeStatus.isSymbolicLink()) throw new Error("The configured Codex home is not a regular directory");
  const sessions = path.join(configuredHome, "sessions");
  const status = fs.lstatSync(sessions);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("The Codex sessions path is not a regular directory");
  const canonicalHome = fs.realpathSync.native(configuredHome);
  const canonicalSessions = fs.realpathSync.native(sessions);
  const relative = path.relative(canonicalHome, canonicalSessions);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("The Codex sessions path escapes the configured home");
  return canonicalSessions;
}

function findRollout(threadId, env) {
  if (!UUID.test(threadId)) throw new Error("The Codex task identity is invalid");
  const sessions = configuredSessions(env);
  const queue = [{ directory: sessions, depth: 0 }];
  const matches = [];
  let entries = 0;
  let directories = 0;
  while (queue.length) {
    const { directory, depth } = queue.pop();
    if (++directories > MAX_DIRECTORIES) throw new Error("The bounded Codex sessions scan exceeded its directory limit");
    const children = fs.readdirSync(directory, { withFileTypes: true });
    entries += children.length;
    if (entries > MAX_ENTRIES) throw new Error("The bounded Codex sessions scan exceeded its entry limit");
    for (const child of children) {
      const candidate = path.join(directory, child.name);
      if (depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(child.name)) {
        if (child.isSymbolicLink()) throw new Error("The Codex sessions scan encountered a linked date directory");
        if (child.isDirectory()) {
          const resolved = fs.realpathSync.native(candidate);
          const relative = path.relative(sessions, resolved);
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("A Codex date directory escapes the sessions path");
          queue.push({ directory: resolved, depth: depth + 1 });
        }
      }
      if (depth === 3 && child.name.startsWith("rollout-") && child.name.endsWith(`-${threadId}.jsonl`)) matches.push(candidate);
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? "Multiple rollouts match the Codex task" : "No rollout matches the Codex task");
  const status = fs.lstatSync(matches[0]);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error("The Codex rollout is not a regular file");
  return { file: matches[0], sessions };
}

function pathIdentity(candidate, kind) {
  const status = fs.lstatSync(candidate);
  if ((kind === "file" ? !status.isFile() : !status.isDirectory()) || status.isSymbolicLink()) throw new Error(`The Codex rollout ${kind === "file" ? "file" : "ancestor"} is not regular`);
  return { path: candidate, dev: status.dev, ino: status.ino };
}

function capturePathBoundary(file, sessions) {
  const resolvedFile = fs.realpathSync.native(file);
  const relative = path.relative(sessions, resolvedFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.relative(file, resolvedFile)) throw new Error("The Codex rollout path escapes its sessions directory");
  const ancestors = [];
  let current = path.dirname(file);
  for (;;) {
    const resolved = fs.realpathSync.native(current);
    const within = path.relative(sessions, resolved);
    if (within.startsWith("..") || path.isAbsolute(within) || path.relative(current, resolved)) throw new Error("A Codex rollout ancestor redirects outside its sessions directory");
    ancestors.push(pathIdentity(current, "directory"));
    if (!path.relative(sessions, current)) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("The Codex rollout path has no sessions ancestor");
    current = parent;
  }
  return { file: pathIdentity(file, "file"), ancestors };
}

function samePathBoundary(expected, current) {
  return expected.file.dev === current.file.dev && expected.file.ino === current.file.ino &&
    expected.ancestors.length === current.ancestors.length && expected.ancestors.every((entry, index) =>
      entry.path === current.ancestors[index].path && entry.dev === current.ancestors[index].dev && entry.ino === current.ancestors[index].ino);
}

function readStable(found, maxBytes) {
  const { file, sessions } = found;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ROLLOUT_BYTES) throw new Error("The Codex rollout read limit is invalid");
  const beforeBoundary = capturePathBoundary(file, sessions);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (before.dev !== beforeBoundary.file.dev || before.ino !== beforeBoundary.file.ino) throw new Error("The Codex rollout changed while opening");
    if (!before.isFile() || before.size === 0 || before.size > maxBytes) throw new Error("The Codex rollout is empty or exceeds the bounded read limit");
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw new Error("The Codex rollout changed while reading");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const afterBoundary = capturePathBoundary(file, sessions);
    if (!samePathBoundary(beforeBoundary, afterBoundary) || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev ||
        before.ino !== afterBoundary.file.ino || before.dev !== afterBoundary.file.dev) throw new Error("The Codex rollout changed while reading");
    if (data.at(-1) !== 0x0a) throw new Error("The Codex rollout has an incomplete final record");
    return { data, identity: { dev: before.dev, ino: before.ino } };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseRecords(data) {
  const records = [];
  let offset = 0;
  while (offset < data.length) {
    const newline = data.indexOf(0x0a, offset);
    if (newline < 0) throw new Error("The Codex rollout has an incomplete final record");
    const raw = data.subarray(offset, newline).toString("utf8");
    const start = offset;
    offset = newline + 1;
    if (!raw) continue;
    const record = JSON.parse(raw);
    if (!object(record) || !object(record.payload)) throw new Error("The Codex rollout contains an invalid record");
    records.push({ record, start });
  }
  return records;
}

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} is missing or invalid`);
  const status = fs.lstatSync(value);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  return fs.realpathSync.native(value);
}

function validateSession(records, threadId, expectedCwd) {
  const sessions = records.filter(({ record }) => record.type === "session_meta").map(({ record }) => record.payload);
  if (sessions.length !== 1) throw new Error("The Codex rollout has ambiguous session identity");
  const session = sessions[0];
  if (session.id !== threadId || session.originator !== "Codex Desktop" || session.source !== "vscode") throw new Error("The rollout does not confirm the exact native Codex Desktop task");
  if (canonicalDirectory(session.cwd, "The rollout workspace") !== expectedCwd) throw new Error("The rollout workspace does not match the selected native task");
}

function delegationOutput(executorThreadId, prompt) {
  return `<codex_delegation>\n  <source_thread_id>${executorThreadId}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`;
}

function normalizedText(value) {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function replyHash(text) {
  return crypto.createHash("sha256").update(normalizedText(text), "utf8").digest("hex");
}

function recordBelongsToTurn(entry, threadId, turnId) {
  const payload = entry.record.payload;
  const metadata = object(payload.internal_chat_message_metadata_passthrough) ? payload.internal_chat_message_metadata_passthrough : {};
  const turnFields = [payload.turn_id, payload.root_turn_id, metadata.turn_id, metadata.root_turn_id].filter((value) => value !== undefined);
  if (!turnFields.includes(turnId)) return false;
  if (turnFields.some((value) => value !== turnId)) throw new Error("The native response contains contradictory turn identity");
  const threadFields = [payload.thread_id, metadata.thread_id].filter((value) => value !== undefined);
  if (threadFields.some((value) => value !== threadId)) throw new Error("The native response contains contradictory task identity");
  return true;
}

function responseItemText(payload) {
  if (!Array.isArray(payload.content) || payload.content.some((item) => !object(item) || item.type !== "output_text" || typeof item.text !== "string")) {
    throw new Error("The native final response contains unsupported content");
  }
  return payload.content.map((item) => item.text).join("");
}

function completedEventText(item) {
  if (!object(item) || item.type !== "AgentMessage" || item.phase !== "final_answer") return null;
  if (!Array.isArray(item.content) || item.content.some((part) => !object(part) || part.type !== "Text" || typeof part.text !== "string")) {
    throw new Error("The native completed assistant item contains unsupported content");
  }
  return item.content.map((part) => part.text).join("");
}

function inspectTurnRecords(records, threadId, turnId, cwd, { requireDispatch } = {}) {
  const turns = records.filter((entry) => recordBelongsToTurn(entry, threadId, turnId));
  const starts = turns.filter(({ record }) => record.type === "event_msg" && STARTED.has(record.payload.type));
  const contexts = turns.filter(({ record }) => record.type === "turn_context");
  const completions = turns.filter(({ record }) => record.type === "event_msg" && COMPLETED.has(record.payload.type));
  const failures = turns.filter(({ record }) => record.type === "event_msg" &&
    (FAILED.has(record.payload.type) || record.payload.error || ["failed", "aborted", "interrupted"].includes(record.payload.status)));
  if (failures.length || starts.length !== 1 || contexts.length !== 1 || completions.length !== 1 ||
      canonicalDirectory(contexts[0].record.payload.cwd, "The observed turn workspace") !== cwd ||
      starts[0].start >= contexts[0].start || contexts[0].start >= completions[0].start) {
    throw new Error("The native turn lifecycle is missing, ambiguous, failed, or out of order");
  }

  let dispatch = null;
  if (requireDispatch) {
    const dispatches = turns.filter(({ record }) => record.type === "response_item" && record.payload.type === "function_call_output" &&
      record.payload.namespace === "codex_app" && record.payload.name === "send_message_to_thread");
    if (dispatches.length !== 1 || dispatches[0].record.payload.output !== requireDispatch.output ||
        contexts[0].start >= dispatches[0].start || dispatches[0].start >= completions[0].start) {
      throw new Error("The newly observed turn is not correlated to the exact native dispatch");
    }
    dispatch = dispatches[0];
  }

  const allAssistantEntries = turns.filter(({ record }) => record.type === "response_item" && record.payload.type === "message" && record.payload.role === "assistant");
  const finalEntries = allAssistantEntries.filter(({ record }) => record.payload.phase === "final_answer");
  if (!finalEntries.length && allAssistantEntries.length) throw new Error("The completed native turn has assistant items but no final assistant reply");
  const assistantItems = [];
  const ids = new Set();
  for (const entry of finalEntries) {
    const { payload } = entry.record;
    if (typeof payload.id !== "string" || !payload.id.trim() || ids.has(payload.id) ||
        entry.start <= (dispatch?.start ?? contexts[0].start) || entry.start >= completions[0].start) {
      throw new Error("The native final response item identity is missing, duplicated, or out of order");
    }
    ids.add(payload.id);
    const text = responseItemText(payload);
    if (!text.trim()) throw new Error("The native final response item is empty");
    assistantItems.push({ id: payload.id, text });
  }

  const eventItems = new Map();
  for (const { record, start } of turns) {
    if (record.type !== "event_msg" || record.payload.type !== "item_completed") continue;
    const eventItem = record.payload.item;
    if (ids.has(eventItem?.id) && (eventItem.type !== "AgentMessage" || eventItem.phase !== "final_answer")) {
      throw new Error("The native assistant item representations conflict in type or phase");
    }
    const text = completedEventText(record.payload.item);
    if (text === null) continue;
    const id = record.payload.item.id;
    if (typeof id !== "string" || !id.trim() || eventItems.has(id) || start <= contexts[0].start || start >= completions[0].start) {
      throw new Error("The native completed assistant item identity is missing, duplicated, or out of order");
    }
    eventItems.set(id, text);
  }
  for (const item of assistantItems) {
    if (eventItems.has(item.id) && eventItems.get(item.id) !== item.text) throw new Error("The native assistant item representations conflict");
  }
  if ([...eventItems.keys()].some((id) => !ids.has(id))) throw new Error("The native completed assistant item has no matching authoritative response item");

  const text = assistantItems.map((item) => item.text).join("\n\n");
  if (Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) throw new Error("The native final response exceeds the bounded reply limit");
  return {
    status: assistantItems.length ? "completed" : "completed_no_reply",
    threadId,
    turnId,
    source: "codex_desktop_rollout",
    assistantItems,
    text,
    replySha256: replyHash(text),
  };
}

export function captureCodexRolloutWatermark({ threadId, expectedCwd }, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  try {
    const cwd = canonicalDirectory(expectedCwd, "The selected native task workspace");
    const found = findRollout(threadId, env);
    const snapshot = readStable(found, maxRolloutBytes);
    const records = parseRecords(snapshot.data);
    validateSession(records, threadId, cwd);
    return {
      status: "available",
      threadId,
      cwd,
      file: found.file,
      size: snapshot.data.length,
      prefixSha256: crypto.createHash("sha256").update(snapshot.data).digest("hex"),
      identity: snapshot.identity,
    };
  } catch (error) {
    return unavailable(error);
  }
}

export function inspectCodexNativeTurn({ threadId, turnId, expectedCwd }, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  try {
    if (!UUID.test(threadId) || !UUID.test(turnId)) throw new Error("The native turn identity is invalid");
    const cwd = canonicalDirectory(expectedCwd, "The selected native task workspace");
    const found = findRollout(threadId, env);
    const snapshot = readStable(found, maxRolloutBytes);
    const records = parseRecords(snapshot.data);
    validateSession(records, threadId, cwd);
    return inspectTurnRecords(records, threadId, turnId, cwd);
  } catch (error) {
    return { ...unavailable(error), threadId, turnId, source: "codex_desktop_rollout", assistantItems: [], text: "", replySha256: null };
  }
}

export function readCodexNativeTurnResponse({ threadId, turnId, previousTurnId, expectedCwd, executorThreadId, prompt, watermark }, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  try {
    if (!UUID.test(threadId) || !UUID.test(turnId) || !UUID.test(executorThreadId)) throw new Error("The native response identity is invalid");
    if (turnId === previousTurnId) throw new Error("The observed turn was already present before dispatch");
    if (typeof prompt !== "string" || !prompt.length) throw new Error("The exact dispatched prompt is unavailable");
    if (!object(watermark) || watermark.status !== "available" || watermark.threadId !== threadId) throw new Error("No trusted pre-send rollout watermark is available");
    const cwd = canonicalDirectory(expectedCwd, "The selected native task workspace");
    if (watermark.cwd !== cwd) throw new Error("The selected native task workspace changed after dispatch");
    const found = findRollout(threadId, env);
    if (found.file !== watermark.file) throw new Error("The selected native task rollout changed after dispatch");
    const snapshot = readStable(found, maxRolloutBytes);
    if (snapshot.identity.dev !== watermark.identity?.dev || snapshot.identity.ino !== watermark.identity?.ino || snapshot.data.length < watermark.size) throw new Error("The selected native task rollout identity changed after dispatch");
    const prefix = snapshot.data.subarray(0, watermark.size);
    if (crypto.createHash("sha256").update(prefix).digest("hex") !== watermark.prefixSha256) throw new Error("The pre-send Codex rollout history changed after dispatch");
    const records = parseRecords(snapshot.data);
    validateSession(records, threadId, cwd);
    const tail = records.filter(({ start }) => start >= watermark.size);
    const inspected = inspectTurnRecords(tail, threadId, turnId, cwd, {
      requireDispatch: { output: delegationOutput(executorThreadId, prompt) },
    });
    return { ...inspected, observationStatus: inspected.status };
  } catch (error) {
    return { ...unavailable(error), threadId, turnId, source: "codex_desktop_rollout", assistantItems: [], text: "", replySha256: null };
  }
}
