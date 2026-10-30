import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkCodeRegistration, planCodeRegistration, planInitialCodeRegistration } from "../src/claude-code-registration.mjs";

const entry = () => ({ command: process.execPath, args: [path.resolve("src/mcp-supervisor.mjs"), "index.mjs"], env: { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_ALLOWED_ROOTS: path.resolve("test"), CUSTOM: "preserve" } });
test("one user-level Code entry replaces ambiguous shared and duplicate project entries without touching other tools", () => {
  const code = { unrelated: 1, mcpServers: { "codex-bridge": entry(), other: { command: "keep" } }, projects: { test: { permissions: "keep", mcpServers: { "codex-bridge-code": entry(), other: { command: "keep" } } } } };
  const desktop = { preferences: { keep: true }, mcpServers: { "codex-bridge": entry(), other: { command: "keep" } } };
  const before = structuredClone({ code, desktop });
  const result = planCodeRegistration({ code, desktop, policyFile: path.resolve("policy.json") });
  assert.deepEqual({ code, desktop }, before, "planning is read-only");
  assert.equal(result.entry.env.CUSTOM, "preserve");
  assert.deepEqual(result.code.projects.test, { permissions: "keep", mcpServers: { other: { command: "keep" } } });
  assert.deepEqual(result.desktop, { preferences: { keep: true }, mcpServers: { other: { command: "keep" } } });
  assert.equal(checkCodeRegistration(result).ready, true);
  assert.deepEqual(planCodeRegistration({ ...result, policyFile: path.resolve("policy.json") }).code, result.code);
});
test("custom project permissions are refused rather than overwritten", () => {
  const code = { mcpServers: { "codex-bridge": entry() }, projects: { special: { mcpServers: { "codex-bridge-code": entry() } } } };
  code.projects.special.mcpServers["codex-bridge-code"].env.CODEX_BRIDGE_APPROVAL = "deny";
  assert.throws(() => planCodeRegistration({ code, desktop: {}, policyFile: path.resolve("policy.json") }), /customized/);
});
test("registration check identifies shared entries, duplicates and missing live policy", () => {
  const result = checkCodeRegistration({ code: { mcpServers: { "codex-bridge": entry() }, projects: { p: { mcpServers: { alias: entry() } } } }, desktop: { mcpServers: { "codex-bridge": entry() } } });
  assert.equal(result.ready, false);
  assert.equal(result.issues.length, 3);
});

const direct = () => ({ ...entry(), args: [path.resolve("src/index.mjs")] });
test("registration check finds an unsupervised shared Desktop bridge under any name", () => {
  const code = { mcpServers: { "codex-bridge": { ...entry(), env: { ...entry().env, CODEX_BRIDGE_PROJECT_POLICY: path.resolve("policy.json") } } } };
  const desktop = { mcpServers: { "codex-bridge-desktop": direct(), other: { command: process.execPath, args: [path.resolve("elsewhere/index.mjs")] } } };
  const result = checkCodeRegistration({ code, desktop });
  assert.equal(result.ready, false);
  assert.deepEqual(result.shared, ["codex-bridge-desktop"]);
  assert.ok(result.issues.some((issue) => /without the supervisor.*codex-bridge-desktop/.test(issue)));
  assert.deepEqual(checkCodeRegistration({ code: {}, desktop }).shared, ["codex-bridge-desktop"]);
});
test("migration removes an identical unsupervised shared entry and refuses a customized one", () => {
  const code = { mcpServers: { "codex-bridge": entry() } };
  const plan = planCodeRegistration({ code, desktop: { mcpServers: { "codex-bridge-desktop": direct() } }, policyFile: path.resolve("policy.json") });
  assert.deepEqual(plan.desktop.mcpServers, {});
  assert.deepEqual(plan.changes.at(-1), { kind: "remove-shared-desktop-entry", name: "codex-bridge-desktop" });
  const customized = direct(); customized.env.CODEX_BRIDGE_APPROVAL = "deny";
  assert.throws(() => planCodeRegistration({ code, desktop: { mcpServers: { "codex-bridge-desktop": customized } }, policyFile: path.resolve("policy.json") }), /codex-bridge-desktop has customized settings/);
});

