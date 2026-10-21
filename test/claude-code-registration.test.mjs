import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkCodeRegistration, planCodeRegistration } from "../src/claude-code-registration.mjs";

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
