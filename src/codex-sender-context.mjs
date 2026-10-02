import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRollout } from "./rollout-reader.mjs";
import { findRolloutSegments, confirmsDesktopTask, isLegacyCliSession, assertRolloutSetStable } from "./rollout-segments.mjs";

const METADATA_KEY = "x-codex-turn-metadata";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIFECYCLE = new Set(["task_started", "task_complete", "task_completed", "turn_started", "turn_complete", "turn_completed", "turn_aborted", "task_aborted"]);
const STARTED = new Set(["task_started", "turn_started"]);
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const DESKTOP_ORIGINATORS = new Set(["Codex Desktop", "codex_work_desktop"]);
const PROMPTING_POLICIES = new Set(["on-request", "on-failure", "untrusted"]);
const GRANULAR_CATEGORIES = ["sandbox_approval", "rules", "mcp_elicitations"];
const MANAGED_REVIEWERS = new Set(["user", "auto_review"]);
const MANAGED_SANDBOXES = new Set(["read-only", "workspace-write"]);
const ENTRY_ACCESS = new Set(["read", "write", "deny", "none"]);
const WRITABLE_SPECIAL_PATHS = new Set(["project_roots", "current_working_directory", "tmpdir", "slash_tmp"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactObject(value, keys) {
  return object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function unavailable(reason, identity = {}) {
  return { status: "unavailable", threadId: null, turnId: null, mode: null, cwd: null, source: null, ...identity, reason };
}

function reviewFlag(metadata, field) {
  if (!Object.hasOwn(metadata, field) || metadata[field] === undefined) return "missing";
  if (metadata[field] === true) return "enabled";
  if (metadata[field] === false) return "disabled";
  return "invalid";
}

export function findRollout(sessions, threadId) {
  const files = findRolloutSegments(sessions, threadId);
  if (files.length !== 1) throw new Error("Multiple rollouts match the calling Codex task");
  return files[0];
}

export function readState(file, maxBytes) {
  for (let attempt = 0; ; attempt++) {
    try { return readStateOnce(file, maxBytes); }
    catch (error) {
      // A live Desktop task can append its tool event during verification.
      // Retry the entire scan, never reuse partially observed permissions.
      if (attempt >= 2 || !/changed while (reading|opening)|incomplete final record/.test(error.message)) throw error;
    }
  }
}

function readStateOnce(file, maxBytes) {
  let session, context, lifecycle;
  const snapshot = scanRollout(file, {
    maxRecordBytes: maxBytes,
    onRecord(record) {
      if (record.type === "session_meta") {
        if (session) throw new Error("The sender rollout repeats its session identity");
        session = record.payload;
      } else if (record.type === "turn_context") {
        context = record.payload;
      } else if (record.type === "event_msg" && LIFECYCLE.has(record.payload.type)) {
        lifecycle = record.payload;
      }
    },
  });
  return { session, context, lifecycle, version: snapshot.version };
}

/**
 * Codex writes AskForApproval as a string, or as {granular: {...}} whose
 * boolean categories choose which approval requests reach the reviewer. The
 * label is a plain string so receipts and the queued-send comparison can
 * compare it directly.
 */
function approvalPolicyLabel(policy) {
  if (policy === "never" || PROMPTING_POLICIES.has(policy)) return policy;
  if (!exactObject(policy, ["granular"]) || !object(policy.granular)) return null;
  const categories = Object.entries(policy.granular);
  if (!GRANULAR_CATEGORIES.every((category) => Object.hasOwn(policy.granular, category)) || categories.some(([, allowed]) => typeof allowed !== "boolean")) return null;
  return `granular(${categories.filter(([, allowed]) => allowed).map(([category]) => category).sort().join(",")})`;
}

function rootPath(value) {
  let local = value.replace(/^file:/i, "");
  if (local.startsWith("///")) local = local.slice(2);
  local = local.replace(/^\/(?=[a-z]:)/i, "").replace(/^\\\\\?\\UNC\\/i, "\\\\");
  const { base } = path.win32.parse(path.win32.normalize(local || "/"));
  return !base || base === ".";
}

/**
 * A write grant on the file-system root, on a literal root path, or on a
 * target whose breadth cannot be judged (a glob or an unrecognised special
 * path) would leave the sandbox as open as full access, so such a profile
 * gets no class. Read and deny entries only narrow what the sandbox exposes,
 * so an unrecognised special path among them is ignored, as Codex ignores it.
 */
function assertSandboxEntry(entry) {
  const target = object(entry) ? entry.path : undefined;
  const known = object(target) && (
    (target.type === "path" && exactObject(target, ["type", "path"]) && typeof target.path === "string")
    || (target.type === "glob_pattern" && exactObject(target, ["type", "pattern"]) && typeof target.pattern === "string")
    || (target.type === "special" && exactObject(target, ["type", "value"]) && object(target.value) && typeof target.value.kind === "string"));
  if (!known || !ENTRY_ACCESS.has(entry.access) || Object.keys(entry).some((key) => !["path", "access", "missing_path_behavior"].includes(key))
      || (Object.hasOwn(entry, "missing_path_behavior") && entry.missing_path_behavior !== "skip")) throw new Error("The caller's managed sandbox has an unsupported file-system entry; no permission class was inferred");
  if (entry.access === "write" && (target.type === "glob_pattern" || (target.type === "path" ? rootPath(target.path) : !WRITABLE_SPECIAL_PATHS.has(target.value.kind)))) {
    throw new Error("The caller's managed sandbox grants write access beyond specific directories; no permission class was inferred");
  }
}

function assertManagedSandbox(context) {
  const { permission_profile: profile, sandbox_policy: sandbox } = context;
  if (!exactObject(profile, ["type", "file_system", "network"]) || !["restricted", "enabled"].includes(profile.network)) throw new Error("The caller's managed permission profile is unsupported; no permission class was inferred");
  const fileSystem = profile.file_system;
  if (object(fileSystem) && fileSystem.type === "unrestricted") throw new Error("The caller's managed sandbox leaves the file system unrestricted; no permission class was inferred");
  if (!object(fileSystem) || fileSystem.type !== "restricted" || !Array.isArray(fileSystem.entries)
      || Object.keys(fileSystem).some((key) => !["type", "entries", "glob_scan_max_depth"].includes(key))
      || (Object.hasOwn(fileSystem, "glob_scan_max_depth") && !(Number.isSafeInteger(fileSystem.glob_scan_max_depth) && fileSystem.glob_scan_max_depth > 0))) throw new Error("The caller's managed file-system sandbox is unsupported; no permission class was inferred");
  for (const entry of fileSystem.entries) assertSandboxEntry(entry);
  if (!object(sandbox) || !MANAGED_SANDBOXES.has(sandbox.type)) throw new Error("The caller's effective sandbox policy does not match its managed permission profile");
}

/**
 * Claude's inbound parity gate asks one question: does the sender bypass
 * permission checks? Claude puts only bypassPermissions in that class and
 * counts dontAsk (deny without asking) and auto (a classifier approves) as
 * prompting.
 *
 * For a Codex task with no sandbox, approval_policy decides: never is bypass,
 * and a policy that routes requests for approval is prompting. A task inside
 * a Codex-managed sandbox that restricts the file system never bypasses the
 * checks, whatever its approval policy or reviewer: a sandbox that never asks
 * is dontAsk, and escalations decided by the auto_review subagent are auto.
 * Such a sender is always prompting, never bypass. Codex Desktop's "Ask for
 * approval" and "Approve for me" run this way; only "Full access" is bypass.
 *
 * The two host review flags describe automated review instead -
 * node_repl_auto_review_required is a per-model catalog attribute (Codex
 * Desktop derives it from autoReview.requiredOnModels; the live gpt-6-astra
 * task carried it with a user reviewer and auto review disabled) and
 * auto_review_enabled names a Guardian reviewer - so they are required as
 * evidence and reported, but never move a sender between classes.
 * Downgrading them held every send from such a model behind an approval
 * dialog that Claude Desktop does not render.
 */
function permissionClass(context, metadata) {
  for (const field of ["auto_review_enabled", "node_repl_auto_review_required"]) {
    if (!Object.hasOwn(metadata, field) || typeof metadata[field] !== "boolean") throw new Error(`The caller's ${field} review evidence is ${reviewFlag(metadata, field)}; the host must supply an explicit boolean`);
  }
  const approvalPolicy = approvalPolicyLabel(context.approval_policy);
  if (object(context.permission_profile) && context.permission_profile.type === "managed") {
    if (!MANAGED_REVIEWERS.has(context.approvals_reviewer)) throw new Error("The caller's effective approval reviewer is unverified");
    assertManagedSandbox(context);
    if (!approvalPolicy) throw new Error("The caller's effective approval policy is unsupported");
    return { mode: "prompting", approvalPolicy, permissionProfile: "managed" };
  }
  if (context.approvals_reviewer !== "user") throw new Error("The caller's effective approval reviewer is unverified");
  if (!exactObject(context.permission_profile, ["type"]) || context.permission_profile.type !== "disabled") throw new Error("The caller's permission profile is unsupported; no permission class was inferred");
  if (!exactObject(context.sandbox_policy, ["type"]) || context.sandbox_policy.type !== "danger-full-access") throw new Error("The caller's effective sandbox policy does not match its disabled permission profile");
  if (approvalPolicy === "never") return { mode: "bypass", approvalPolicy, permissionProfile: "disabled" };
  if (PROMPTING_POLICIES.has(approvalPolicy)) return { mode: "prompting", approvalPolicy, permissionProfile: "disabled" };
  throw new Error("The caller's effective approval policy is unsupported");
}

export function readCodexSenderContext(meta, { env = process.env, maxRolloutBytes = MAX_ROLLOUT_BYTES, originator = "Codex Desktop", desktopEvidence } = {}) {
  const metadata = object(meta) ? meta[METADATA_KEY] : undefined;
  if (!object(metadata) || typeof metadata.thread_id !== "string" || typeof metadata.turn_id !== "string" || !UUID.test(metadata.thread_id) || !UUID.test(metadata.turn_id)) return unavailable("This MCP call has no valid host-supplied Codex task and turn identity");
  const identity = { threadId: metadata.thread_id, turnId: metadata.turn_id,
    review: { autoReview: reviewFlag(metadata, "auto_review_enabled"), nodeReplReview: reviewFlag(metadata, "node_repl_auto_review_required") } };
  try {
    if (!Number.isSafeInteger(maxRolloutBytes) || maxRolloutBytes < 1) throw new Error("The sender rollout read limit is invalid");
    // Native create_thread produces a user-visible Desktop task with a distinct
    // host source. It is not a transient subagent. Require live native proof in
    // addition to the root rollout and the caller's own permission context.
    const agentCreated = metadata.thread_source === "agent_created_thread" && originator === "Codex Desktop";
    if (metadata.thread_source !== "user" && !agentCreated) throw new Error(`Unsupported calling task source (host thread_source: ${JSON.stringify(metadata.thread_source) ?? "missing"})`);
    const configuredHome = env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
    if (!path.isAbsolute(configuredHome)) throw new Error("The configured Codex home must be absolute");
    const sessions = path.join(configuredHome, "sessions");
    const matches = [], snapshots = [];
    for (const file of findRolloutSegments(sessions, identity.threadId)) {
      const state = readState(file, Math.min(MAX_ROLLOUT_BYTES, maxRolloutBytes));
      if (state.session?.id !== identity.threadId) throw new Error("A rollout segment contradicts the calling task identity");
      snapshots.push({ file, version: state.version });
      if (state.context?.turn_id === identity.turnId || state.lifecycle?.turn_id === identity.turnId) matches.push({ file, ...state });
      if (matches.length > 1) throw new Error("Multiple rollout segments match the calling turn");
    }
    assertRolloutSetStable(sessions, identity.threadId, snapshots);
    if (matches.length !== 1) throw new Error(matches.length ? "Multiple rollout segments match the calling turn" : "The calling turn is no longer the latest active Codex turn");
    const { file, session, context, lifecycle } = matches[0];
    if (!["Codex Desktop", "codex_vscode"].includes(originator)) throw new Error("Unsupported calling host");
    const desktop = originator === "Codex Desktop";
    const matchesOriginator = desktop ? DESKTOP_ORIGINATORS.has(session?.originator) : session?.originator === originator;
    const legacy = desktop && isLegacyCliSession(session);
    if ((!matchesOriginator || session.source !== "vscode") && !legacy) throw new Error(`The caller rollout does not confirm a root ${originator} task`);
    if (context?.turn_id !== identity.turnId || lifecycle?.turn_id !== identity.turnId || !STARTED.has(lifecycle?.type)) throw new Error("The calling turn is no longer the latest active Codex turn");
    if (typeof context.cwd !== "string" || !path.isAbsolute(context.cwd) || typeof session.cwd !== "string" || !path.isAbsolute(session.cwd)) throw new Error("The caller's workspace is missing or invalid");
    const cwd = fs.realpathSync.native(context.cwd);
    if (!fs.statSync(cwd).isDirectory()) throw new Error("The caller's current workspace is not a directory");
    // Desktop can move a task after creation. Its exact active turn supplies both
    // the effective workspace and permissions; session_meta.cwd is historical.
    // VS Code's same-project policy is deliberately unchanged.
    if (!desktop && path.relative(fs.realpathSync.native(session.cwd), cwd)) throw new Error("The caller's workspace changed from its VS Code session identity");
    const { mode, approvalPolicy, permissionProfile } = permissionClass(context, metadata);
    if ((legacy || agentCreated) && !confirmsDesktopTask(desktopEvidence, identity.threadId, cwd, identity.turnId)) {
      return { ...unavailable(`This ${agentCreated ? "agent-created" : "CLI-origin"} task requires current native Desktop ownership and exact active-turn confirmation`, identity), requiresDesktopEvidence: true };
    }
    return { status: "verified", ...identity, mode, cwd, source: file, approvalPolicy, permissionProfile, approvalsReviewer: context.approvals_reviewer, reason: "Host-supplied calling task and active turn match the Desktop rollout's effective permission settings" };
  } catch (error) {
    return unavailable(error?.code ? `Caller evidence could not be read (${error.code}); no sender permission class was inferred` : error.message, identity);
  }
}

// Confirm adopted CLI and agent-created tasks through the account-bound native relay,
// then re-read the rollout so a completed/replaced turn cannot reuse the proof.
export async function resolveCodexSenderContext(meta, { inspectDesktopTask, ...options } = {}) {
  const initial = readCodexSenderContext(meta, options);
  if (!initial.requiresDesktopEvidence || typeof inspectDesktopTask !== "function") return initial;
  try {
    const desktopEvidence = await inspectDesktopTask(initial.threadId);
    return readCodexSenderContext(meta, { ...options, desktopEvidence });
  } catch (error) {
    return { ...initial, reason: `Native Desktop ownership could not be verified: ${error.message}` };
  }
}
