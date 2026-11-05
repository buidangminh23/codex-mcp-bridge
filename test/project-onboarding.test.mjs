import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inspectBridgeProject, prepareBridgeProject, onboardingPaths } from "../src/project-onboarding.mjs";
import { registerProjectOnboardingTools } from "../src/project-onboarding-tools.mjs";
import { createProjectScope, editProjectGrant, updateProjectPolicy } from "../src/project-policy.mjs";
import { createHardenedRootPolicy, rootPolicyAccessScope } from "../src/hardened-root-policy.mjs";

const root = path.resolve(import.meta.dirname, "..");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-onboarding-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, "项目 with spaces"); fs.mkdirSync(cwd);
  const file = path.join(home, "policy.json");
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: "", CODEX_BRIDGE_HARDENED: "0", CODEX_BRIDGE_PROJECT_POLICY: file };
  const config = path.join(home, ".claude.json");
  return { home, cwd, file, config, env, options: { env } };
}
function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" }); }
function makeRepo(f) {
  git(f.cwd, "init", "-b", "main");
  git(f.cwd, "-c", "user.name=Bridge test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "test");
  const wt = path.join(f.home, "separate worktree");
  git(f.cwd, "worktree", "add", "--detach", wt);
  return wt;
}
const key = directory => fs.realpathSync.native(directory).split(path.sep).join("/");

test("inspection is read-only; onboarding preserves unrelated config and never claims a live connection", t => {
  const f = fixture(t);
  const original = { mcpServers: { custom: { command: "keep" } }, projects: { "/other": { hasTrustDialogAccepted: false, history: [1] } }, theme: "dark" };
  fs.writeFileSync(f.config, JSON.stringify(original));
  assert.equal(inspectBridgeProject({ cwd: f.cwd }, f.options).status, "needs_setup");
  assert.equal(fs.existsSync(f.file), false);
  const result = prepareBridgeProject({ cwd: f.cwd, taskCards: true }, f.options);
  assert.equal(result.status, "configured");
  assert.equal(result.connection.ready, null);
  assert.equal(result.taskCards.status, "requires_extension_check");
  const actual = JSON.parse(fs.readFileSync(f.config));
  assert.equal(actual.projects[key(f.cwd)].hasTrustDialogAccepted, true);
  delete actual.projects[key(f.cwd)]; assert.deepEqual(actual, original);
  assert.equal(result.backups.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.backups[0])), original);
  assert.equal(createProjectScope(f.file).allows(f.cwd), true);
  const configRaw = fs.readFileSync(f.config, "utf8"), policyRaw = fs.readFileSync(f.file, "utf8");
  const again = prepareBridgeProject({ cwd: f.cwd }, f.options);
  assert.equal(again.idempotent, true); assert.deepEqual(again.changedFiles, []);
  assert.equal(fs.readFileSync(f.config, "utf8"), configRaw);
  assert.equal(fs.readFileSync(f.file, "utf8"), policyRaw);
});

test("worktree onboarding trusts the primary repository and authorizes registered sibling checkouts", t => {
  const f = fixture(t), wt = makeRepo(f);
  const result = prepareBridgeProject({ cwd: wt }, f.options);
  assert.equal(result.project.root, fs.realpathSync.native(f.cwd));
  const config = JSON.parse(fs.readFileSync(f.config));
  assert.equal(config.projects[key(f.cwd)].hasTrustDialogAccepted, true);
  assert.equal(config.projects[key(wt)], undefined);
  const scope = createProjectScope(f.file);
  assert.equal(scope.allows(wt), true); assert.equal(scope.allows(f.cwd), true);
  assert.equal(inspectBridgeProject({ cwd: f.cwd }, f.options).status, "configured");
});

