import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { automaticSetupEnabled, checkSetup, runSetup, setupArguments, setupEnvironment, setupPaths } from "../src/setup.mjs";

const root = path.resolve(import.meta.dirname, "..");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-setup-"));
  const home = path.join(directory, "home");
  const binary = path.join(directory, "codex.exe");
  fs.mkdirSync(home);
  fs.writeFileSync(binary, "");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { HOME: home, USERPROFILE: home, APPDATA: path.join(home, "roaming"), CODEX_HOME: path.join(home, "codex"), npm_config_global: "true" };
  const paths = setupPaths(env, "win32");
  const calls = [];
  const inventory = new Map();
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const registration = (worker, extra = {}) => ({ command: process.execPath,
    args: [path.join(root, "src", "mcp-supervisor.mjs"), worker], ...extra });
  const standalone = (worker, caller) => ({ command: process.execPath, args: [path.join(root, "src", worker)], ...(caller ? { env: { ANTIGRAVITY_BRIDGE_CALLER: caller } } : {}) });
  const run = (command, args, childEnv) => {
    calls.push({ command, args, env: childEnv });
    if (args[0] === "mcp") {
      if (args[1] === "list") return JSON.stringify([...inventory.keys()].map((name) => ({ name })));
      if (args[1] === "get") return JSON.stringify(inventory.get(args[2]));
      throw new Error("Unexpected Codex mutation");
    }
    const name = path.basename(args[0]);
    if (name === "install-claude-code.mjs") write(paths.code, { mcpServers: { "codex-bridge": registration("index.mjs") } });
    else if (name === "install-claude-desktop.mjs") write(paths.desktop, { mcpServers: { "codex-bridge-desktop": registration("index.mjs") } });
    else if (name === "install-native-relay.mjs") {
      inventory.set("codex-native-relay", { enabled: true, transport: { type: "stdio", ...registration("native-relay-companion.mjs"), env_vars: ["CODEX_APP_TOOLS_PIPE_PATH"] } });
      write(path.join(paths.codex, "native-relay.json"), { relayThreadId: "01234567-89ab-4cde-8123-0123456789ab", desktopTasks: true });
    } else if (name === "install-codex-mcp.mjs") inventory.set("claude-bridge", { enabled: true, transport: { type: "stdio", ...registration("claude-bridge.mjs") } });
    else if (name === "install-antigravity-bridge.mjs") {
      const code = JSON.parse(fs.readFileSync(paths.code));
      code.mcpServers["antigravity-bridge"] = standalone("antigravity-bridge.mjs", "claude");
      write(paths.code, code);
      inventory.set("antigravity-bridge", { enabled: true, transport: { type: "stdio", ...standalone("antigravity-bridge.mjs", "codex") } });
      write(path.join(paths.gemini, "mcp_config.json"), { mcpServers: { "agent-bridge": standalone("antigravity-outbound-bridge.mjs") } });
      write(path.join(paths.gemini, "sidecars", "codex-bridge", "sidecar.json"), standalone("antigravity-sidecar.mjs"));
      write(path.join(paths.gemini, "config.json"), { sidecars: { "codex-bridge": { enabled: true } } });
    } else throw new Error(`Unexpected setup script ${name}`);
    return "{}";
  };
  return { home, env, paths, calls, inventory, write, run, resolve: () => binary };
}

test("only explicit global npm installs configure applications automatically", () => {
  assert.equal(automaticSetupEnabled({ npm_config_global: "true" }), true);
  for (const env of [{}, { npm_config_global: "false" }, { npm_config_global: "true", CODEX_BRIDGE_SKIP_SETUP: "1" }]) {
    assert.equal(automaticSetupEnabled(env), false);
    const result = runSetup({ args: ["--postinstall"], env, run: () => assert.fail("must not run") });
    assert.equal(result.skipped, true);
  }
});

test("setup targets the Microsoft Store Claude data root and respects explicit paths", (t) => {
  const setup = fixture(t);
  const local = path.join(setup.home, "local");
  const desktopRoot = path.join(local, "Packages", "Claude_test", "LocalCache", "Roaming", "Claude");
  fs.mkdirSync(path.dirname(path.dirname(path.dirname(desktopRoot))), { recursive: true });
  const env = { ...setup.env, LOCALAPPDATA: local };
  const desktop = path.join(desktopRoot, "claude_desktop_config.json");
  assert.equal(setupPaths(env, "win32").desktop, desktop);
  fs.mkdirSync(desktopRoot, { recursive: true });
  assert.equal(setupPaths(env, "win32").desktop, desktop);
  const customRoot = path.join(setup.home, "custom-desktop");
  assert.equal(setupPaths({ ...env, CLAUDE_DESKTOP_USER_DATA: customRoot }, "win32").desktop,
    path.join(customRoot, "claude_desktop_config.json"));
  const customFile = path.join(setup.home, "custom.json");
  assert.equal(setupPaths({ ...env, CLAUDE_DESKTOP_USER_DATA: customRoot, CLAUDE_DESKTOP_CONFIG: customFile }, "win32").desktop, customFile);
  assert.ok(runSetup({ ...setup, env, args: ["--dry-run"], platform: "win32", root }).files.includes(desktop));
  assert.equal(setup.calls.length, 0);
});

