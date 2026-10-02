import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { readCodexSenderContext, resolveCodexSenderContext } from "../src/codex-sender-context.mjs";
import { assertRecipientClass } from "../src/recipient-preflight.mjs";

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

function workDesktopFixture() {
  const f = fixture();
  f.session.originator = "codex_work_desktop";
  f.metadata.auto_review_enabled = true;
  f.metadata.node_repl_auto_review_required = true;
  Object.assign(f.context, {
    approval_policy: "on-request",
    approvals_reviewer: "auto_review",
    permission_profile: {
      type: "managed",
      file_system: { type: "restricted", entries: [
        { path: { type: "special", value: { kind: "root" } }, access: "read" },
        { path: { type: "path", path: f.home }, access: "write" },
        { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
        { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
        { path: { type: "path", path: path.join(f.home, ".git") }, access: "read", missing_path_behavior: "skip" },
      ] },
      network: "restricted",
    },
    sandbox_policy: {
      type: "workspace-write", writable_roots: [f.home], network_access: false,
      exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
    },
  });
  f.write();
  return f;
}

it("selects the exact active turn in a continuation, regardless of file timestamps", () => {
  const f = managedFixture();
  const continued = f.file.replace(".jsonl", `_${otherId}.jsonl`);
  fs.copyFileSync(f.file, continued);
  f.context.turn_id = otherId;
  f.lifecycle.turn_id = otherId;
  f.lifecycle.type = "task_complete";
  f.write();
  fs.utimesSync(f.file, new Date(), new Date(Date.now() + 86400000));
  const result = f.read();
  assert.equal(result.status, "verified", result.reason);
  assert.equal(result.source, continued);
  fs.copyFileSync(continued, f.file);
  assert.match(f.read().reason, /Multiple rollout segments/);
});

it("requires live native ownership for an adopted CLI task and rechecks permissions after inspection", async () => {
  const f = managedFixture();
  Object.assign(f.session, { originator: "codex-tui", source: "cli" });
  f.write();
  const evidence = { thread: { id: threadId, kind: "codex", hostId: "local", cwd: f.home }, latestTurnId: turnId };
  const resolve = (inspectDesktopTask) => resolveCodexSenderContext({ "x-codex-turn-metadata": f.metadata }, { env: { HOME: f.home }, inspectDesktopTask });
  assert.equal(f.read().status, "unavailable");
  assert.equal((await resolve(async () => evidence)).mode, "prompting");
  for (const changed of [
    { ...evidence, latestTurnId: otherId },
    { ...evidence, thread: { ...evidence.thread, id: otherId } },
    { ...evidence, thread: { ...evidence.thread, hostId: "remote" } },
    { ...evidence, thread: { ...evidence.thread, kind: "chatgpt" } },
    { ...evidence, thread: { ...evidence.thread, cwd: root } },
  ]) assert.equal((await resolve(async () => changed)).status, "unavailable");
  assert.equal((await resolve(async () => { throw new Error("relay unavailable"); })).status, "unavailable");
  assert.equal((await resolve(async () => {
    f.lifecycle.type = "task_complete"; f.write(); return evidence;
  })).status, "unavailable");
  f.lifecycle.type = "task_started"; f.write();
  // Upstream classifies a managed, restricting sandbox as prompting even when
  // it never asks. Re-read that policy without confusing it with full access.
  const never = await resolve(async () => {
    f.context.approval_policy = "never"; f.write(); return evidence;
  });
  assert.equal(never.mode, "prompting");
  assert.equal(never.approvalPolicy, "never");
  assert.equal((await resolve(async () => {
    f.context.approvals_reviewer = "unverified-reviewer"; f.write(); return evidence;
  })).status, "unavailable");
});

it("does not consult Desktop adoption for malformed metadata or unknown origins", async () => {
  const f = managedFixture();
  f.session.originator = "unknown"; f.write();
  let calls = 0;
  const inspectDesktopTask = async () => { calls++; return {}; };
  assert.equal((await resolveCodexSenderContext({ "x-codex-turn-metadata": f.metadata }, { env: { HOME: f.home }, inspectDesktopTask })).status, "unavailable");
  assert.equal((await resolveCodexSenderContext({}, { env: { HOME: f.home }, inspectDesktopTask })).status, "unavailable");
  assert.equal(calls, 0);
});

it("verifies native agent-created Desktop tasks with their own live turn and permissions", async () => {
  const f = managedFixture();
  f.metadata.thread_source = "agent_created_thread";
  const evidence = { thread: { id: threadId, kind: "codex", hostId: "local", cwd: f.home }, latestTurnId: turnId };
  const resolve = (inspectDesktopTask) => resolveCodexSenderContext({ "x-codex-turn-metadata": f.metadata }, { env: { HOME: f.home }, inspectDesktopTask });
  assert.equal(f.read().requiresDesktopEvidence, true);
  assert.equal((await resolve(undefined)).status, "unavailable");
  const result = await resolve(async id => { assert.equal(id, threadId); return evidence; });
  assert.equal(result.status, "verified", result.reason);
  assert.equal(result.threadId, threadId);
  assert.equal(result.mode, "prompting");
  assert.equal(result.approvalPolicy, "granular(mcp_elicitations,request_permissions,rules,sandbox_approval,skill_approval)");
  for (const changed of [
    {},
    { ...evidence, latestTurnId: otherId },
    { ...evidence, thread: { ...evidence.thread, id: otherId } },
    { ...evidence, thread: { ...evidence.thread, hostId: "remote" } },
    { ...evidence, thread: { ...evidence.thread, kind: "chatgpt" } },
    { ...evidence, thread: { ...evidence.thread, cwd: root } },
  ]) assert.equal((await resolve(async () => changed)).status, "unavailable");
  assert.equal((await resolve(async () => { throw new Error("relay unavailable"); })).status, "unavailable");
  assert.equal((await resolve(async () => {
    f.lifecycle.type = "task_complete"; f.write(); return evidence;
  })).status, "unavailable");
  f.lifecycle.type = "task_started"; f.write();
  const never = await resolve(async () => {
    f.context.approval_policy = "never"; f.write(); return evidence;
  });
  assert.equal(never.mode, "prompting");
  assert.equal(never.approvalPolicy, "never");
  assert.equal((await resolve(async () => {
    f.context.approvals_reviewer = "unverified-reviewer"; f.write(); return evidence;
  })).status, "unavailable");
});

it("does not treat subagents, unknown sources or non-Desktop origins as native created tasks", async () => {
  for (const source of ["subagent", "agent", "agent_created_thread_unknown", undefined, {}, true]) {
    const f = managedFixture();
    f.metadata.thread_source = source;
    let calls = 0;
    const result = await resolveCodexSenderContext({ "x-codex-turn-metadata": f.metadata }, {
      env: { HOME: f.home }, inspectDesktopTask: async () => { calls++; return {}; },
    });
    assert.equal(result.status, "unavailable");
    assert.equal(calls, 0);
  }
  for (const source of ["cli", { subagent: { thread_spawn: { parent_thread_id: otherId } } }]) {
    const f = managedFixture();
    f.metadata.thread_source = "agent_created_thread";
    f.session.source = source; f.write();
    assert.equal(f.read().status, "unavailable");
    assert.equal(f.read().requiresDesktopEvidence, undefined);
  }
  const f = fixture();
  f.metadata.thread_source = "agent_created_thread";
  f.session.originator = "codex_vscode"; f.write();
  assert.equal(f.read({ originator: "codex_vscode" }).status, "unavailable");
});

it("recognizes local Work Desktop without accepting web, CLI, or extension origins", () => {
  for (const originator of ["Codex Desktop", "codex_work_desktop"]) {
    const f = fixture();
    f.session.originator = originator;
    f.write();
    assert.equal(f.read().status, "verified");
    assert.equal(f.read({ originator: "codex_vscode" }).status, "unavailable");
  }
  for (const originator of ["codex_work_web", "codex_cli_rs", "codex_vscode", "Codex Desktop unknown"]) {
    const f = workDesktopFixture();
    f.session.originator = originator;
    f.write();
    assert.equal(f.read().status, "unavailable", originator);
  }
});

it("verifies the observed managed Desktop shape as prompting and preserves review evidence", () => {
  for (const originator of ["Codex Desktop", "codex_work_desktop"]) {
    for (const reviewer of ["user", "auto_review"]) {
      for (const policy of ["on-request", "on-failure", "untrusted"]) {
        const f = workDesktopFixture();
        f.session.originator = originator;
        f.context.approvals_reviewer = reviewer;
        f.context.approval_policy = policy;
        f.write();
        const result = f.read();
        assert.equal(result.status, "verified", result.reason);
        assert.equal(result.mode, "prompting");
        assert.equal(result.approvalPolicy, policy);
        assert.deepEqual(result.review, { autoReview: "enabled", nodeReplReview: "enabled" });
      }
    }
  }
});

it("keeps managed Work Desktop senders in the prompting class, including never and granular approvals", () => {
  for (const policy of ["never", { granular: { sandbox_approval: true, rules: true, mcp_elicitations: false } }]) {
    const f = workDesktopFixture();
    f.context.approval_policy = policy;
    f.metadata.sandbox_mode = "danger-full-access";
    f.write();
    const result = f.read();
    assert.equal(result.status, "verified", result.reason);
    assert.equal(result.mode, "prompting");
  }
});

it("fails closed for malformed Work Desktop review evidence and unsupported managed shapes", () => {
  const changes = [
    f => { delete f.metadata.auto_review_enabled; },
    f => { f.metadata.node_repl_auto_review_required = "true"; },
    f => { f.context.approvals_reviewer = "unknown"; },
    f => { f.context.permission_profile.extra = true; },
    f => { f.context.permission_profile.file_system.type = "unrestricted"; },
    f => { f.context.permission_profile.file_system.entries[0].access = "allow"; },
    f => { f.context.permission_profile.file_system.entries[0].access = "write"; },
    f => { f.context.permission_profile.file_system.entries[1].extra = true; },
    f => { f.context.permission_profile.file_system.entries[4].missing_path_behavior = "allow"; },
    f => { f.context.sandbox_policy.type = "danger-full-access"; },
    f => { f.context.approval_policy = { granular: {} }; },
  ];
  for (const change of changes) {
    const f = workDesktopFixture();
    change(f);
    f.write();
    const result = f.read();
    assert.equal(result.status, "unavailable", String(change));
    assert.equal(result.mode, null);
  }
});

it("keeps active-turn, workspace, and identity checks for managed Work Desktop callers", () => {
  for (const change of [
    f => { f.session.id = otherId; },
    f => { f.session.source = "cli"; },
    f => { f.metadata.thread_source = "subagent"; },
    f => { f.metadata.turn_id = otherId; },
    f => { f.context.cwd = path.join(root, "missing-workspace"); },
    f => { f.lifecycle.type = "task_complete"; },
  ]) {
    const f = workDesktopFixture();
    change(f);
    f.write();
    assert.equal(f.read().status, "unavailable", String(change));
  }
});

it("preserves recipient parity and explicit hold/refuse for a verified managed sender", () => {
  const sender = workDesktopFixture().read();
  assert.equal(sender.status, "verified");
  const recipient = { desktop: { title: "Test", permissionMode: "default", permissionClass: "prompting" } };
  assert.doesNotThrow(() => assertRecipientClass(recipient, sender));
  assert.throws(() => assertRecipientClass({ desktop: { ...recipient.desktop, permissionMode: "bypassPermissions", permissionClass: "bypass" } }, sender),
    error => error.preflight?.code === "CLAUDE_RECIPIENT_CLASS_MISMATCH" && error.preflight.sent === false);
  for (const value of ["hold", "refuse"]) {
    assert.throws(() => assertRecipientClass({ ...recipient, inbound: { value, source: "managed" } }, sender),
      error => error.preflight?.code === "CLAUDE_RECIPIENT_INBOUND_POLICY" && error.preflight.sent === false);
  }
});

it("verifies only the exact active Desktop caller's effective disabled permissions", () => {
  const f = fixture();
  assert.deepEqual(f.read(), { status: "verified", threadId, turnId, mode: "bypass", cwd: fs.realpathSync.native(f.home), source: f.file, review: { autoReview: "disabled", nodeReplReview: "disabled" }, approvalPolicy: "never", permissionProfile: "disabled", approvalsReviewer: "user", reason: "Host-supplied calling task and active turn match the Desktop rollout's effective permission settings" });
});

const GRANULAR = { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } };
const GRANULAR_LABEL = "granular(mcp_elicitations,request_permissions,rules,sandbox_approval,skill_approval)";

/**
 * The shape a new "Ask for approval" task records on Codex Desktop 26.924
 * (issue #83): a managed profile whose restricted file system can write only
 * the workspace and temporary directories, granular approvals, a user reviewer.
 */
function managedFixture({ approvalPolicy = GRANULAR, reviewer = "user", sandbox = "workspace-write", network = "restricted" } = {}) {
  const f = fixture();
  f.context.approval_policy = structuredClone(approvalPolicy);
  f.context.approvals_reviewer = reviewer;
  f.context.permission_profile = { type: "managed", file_system: { type: "restricted", entries: [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
    ...(sandbox === "workspace-write" ? [
      { path: { type: "path", path: f.home }, access: "write" },
      { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
      { path: { type: "path", path: path.join(f.home, ".git") }, access: "read", missing_path_behavior: "skip" },
    ] : []),
  ] }, network };
  f.context.active_permission_profile = { id: sandbox === "workspace-write" ? ":workspace" : ":read-only" };
  f.context.sandbox_policy = sandbox === "workspace-write"
    ? { type: "workspace-write", network_access: network === "enabled", exclude_tmpdir_env_var: false, exclude_slash_tmp: false }
    : { type: "read-only" };
  f.write();
  return f;
}

it("classifies the Codex Desktop 26.924 managed workspace sandbox with granular approvals as prompting", () => {
  const f = managedFixture();
  const result = f.read();
  assert.equal(result.status, "verified", result.reason);
  assert.equal(result.mode, "prompting");
  assert.equal(result.approvalPolicy, GRANULAR_LABEL);
  assert.equal(result.permissionProfile, "managed");
  assert.equal(result.approvalsReviewer, "user");
  assert.equal(JSON.stringify(f.read()), JSON.stringify(result), "Two reads of one turn must compare equal before a queued send is written");
});

/**
 * Claude counts dontAsk (deny without asking) and auto (a classifier
 * approves) as prompting, so a task inside a restricting Codex sandbox is
 * prompting whether it never asks or its escalations go to the auto_review
 * subagent. Nothing about a managed sandbox may ever attest bypass.
 */
it("keeps every restricting managed sandbox in the prompting class, whatever its approval policy or reviewer", () => {
  const policies = [
    ["never", "never"], ["on-request", "on-request"], ["on-failure", "on-failure"], ["untrusted", "untrusted"], [GRANULAR, GRANULAR_LABEL],
    [{ granular: { sandbox_approval: false, rules: false, skill_approval: false, request_permissions: false, mcp_elicitations: false } }, "granular()"],
    [{ granular: { sandbox_approval: true, rules: false, mcp_elicitations: true } }, "granular(mcp_elicitations,sandbox_approval)"],
  ];
  for (const [approvalPolicy, label] of policies) {
    for (const reviewer of ["user", "auto_review"]) {
      const result = managedFixture({ approvalPolicy, reviewer }).read();
      assert.equal(result.status, "verified", `${label} ${reviewer}: ${result.reason}`);
      assert.equal(result.mode, "prompting", `${label} ${reviewer}`);
      assert.equal(result.approvalPolicy, label);
      assert.equal(result.approvalsReviewer, reviewer);
    }
  }
  for (const options of [{ sandbox: "read-only" }, { network: "enabled" }, { sandbox: "read-only", approvalPolicy: "never", reviewer: "auto_review" }]) {
    const result = managedFixture(options).read();
    assert.equal(result.status, "verified", `${JSON.stringify(options)}: ${result.reason}`);
    assert.equal(result.mode, "prompting");
  }
});

it("ignores unrecognised read and deny targets in a managed sandbox, as Codex does", () => {
  const f = managedFixture();
  f.context.permission_profile.file_system.glob_scan_max_depth = 3;
  f.context.permission_profile.file_system.entries.push(
    { path: { type: "special", value: { kind: "unknown", path: ":future" } }, access: "read" },
    { path: { type: "special", value: { kind: "home" } }, access: "deny" },
    { path: { type: "glob_pattern", pattern: "**/*.pem" }, access: "none" },
  );
  f.write();
  const result = f.read();
  assert.equal(result.status, "verified", result.reason);
  assert.equal(result.mode, "prompting");
});

it("fails closed on a managed profile that is unrestricted, writable everywhere, or malformed", () => {
  const entries = (f) => f.context.permission_profile.file_system.entries;
  const unrestricted = /leaves the file system unrestricted/;
  const broad = /grants write access beyond specific directories/;
  const entry = /unsupported file-system entry/;
  const fileSystem = /managed file-system sandbox is unsupported/;
  const profile = /managed permission profile is unsupported/;
  const legacy = /does not match its managed permission profile/;
  const reviewer = /approval reviewer is unverified/;
  const policy = /approval policy is unsupported/;
  const cases = {
    "unrestricted file system": [unrestricted, (f) => { f.context.permission_profile.file_system = { type: "unrestricted" }; }],
    "root write": [broad, (f) => { entries(f).push({ path: { type: "special", value: { kind: "root" } }, access: "write" }); }],
    "POSIX root path write": [broad, (f) => { entries(f).push({ path: { type: "path", path: "/" }, access: "write" }); }],
    "drive root path write": [broad, (f) => { entries(f).push({ path: { type: "path", path: "C:\\" }, access: "write" }); }],
    "dot-segment root path write": [broad, (f) => { entries(f).push({ path: { type: "path", path: [f.home, ...Array(16).fill("..")].join(path.sep) }, access: "write" }); }],
    "share root path write": [broad, (f) => { entries(f).push({ path: { type: "path", path: "\\\\server\\share" }, access: "write" }); }],
    "extended share root path write": [broad, (f) => { entries(f).push({ path: { type: "path", path: "\\\\?\\UNC\\server\\share\\" }, access: "write" }); }],
    "root URI write": [broad, (f) => { entries(f).push({ path: { type: "path", path: "file:///" }, access: "write" }); }],
    "drive root URI write": [broad, (f) => { entries(f).push({ path: { type: "path", path: "file:///C:/" }, access: "write" }); }],
    "glob write": [broad, (f) => { entries(f).push({ path: { type: "glob_pattern", pattern: "**" }, access: "write" }); }],
    "unknown special write": [broad, (f) => { entries(f).push({ path: { type: "special", value: { kind: "unknown", path: ":home" } }, access: "write" }); }],
    "future special write": [broad, (f) => { entries(f).push({ path: { type: "special", value: { kind: "home" } }, access: "write" }); }],
    "unknown access": [entry, (f) => { entries(f)[1].access = "execute"; }],
    "unknown path type": [entry, (f) => { entries(f)[1].path = { type: "volume", path: f.home }; }],
    "extra entry field": [entry, (f) => { entries(f)[1].recursive = true; }],
    "extra path field": [entry, (f) => { entries(f)[1].path.escalated = true; }],
    "unknown missing path behavior": [entry, (f) => { entries(f)[4].missing_path_behavior = "create"; }],
    "entries not a list": [fileSystem, (f) => { f.context.permission_profile.file_system.entries = {}; }],
    "extra file-system field": [fileSystem, (f) => { f.context.permission_profile.file_system.escalation = "auto"; }],
    "invalid glob depth": [fileSystem, (f) => { f.context.permission_profile.file_system.glob_scan_max_depth = 0; }],
    "extra profile field": [profile, (f) => { f.context.permission_profile.extra = true; }],
    "unknown network": [profile, (f) => { f.context.permission_profile.network = "proxied"; }],
    "full-access legacy sandbox": [legacy, (f) => { f.context.sandbox_policy = { type: "danger-full-access" }; }],
    "external legacy sandbox": [legacy, (f) => { f.context.sandbox_policy = { type: "external-sandbox", network_access: "restricted" }; }],
    "missing legacy sandbox": [legacy, (f) => { delete f.context.sandbox_policy; }],
    "missing reviewer": [reviewer, (f) => { delete f.context.approvals_reviewer; }],
    "legacy reviewer spelling": [reviewer, (f) => { f.context.approvals_reviewer = "guardian_subagent"; }],
    "unknown reviewer": [reviewer, (f) => { f.context.approvals_reviewer = "admin"; }],
    "unknown approval policy": [policy, (f) => { f.context.approval_policy = "on-demand"; }],
    "granular without a required category": [policy, (f) => { delete f.context.approval_policy.granular.rules; }],
    "granular with a non-boolean category": [policy, (f) => { f.context.approval_policy.granular.rules = "true"; }],
    "granular with an extra wrapper field": [policy, (f) => { f.context.approval_policy.never = true; }],
    "empty granular": [policy, (f) => { f.context.approval_policy = { granular: {} }; }],
  };
  for (const [name, [reason, change]] of Object.entries(cases)) {
    const f = managedFixture();
    change(f);
    f.write();
    const result = f.read();
    assert.equal(result.status, "unavailable", name);
    assert.equal(result.mode, null, name);
    assert.match(result.reason, reason, name);
  }
});

it("still requires a user reviewer and a string approval policy for full access", () => {
  for (const change of [(f) => { f.context.approvals_reviewer = "auto_review"; }, (f) => { f.context.approval_policy = structuredClone(GRANULAR); }]) {
    const f = fixture();
    change(f);
    f.write();
    assert.equal(f.read().status, "unavailable");
    assert.equal(f.read().mode, null);
  }
});

it("does not infer calling identity from global environment or manual relay binding", () => {
  const f = fixture();
  const result = readCodexSenderContext({}, { env: { HOME: f.home, CODEX_THREAD_ID: threadId, CLAUDE_BRIDGE_PERMISSION_MODE: "bypass" } });
  assert.equal(result.status, "unavailable");
  assert.equal(result.mode, null);
});

it("keeps VS Code caller verification separate from the default Desktop policy", () => {
  const f = fixture();
  assert.equal(f.read({ originator: "codex_vscode" }).status, "unavailable");
  f.session.originator = "codex_vscode";
  f.write();
  assert.equal(f.read().status, "unavailable");
  assert.equal(f.read({ originator: "codex_vscode" }).status, "verified");
  f.metadata.turn_id = "00000000-0000-4000-8000-000000000000";
  assert.equal(f.read({ originator: "codex_vscode" }).status, "unavailable");
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

it("rejects missing or invalid review evidence even when the other review flag is enabled", () => {
  for (const value of [undefined, null, "false", "true", 0, 1, {}]) {
    for (const field of ["auto_review_enabled", "node_repl_auto_review_required"]) {
      const f = fixture();
      f.metadata.auto_review_enabled = true;
      f.metadata.node_repl_auto_review_required = true;
      f.metadata[field] = value;
      assert.equal(f.read().status, "unavailable");
      assert.equal(f.read().mode, null);
      assert.match(f.read().reason, new RegExp(field));
    }
  }
});

it("requires a known approval reviewer even when automatic review is enabled", () => {
  const f = fixture();
  f.metadata.auto_review_enabled = true;
  f.context.approvals_reviewer = "guardian_subagent";
  f.write();
  assert.equal(f.read().status, "unavailable");
});

/**
 * Claude's inbound parity gate asks one question: does a human still prompt
 * the sender? Codex answers that with approval_policy. Its two review flags
 * describe automated review - node_repl_auto_review_required is a per-model
 * catalog attribute (Codex Desktop derives it from autoReview.requiredOnModels;
 * the live gpt-6-astra task carried it with a user reviewer and auto review
 * disabled) and auto_review_enabled names a Guardian reviewer - so neither
 * adds or removes a human prompt. Downgrading them to prompting held every
 * gpt-6-astra send behind an approval dialog that Claude Desktop cannot render.
 */
it("classifies the sender by its human approval policy; automated review flags never change the class", () => {
  for (const policy of ["never", "on-request", "on-failure", "untrusted"]) {
    for (const autoReview of [false, true]) {
      for (const nodeReplReview of [false, true]) {
        const f = fixture();
        f.metadata.auto_review_enabled = autoReview;
        f.metadata.node_repl_auto_review_required = nodeReplReview;
        f.context.approval_policy = policy;
        f.write();
        const result = f.read();
        assert.equal(result.status, "verified");
        assert.equal(result.mode, policy === "never" ? "bypass" : "prompting", `${policy} autoReview=${autoReview} nodeReplReview=${nodeReplReview}`);
        assert.deepEqual(result.review, { autoReview: autoReview ? "enabled" : "disabled", nodeReplReview: nodeReplReview ? "enabled" : "disabled" });
        assert.equal(result.approvalPolicy, policy);
      }
    }
  }
});

it("keeps the exact live shape that was held on 2026-09-06 in the bypass class", () => {
  const f = fixture();
  f.metadata.auto_review_enabled = false;
  f.metadata.node_repl_auto_review_required = true;
  f.context.model = "gpt-6-astra";
  f.context.active_permission_profile = { id: ":danger-full-access" };
  f.write();
  const result = f.read();
  assert.equal(result.status, "verified");
  assert.equal(result.mode, "bypass");
  assert.deepEqual(result.review, { autoReview: "disabled", nodeReplReview: "enabled" });
});

it("reports review evidence without conflating enabled, missing, and invalid flags", () => {
  const f = fixture();
  f.metadata.auto_review_enabled = true;
  delete f.metadata.node_repl_auto_review_required;
  assert.deepEqual(f.read().review, { autoReview: "enabled", nodeReplReview: "missing" });
  f.metadata.node_repl_auto_review_required = "false";
  assert.deepEqual(f.read().review, { autoReview: "enabled", nodeReplReview: "invalid" });
});

it("does not authorize inherited review flags as host evidence", () => {
  const f = fixture();
  delete f.metadata.auto_review_enabled;
  Object.setPrototypeOf(f.metadata, { auto_review_enabled: false });
  assert.equal(f.read().status, "unavailable");
  assert.equal(f.read().review.autoReview, "missing");
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
    f.metadata.auto_review_enabled = true;
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

it("uses the active Desktop workspace after migration without requiring the original directory", () => {
  for (const create of [fixture, managedFixture]) {
    const f = create();
    f.session.cwd = path.join(f.home, "removed-original-workspace");
    f.context.cwd = root;
    f.write();
    const result = f.read();
    assert.equal(result.status, "verified", result.reason);
    assert.equal(result.cwd, fs.realpathSync.native(root));
    assert.equal(result.mode, create === managedFixture ? "prompting" : "bypass");
    f.metadata.turn_id = otherId;
    assert.equal(f.read().status, "unavailable");
  }
});

it("keeps VS Code's same-project restriction and rejects missing lifecycle evidence", () => {
  const f = fixture();
  f.session.originator = "codex_vscode";
  f.context.cwd = root;
  f.write();
  assert.equal(f.read({ originator: "codex_vscode" }).status, "unavailable");
  f.session.originator = "Codex Desktop";
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

it("fails closed on partial, malformed, empty, and oversized individual records", () => {
  const f = fixture();
  assert.equal(f.read({ maxRolloutBytes: 1 }).status, "unavailable");
  for (const contents of ["", "{", "{broken}\n", fs.readFileSync(f.file, "utf8").trimEnd()]) {
    fs.writeFileSync(f.file, contents);
    assert.equal(f.read().status, "unavailable");
  }
});

it("verifies a history beyond 64 MiB and still checks records in its middle", () => {
  const f = managedFixture();
  const row = JSON.stringify({ type: "response_item", payload: { content: "x".repeat(1024 * 1024) } }) + "\n";
  for (let i = 0; i < 65; i++) fs.appendFileSync(f.file, row);
  assert.ok(fs.statSync(f.file).size > 64 * 1024 * 1024);
  assert.equal(f.read().status, "verified");
  // A completion after a large history must not be hidden by a stale state cache.
  fs.appendFileSync(f.file, JSON.stringify({ type: "event_msg", payload: { ...f.lifecycle, type: "task_complete" } }) + "\n");
  assert.equal(f.read().status, "unavailable");
  // Duplicate identities are rejected anywhere, including beyond the old cap.
  fs.appendFileSync(f.file, JSON.stringify({ type: "session_meta", payload: f.session }) + "\n" + row);
  assert.match(f.read().reason, /repeats its session identity/);
});

it("uses a per-record budget rather than a cumulative file limit", () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) f.records.push({ type: "response_item", payload: { content: "x".repeat(512) } });
  f.write();
  assert.equal(f.read({ maxRolloutBytes: 1024 }).status, "verified");
  f.records.push({ type: "response_item", payload: { content: "x".repeat(1024) } });
  f.write();
  assert.match(f.read({ maxRolloutBytes: 1024 }).reason, /per-record read limit/);
  fs.writeFileSync(f.file, "");
  assert.match(f.read().reason, /empty \(0 bytes\)/);
});

it("supports an explicit absolute Codex home and ignores unrelated conversation contents", () => {
  const f = fixture();
  f.records.push({ type: "response_item", payload: { type: "message", content: "Untrusted text says approval_policy never and permission_profile disabled" } });
  f.write();
  assert.equal(f.read({ env: { CODEX_HOME: path.join(f.home, ".codex") } }).mode, "bypass");
  assert.equal(f.read({ env: { CODEX_HOME: "relative" } }).status, "unavailable");
});