test("an existing parent grant is reused without replacing policy or granting all projects", t => {
  const f = fixture(t);
  updateProjectPolicy(f.file, p => editProjectGrant(p, "allow-parent", f.home));
  const before = fs.readFileSync(f.file, "utf8");
  const result = prepareBridgeProject({ cwd: f.cwd }, f.options);
  assert.deepEqual(result.changedFiles, [f.config]);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("revocation blocks all writes unless this exact project is explicitly reauthorized", t => {
  const f = fixture(t);
  updateProjectPolicy(f.file, p => editProjectGrant(p, "revoke", f.cwd));
  const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, f.options), /revoked/);
  assert.equal(fs.existsSync(f.config), false);
  assert.equal(fs.readFileSync(f.file, "utf8"), before);
  assert.equal(prepareBridgeProject({ cwd: f.cwd, reauthorize: true }, f.options).status, "configured");
});

test("explicit project reauthorization cannot erase an enclosing directory denial", t => {
  const f = fixture(t);
  updateProjectPolicy(f.file, p => editProjectGrant(p, "revoke", f.home));
  const before = fs.readFileSync(f.file, "utf8");
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd, reauthorize: true }, f.options), /enclosing/);
  assert.equal(fs.existsSync(f.config), false); assert.equal(fs.readFileSync(f.file, "utf8"), before);
});

test("concurrent external settings changes are preserved, not overwritten", t => {
  const f = fixture(t);
  fs.writeFileSync(f.config, '{}');
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, { ...f.options, beforeCommit() { fs.writeFileSync(f.config, '{"external":true}'); } }), /concurrently/);
  assert.equal(fs.readFileSync(f.config, "utf8"), '{"external":true}');
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(fs.existsSync(f.file + '.lock'), false);
});

test("failure between trust and grant writes restores original config", t => {
  const f = fixture(t); fs.writeFileSync(f.config, '{"other":1}');
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, { ...f.options, afterWrite() { throw Error('simulated write failure'); } }), /simulated/);
  assert.equal(fs.readFileSync(f.config, "utf8"), '{"other":1}');
  assert.equal(fs.existsSync(f.file), false);
});

test("rollback never erases a concurrent external change and reports partial state", t => {
  const f = fixture(t); fs.writeFileSync(f.config, '{}');
  try {
    prepareBridgeProject({ cwd: f.cwd }, { ...f.options, afterWrite() { fs.writeFileSync(f.config, '{"external":2}'); throw Error('abort'); } });
    assert.fail('expected failure');
  } catch (e) {
    assert.equal(e.onboarding.status, "partial_needs_review");
    assert.deepEqual(e.onboarding.remainingFiles, [f.config]);
    assert.equal(fs.readFileSync(f.config, "utf8"), '{"external":2}');
  }
});

test("malformed and linked config files fail without modifying the project policy", t => {
  const f = fixture(t); fs.writeFileSync(f.config, '{broken');
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, f.options));
  assert.equal(fs.existsSync(f.file), false);
  fs.unlinkSync(f.config);
  const other = path.join(f.home, 'other.json'); fs.writeFileSync(other, '{}'); fs.linkSync(other, f.config);
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, f.options), /linked/);
  assert.equal(fs.readFileSync(other, 'utf8'), '{}');
});

test("stale locks are not stolen and a missing shared policy configuration is not guessed", t => {
  const f = fixture(t); fs.writeFileSync(f.file + '.lock', 'owner');
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, f.options), /EEXIST/);
  assert.equal(fs.readFileSync(f.file + '.lock', 'utf8'), 'owner');
  assert.equal(fs.existsSync(f.config), false);
  assert.throws(() => onboardingPaths({ HOME: f.home }), /CODEX_BRIDGE_PROJECT_POLICY/);
  assert.throws(() => onboardingPaths({ ...f.env, CODEX_BRIDGE_HARDENED: '1' }), /hardened/);
});

test("unsafe roots and unverified Git repositories are rejected", t => {
  const f = fixture(t);
  assert.throws(() => prepareBridgeProject({ cwd: f.home }, f.options), /user home/);
  assert.throws(() => prepareBridgeProject({ cwd: 'relative' }, f.options), /absolute/);
  assert.throws(() => prepareBridgeProject({ cwd: path.parse(f.home).root }, f.options), /drive root/);
  fs.writeFileSync(path.join(f.cwd, '.git'), 'gitdir: unavailable');
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, f.options), /repository identity/);
  assert.equal(fs.existsSync(f.config), false);
});

