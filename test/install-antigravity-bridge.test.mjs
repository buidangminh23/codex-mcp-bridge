import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { applyJsonEdits, installerArguments, planAntigravityInstallation, validateCodexExecutable } from "../scripts/install-antigravity-bridge.mjs";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-installer-"));
const root = path.join(sandbox, "package");
const node = process.execPath;
const entry = path.join(root, "src", "antigravity-bridge.mjs");
const sidecarEntry = path.join(root, "src", "antigravity-sidecar.mjs");
const outboundEntry = path.join(root, "src", "antigravity-outbound-bridge.mjs");
let sequence = 0;

after(() => {
  const resolved = fs.realpathSync.native(sandbox);
  assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
  fs.rmSync(resolved, { recursive: true, force: true });
});

function fixture() {
  const home = path.join(sandbox, `home-${++sequence}`);
  fs.mkdirSync(home);
  return { home, codeConfigDir: home, root, node, appData: path.join(home, "roaming") };
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
  assert.equal(plan.edits.length, 4);
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

test("uses a separate Claude configuration directory without changing the home configuration", () => {
  const options = fixture();
  const homeConfig = write(options.home, ".claude.json", { preserved: true });
  const codeConfigDir = path.join(options.home, "custom-claude");
  const codeConfig = write(codeConfigDir, ".claude.json", { preferences: { theme: "dark" }, mcpServers: { existing: { command: "keep" } } });
  const installOptions = { ...options, codeConfigDir, targets: ["claude"], setup: true };
  const plan = planAntigravityInstallation(installOptions);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].file, codeConfig);
  applyJsonEdits(plan.edits);
  assert.deepEqual(read(homeConfig), { preserved: true });
  assert.deepEqual(read(codeConfig).preferences, { theme: "dark" });
  assert.deepEqual(read(codeConfig).mcpServers.existing, { command: "keep" });
  assert.equal(read(codeConfig).mcpServers["antigravity-bridge"].env.ANTIGRAVITY_BRIDGE_CALLER, "claude");
  assert.equal(planAntigravityInstallation(installOptions).edits.length, 0);
  applyJsonEdits(planAntigravityInstallation({ ...installOptions, remove: true }).edits);
  assert.deepEqual(read(codeConfig).mcpServers, { existing: { command: "keep" } });
  assert.throws(() => planAntigravityInstallation({ ...installOptions, codeConfigDir: "relative" }), /absolute/);
});

