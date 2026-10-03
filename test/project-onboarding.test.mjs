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