test("project directory replacement during setup is rejected before trust is stored", t => {
  const f = fixture(t);
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, { ...f.options, beforeCommit() { fs.renameSync(f.cwd, f.cwd + '-old'); fs.mkdirSync(f.cwd); } }), /changed during/);
  assert.equal(fs.existsSync(f.config), false); assert.equal(fs.existsSync(f.file), false);
});

test("home aliases cannot bypass the whole-home onboarding restriction", t => {
  const f = fixture(t);
  const alias = f.home + '-alias';
  fs.symlinkSync(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.unlinkSync(alias));
  assert.throws(() => prepareBridgeProject({ cwd: alias }, f.options), /user home/);
  assert.throws(() => prepareBridgeProject({ cwd: f.home }, { env: { ...f.env, HOME: alias, USERPROFILE: alias } }), /user home/);
  assert.equal(fs.existsSync(f.config), false);
  assert.equal(fs.existsSync(f.file), false);
});

test("custom Claude config directory is supported without touching default config", t => {
  const f = fixture(t); const custom = path.join(f.home, 'custom'); fs.mkdirSync(custom);
  const result = prepareBridgeProject({ cwd: f.cwd }, { env: { ...f.env, CLAUDE_CONFIG_DIR: custom } });
  assert.equal(result.workspaceTrust.file, path.join(custom, '.claude.json'));
  assert.equal(fs.existsSync(f.config), false);
});

test("inspection reports a missing or unreadable project policy instead of failing", t => {
  const f = fixture(t);
  const env = { ...f.env }; delete env.CODEX_BRIDGE_PROJECT_POLICY;
  const missing = inspectBridgeProject({ cwd: f.cwd }, { env });
  assert.equal(missing.status, "needs_setup");
  assert.equal(missing.communicationAuthorization.status, "policy_not_configured");
  assert.equal(missing.communicationAuthorization.file, null);
  assert.equal(missing.workspaceTrust.file, f.config);
  assert.equal(missing.nextActions.some(action => action.tool === "prepare_bridge_project"), false);
  const setup = missing.nextActions.find(action => action.setting === "CODEX_BRIDGE_PROJECT_POLICY");
  assert.equal(setup.suggestedFile, path.join(f.home, ".config", "GptClaudeBridge", "projects.json"));
  assert.match(setup.then, /bridge-projects prepare/);
  assert.match(setup.then, /codex-bridge-code-install --policy/);
  const codexSetup = inspectBridgeProject({ cwd: f.cwd }, { env, policyRegistration: "codex" }).nextActions.find(action => action.setting === "CODEX_BRIDGE_PROJECT_POLICY");
  assert.match(codexSetup.then, /claude-mcp-bridge-install with CODEX_BRIDGE_PROJECT_POLICY=/);
  assert.throws(() => inspectBridgeProject({ cwd: f.cwd }, { env, policyRegistration: "other" }), /Unknown project policy registration/);
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, { env }), /^Error: Configure the shared CODEX_BRIDGE_PROJECT_POLICY before onboarding projects\.$/);
  fs.writeFileSync(f.file, "not json");
  const invalid = inspectBridgeProject({ cwd: f.cwd }, f.options);
  assert.equal(invalid.status, "needs_setup");
  assert.equal(invalid.communicationAuthorization.status, "policy_invalid");
  assert.equal(invalid.communicationAuthorization.file, f.file);
  assert.equal(invalid.nextActions.some(action => action.tool === "prepare_bridge_project"), false);
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, f.options));
  assert.equal(fs.readFileSync(f.file, "utf8"), "not json");
  assert.equal(fs.existsSync(f.config), false);
});

test("MCP inspection returns an error result instead of throwing on invalid input", async t => {
  const f = fixture(t), handlers = new Map();
  registerProjectOnboardingTools((name, definition, handler) => handlers.set(name, handler), { options: f.options, beforePrepare() {} });
  const result = await handlers.get('inspect_bridge_project')({ cwd: path.join(f.home, 'absent') });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.onboarding.status, 'failed');
});

