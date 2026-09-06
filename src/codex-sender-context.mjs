import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const METADATA_KEY = "x-codex-turn-metadata";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIFECYCLE = new Set(["task_started", "task_complete", "task_completed", "turn_started", "turn_complete", "turn_completed", "turn_aborted", "task_aborted"]);
const STARTED = new Set(["task_started", "turn_started"]);
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_DIRECTORIES = 4096;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function unavailable(reason, identity = {}) {
  return { status: "unavailable", threadId: null, turnId: null, mode: null, cwd: null, source: null, ...identity, reason };
}

function findRollout(sessions, threadId) {
  if (!fs.lstatSync(sessions).isDirectory()) throw new Error("The Codex sessions path is not a regular directory");
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
        if (child.isDirectory()) queue.push({ directory: candidate, depth: depth + 1 });
      }
      if (depth === 3 && child.name.startsWith("rollout-") && child.name.endsWith(`-${threadId}.jsonl`)) {
        if (!child.isFile() || child.isSymbolicLink()) throw new Error("The sender rollout is not a regular file");
        matches.push(candidate);
      }
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? "Multiple rollouts match the calling Codex task" : "No rollout matches the calling Codex task");
  return matches[0];
}

function readState(file, maxBytes) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size === 0 || before.size > maxBytes) throw new Error("The sender rollout is empty or exceeds the bounded read limit");
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw new Error("The sender rollout changed while reading");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.dev !== current.dev) throw new Error("The sender rollout changed while reading");
    const text = data.toString("utf8");
    if (!text.endsWith("\n")) throw new Error("The sender rollout has an incomplete final record");
    let session;
    let context;
    let lifecycle;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line);
      if (!object(record) || !object(record.payload)) throw new Error("The sender rollout contains an invalid record");
      if (record.type === "session_meta") {
        if (session) throw new Error("The sender rollout repeats its session identity");
        session = record.payload;
      } else if (record.type === "turn_context") {
        context = record.payload;
      } else if (record.type === "event_msg" && LIFECYCLE.has(record.payload.type)) {
        lifecycle = record.payload;
      }
    }
    return { session, context, lifecycle };
  } finally {
    fs.closeSync(descriptor);
  }
}

function permissionClass(context, metadata) {
  if (metadata.auto_review_enabled !== false || metadata.node_repl_auto_review_required !== false) throw new Error("The caller's automatic approval review state is enabled or unverified");
  if (context.approvals_reviewer !== "user") throw new Error("The caller's effective approval reviewer is unverified");
  if (!exactObject(context.permission_profile, ["type"]) || context.permission_profile.type !== "disabled") throw new Error("The caller's permission profile is restricted or unsupported; no permission class was inferred");
  if (!exactObject(context.sandbox_policy, ["type"]) || context.sandbox_policy.type !== "danger-full-access") throw new Error("The caller's effective sandbox policy does not match its disabled permission profile");
  if (context.approval_policy === "never") return "bypass";
  if (["on-request", "on-failure", "untrusted"].includes(context.approval_policy)) return "prompting";
  throw new Error("The caller's effective approval policy is unsupported");
}

export function readCodexSenderContext(meta, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES } = {}) {
  const metadata = object(meta) ? meta[METADATA_KEY] : undefined;
  if (!object(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.turn_id !== "string" || !UUID.test(metadata.thread_id) || !UUID.test(metadata.turn_id)) return unavailable("This MCP call has no valid host-supplied Codex task and turn identity");
  const identity = { threadId: metadata.thread_id, turnId: metadata.turn_id };
  try {
    if (!Number.isSafeInteger(maxRolloutBytes) || maxRolloutBytes < 1) throw new Error("The sender rollout read limit is invalid");
    if (metadata.thread_source !== "user") throw new Error("This MCP call is not from a user-owned Codex task");
    const configuredHome = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
    if (!path.isAbsolute(configuredHome)) throw new Error("The configured Codex home must be absolute");
    const sessions = path.join(configuredHome, "sessions");
    const file = findRollout(sessions, identity.threadId);
    const state = readState(file, Math.min(MAX_ROLLOUT_BYTES, maxRolloutBytes));
    const { session, context, lifecycle } = state;
    if (session?.id !== identity.threadId || session.originator !== "Codex Desktop" || session.source !== "vscode") throw new Error("The caller rollout does not confirm a root Codex Desktop task");
    if (context?.turn_id !== identity.turnId || lifecycle?.turn_id !== identity.turnId || !STARTED.has(lifecycle?.type)) throw new Error("The calling turn is no longer the latest active Codex turn");
    if (typeof context.cwd !== "string" || !path.isAbsolute(context.cwd) || typeof session.cwd !== "string" || !path.isAbsolute(session.cwd)) throw new Error("The caller's workspace is missing or invalid");
    const cwd = fs.realpathSync.native(context.cwd);
    if (!fs.statSync(cwd).isDirectory() || path.relative(fs.realpathSync.native(session.cwd), cwd)) throw new Error("The caller's workspace changed from its Desktop session identity");
    const mode = permissionClass(context, metadata);
    return { status: "verified", ...identity, mode, cwd, source: file, reason: "Host-supplied calling task and active turn match the Desktop rollout's effective permission settings" };
  } catch (error) {
    return unavailable(error?.code ? `Caller evidence could not be read (${error.code}); no sender permission class was inferred` : error.message, identity);
  }
}