test("CLI setup uses HOME and CLAUDE_CONFIG_DIR consistently on every platform", () => {
  const options = fixture();
  const script = fileURLToPath(new URL("../scripts/install-antigravity-bridge.mjs", import.meta.url));
  const codeConfigDir = path.join(options.home, "custom-claude");
  const output = execFileSync(process.execPath, [script, "--claude", "--desktop", "--setup", "--dry-run"], {
    env: { ...process.env, HOME: options.home, USERPROFILE: path.join(options.home, "unused-profile"), CLAUDE_CONFIG_DIR: codeConfigDir, APPDATA: options.appData },
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  const plan = JSON.parse(output);
  assert.ok(plan.files.some((file) => file.path === path.join(codeConfigDir, ".claude.json")));
  assert.ok(plan.files.some((file) => file.path === path.join(options.home, ".gemini", "config", "config.json")));
  assert.deepEqual(fs.readdirSync(options.home), []);
});

test("automatic setup preserves a disabled sidecar and custom display and restart settings", () => {
  const options = fixture();
  const definitionPath = write(options.home, ".gemini/config/sidecars/codex-bridge/sidecar.json", {
    command: "old-node", args: [sidecarEntry], display_name: "Custom bridge name", restart_policy: "never", custom: { keep: true },
  });
  const configPath = write(options.home, ".gemini/config/config.json", { sidecars: { "codex-bridge": { enabled: false, custom: 3 } }, userSettings: { permissions: "ask" } });
  const mcpPath = write(options.home, ".gemini/config/mcp_config.json", { mcpServers: { "agent-bridge": { command: "old-node", args: [outboundEntry], disabled: true, timeoutSeconds: 70 } } });
  const plan = planAntigravityInstallation({ ...options, targets: ["desktop"], setup: true });
  assert.ok(plan.notices.some((notice) => notice.includes("disabled")));
  applyJsonEdits(plan.edits);
  assert.deepEqual(read(configPath), { sidecars: { "codex-bridge": { enabled: false, custom: 3 } }, userSettings: { permissions: "ask" } });
  assert.deepEqual(read(definitionPath), { command: node, args: [sidecarEntry], display_name: "Custom bridge name", restart_policy: "never", custom: { keep: true } });
  assert.equal(read(mcpPath).mcpServers["agent-bridge"].disabled, true);
  assert.equal(read(mcpPath).mcpServers["agent-bridge"].timeoutSeconds, 70);
  assert.equal(planAntigravityInstallation({ ...options, targets: ["desktop"], setup: true }).edits.length, 0);
  applyJsonEdits(planAntigravityInstallation({ ...options, targets: ["desktop"] }).edits);
  assert.equal(read(configPath).sidecars["codex-bridge"].enabled, true);
});

test("setup enables the existing Windows background preference and preserves native account and permission settings", () => {
  const options = { ...fixture(), targets: ["desktop"], setup: true, platform: "win32" };
  const original = { runInBackground: "false", account: { token: "private" }, permissions: { tools: "ask" }, custom: 5 };
  const storage = write(options.appData, "Antigravity/app_storage.json", original);
  const plan = planAntigravityInstallation(options);
  assert.deepEqual(read(storage), original);
  assert.equal(plan.backgroundPreference.status, "planned");
  assert.equal(plan.backgroundPreference.liveVerified, false);
  assert.equal(plan.edits.filter((edit) => edit.file === storage).length, 1);
  applyJsonEdits(plan.edits);
  assert.deepEqual(read(storage), { ...original, runInBackground: "true" });
  const repeated = planAntigravityInstallation(options);
  assert.equal(repeated.backgroundPreference.status, "configured");
  assert.equal(repeated.edits.length, 0);
  applyJsonEdits(planAntigravityInstallation({ ...options, remove: true }).edits);
  assert.deepEqual(read(storage), { ...original, runInBackground: "true" });
});

test("setup reports missing or unverified native background preferences without creating or guessing native files", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const options = { ...fixture(), targets: ["desktop"], setup: true, platform };
    const plan = planAntigravityInstallation(options);
    assert.equal(plan.backgroundPreference.status, "unavailable");
    assert.equal(plan.backgroundPreference.liveVerified, false);
    assert.ok(plan.notices.some((notice) => /background/.test(notice)));
    assert.ok(!plan.edits.some((edit) => edit.file.includes("app_storage")));
    applyJsonEdits(plan.edits);
    assert.equal(fs.existsSync(options.appData), false);
  }
  const options = { ...fixture(), targets: ["desktop"], setup: true, platform: "win32", appData: "relative" };
  assert.match(planAntigravityInstallation(options).backgroundPreference.detail, /absolute APPDATA/);
});

test("native background preferences change only during explicit comprehensive setup", () => {
  const options = { ...fixture(), targets: ["desktop"], platform: "win32" };
  const original = { runInBackground: "false", custom: "keep" };
  const storage = write(options.appData, "Antigravity/app_storage.json", original);
  const plan = planAntigravityInstallation(options);
  assert.equal(plan.backgroundPreference, null);
  assert.ok(!plan.edits.some((edit) => edit.file === storage));
  applyJsonEdits(plan.edits);
  assert.deepEqual(read(storage), original);
  for (const platform of ["darwin", "linux"]) {
    const unsupported = planAntigravityInstallation({ ...options, setup: true, platform });
    assert.equal(unsupported.backgroundPreference.status, "unavailable");
    assert.ok(!unsupported.edits.some((edit) => edit.file === storage));
  }
});

