import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { applyJsonEdits, installerArguments, planAntigravityInstallation } from "../scripts/install-antigravity-bridge.mjs";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-installer-"));
const root = path.join(sandbox, "package");
const node = process.execPath;
const entry = path.join(root, "src", "antigravity-bridge.mjs");
const sidecarEntry = path.join(root, "src", "antigravity-sidecar.mjs");
let sequence = 0;

after(() => {
  const resolved = fs.realpathSync.native(sandbox);
  assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function fixture() {
  const home = path.join(sandbox, `home-${++sequence}`);
  fs.mkdirSync(home);
  return { home, root, node };
}

function write(home, relative, value) {
  const file = path.join(home, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

test("plans both client registrations and an app-managed sidecar without writing files", () => {
  const options = fixture();
  const plan = planAntigravityInstallation(options);
  assert.equal(plan.codex.environment.ANTIGRAVITY_BRIDGE_CALLER, "codex");
  assert.deepEqual(plan.codex.commandArgs, [entry]);
  assert.equal(plan.edits.length, 3);
  assert.deepEqual(fs.readdirSync(options.home), []);
  assert.ok(!JSON.stringify(plan).includes("dangerously-skip-permissions"));
});

test("preserves Claude preferences, other servers and bridge-specific settings", () => {
  const options = fixture();
  const file = write(options.home, ".claude.json", {
    theme: "dark",
    projects: { example: { allowedTools: ["Read"] } },
    mcpServers: {
      unrelated: { command: "other" },
      "antigravity-bridge": { command: "old-node", args: [entry], custom: 4, env: { KEEP: "yes", ANTIGRAVITY_BRIDGE_CALLER: "claude" } },
    },
  });
  applyJsonEdits(planAntigravityInstallation({ ...options, targets: ["claude"] }).edits);
  const result = read(file);
  assert.equal(result.theme, "dark");
  assert.deepEqual(result.projects, { example: { allowedTools: ["Read"] } });
  assert.deepEqual(result.mcpServers.unrelated, { command: "other" });
  assert.equal(result.mcpServers["antigravity-bridge"].custom, 4);
  assert.deepEqual(result.mcpServers["antigravity-bridge"].env, { KEEP: "yes", ANTIGRAVITY_BRIDGE_CALLER: "claude" });
  assert.equal(planAntigravityInstallation({ ...options, targets: ["claude"] }).edits.length, 0);
});

test("enables only the owned sidecar and retains native permission configuration", () => {
  const options = fixture();
  const configPath = write(options.home, ".gemini/config/config.json", { sidecars: { other: { enabled: false } }, userSettings: { permissions: "ask" }, plugins: ["existing"] });
  const plan = planAntigravityInstallation({ ...options, targets: ["desktop"] });
  applyJsonEdits(plan.edits);
  assert.deepEqual(read(configPath), { sidecars: { other: { enabled: false }, "codex-bridge": { enabled: true } }, userSettings: { permissions: "ask" }, plugins: ["existing"] });
  const definition = read(path.join(options.home, ".gemini/config/sidecars/codex-bridge/sidecar.json"));
  assert.equal(definition.command, node);
  assert.deepEqual(definition.args, [sidecarEntry]);
  assert.equal(definition.restart_policy, "on-failure");
});

test("rejects occupied registration and sidecar names before writing any file", () => {
  for (const target of ["claude", "desktop"]) {
    const options = fixture();
    const file = target === "claude"
      ? write(options.home, ".claude.json", { mcpServers: { "antigravity-bridge": { command: "node", args: ["some-other-bridge.mjs"] } } })
      : write(options.home, ".gemini/config/sidecars/codex-bridge/sidecar.json", { command: "node", args: ["unrelated.mjs"] });
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => planAntigravityInstallation({ ...options, targets: [target] }), /different entrypoint/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});

test("refuses a conflicting configured caller identity", () => {
  const options = fixture();
  write(options.home, ".claude.json", { mcpServers: { "antigravity-bridge": { command: node, args: [entry], env: { ANTIGRAVITY_BRIDGE_CALLER: "codex" } } } });
  assert.throws(() => planAntigravityInstallation({ ...options, targets: ["claude"] }), /conflicting caller identity/);
});

test("retargets recognized Codex entries without resetting custom settings", () => {
  const options = fixture();
  const codexExisting = { enabled: false, disabled_tools: ["send_to_antigravity"], tool_timeout_sec: 90, transport: { type: "stdio", command: "old-node", args: [entry], env: { ANTIGRAVITY_BRIDGE_CALLER: "codex", CUSTOM: "yes" }, cwd: options.home } };
  const plan = planAntigravityInstallation({ ...options, targets: ["codex"], codexExisting });
  assert.equal(plan.codex.mode, "retarget");
  assert.equal(plan.codex.environment.CUSTOM, "yes");
  assert.equal(codexExisting.enabled, false);
  assert.deepEqual(codexExisting.disabled_tools, ["send_to_antigravity"]);
  assert.throws(() => planAntigravityInstallation({ ...options, targets: ["codex"], codexExisting: { transport: { type: "http", url: "http://localhost" } } }), /not stdio/);
});

test("rejects a concurrently changed configuration before applying the plan", () => {
  const options = fixture();
  const file = write(options.home, ".claude.json", { keep: true });
  const plan = planAntigravityInstallation({ ...options, targets: ["claude", "desktop"] });
  fs.writeFileSync(file, JSON.stringify({ concurrent: true }));
  assert.throws(() => applyJsonEdits(plan.edits), /Configuration changed/);
  assert.deepEqual(read(file), { concurrent: true });
  assert.equal(fs.existsSync(path.join(options.home, ".gemini")), false);
});

test("removes only owned entries and leaves delivery data intact", () => {
  const options = fixture();
  write(options.home, ".claude.json", { mcpServers: { other: { command: "other" } } });
  applyJsonEdits(planAntigravityInstallation({ ...options, targets: ["claude", "desktop"] }).edits);
  const receipt = write(options.home, ".codex/antigravity-bridge/delivery.json", { status: "unknown" });
  const removal = planAntigravityInstallation({ ...options, targets: ["claude", "desktop"], remove: true });
  applyJsonEdits(removal.edits);
  assert.deepEqual(read(path.join(options.home, ".claude.json")), { mcpServers: { other: { command: "other" } } });
  assert.deepEqual(read(receipt), { status: "unknown" });
  assert.equal(fs.existsSync(path.join(options.home, ".gemini/config/sidecars/codex-bridge/sidecar.json")), false);
  assert.equal(planAntigravityInstallation({ ...options, targets: ["claude", "desktop"], remove: true }).edits.length, 0);
});

test("argument parsing supports selected targets and rejects typos", () => {
  assert.deepEqual(installerArguments(["--desktop", "--claude", "--dry-run"]), { targets: ["claude", "desktop"], dryRun: true, remove: false, help: false });
  assert.equal(installerArguments([]).targets.length, 3);
  assert.throws(() => installerArguments(["--dangerously-skip-permissions"]), /Unknown option/);
});

test("rejects symlinked JSON configuration", { skip: process.platform === "win32" }, () => {
  const options = fixture();
  const target = write(options.home, "original.json", { keep: true });
  fs.symlinkSync(target, path.join(options.home, ".claude.json"));
  assert.throws(() => planAntigravityInstallation({ ...options, targets: ["claude"] }), /Unsafe configuration/);
  assert.deepEqual(read(target), { keep: true });
});