test("MCP setup requires caller verification before writes", async t => {
  const f = fixture(t), handlers = new Map();
  registerProjectOnboardingTools((name, definition, handler) => handlers.set(name, { definition, handler }), { options: f.options, beforePrepare() { throw Error('sender unverified'); } });
  await assert.rejects(handlers.get('prepare_bridge_project').handler({ cwd: f.cwd }), /sender unverified/);
  assert.equal(fs.existsSync(f.config), false);
  assert.equal(handlers.get('prepare_bridge_project').definition.annotations.readOnlyHint, false);
  assert.equal(handlers.get('inspect_bridge_project').definition.annotations.readOnlyHint, true);
});

for (const entry of ['index.mjs', 'claude-bridge.mjs']) test(`${entry} exposes real MCP inspection and rejects unverified legacy mutation`, async t => {
  const f = fixture(t);
  const client = new Client({ name: 'onboarding-transport-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', entry)], env: {
    PATH: process.env.PATH ?? '', HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: path.join(f.home, '.codex'),
    CODEX_BRIDGE_PROJECT_POLICY: f.file, CODEX_BRIDGE_DESKTOP_TASKS: '0', CODEX_BRIDGE_AUTOSTART: '0', CODEX_APP_SERVER_URL: 'ws://127.0.0.1:9',
  }, stderr: 'ignore' });
  try {
    await client.connect(transport);
    const inspected = await client.callTool({ name: 'inspect_bridge_project', arguments: { cwd: f.cwd } });
    assert.equal(inspected.isError, undefined);
    assert.equal(inspected.structuredContent.onboarding.status, 'needs_setup');
    const result = await client.callTool({ name: 'prepare_bridge_project', arguments: { cwd: f.cwd } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /verified Desktop caller/);
    assert.equal(fs.existsSync(f.config), false);
  } finally { await client.close(); }
});

for (const entry of ['index.mjs', 'claude-bridge.mjs']) test(`${entry} reports its effective authorization and an optional policy migration through MCP inspection`, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ projects: { [key(f.cwd)]: { hasTrustDialogAccepted: true } } }));
  const client = new Client({ name: 'onboarding-transport-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', entry)], env: {
    PATH: process.env.PATH ?? '', HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: path.join(f.home, '.codex'),
    CODEX_BRIDGE_ALLOWED_ROOTS: f.home, CODEX_BRIDGE_THREAD_POLICY: 'roots',
    CODEX_BRIDGE_DESKTOP_TASKS: '0', CODEX_BRIDGE_AUTOSTART: '0', CODEX_APP_SERVER_URL: 'ws://127.0.0.1:9',
  }, stderr: 'ignore' });
  try {
    await client.connect(transport);
    const inspected = await client.callTool({ name: 'inspect_bridge_project', arguments: { cwd: f.cwd } });
    assert.equal(inspected.isError, undefined);
    const onboarding = inspected.structuredContent.onboarding;
    assert.equal(onboarding.status, 'configured');
    assert.equal(onboarding.communicationAuthorization.status, 'authorized');
    assert.equal(onboarding.communicationAuthorization.mode, entry === 'index.mjs' ? 'allowed-roots' : 'no-root-restriction');
    assert.equal(onboarding.projectPolicy.status, 'not_configured');
    assert.equal(onboarding.projectPolicy.requiredForNativeDelivery, false);
    assert.equal(onboarding.nextActions.some(action => action.setting === 'CODEX_BRIDGE_PROJECT_POLICY'), false);
    const setup = onboarding.projectPolicy.optionalMigration;
    if (entry === 'index.mjs') {
      assert.match(setup.then, /codex-bridge-code-install --policy "/);
      assert.doesNotMatch(setup.then, /claude-mcp-bridge-install/);
    } else {
      assert.match(setup.then, /claude-mcp-bridge-install with CODEX_BRIDGE_PROJECT_POLICY="[^"]+" set, then restart Codex Desktop/);
      assert.doesNotMatch(setup.then, /codex-bridge-code-install/);
    }
  } finally { await client.close(); }
});

const trusted = f => fs.writeFileSync(f.config, JSON.stringify({ projects: { [key(f.cwd)]: { hasTrustDialogAccepted: true } } }));
const noPolicy = f => { const env = { ...f.env }; delete env.CODEX_BRIDGE_PROJECT_POLICY; return env; };