test("migration refuses a shared entry whose direct arguments are customized", () => {
  const code = { mcpServers: { "codex-bridge": entry() } };
  const flagged = { ...direct(), args: [path.resolve("src/index.mjs"), "--some-flag"] };
  assert.throws(() => planCodeRegistration({ code, desktop: { mcpServers: { "codex-bridge-desktop": flagged } }, policyFile: path.resolve("policy.json") }), /codex-bridge-desktop has customized settings/);
  const project = { mcpServers: { "codex-bridge": entry() }, projects: { p: { mcpServers: { alias: { ...entry(), args: [path.resolve("src/index.mjs"), "--extra"] } } } } };
  assert.throws(() => planCodeRegistration({ code: project, desktop: {}, policyFile: path.resolve("policy.json") }), /Project p has a customized alias entry/);
});
test("migration refuses a bridge entry from another installation that the check would flag", () => {
  const other = path.join(path.resolve("."), "opt-other", "src");
  const code = { mcpServers: { "codex-bridge": { ...entry(), args: [path.join(other, "mcp-supervisor.mjs"), "index.mjs"] } } };
  const desktop = { mcpServers: { x: direct() } };
  assert.deepEqual(checkCodeRegistration({ code, desktop }).shared, ["x"]);
  assert.throws(() => planCodeRegistration({ code, desktop, policyFile: path.resolve("policy.json") }), /Shared Desktop entry x runs another bridge installation from .*src; update or remove it before migration/);
  const projects = { ...code, projects: { p: { mcpServers: { alias: entry() } } } };
  assert.deepEqual(checkCodeRegistration({ code: projects, desktop: {} }).overrides, [{ project: "p", alias: "alias" }]);
  assert.throws(() => planCodeRegistration({ code: projects, desktop: {}, policyFile: path.resolve("policy.json") }), /Project p entry alias runs another bridge installation/);
});

test("installer previews without writes, requires stopped clients, backs up exact input and verifies applied registration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-code-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codeFile = path.join(root, "code.json"), desktopFile = path.join(root, "desktop.json"), policyFile = path.join(root, "projects.json");
  const original = JSON.stringify({ mcpServers: { "codex-bridge": entry() } });
  fs.writeFileSync(codeFile, original);
  fs.writeFileSync(desktopFile, original);
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, grants: [], denies: [] }));
  const base = [path.resolve("scripts/install-claude-code.mjs"), "--code-config", codeFile, "--desktop-config", desktopFile, "--policy", policyFile];
  const run = (...args) => spawnSync(process.execPath, [...base, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(codeFile, "utf8"), original);
  assert.equal(run("--apply").status, 1);
  assert.equal(fs.readFileSync(codeFile, "utf8"), original);
  const applied = run("--apply", "--clients-stopped");
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(fs.readFileSync(codeFile)).mcpServers["codex-bridge"].env.CODEX_BRIDGE_PROJECT_POLICY, policyFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(desktopFile)).mcpServers, {});
  for (const name of fs.readdirSync(root).filter((name) => name.includes(".backup-"))) assert.equal(fs.readFileSync(path.join(root, name), "utf8"), original);
  assert.equal(run("--check").status, 0);
  fs.writeFileSync(policyFile, "broken");
  assert.equal(run("--check").status, 1);
});

test("installer rejects hard-linked configuration without changing either name", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-code-linked-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source.json"), codeFile = path.join(root, "code.json");
  const original = JSON.stringify({ mcpServers: { "codex-bridge": entry() } });
  fs.writeFileSync(source, original);
  fs.linkSync(source, codeFile);
  const result = spawnSync(process.execPath, [path.resolve("scripts/install-claude-code.mjs"), "--code-config", codeFile,
    "--desktop-config", path.join(root, "desktop.json"), "--check"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /linked|regular/i);
  assert.equal(fs.readFileSync(source, "utf8"), original);
  assert.equal(fs.readFileSync(codeFile, "utf8"), original);
});