test("setup refuses unsafe native preferences and detects concurrent changes before applying any registration", () => {
  const options = { ...fixture(), targets: ["desktop"], setup: true, platform: "win32" };
  const storage = write(options.appData, "Antigravity/app_storage.json", { runInBackground: "false" });
  const alias = path.join(options.home, "native-alias.json");
  fs.linkSync(storage, alias);
  assert.throws(() => planAntigravityInstallation(options), /Unsafe configuration/);
  assert.equal(fs.existsSync(path.join(options.home, ".gemini")), false);
  fs.unlinkSync(alias);
  const plan = planAntigravityInstallation(options);
  fs.writeFileSync(storage, JSON.stringify({ runInBackground: "false", concurrent: true }));
  assert.throws(() => applyJsonEdits(plan.edits), /changed while preparing/);
  assert.deepEqual(read(storage), { runInBackground: "false", concurrent: true });
  assert.equal(fs.existsSync(path.join(options.home, ".gemini")), false);
});

test("malformed native preferences report a static diagnostic without exposing file paths or JSON", () => {
  for (const text of ["null", "[]", "true", "42", '"private-native-value"', '{"private-native-value":']) {
    const options = { ...fixture(), targets: ["desktop"], setup: true, platform: "win32" };
    const storage = write(options.appData, "Antigravity/app_storage.json", {});
    fs.writeFileSync(storage, text);
    assert.throws(() => planAntigravityInstallation(options), {
      message: "Invalid Antigravity native preferences: expected a JSON object.",
    });
    assert.equal(fs.readFileSync(storage, "utf8"), text);
    assert.equal(fs.existsSync(path.join(options.home, ".gemini")), false);
  }
});

test("malformed native preferences stay sanitized during concurrency checks and readback", (t) => {
  const options = { ...fixture(), targets: ["desktop"], setup: true, platform: "win32" };
  const storage = write(options.appData, "Antigravity/app_storage.json", { runInBackground: "false" });
  const plan = planAntigravityInstallation(options);
  const invalid = '{"private-native-value":';
  fs.writeFileSync(storage, invalid);
  assert.throws(() => applyJsonEdits(plan.edits), { message: "Invalid Antigravity native preferences: expected a JSON object." });
  assert.equal(fs.existsSync(path.join(options.home, ".gemini")), false);
  fs.writeFileSync(storage, JSON.stringify({ runInBackground: "false" }));
  const updated = planAntigravityInstallation(options);
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", function (source, destination) {
    const result = originalRename.call(fs, source, destination);
    if (destination === storage) fs.writeFileSync(storage, invalid);
    return result;
  });
  assert.throws(() => applyJsonEdits(updated.edits), { message: "Invalid Antigravity native preferences: expected a JSON object." });
  assert.equal(fs.readFileSync(storage, "utf8"), invalid);
});

