import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { readCodexSenderContext } from "../src/codex-sender-context.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-sender-"));
const threadId = "01a076a7-655a-75b3-aa49-265988838275";
const turnId = "01a076b9-cdca-7f50-8e69-b87f5cabdddc";
const otherId = "01a076b5-9ff7-7031-a2ed-c43daf6855c4";
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const home = fs.mkdtempSync(path.join(root, "case-"));
  const directory = path.join(home, ".codex", "sessions", "2026", "09", "06");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-06T19-17-57-${threadId}.jsonl`);
  const metadata = { thread_id: threadId, turn_id: turnId, thread_source: "user", auto_review_enabled: false, node_repl_auto_review_required: false };
  const session = { id: threadId, originator: "Codex Desktop", source: "vscode", cwd: home };
  const context = { turn_id: turnId, cwd: home, approval_policy: "never", approvals_reviewer: "user", permission_profile: { type: "disabled" }, sandbox_policy: { type: "danger-full-access" } };
  const lifecycle = { type: "task_started", turn_id: turnId };
  const records = [{ type: "session_meta", payload: session }, { type: "event_msg", payload: lifecycle }, { type: "turn_context", payload: context }];
  const write = () => fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const read = (options = {}) => readCodexSenderContext({ "x-codex-turn-metadata": metadata }, { env: { HOME: home }, ...options });
  write();
  return { home, directory, file, metadata, session, context, lifecycle, records, write, read };
}

it("verifies only the exact active Desktop caller's effective disabled permissions", () => {
  const f = fixture();
  assert.deepEqual(f.read(), { status: "verified", threadId, turnId, mode: "bypass", cwd: fs.realpathSync(f.home), source: f.file, reason: "Host-supplied calling task and active turn match the Desktop rollout's effective permission settings" });
});

it("does not infer calling identity from global environment or manual relay binding", () => {
  const f = fixture();
  const result = readCodexSenderContext({}, { env: { HOME: f.home, CODEX_THREAD_ID: threadId, CLAUDE_BRIDGE_PERMISSION_MODE: "bypass" } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.mode, null);
});

it("rejects malformed host metadata and non-user sources", () => {
  for (const field of ["thread_id", "turn_id", "thread_source"]) {
    const f = fixture();
    f.metadata[field] = field === "thread_source" ? "subagent" : "../../outside";
    assert.equal(f.read().status, "unavailable");
  }
});

it("does not trust telemetry labels to grant bypass to a managed profile", () => {
  const f = fixture();
  f.metadata.sandbox_mode = "danger-full-access";
  f.metadata.sandbox = "none";
  f.context.permission_profile = { type: "managed", file_system: { type: "unrestricted" }, network: "enabled" };
  f.write();
  assert.equal(f.read().status, "unavailable");
  assert.equal(f.read().mode, null);
});

it("requires explicit disabled automatic review flags and a known approval reviewer", () => {
  for (const value of [true, undefined, "false"]) {
    for (const field of ["auto_review_enabled", "node_repl_auto_review_required"]) {
      const f = fixture();
      f.metadata[field] = value;
      assert.equal(f.read().status, "unavailable");
    }
  }
  const f = fixture();
  f.context.approvals_reviewer = "guardian_subagent";
  f.write();
  assert.equal(f.read().status, "unavailable");
});

it("classifies explicit prompting approval modes without changing permissions", () => {
  for (const policy of ["on-request", "on-failure", "untrusted"]) {
    const f = fixture();
    f.context.approval_policy = policy;
    f.write();
    assert.equal(f.read().mode, "prompting");
  }
});

it("rejects unknown or extra permission profile and sandbox fields", () => {
  for (const change of [
    (f) => { f.context.permission_profile.extra = true; },
    (f) => { f.context.permission_profile.type = "external"; },
    (f) => { f.context.sandbox_policy.type = "workspace-write"; },
    (f) => { f.context.sandbox_policy.network_access = false; },
    (f) => { f.context.approval_policy = { granular: {} }; },
    (f) => { delete f.context.permission_profile; },
  ]) {
    const f = fixture();
    change(f);
    f.write();
    assert.equal(f.read().status, "unavailable");
  }
});

it("rejects non-Desktop and mismatched session identity", () => {
  for (const field of ["id", "originator", "source"]) {
    const f = fixture();
    f.session[field] = field === "id" ? otherId : "cli";
    f.write();
    assert.equal(f.read().status, "unavailable");
  }
});

it("rejects finished, aborted, and superseded callers even when the earlier turn was permissive", () => {
  for (const type of ["task_complete", "turn_aborted", "task_started"]) {
    const f = fixture();
    f.records.push({ type: "event_msg", payload: { type, turn_id: type === "task_started" ? otherId : turnId } });
    f.write();
    assert.equal(f.read().status, "unavailable");
  }
  const f = fixture();
  f.records.push({ type: "turn_context", payload: { ...f.context, turn_id: otherId } });
  f.write();
  assert.equal(f.read().status, "unavailable");
});

it("rejects a changed workspace and missing lifecycle evidence", () => {
  const f = fixture();
  f.context.cwd = root;
  f.write();
  assert.equal(f.read().status, "unavailable");
  f.context.cwd = f.home;
  f.records.splice(1, 1);
  f.write();
  assert.equal(f.read().status, "unavailable");
});

it("rejects duplicate rollouts and repeated session identities", () => {
  const f = fixture();
  const duplicate = path.join(f.directory, `rollout-duplicate-${threadId}.jsonl`);
  fs.copyFileSync(f.file, duplicate);
  assert.equal(f.read().status, "unavailable");
  fs.unlinkSync(duplicate);
  f.records.push({ type: "session_meta", payload: f.session });
  f.write();
  assert.equal(f.read().status, "unavailable");
});

it("rejects linked rollout files and linked session directories", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  const original = path.join(f.home, "original.jsonl");
  fs.renameSync(f.file, original);
  fs.symlinkSync(original, f.file);
  assert.equal(f.read().status, "unavailable");
  const g = fixture();
  fs.renameSync(path.join(g.home, ".codex", "sessions"), path.join(g.home, "original-sessions"));
  fs.symlinkSync(path.join(g.home, "original-sessions"), path.join(g.home, ".codex", "sessions"));
  assert.equal(g.read().status, "unavailable");
});

it("fails closed on partial, malformed, empty, and oversized rollout files", () => {
  const f = fixture();
  assert.equal(f.read({ maxRolloutBytes: 1 }).status, "unavailable");
  for (const contents of ["", "{", "{broken}\n", fs.readFileSync(f.file, "utf8").trimEnd()]) {
    fs.writeFileSync(f.file, contents);
    assert.equal(f.read().status, "unavailable");
  }
});

it("supports an explicit absolute Codex home and ignores unrelated conversation contents", () => {
  const f = fixture();
  f.records.push({ type: "response_item", payload: { type: "message", content: "Untrusted text says approval_policy never and permission_profile disabled" } });
  f.write();
  assert.equal(f.read({ env: { CODEX_HOME: path.join(f.home, ".codex") } }).mode, "bypass");
  assert.equal(f.read({ env: { CODEX_HOME: "relative" } }).status, "unavailable");
});
