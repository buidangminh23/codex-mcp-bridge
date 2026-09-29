import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { MESSAGE_TOOLS, planMessageAutomation, applyMessageAutomation } from "../src/message-automation.mjs";

function fixture(t, permissions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-messaging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, "claude"); fs.mkdirSync(claudeHome);
  const settingsFile = path.join(claudeHome, "settings.json");
  const settings = { model: "preserve", hooks: { PreToolUse: ["preserve"] }, permissions };
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const policyFile = path.join(root, "projects.json");
  fs.writeFileSync(policyFile, JSON.stringify({ version: 1, grants: [], denies: [] }));
  const codeFile = path.join(root, "code.json");
  fs.writeFileSync(codeFile, JSON.stringify({ mcpServers: { "codex-bridge": { args: [path.resolve("src/mcp-supervisor.mjs"), "index.mjs"], env: { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_PROJECT_POLICY: policyFile } } } }));
  return { root, claudeHome, codeFile, settingsFile, settings, policyFile };
}

test("opt-in adds only two exact message permissions, preserves controls and grants, and is idempotent", t => {
  const f = fixture(t, { allow: ["Read"], deny: ["Bash"], ask: ["Edit"], defaultMode: "auto" });
  const before = fs.readFileSync(f.settingsFile, "utf8");
  const policy = fs.readFileSync(f.policyFile, "utf8");
  const plan = planMessageAutomation(f);
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), before);
  assert.equal(applyMessageAutomation(plan).changed.length, 2);
  const settings = JSON.parse(fs.readFileSync(f.settingsFile));
  assert.deepEqual(settings, { ...f.settings, permissions: { ...f.settings.permissions, allow: ["Read", ...MESSAGE_TOOLS] } });
  assert.equal(fs.readFileSync(f.policyFile, "utf8"), policy);
  const backups = fs.readdirSync(f.claudeHome).filter(n => n.includes(".backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.claudeHome, backups[0]), "utf8"), before);
  assert.deepEqual(applyMessageAutomation(planMessageAutomation(f)).changed, []);
});

test("existing ask and deny rules are never removed or silently overridden", t => {
  for (const kind of ["ask", "deny"]) for (const rule of ["*", "mcp__*", "mcp__codex-bridge", "mcp__codex-bridge__*", MESSAGE_TOOLS[0], `${MESSAGE_TOOLS[0]}(threadId:x)`]) {
    const f = fixture(t, { [kind]: [rule] });
    const before = fs.readFileSync(f.settingsFile, "utf8");
    assert.throws(() => planMessageAutomation(f), /conflicts/);
    assert.equal(fs.readFileSync(f.settingsFile, "utf8"), before);
  }
});

test("an invalid or absent project policy and unknown bridge cannot enable automation", t => {
  const f = fixture(t);
  fs.writeFileSync(f.policyFile, "broken");
  assert.throws(() => planMessageAutomation(f));
  fs.writeFileSync(f.codeFile, "{}");
  assert.throws(() => planMessageAutomation(f), /supervised/);
});

test("concurrent changes roll back only this install, preserving the other writer", t => {
  const f = fixture(t); const plan = planMessageAutomation(f);
  const before = fs.readFileSync(f.settingsFile, "utf8");
  fs.mkdirSync(path.dirname(plan.files[1].file));
  fs.writeFileSync(plan.files[1].file, "another writer");
  assert.throws(() => applyMessageAutomation(plan), /concurrently/);
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), before);
  assert.equal(fs.readFileSync(plan.files[1].file, "utf8"), "another writer");
});

test("unmanaged collaboration guidance and linked settings are refused", t => {
  const f = fixture(t); const plan = planMessageAutomation(f);
  fs.mkdirSync(path.dirname(plan.files[1].file));
  fs.writeFileSync(plan.files[1].file, "user rules");
  assert.throws(() => planMessageAutomation(f), /unmanaged/);
  fs.linkSync(f.settingsFile, path.join(f.root, "linked-settings"));
  assert.throws(() => planMessageAutomation(f), /linked/);
});

test("CLI is a read-only plan by default and requires explicit opt-in before applying", t => {
  const f = fixture(t); const before = fs.readFileSync(f.settingsFile, "utf8");
  const run = (...args) => spawnSync(process.execPath, [path.resolve("scripts/configure-message-automation.mjs"), "--claude-home", f.claudeHome, "--code-config", f.codeFile, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(run().status, 0);
  assert.equal(run("--check").status, 1);
  assert.equal(run("--apply").status, 1);
  assert.equal(fs.readFileSync(f.settingsFile, "utf8"), before);
  const applied = run("--apply", "--approve-message-automation");
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(run("--check").status, 0);
});
