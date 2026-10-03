import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRollout } from "./rollout-reader.mjs";
import { findRolloutSegments, confirmsDesktopTask, isLegacyCliSession, assertRolloutSetStable } from "./rollout-segments.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ROLLOUT_BYTES = 16 * 1024 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024;
const DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);
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

function findRollouts(threadId, env) {
  const sessions = configuredSessions(env);
  return findRolloutSegments(sessions, threadId).map((file) => ({ file, sessions }));
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

function readStable(found, maxBytes, { threadId, turnId, afterOffset = 0, prefixSize } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return readStableOnce(found, maxBytes, { threadId, turnId, afterOffset, prefixSize }); }
    catch (error) {
      if (attempt >= 2 || !/changed while (reading|opening)|incomplete final record/.test(error.message)) throw error;
    }
  }
}

function readStableOnce(found, maxBytes, { threadId, turnId, afterOffset, prefixSize }) {
  const { file, sessions } = found;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ROLLOUT_BYTES) throw new Error("The Codex rollout read limit is invalid");
  const beforeBoundary = capturePathBoundary(file, sessions);
  const records = [];
  const digest = crypto.createHash("sha256");
  let session, latestContext, retainedBytes = 0, turnBeforeWatermark = false;
  const snapshot = scanRollout(file, {
    maxRecordBytes: maxBytes,
    onChunk(chunk, offset) {
      // Verify every byte of the pre-send prefix without keeping it in memory.
      const length = prefixSize === undefined ? chunk.length : Math.max(0, Math.min(chunk.length, prefixSize - offset));
      if (length) digest.update(chunk.subarray(0, length));
    },
    onRecord(record, start, bytes) {
      if (record.type === "session_meta") {
        if (session) throw new Error("The Codex rollout has ambiguous session identity");
        session = record.payload;
      }
      if (record.type === "turn_context") latestContext = record.payload;
      const entry = { record, start };
      if (turnId && recordBelongsToTurn(entry, threadId, turnId)) {
        if (start < afterOffset) { turnBeforeWatermark = true; return; }
        retainedBytes += bytes;
        if (retainedBytes > maxBytes) throw new Error(`The selected native turn exceeds the ${maxBytes}-byte retained-record limit`);
        records.push(entry);
      }
    },
  });
  const afterBoundary = capturePathBoundary(file, sessions);
  if (!samePathBoundary(beforeBoundary, afterBoundary) || snapshot.identity.dev !== beforeBoundary.file.dev || snapshot.identity.ino !== beforeBoundary.file.ino) {
    throw new Error("The Codex rollout changed while reading");
  }
  return { ...snapshot, file, sessions, records, retainedBytes, session, latestContext, turnBeforeWatermark, prefixSha256: digest.digest("hex") };
}

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} is missing or invalid`);
  const status = fs.lstatSync(value);
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`${label} is not a regular directory`);
  return fs.realpathSync.native(value);
}

function validateIdentity({ session }, threadId, expectedCwd, desktopEvidence) {
  if (!session) throw new Error("The Codex rollout is missing its session identity");
  const desktop = DESKTOP_ORIGINATORS.has(session.originator) && session.source === "vscode";
  const adopted = isLegacyCliSession(session) && confirmsDesktopTask(desktopEvidence, threadId, expectedCwd);
  if (session.id !== threadId || (!desktop && !adopted)) throw new Error("The rollout does not confirm the exact native Codex Desktop task");
  if (typeof session.cwd !== "string" || !path.isAbsolute(session.cwd)) throw new Error("The original rollout workspace is missing or invalid");
}

function validateSession(snapshot, threadId, expectedCwd, desktopEvidence) {
  validateIdentity(snapshot, threadId, expectedCwd, desktopEvidence);
  // Current cwd comes from independently inspected native Desktop metadata.
  if (canonicalDirectory(snapshot.latestContext ? snapshot.latestContext.cwd : snapshot.session.cwd, "The rollout workspace") !== expectedCwd) throw new Error("The rollout workspace does not match the selected native task");
}

function uniqueTurn(snapshots) {
  const selected = snapshots.filter((snapshot) => snapshot.records.length);
  if (selected.length !== 1) throw new Error(selected.length
    ? "The native turn spans multiple rollout segments or has ambiguous copies; response withheld"
    : "No rollout segment contains the selected native turn");
  return selected[0];
}

function delegationOutputs(executorThreadId, prompt) {
  const escaped = prompt.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);
  // Older Desktop rollouts stored raw text; current builds escape XML text content.
  return [prompt, escaped].map((text) => `<codex_delegation>\n  <source_thread_id>${executorThreadId}</source_thread_id>\n  <input>${text}</input>\n</codex_delegation>`);
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
      record.payload.namespace === "codex_app" && record.payload.name === (requireDispatch.operation ?? "send_message_to_thread"));
    if (dispatches.length !== 1 || !requireDispatch.outputs.includes(dispatches[0].record.payload.output) ||
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

export function captureCodexRolloutWatermark({ threadId, expectedCwd, desktopEvidence }, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  try {
    const cwd = canonicalDirectory(expectedCwd, "The selected native task workspace");
    const snapshots = findRollouts(threadId, env).map((found) => ({ ...found, ...readStable(found, maxRolloutBytes) }));
    assertRolloutSetStable(snapshots[0].sessions, threadId, snapshots);
    for (const snapshot of snapshots) validateIdentity(snapshot, threadId, cwd, desktopEvidence);
    const matches = snapshots.length === 1 ? snapshots : snapshots.filter((snapshot) =>
      desktopEvidence?.latestTurnId && snapshot.latestContext?.turn_id === desktopEvidence.latestTurnId);
    if (matches.length !== 1) throw new Error("Multiple rollouts require an unambiguous current native Desktop turn");
    const selected = matches[0];
    validateSession(selected, threadId, cwd, desktopEvidence);
    const mark = ({ file, size, prefixSha256, identity }) => ({ file, size, prefixSha256, identity });
    return { status: "available", threadId, cwd, ...mark(selected), segments: snapshots.map(mark) };
  } catch (error) {
    return unavailable(error);
  }
}

// Creation has no pre-send rollout: the confirmed fresh thread ID is its boundary.
// Require the exact create_thread dispatch, executor and prompt rather than
// treating any later turn in that thread as the delegated reply.
export function readCodexNativeCreationResponse({ threadId, turnId, expectedCwd, executorThreadId, prompt, desktopEvidence }, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  try {
    if (!UUID.test(threadId) || !UUID.test(turnId) || !UUID.test(executorThreadId)) throw new Error("The native creation response identity is invalid");
    if (typeof prompt !== "string" || !prompt.length) throw new Error("The exact creation prompt is unavailable");
    const cwd = canonicalDirectory(expectedCwd, "The created native task workspace");
    let retainedBytes = 0;
    const snapshots = findRollouts(threadId, env).map((found) => {
      const snapshot = readStable(found, maxRolloutBytes, { threadId, turnId });
      retainedBytes += snapshot.retainedBytes;
      if (retainedBytes > maxRolloutBytes) throw new Error("The native turn exceeds the retained-record limit across segments");
      validateIdentity(snapshot, threadId, cwd, desktopEvidence);
      return snapshot;
    });
    assertRolloutSetStable(snapshots[0].sessions, threadId, snapshots);
    const selected = uniqueTurn(snapshots);
    validateSession(selected, threadId, cwd, desktopEvidence);
    return inspectTurnRecords(selected.records, threadId, turnId, cwd, {
      requireDispatch: { operation: "create_thread", outputs: delegationOutputs(executorThreadId, prompt) },
    });
  } catch (error) {
    return { ...unavailable(error), threadId, turnId, source: "codex_desktop_rollout", assistantItems: [], text: "", replySha256: null };
  }
}

export function inspectCodexNativeTurn({ threadId, turnId, expectedCwd, desktopEvidence }, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  try {
    if (!UUID.test(threadId) || !UUID.test(turnId)) throw new Error("The native turn identity is invalid");
    const cwd = canonicalDirectory(expectedCwd, "The selected native task workspace");
    let retainedBytes = 0;
    const snapshots = findRollouts(threadId, env).map((found) => {
      const snapshot = readStable(found, maxRolloutBytes, { threadId, turnId });
      retainedBytes += snapshot.retainedBytes;
      if (retainedBytes > maxRolloutBytes) throw new Error("The native turn exceeds the retained-record limit across segments");
      return snapshot;
    });
    assertRolloutSetStable(snapshots[0].sessions, threadId, snapshots);
    for (const snapshot of snapshots) validateIdentity(snapshot, threadId, cwd, desktopEvidence);
    const selected = uniqueTurn(snapshots);
    validateSession(selected, threadId, cwd, desktopEvidence);
    return inspectTurnRecords(selected.records, threadId, turnId, cwd);
  } catch (error) {
    return { ...unavailable(error), threadId, turnId, source: "codex_desktop_rollout", assistantItems: [], text: "", replySha256: null };
  }
}

export function readCodexNativeTurnResponse({ threadId, turnId, previousTurnId, expectedCwd, executorThreadId, prompt, watermark, desktopEvidence }, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  try {
    if (!UUID.test(threadId) || !UUID.test(turnId) || !UUID.test(executorThreadId)) throw new Error("The native response identity is invalid");
    if (turnId === previousTurnId) throw new Error("The observed turn was already present before dispatch");
    if (typeof prompt !== "string" || !prompt.length) throw new Error("The exact dispatched prompt is unavailable");
    if (!object(watermark) || watermark.status !== "available" || watermark.threadId !== threadId) throw new Error("No trusted pre-send rollout watermark is available");
    const cwd = canonicalDirectory(expectedCwd, "The selected native task workspace");
    if (watermark.cwd !== cwd) throw new Error("The selected native task workspace changed after dispatch");
    const marks = watermark.segments ?? [watermark];
    if (!Array.isArray(marks) || !marks.length || marks.length > 64
        || new Set(marks.map((mark) => mark.file)).size !== marks.length
        || !marks.some((mark) => mark.file === watermark.file && mark.size === watermark.size && mark.prefixSha256 === watermark.prefixSha256)) throw new Error("The pre-send segment watermarks are invalid");
    for (const mark of marks) if (!Number.isSafeInteger(mark.size) || mark.size < 1) throw new Error("The pre-send rollout watermark size is invalid");
    const found = findRollouts(threadId, env);
    if (marks.some((mark) => !found.some(({ file }) => file === mark.file))) throw new Error("A pre-send rollout segment disappeared after dispatch");
    let retainedBytes = 0;
    const snapshots = found.map((entry) => {
      const mark = marks.find(({ file }) => file === entry.file);
      const snapshot = readStable(entry, maxRolloutBytes, { threadId, turnId, afterOffset: mark?.size ?? 0, prefixSize: mark?.size });
      retainedBytes += snapshot.retainedBytes;
      if (retainedBytes > maxRolloutBytes) throw new Error("The native turn exceeds the retained-record limit across segments");
      if (mark) {
        if (snapshot.identity.dev !== mark.identity?.dev || snapshot.identity.ino !== mark.identity?.ino || snapshot.size < mark.size) throw new Error("The selected native task rollout identity changed after dispatch");
        if (snapshot.prefixSha256 !== mark.prefixSha256) throw new Error("The pre-send Codex rollout history changed after dispatch");
      }
      if (snapshot.turnBeforeWatermark) throw new Error("The observed turn was already present before dispatch");
      validateIdentity(snapshot, threadId, cwd, desktopEvidence);
      return snapshot;
    });
    assertRolloutSetStable(snapshots[0].sessions, threadId, snapshots);
    const selected = uniqueTurn(snapshots);
    validateSession(selected, threadId, cwd, desktopEvidence);
    const inspected = inspectTurnRecords(selected.records, threadId, turnId, cwd, {
      requireDispatch: { outputs: delegationOutputs(executorThreadId, prompt) },
    });
    return { ...inspected, observationStatus: inspected.status };
  } catch (error) {
    return { ...unavailable(error), threadId, turnId, source: "codex_desktop_rollout", assistantItems: [], text: "", replySha256: null };
  }
}