test("installer rejects oversized configuration before JSON parsing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-code-large-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codeFile = path.join(root, "code.json");
  fs.writeFileSync(codeFile, JSON.stringify({ padding: "x".repeat(8 * 1024 * 1024) }));
  const result = spawnSync(process.execPath, [path.resolve("scripts/install-claude-code.mjs"), "--code-config", codeFile,
    "--desktop-config", path.join(root, "desktop.json"), "--check"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /size|limit|oversized/i);
});

const initialPlan = (options = {}) => planInitialCodeRegistration({ code: {}, desktop: {}, root: path.resolve("."), node: process.execPath,
  environment: { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_THREAD_POLICY: "roots", CODEX_BRIDGE_ALLOWED_ROOTS: path.resolve("test") }, ...options });

test("first-install plan creates the supervised Code bridge without copying permissions or unrelated environment", () => {
  const code = { preferences: { keep: true }, mcpServers: { other: { command: "keep" } } };
  const before = structuredClone(code);
  const plan = initialPlan({ code, environment: { CODEX_BIN: path.resolve("codex.exe"), CODEX_BRIDGE_DESKTOP_TASKS: "1",
    CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_ENFORCE_FULL_ACCESS: "1", CODEX_BRIDGE_APPROVAL_POLICY: "never",
    CODEX_BRIDGE_SANDBOX: "danger-full-access", ANTHROPIC_API_KEY: "private", PATH: "private" } });
  assert.deepEqual(code, before);
  assert.deepEqual(plan.entry.args, [path.resolve("src/mcp-supervisor.mjs"), "index.mjs"]);
  assert.equal(plan.entry.command, process.execPath);
  assert.equal(plan.entry.type, "stdio");
  assert.deepEqual(plan.entry.env, { CODEX_BIN: path.resolve("codex.exe"), CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0" });
  assert.deepEqual(plan.code.mcpServers.other, before.mcpServers.other);
  assert.deepEqual(plan.code.preferences, before.preferences);
  assert.deepEqual(plan.desktop, {});
  assert.deepEqual(initialPlan({ code: plan.code, desktop: plan.desktop, environment: plan.entry.env }).changes, []);
});

test("first-install update preserves custom environment, permission fields, routing opt-out and the original scope authority", () => {
  const prior = { ...entry(), disabled: true, permissions: { allow: [] }, env: { CUSTOM: "private", CODEX_BRIDGE_DESKTOP_TASKS: "0",
    CODEX_BRIDGE_AUTOSTART: "1", CODEX_BRIDGE_ALLOWED_ROOTS: "narrow", CODEX_BRIDGE_SANDBOX: "read-only", CODEX_BRIDGE_APPROVAL: "deny" } };
  const plan = initialPlan({ code: { mcpServers: { "codex-bridge": prior } }, environment: {
    CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_THREAD_POLICY: "all",
    CODEX_BRIDGE_PROJECT_POLICY: path.resolve("broader-policy.json"), CODEX_BIN: path.resolve("codex.exe") } });
  assert.deepEqual(plan.entry.env, { CODEX_BRIDGE_DESKTOP_TASKS: "0", CODEX_BRIDGE_AUTOSTART: "1", CODEX_BIN: path.resolve("codex.exe"),
    ...prior.env });
  assert.equal(plan.entry.disabled, true);
  assert.deepEqual(plan.entry.permissions, prior.permissions);
  assert.equal(plan.entry.env.CODEX_BRIDGE_PROJECT_POLICY, undefined);
  assert.equal(plan.entry.env.CODEX_BRIDGE_THREAD_POLICY, undefined);
});

test("first-install update retargets known package installations and refuses an unrelated or customized command", () => {
  const old = { ...entry(), args: [path.resolve("old/codex-mcp-bridge/src/index.mjs")] };
  assert.deepEqual(initialPlan({ code: { mcpServers: { "codex-bridge": old } } }).entry.args, [path.resolve("src/mcp-supervisor.mjs"), "index.mjs"]);
  for (const conflicting of [
    { command: "custom", args: [] },
    { ...entry(), args: [path.resolve("unrelated/src/index.mjs")] },
    { ...entry(), args: [path.resolve("src/index.mjs"), "--custom"] },
    { type: "http", url: "https://example.invalid/mcp" },
  ]) assert.throws(() => initialPlan({ code: { mcpServers: { "codex-bridge": conflicting } } }), /conflicting|unrecognized|customized/);
});

test("first-install plan renames the shadowing shared bridge intact and preserves project overrides with notices", () => {
  const shared = { ...direct(), env: { ...direct().env, CUSTOM: "shared-secret", CODEX_BRIDGE_DESKTOP_TASKS: "0" } };
  const code = { projects: { project: { trust: "keep", mcpServers: { "codex-bridge": entry() } } } };
  const desktop = { mcpServers: { "codex-bridge": shared, other: { command: "keep" } }, preferences: { keep: true } };
  const before = structuredClone({ code, desktop });
  const plan = initialPlan({ code, desktop });
  assert.deepEqual({ code, desktop }, before);
  assert.equal(plan.desktop.mcpServers["codex-bridge"], undefined);
  assert.deepEqual(plan.desktop.mcpServers["codex-bridge-desktop"], shared);
  assert.deepEqual(plan.desktop.mcpServers.other, desktop.mcpServers.other);
  assert.deepEqual(plan.code.projects, code.projects);
  assert.equal(plan.notices.length, 1);
  assert.match(plan.notices[0], /Project project.*override/);
  assert.throws(() => initialPlan({ desktop: { mcpServers: { "codex-bridge": shared, "codex-bridge-desktop": entry() } } }), /already exists/);
});

test("first-install plan rejects malformed configuration instead of replacing it", () => {
  for (const code of [null, [], { mcpServers: [] }, { projects: [] }]) assert.throws(() => initialPlan({ code }), /JSON object/);
  assert.throws(() => initialPlan({ desktop: { mcpServers: [] } }), /JSON object/);
  assert.throws(() => initialPlan({ code: { mcpServers: { "codex-bridge": { ...entry(), env: [] } } } }), /JSON object/);
  assert.throws(() => initialPlan({ environment: { CODEX_BRIDGE_DESKTOP_TASKS: true } }), /must be strings/);
});

function initialSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-code-first-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codeFile = path.join(root, "code", ".claude.json");
  const desktopFile = path.join(root, "desktop", "claude_desktop_config.json");
  const env = { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: path.dirname(codeFile),
    CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_THREAD_POLICY: "roots", CODEX_BRIDGE_ALLOWED_ROOTS: root };
  const base = [path.resolve("scripts/install-claude-code.mjs"), "--install", "--desktop-config", desktopFile];
  return { root, codeFile, desktopFile, env, run: (...args) => spawnSync(process.execPath, [...base, ...args], { env, encoding: "utf8", windowsHide: true }) };
}

test("--install creates missing Code config, honors CLAUDE_CONFIG_DIR and leaves a missing shared config absent", (t) => {
  const fixture = initialSandbox(t);
  const preview = fixture.run("--dry-run");
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).configured, false);
  assert.equal(fs.existsSync(fixture.codeFile), false);
  assert.equal(fs.existsSync(fixture.desktopFile), false);
  const installed = fixture.run();
  assert.equal(installed.status, 0, installed.stderr);
  const result = JSON.parse(installed.stdout);
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  assert.equal(result.writtenFiles, 1);
  assert.equal(result.restartRequired, true);
  const config = JSON.parse(fs.readFileSync(fixture.codeFile, "utf8"));
  assert.equal(config.mcpServers["codex-bridge"].env.CODEX_BRIDGE_ALLOWED_ROOTS, fixture.root);
  assert.equal(fs.existsSync(fixture.desktopFile), false);
  assert.equal(fs.existsSync(path.join(fixture.root, ".claude.json")), false);
  const before = fs.statSync(fixture.codeFile, { bigint: true });
  const repeated = fixture.run();
  assert.equal(repeated.status, 0, repeated.stderr);
  const next = JSON.parse(repeated.stdout);
  assert.equal(next.writtenFiles, 0);
  assert.equal(next.restartRequired, false);
  assert.deepEqual(next.changes, []);
  assert.equal(fs.statSync(fixture.codeFile, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.deepEqual(fs.readdirSync(path.dirname(fixture.codeFile)), [".claude.json"]);
});

test("--install backs up exact input before fixing shared-name shadowing and does not print environment values", (t) => {
  const fixture = initialSandbox(t);
  fs.mkdirSync(path.dirname(fixture.codeFile), { recursive: true });
  fs.mkdirSync(path.dirname(fixture.desktopFile), { recursive: true });
  const originalCode = JSON.stringify({ mcpServers: { "codex-bridge": { ...entry(), env: { ...entry().env, CUSTOM: "do-not-print-this" } } } });
  const originalDesktop = JSON.stringify({ mcpServers: { "codex-bridge": direct() } });
  fs.writeFileSync(fixture.codeFile, originalCode);
  fs.writeFileSync(fixture.desktopFile, originalDesktop);
  const installed = fixture.run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(installed.stdout.includes("do-not-print-this"), false);
  assert.equal(JSON.parse(installed.stdout).writtenFiles, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.desktopFile, "utf8")).mcpServers["codex-bridge-desktop"], direct());
  const backupFor = (file) => path.join(path.dirname(file), fs.readdirSync(path.dirname(file)).find((name) => name.includes(".backup-")));
  assert.equal(fs.readFileSync(backupFor(fixture.codeFile), "utf8"), originalCode);
  assert.equal(fs.readFileSync(backupFor(fixture.desktopFile), "utf8"), originalDesktop);
});