test("setup refuses ambiguous Claude roots and follows the uniquely identified account root", (t) => {
  const setup = fixture(t);
  const local = path.join(setup.home, "local");
  const desktopRoot = path.join(local, "Packages", "Claude_test", "LocalCache", "Roaming", "Claude");
  fs.mkdirSync(desktopRoot, { recursive: true });
  fs.mkdirSync(path.dirname(setup.paths.desktop), { recursive: true });
  const env = { ...setup.env, LOCALAPPDATA: local };
  assert.throws(() => runSetup({ ...setup, env, args: ["--no-download"], platform: "win32", root }), /Multiple Claude Desktop data roots/);
  assert.equal(setup.calls.length, 0);
  const account = { lastKnownAccountUuid: "12345678-1234-4234-8234-123456789abc", windowSizeWasSignedIn: true };
  setup.write(path.join(desktopRoot, "config.json"), account);
  assert.equal(setupPaths(env, "win32").desktop, path.join(desktopRoot, "claude_desktop_config.json"));
  setup.write(path.join(path.dirname(setup.paths.desktop), "config.json"), account);
  assert.throws(() => setupPaths(env, "win32"), /Multiple Claude Desktop data roots/);
});

test("invalid flags and dry-run never start installers or write configuration", (t) => {
  const setup = fixture(t);
  assert.throws(() => setupArguments(["--check", "--dry-run"]), /not both/);
  assert.throws(() => setupArguments(["--full-access"]), /Unknown/);
  const before = fs.readdirSync(setup.home);
  const preview = runSetup({ ...setup, args: ["--dry-run"], platform: "win32", root });
  assert.equal(preview.dryRun, true);
  assert.equal(setup.calls.length, 0);
  assert.deepEqual(fs.readdirSync(setup.home), before);
});

test("setup does not copy active agent permission overrides or temporary pipe identities", (t) => {
  const setup = fixture(t);
  const env = setupEnvironment({ ...setup.env, CODEX_BRIDGE_APPROVAL_POLICY: "never", CODEX_BRIDGE_ENFORCE_FULL_ACCESS: "1", CODEX_BRIDGE_SANDBOX: "danger-full-access", CLAUDE_BRIDGE_PERMISSION_MODE: "bypass", CODEX_APP_TOOLS_PIPE_PATH: "private-pipe", CODEX_THREAD_ID: "private-thread", PATH: "preserved" }, setup.paths, process.execPath);
  assert.equal(env.PATH, "preserved");
  for (const key of ["CODEX_BRIDGE_APPROVAL_POLICY", "CODEX_BRIDGE_ENFORCE_FULL_ACCESS", "CODEX_BRIDGE_SANDBOX", "CLAUDE_BRIDGE_PERMISSION_MODE", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_THREAD_ID"]) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(env.CODEX_HOME, setup.paths.codex);
});

test("global setup initializes all native and Antigravity entries then verifies disk configuration", (t) => {
  const setup = fixture(t);
  const result = runSetup({ ...setup, args: ["--postinstall", "--no-download"], platform: "win32", root });
  assert.equal(result.configured, true, JSON.stringify(result));
  assert.equal(result.liveVerified, false);
  const scripts = setup.calls.filter((call) => call.args[0] !== "mcp");
  assert.deepEqual(scripts.map((call) => path.basename(call.args[0])), ["install-claude-code.mjs", "install-claude-desktop.mjs", "install-native-relay.mjs", "install-codex-mcp.mjs", "install-antigravity-bridge.mjs"]);
  assert.ok(scripts[2].args.includes("--desktop-tasks"));
  assert.ok(!scripts[2].args.includes("--no-bootstrap"));
  assert.equal(scripts[0].env.CODEX_BRIDGE_AUTOSTART, "0");
  assert.ok(scripts[1].args.includes("codex-bridge-desktop"));
  assert.ok(scripts[4].args.includes("--all"));
  assert.match(result.nextActions.join(" "), /same saved project/);
});

test("an existing relay routing opt-out is not forced back on during reinstall", (t) => {
  const setup = fixture(t);
  setup.write(path.join(setup.paths.codex, "native-relay.json"), { desktopTasks: false, relayThreadId: "existing" });
  runSetup({ ...setup, args: ["--no-download"], platform: "win32", root });
  const relayCall = setup.calls.find((call) => path.basename(call.args[0]) === "install-native-relay.mjs");
  assert.ok(!relayCall.args.includes("--desktop-tasks"));
});

test("a failed Claude registration cannot be reported as successful or overwritten by later JSON installers", (t) => {
  const setup = fixture(t);
  const run = (command, args, env) => {
    if (path.basename(args[0]) === "install-claude-code.mjs") throw new Error("Shared Desktop name collision");
    return setup.run(command, args, env);
  };
  const result = runSetup({ ...setup, run, args: ["--no-download"], platform: "win32", root });
  assert.equal(result.configured, false);
  assert.match(result.components[0].detail, /collision/);
  assert.ok(!setup.calls.some((call) => /install-(claude-desktop|antigravity-bridge)/.test(call.args[0])));
});

test("read-only verification detects missing bootstrap and disabled servers", (t) => {
  const setup = fixture(t);
  runSetup({ ...setup, args: ["--no-download"], platform: "win32", root });
  setup.write(path.join(setup.paths.codex, "native-relay.json"), {});
  setup.inventory.get("claude-bridge").enabled = false;
  setup.calls.length = 0;
  const result = checkSetup({ ...setup, platform: "win32", root });
  assert.equal(result.configured, false);
  assert.ok(result.components.some((item) => /executor/.test(item.name) && item.status === "incomplete"));
  assert.ok(result.components.some((item) => /disabled/.test(item.detail ?? "")));
  assert.ok(setup.calls.every((call) => call.args[0] === "mcp" && ["list", "get"].includes(call.args[1])));
});

test("the package lifecycle skips local npm ci without creating application files", (t) => {
  const setup = fixture(t);
  const child = spawnSync(process.execPath, [path.join(root, "scripts", "setup.mjs"), "--postinstall"], {
    env: { ...process.env, ...setup.env, npm_config_global: "false" }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /only for a global npm install/);
  assert.deepEqual(fs.readdirSync(setup.home), []);
});