test("an active allowed-roots authorization is not reported as missing setup", t => {
  const f = fixture(t); trusted(f);
  const result = inspectBridgeProject({ cwd: f.cwd }, { env: noPolicy(f), evaluateAuthorization: () => ({ mode: "allowed-roots", authorized: true, threadPolicy: "roots", existingTasks: "in-scope" }) });
  assert.equal(result.status, "configured");
  assert.deepEqual([result.communicationAuthorization.mode, result.communicationAuthorization.status, result.communicationAuthorization.threadPolicy, result.communicationAuthorization.existingTasks], ["allowed-roots", "authorized", "roots", "in-scope"]);
  assert.doesNotMatch(result.communicationAuthorization.detail, /Existing tasks/);
  assert.match(result.liveChecks.creationTarget.detail, /Sending to an existing task does not need this match/);
  assert.equal(result.projectPolicy.status, "not_configured");
  assert.equal(result.projectPolicy.requiredForNativeDelivery, false);
  assert.match(result.projectPolicy.optionalMigration.detail, /Optional configuration migration/);
  assert.equal(result.nextActions.some(action => action.setting || action.tool === "prepare_bridge_project"), false);
  assert.equal(result.connection.status, "not_tested");
  assert.equal(result.liveChecks.senderDestination.status, "not_checked");
  assert.match(result.liveChecks.senderDestination.detail, /does not replace/);
  assert.equal(result.liveChecks.creationTarget.status, "not_checked");
  assert.match(result.liveChecks.creationTarget.detail, /exactly one saved local project/);
});

test("a directory outside allowed roots needs an owner decision and no policy prerequisite", t => {
  const f = fixture(t); trusted(f);
  const result = inspectBridgeProject({ cwd: f.cwd }, { env: noPolicy(f), evaluateAuthorization: () => ({ mode: "allowed-roots", authorized: false }) });
  assert.equal(result.status, "needs_setup");
  assert.equal(result.communicationAuthorization.status, "outside_allowed_roots");
  const [action] = result.nextActions;
  assert.equal(action.setting, "CODEX_BRIDGE_ALLOWED_ROOTS");
  assert.equal(action.ownerDecision, true);
  assert.match(action.then, /Never widen scope/);
  assert.equal(result.nextActions.some(next => next.setting === "CODEX_BRIDGE_PROJECT_POLICY"), false);
  assert.equal(result.projectPolicy.optionalMigration, undefined);
});

test("owned thread policy says existing tasks are not reachable through the root", t => {
  const f = fixture(t); trusted(f);
  const result = inspectBridgeProject({ cwd: f.cwd }, { env: noPolicy(f), evaluateAuthorization: () => ({ mode: "allowed-roots", authorized: true, threadPolicy: "owned", existingTasks: "owned-or-allowlisted" }) });
  assert.equal(result.communicationAuthorization.existingTasks, "owned-or-allowlisted");
  assert.match(result.communicationAuthorization.detail, /CODEX_BRIDGE_THREAD_POLICY=roots or an allowlisted thread ID/);
});

test("the policy-file CLI path does not claim to know the running bridge's mode", t => {
  const f = fixture(t); trusted(f);
  const result = inspectBridgeProject({ cwd: f.cwd }, f.options);
  assert.equal(result.communicationAuthorization.mode, "not_evaluated");
  assert.match(result.communicationAuthorization.detail, /reads only the policy file/);
  assert.equal(result.projectPolicy.status, "file_missing");
  assert.equal(result.projectPolicy.requiredForNativeDelivery, null);
});

test("missing workspace trust stays a setup step when roots authorize the project", t => {
  const f = fixture(t);
  const result = inspectBridgeProject({ cwd: f.cwd }, { env: noPolicy(f), evaluateAuthorization: () => ({ mode: "allowed-roots", authorized: true }) });
  assert.equal(result.status, "needs_setup");
  assert.equal(result.communicationAuthorization.status, "authorized");
  assert.equal(result.nextActions[0].setting, "workspaceTrust");
  assert.equal(result.nextActions.some(next => next.setting === "CODEX_BRIDGE_PROJECT_POLICY"), false);
});