test("CLI malformed native preferences retain a static setup-compatible stderr diagnostic", { skip: process.platform !== "win32" }, () => {
  const options = fixture();
  const storage = write(options.appData, "Antigravity/app_storage.json", {});
  const script = fileURLToPath(new URL("../scripts/install-antigravity-bridge.mjs", import.meta.url));
  for (const text of ['["private-native-value"]', '{"private-native-value":']) {
    fs.writeFileSync(storage, text);
    const result = spawnSync(process.execPath, [script, "--desktop", "--setup"], {
      env: { ...process.env, HOME: options.home, USERPROFILE: options.home, APPDATA: options.appData },
      encoding: "utf8", windowsHide: true, timeout: 15000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "Invalid Antigravity native preferences: expected a JSON object.");
    assert.equal(fs.existsSync(path.join(options.home, ".gemini")), false);
  }
});

test("CLI setup reports saved background settings separately from live activation without disclosing native values", { skip: process.platform !== "win32" }, () => {
  const options = fixture();
  const storage = write(options.appData, "Antigravity/app_storage.json", { runInBackground: "false", accountToken: "do-not-print" });
  const script = fileURLToPath(new URL("../scripts/install-antigravity-bridge.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script, "--desktop", "--setup"], {
    env: { ...process.env, HOME: options.home, USERPROFILE: options.home, APPDATA: options.appData },
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  const result = JSON.parse(output);
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  assert.equal(result.backgroundPreference.status, "configured");
  assert.equal(result.backgroundPreference.liveVerified, false);
  assert.doesNotMatch(output, /accountToken|do-not-print|reopen|Restart|Reload/);
  assert.deepEqual(read(storage), { runInBackground: "true", accountToken: "do-not-print" });
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

test("automatic setup migrates recognized package entries and preserves existing access settings", () => {
  const options = fixture();
  const source = path.join(options.home, "tools", "codex-mcp-bridge", "src");
  const oldEntry = path.join(source, "antigravity-bridge.mjs");
  const codexExisting = { enabled: false, disabled_tools: ["send_to_antigravity"], tool_timeout_sec: 90, transport: { type: "stdio", command: node, args: [oldEntry], env: { ANTIGRAVITY_BRIDGE_CALLER: "codex", CUSTOM: "yes" }, cwd: options.home } };
  const originalCodex = structuredClone(codexExisting);
  const claudePath = write(options.home, ".claude.json", { mcpServers: { "antigravity-bridge": { command: node, args: [oldEntry], disabled: true, custom: 4, env: { ANTIGRAVITY_BRIDGE_CALLER: "claude", CUSTOM: "yes" } } } });
  const outboundPath = write(options.home, ".gemini/config/mcp_config.json", { mcpServers: { "agent-bridge": { command: node, args: [path.join(source, "antigravity-outbound-bridge.mjs")], disabled: true, timeoutSeconds: 70, env: { CUSTOM: "yes" } } } });
  const definitionPath = write(options.home, ".gemini/config/sidecars/codex-bridge/sidecar.json", { command: node, args: [path.join(source, "antigravity-sidecar.mjs")], display_name: "Saved name", restart_policy: "never", env: { CUSTOM: "yes" } });
  const settingsPath = write(options.home, ".gemini/config/config.json", { sidecars: { "codex-bridge": { enabled: false } }, userSettings: { permissions: "ask" } });
  const plan = planAntigravityInstallation({ ...options, setup: true, codexExisting });
  assert.equal(plan.codex.mode, "retarget");
  assert.deepEqual(plan.codex.commandArgs, [entry]);
  assert.deepEqual(plan.codex.environment, codexExisting.transport.env);
  assert.deepEqual(codexExisting, originalCodex);
  applyJsonEdits(plan.edits);
  assert.deepEqual(read(claudePath).mcpServers["antigravity-bridge"], { type: "stdio", command: node, args: [entry], disabled: true, custom: 4, env: { ANTIGRAVITY_BRIDGE_CALLER: "claude", CUSTOM: "yes" } });
  assert.deepEqual(read(outboundPath).mcpServers["agent-bridge"], { command: node, args: [outboundEntry], disabled: true, timeoutSeconds: 70, env: { CUSTOM: "yes" } });
  assert.deepEqual(read(definitionPath), { command: node, args: [sidecarEntry], display_name: "Saved name", restart_policy: "never", env: { CUSTOM: "yes" } });
  assert.deepEqual(read(settingsPath), { sidecars: { "codex-bridge": { enabled: false } }, userSettings: { permissions: "ask" } });
  assert.equal(planAntigravityInstallation({ ...options, setup: true, codexExisting }).edits.length, 0);
  for (const mode of [{}, { setup: true, remove: true }]) {
    assert.throws(() => planAntigravityInstallation({ ...options, ...mode, targets: ["codex"], codexExisting }), /different entrypoint/);
  }
});

test("automatic setup refuses unknown package paths, scripts, launchers and extra arguments before writing", () => {
  const source = path.join(sandbox, "previous", "codex-mcp-bridge", "src");
  const cases = [
    { command: "python", args: [path.join(source, "antigravity-bridge.mjs")] },
    { command: path.join(sandbox, "custom-launcher"), args: [path.join(source, "antigravity-bridge.mjs")] },
    { command: node, args: [path.join(source, "antigravity-bridge.mjs"), "--custom"] },
    { command: node, args: [path.join(source, "antigravity-sidecar.mjs")] },
    { command: node, args: [path.join(sandbox, "other-package", "src", "antigravity-bridge.mjs")] },
    { command: node, args: [path.join("codex-mcp-bridge", "src", "antigravity-bridge.mjs")] },
  ];
  for (const existing of cases) {
    const options = fixture();
    const config = write(options.home, ".claude.json", { mcpServers: { "antigravity-bridge": existing } });
    const before = fs.readFileSync(config, "utf8");
    assert.throws(() => planAntigravityInstallation({ ...options, targets: ["claude", "desktop"], setup: true }), /different entrypoint|different launcher/);
    assert.equal(fs.readFileSync(config, "utf8"), before);
    assert.equal(fs.existsSync(path.join(options.home, ".gemini")), false);
  }
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
  assert.deepEqual(installerArguments(["--desktop", "--claude", "--dry-run"]), { targets: ["claude", "desktop"], dryRun: true, remove: false, setup: false, help: false });
  assert.equal(installerArguments(["--all", "--setup"]).setup, true);
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

test("rejects a configuration path replaced after opening before reading", (t) => {
  const options = fixture();
  const file = write(options.home, ".claude.json", { original: true });
  const replacement = write(options.home, "replacement.json", { replaced: true });
  const originalLstat = fs.lstatSync;
  const originalRead = fs.readSync;
  let swapped = false;
  let reads = 0;
  t.mock.method(fs, "readSync", function (...args) {
    reads++;
    return originalRead.apply(fs, args);
  });
  t.mock.method(fs, "lstatSync", function (target, ...args) {
    if (target === file && !swapped) {
      swapped = true;
      fs.renameSync(file, path.join(options.home, "original.json"));
      fs.renameSync(replacement, file);
    }
    return originalLstat.call(fs, target, ...args);
  });
  assert.throws(() => planAntigravityInstallation({ ...options, targets: ["claude"] }), /changed while opening/);
  assert.equal(swapped, true);
  assert.equal(reads, 0);
  assert.deepEqual(read(file), { replaced: true });
});

test("rejects a configuration changed while reading its open descriptor", (t) => {
  const options = fixture();
  const file = write(options.home, ".claude.json", { original: true });
  const originalRead = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", function (...args) {
    const length = originalRead.apply(fs, args);
    if (!changed) {
      changed = true;
      fs.appendFileSync(file, " ");
    }
    return length;
  });
  assert.throws(() => planAntigravityInstallation({ ...options, targets: ["claude"] }), /changed while reading/);
  assert.equal(changed, true);
});

test("rejects hardlinked and oversized configuration files before reading", () => {
  for (const kind of ["hardlink", "oversized"]) {
    const options = fixture();
    const file = write(options.home, ".claude.json", { original: true });
    if (kind === "hardlink") fs.linkSync(file, path.join(options.home, "shared.json"));
    else fs.truncateSync(file, 16 * 1024 * 1024 + 1);
    assert.throws(() => planAntigravityInstallation({ ...options, targets: ["claude"] }), /Unsafe configuration/);
  }
});

test("requires an absolute existing executable and rejects Windows shell scripts", () => {
  const options = fixture();
  assert.equal(validateCodexExecutable(process.execPath), fs.realpathSync.native(process.execPath));
  assert.throws(() => validateCodexExecutable("codex"), /absolute native executable/);
  assert.throws(() => validateCodexExecutable(options.home), /regular file/);
  assert.throws(() => validateCodexExecutable(path.join(options.home, "missing.exe")), /ENOENT/);
  for (const extension of ["cmd", "bat", "ps1", "js"]) {
    const script = path.join(options.home, `codex.${extension}`);
    fs.writeFileSync(script, "untrusted script");
    assert.throws(() => validateCodexExecutable(script, { platform: "win32" }), /not a shell script/);
  }
  const native = path.join(options.home, "custom codex.exe");
  fs.writeFileSync(native, "fixture");
  assert.equal(validateCodexExecutable(native, { platform: "win32" }), fs.realpathSync.native(native));
});

test("desktop installs the native outbound MCP without claiming a foreign caller identity", () => {
  const options = fixture();
  const config = write(options.home, ".gemini/config/mcp_config.json", { custom: { keep: true }, mcpServers: { filesystem: { command: "filesystem", args: ["root"] } } });
  const plan = planAntigravityInstallation({ ...options, targets: ["desktop"] });
  assert.equal(plan.outboundEntry, outboundEntry);
  applyJsonEdits(plan.edits);
  const value = read(config);
  assert.deepEqual(value.custom, { keep: true });
  assert.deepEqual(value.mcpServers.filesystem, { command: "filesystem", args: ["root"] });
  assert.deepEqual(value.mcpServers["agent-bridge"], { command: node, args: [outboundEntry] });
  assert.equal(fs.existsSync(path.join(options.home, ".gemini/config/mcp.json")), false);
  assert.equal(planAntigravityInstallation({ ...options, targets: ["desktop"] }).edits.length, 0);
});

test("outbound updates preserve custom settings and report copied bridges without editing them", () => {
  const options = fixture();
  const copied = { command: "node", args: ["some-source-bridge.mjs"], env: { CODEX_BRIDGE_DESKTOP_TASKS: "1" } };
  const config = write(options.home, ".gemini/config/mcp_config.json", { mcpServers: {
    "agent-bridge": { command: "old-node", args: [outboundEntry], disabled: true, timeoutSeconds: 120, env: { CUSTOM: "keep" } },
    "codex-bridge": copied,
    "claude-bridge": copied,
  } });
  const plan = planAntigravityInstallation({ ...options, targets: ["desktop"] });
  assert.equal(plan.notices.length, 2);
  applyJsonEdits(plan.edits);
  const servers = read(config).mcpServers;
  assert.deepEqual(servers["agent-bridge"], { command: node, args: [outboundEntry], disabled: true, timeoutSeconds: 120, env: { CUSTOM: "keep" } });
  assert.deepEqual(servers["codex-bridge"], copied);
  assert.deepEqual(servers["claude-bridge"], copied);
});

test("outbound entrypoint collisions and foreign identity environments fail before writes", () => {
  for (const existing of [
    { command: node, args: [path.join(root, "other.mjs")] },
    { command: node, args: [outboundEntry], env: { CODEX_THREAD_ID: "foreign" } },
    { command: node, args: [outboundEntry], env: { CLAUDE_SESSION_ID: "foreign" } },
    { command: node, args: [outboundEntry], env: { ANTIGRAVITY_BRIDGE_CALLER: "codex" } },
    { command: node, args: [outboundEntry], serverUrl: "https://example.invalid/mcp" },
  ]) {
    const options = fixture();
    const file = write(options.home, ".gemini/config/mcp_config.json", { mcpServers: { "agent-bridge": existing } });
    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => planAntigravityInstallation({ ...options, targets: ["desktop"] }), /different entrypoint|foreign caller|not stdio/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(fs.existsSync(path.join(options.home, ".gemini/config/sidecars")), false);
  }
});

test("desktop removal deletes only its owned outbound registration", () => {
  const options = fixture();
  const file = write(options.home, ".gemini/config/mcp_config.json", { custom: true, mcpServers: { existing: { command: "keep" } } });
  applyJsonEdits(planAntigravityInstallation({ ...options, targets: ["desktop"] }).edits);
  applyJsonEdits(planAntigravityInstallation({ ...options, targets: ["desktop"], remove: true }).edits);
  assert.deepEqual(read(file), { custom: true, mcpServers: { existing: { command: "keep" } } });
  assert.equal(planAntigravityInstallation({ ...options, targets: ["desktop"], remove: true }).edits.length, 0);
});

test("JSON update readback detects a changed output without overwriting it", (t) => {
  const options = fixture();
  const file = write(options.home, ".gemini/config/mcp_config.json", { mcpServers: {} });
  const plan = planAntigravityInstallation({ ...options, targets: ["desktop"] });
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", function (source, destination) {
    const result = originalRename.call(fs, source, destination);
    if (destination === file) fs.writeFileSync(file, JSON.stringify({ concurrent: true }));
    return result;
  });
  assert.throws(() => applyJsonEdits(plan.edits), /readback did not match/);
  assert.deepEqual(read(file), { concurrent: true });
  assert.equal(fs.existsSync(path.join(options.home, ".gemini/config/sidecars")), false);
});