test("--install leaves both files untouched when a shared rename collision or malformed JSON is found", (t) => {
  const fixture = initialSandbox(t);
  fs.mkdirSync(path.dirname(fixture.codeFile), { recursive: true });
  fs.mkdirSync(path.dirname(fixture.desktopFile), { recursive: true });
  const code = JSON.stringify({ mcpServers: { "codex-bridge": entry() } });
  const desktop = JSON.stringify({ mcpServers: { "codex-bridge": direct(), "codex-bridge-desktop": entry() } });
  fs.writeFileSync(fixture.codeFile, code);
  fs.writeFileSync(fixture.desktopFile, desktop);
  assert.equal(fixture.run().status, 1);
  assert.equal(fs.readFileSync(fixture.codeFile, "utf8"), code);
  assert.equal(fs.readFileSync(fixture.desktopFile, "utf8"), desktop);
  assert.equal(fs.readdirSync(path.dirname(fixture.codeFile)).length, 1);
  fs.writeFileSync(fixture.desktopFile, "not json");
  assert.equal(fixture.run().status, 1);
  assert.equal(fs.readFileSync(fixture.codeFile, "utf8"), code);
  assert.equal(fs.readFileSync(fixture.desktopFile, "utf8"), "not json");
});

test("--install refuses a hard-linked config before modifying any settings", (t) => {
  const fixture = initialSandbox(t);
  fs.mkdirSync(path.dirname(fixture.codeFile), { recursive: true });
  const original = JSON.stringify({ preferences: { keep: true } });
  const alias = path.join(fixture.root, "alias.json");
  fs.writeFileSync(alias, original);
  fs.linkSync(alias, fixture.codeFile);
  const result = fixture.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /linked|regular/);
  assert.equal(fs.readFileSync(alias, "utf8"), original);
  assert.equal(fs.existsSync(fixture.desktopFile), false);
});