test("a configured project policy stays authoritative over any root evaluation", t => {
  const f = fixture(t); trusted(f);
  const options = { ...f.options, evaluateAuthorization: () => ({ mode: "project-policy", authorized: false }) };
  const missing = inspectBridgeProject({ cwd: f.cwd }, options);
  assert.equal(missing.status, "needs_setup");
  assert.deepEqual([missing.communicationAuthorization.mode, missing.communicationAuthorization.status], ["project-policy", "missing"]);
  assert.equal(missing.projectPolicy.requiredForNativeDelivery, true);
  assert.equal(missing.projectPolicy.optionalMigration, undefined);
  assert.equal(missing.nextActions[0].tool, "prepare_bridge_project");
  updateProjectPolicy(f.file, p => editProjectGrant(p, "revoke", f.cwd));
  assert.equal(inspectBridgeProject({ cwd: f.cwd }, options).communicationAuthorization.status, "revoked");
  fs.writeFileSync(f.file, "not json");
  const invalid = inspectBridgeProject({ cwd: f.cwd }, options);
  assert.deepEqual([invalid.status, invalid.communicationAuthorization.status, invalid.projectPolicy.status], ["needs_setup", "policy_invalid", "invalid"]);
});

test("a hardened deployment can be inspected but never prepared or migrated", t => {
  const f = fixture(t); trusted(f);
  const env = { ...noPolicy(f), CODEX_BRIDGE_HARDENED: "1" };
  const options = { env, evaluateAuthorization: () => ({ mode: "pinned-roots", authorized: true }) };
  const result = inspectBridgeProject({ cwd: f.cwd }, options);
  assert.equal(result.status, "configured");
  assert.equal(result.communicationAuthorization.mode, "pinned-roots");
  assert.equal(result.projectPolicy.optionalMigration, undefined);
  assert.match(result.liveChecks.creationTarget.detail, /every native operation on an existing task needs the same match/);
  assert.doesNotMatch(result.liveChecks.creationTarget.detail, /does not need this match/);
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, options), /hardened/);
  assert.throws(() => inspectBridgeProject({ cwd: f.cwd }, { env }), /hardened/);
});

test("hardened inspection discloses nothing about a directory outside its pinned roots", t => {
  const f = fixture(t), pinnedRoot = path.join(f.home, "pinned"), outside = makeRepo(f);
  fs.mkdirSync(pinnedRoot);
  const env = { ...noPolicy(f), CODEX_BRIDGE_HARDENED: "1", CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_THREAD_POLICY: "roots", CODEX_BRIDGE_REMAP: "0", CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_ALLOWED_ROOTS: pinnedRoot };
  delete env.CODEX_BRIDGE_PATH_MAP; delete env.CODEX_BRIDGE_ALLOWED_THREADS;
  const policy = createHardenedRootPolicy(env);
  const result = inspectBridgeProject({ cwd: outside }, { env, evaluateAuthorization: cwd => rootPolicyAccessScope(policy, cwd) });
  assert.deepEqual([result.status, result.communicationAuthorization.mode, result.communicationAuthorization.status], ["needs_setup", "pinned-roots", "outside_allowed_roots"]);
  assert.equal(result.project, undefined);
  assert.equal(result.workspaceTrust, undefined);
  assert.equal(JSON.stringify(result).includes(path.basename(outside)), false);
  assert.equal(inspectBridgeProject({ cwd: pinnedRoot }, { env, evaluateAuthorization: cwd => rootPolicyAccessScope(policy, cwd) }).communicationAuthorization.status, "authorized");
});

test("preparing still requires a project policy under roots authorization", t => {
  const f = fixture(t);
  assert.throws(() => prepareBridgeProject({ cwd: f.cwd }, { env: noPolicy(f), evaluateAuthorization: () => ({ mode: "allowed-roots", authorized: true }) }), /Configure the shared CODEX_BRIDGE_PROJECT_POLICY/);
  assert.equal(fs.existsSync(f.config), false);
});
