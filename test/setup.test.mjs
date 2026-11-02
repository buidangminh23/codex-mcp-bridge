import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { automaticSetupEnabled, checkSetup, printSetup, runSetup, setupArguments, setupEnvironment, setupPaths, setupProcessFailure } from "../src/setup.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("one-command setup preserves structured service failure codes without copying private output", () => {
  const service = setupProcessFailure(process.execPath, ["setup-background-relay.mjs"], {
    status: 1, stdout: JSON.stringify({ configured: false, service: { code: "TASK_SCHEDULER_UNAVAILABLE" }, token: "private-value" }), stderr: "",
  });
  assert.equal(service.code, "TASK_SCHEDULER_UNAVAILABLE");
  assert.match(service.message, /TASK_SCHEDULER_UNAVAILABLE/);
  assert.doesNotMatch(service.message, /private-value|token/);
  const diagnostic = setupProcessFailure(process.execPath, ["setup-background-relay.mjs"], { status: 1,
    stderr: "Bridge diagnostic (include this block in a bug report)\nWORKER_STORAGE_UNSAFE | background-relay / setup\nReason: private account data\n" });
  assert.equal(diagnostic.code, "WORKER_STORAGE_UNSAFE");
  assert.doesNotMatch(diagnostic.message, /private account data/);
});

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
  let backgroundConfigured = false;
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  const registration = (worker, extra = {}) => ({ command: process.execPath,
    args: [path.join(root, "src", "mcp-supervisor.mjs"), worker], ...extra });
  const standalone = (worker, caller) => ({ command: process.execPath,
    args: ["antigravity-bridge.mjs", "antigravity-outbound-bridge.mjs"].includes(worker) ? [path.join(root, "src", "mcp-supervisor.mjs"), worker] : [path.join(root, "src", worker)],
    ...(caller ? { env: { ANTIGRAVITY_BRIDGE_CALLER: caller } } : {}) });
  const run = (command, args, childEnv) => {
    calls.push({ command, args, env: childEnv });
    if (args[0] === "mcp") {
      if (args[1] === "list") return JSON.stringify([...inventory.keys()].map((name) => ({ name })));
      if (args[1] === "get") return JSON.stringify(inventory.get(args[2]));
      throw new Error("Unexpected Codex mutation");
    }
    const name = path.basename(args[0]);
    if (name === "install-claude-code.mjs") write(paths.code, { mcpServers: { "codex-bridge": registration("index.mjs") } });
    else if (name === "install-claude-desktop.mjs") write(paths.desktop, { mcpServers: { "codex-bridge-desktop": registration("index.mjs") }, preferences: { menuBarEnabled: true } });
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
    } else if (name === "setup-background-relay.mjs") {
      if (!args.includes("--check")) backgroundConfigured = true;
      return JSON.stringify({ configured: backgroundConfigured, liveVerified: backgroundConfigured, transportReady: backgroundConfigured });
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
  assert.deepEqual(scripts.map((call) => path.basename(call.args[0])), ["install-claude-code.mjs", "install-claude-desktop.mjs", "install-native-relay.mjs", "install-codex-mcp.mjs", "install-antigravity-bridge.mjs", "setup-background-relay.mjs", "setup-background-relay.mjs"]);
  assert.ok(scripts[2].args.includes("--desktop-tasks"));
  assert.ok(!scripts[2].args.includes("--no-bootstrap"));
  assert.ok(scripts.slice(0, 5).every((call) => call.args.includes("--setup")));
  assert.deepEqual(scripts[5].args.slice(1), ["--json"]);
  assert.deepEqual(scripts[6].args.slice(1), ["--check", "--json"]);
  assert.equal(result.verification.find(item => item.name === "Independent background relay").liveVerified, true);
  assert.equal(scripts[0].env.CODEX_BRIDGE_AUTOSTART, "0");
  assert.ok(scripts[1].args.includes("codex-bridge-desktop"));
  assert.ok(scripts[4].args.includes("--all"));
  assert.match(result.nextActions.join(" "), /same saved project/);
  assert.match(result.nextActions.join(" "), /earlier settings/);
  assert.doesNotMatch(result.nextActions.join(" "), /(?:Open or reconnect|quit|reopen|keep.*task open)/i);
  const output = [];
  printSetup(result, { output: (line) => output.push(line) });
  assert.match(output[0], /configuration verified.*connections have not been verified/);
});

test("setup help exposes one command for updating the package and applying managed settings", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const result = runSetup({ args: ["--help"], platform, run: () => assert.fail("must not run") });
    assert.ok(result.help.includes(`${platform === "win32" ? "npx.cmd" : "npx"} --yes --ignore-scripts --package=@minhspark/codex-mcp-bridge@latest -- codex-bridge-update${platform === "win32" ? " --user" : ""}\n`));
    assert.match(result.help, /background relay health and loaded native app connections are verified separately/);
    assert.doesNotMatch(result.help, /--foreground-scripts|--allow-scripts/);
  }
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

test("read-only verification distinguishes missing bootstrap from a disabled registration", (t) => {
  const setup = fixture(t);
  runSetup({ ...setup, args: ["--no-download"], platform: "win32", root });
  setup.write(path.join(setup.paths.codex, "native-relay.json"), {});
  setup.inventory.get("claude-bridge").enabled = false;
  setup.calls.length = 0;
  const result = checkSetup({ ...setup, platform: "win32", root });
  assert.equal(result.configured, false);
  assert.ok(result.components.some((item) => /executor/.test(item.name) && item.status === "incomplete"));
  const disabled = result.components.find((item) => item.name === "Codex / claude-bridge");
  assert.equal(disabled.status, "configured");
  assert.equal(disabled.deliveryEnabled, false);
  assert.ok(disabled.notices.some((notice) => /intentionally disabled/.test(notice)));
  assert.ok(setup.calls.every((call) => call.args[0] === "mcp" && ["list", "get"].includes(call.args[1])
    || path.basename(call.args[0]) === "setup-background-relay.mjs" && JSON.stringify(call.args.slice(1)) === JSON.stringify(["--check", "--json"])));
});

test("global updates preserve disabled delivery choices as configured restrictions instead of installation failures", (t) => {
  const setup = fixture(t);
  const run = (command, args, env) => {
    const output = setup.run(command, args, env);
    if (path.basename(args[0]) === "install-antigravity-bridge.mjs") {
      setup.inventory.get("claude-bridge").enabled = false;
      const code = JSON.parse(fs.readFileSync(setup.paths.code, "utf8"));
      code.mcpServers["codex-bridge"].disabled = true;
      setup.write(setup.paths.code, code);
      const desktop = JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8"));
      desktop.mcpServers["codex-bridge-desktop"].disabled = true;
      desktop.mcpServers["codex-bridge-desktop"].env = { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0" };
      setup.write(setup.paths.desktop, desktop);
      setup.write(path.join(setup.paths.gemini, "config.json"), { sidecars: { "codex-bridge": { enabled: false } } });
    }
    return output;
  };
  const result = runSetup({ ...setup, run, args: ["--postinstall", "--no-download"], platform: "win32", root });
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  for (const name of ["Codex / claude-bridge", "Claude Code / codex-bridge", "Claude Desktop / codex-bridge-desktop", "Antigravity / codex-bridge sidecar"]) {
    const component = result.verification.find((item) => item.name === name);
    assert.equal(component.status, "configured");
    assert.equal(component.deliveryEnabled, false);
    assert.ok(component.notices.some((notice) => /intentionally disabled/.test(notice)));
  }
  const desktop = result.verification.find((item) => item.name === "Claude Desktop / codex-bridge-desktop");
  assert.equal(desktop.nativeCodeOnly, true);
  assert.equal(desktop.sharedChatDelivery, "unsupported");
  const output = [];
  printSetup(result, { output: (line) => output.push(line) });
  assert.equal(output.filter((line) => /intentionally disabled/.test(line)).length, 4);
  assert.equal(setup.inventory.get("claude-bridge").enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.code, "utf8")).mcpServers["codex-bridge"].disabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(setup.paths.gemini, "config.json"), "utf8")).sidecars["codex-bridge"].enabled, false);
});

test("disabled registrations still require valid commands, workers, caller identities and native pipe forwarding", (t) => {
  const setup = fixture(t);
  runSetup({ ...setup, args: ["--no-download"], platform: "win32", root });
  const relay = setup.inventory.get("codex-native-relay");
  relay.enabled = false;
  relay.transport.env_vars = [];
  const antigravity = setup.inventory.get("antigravity-bridge");
  antigravity.enabled = false;
  antigravity.transport.env.ANTIGRAVITY_BRIDGE_CALLER = "claude";
  const code = JSON.parse(fs.readFileSync(setup.paths.code, "utf8"));
  code.mcpServers["codex-bridge"].disabled = true;
  code.mcpServers["codex-bridge"].args = ["custom.mjs"];
  setup.write(setup.paths.code, code);
  const desktop = JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8"));
  desktop.mcpServers["codex-bridge-desktop"].disabled = true;
  desktop.mcpServers["codex-bridge-desktop"].command = path.join(setup.home, "missing-node.exe");
  setup.write(setup.paths.desktop, desktop);
  setup.write(path.join(setup.paths.gemini, "config.json"), { sidecars: { "codex-bridge": { enabled: "false" } } });
  const result = checkSetup({ ...setup, platform: "win32", root });
  assert.equal(result.configured, false);
  for (const pattern of [/Native pipe forwarding/, /caller registration/, /unsupported launcher/, /command is missing/, /enabled setting is missing or invalid/]) {
    assert.ok(result.components.some((item) => item.status === "incomplete" && pattern.test(item.detail)), String(pattern));
  }
});

test("verification distinguishes native-only shared registration from unsupported Desktop Chat delivery", (t) => {
  const setup = fixture(t);
  runSetup({ ...setup, args: ["--no-download"], platform: "win32", root });
  const desktop = JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8"));
  desktop.mcpServers["codex-bridge-desktop"].env = { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0",
    CODEX_BRIDGE_SANDBOX: "read-only", CODEX_BRIDGE_APPROVAL: "deny" };
  setup.write(setup.paths.desktop, desktop);
  const result = checkSetup({ ...setup, platform: "win32", root });
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  const component = result.components.find((item) => item.name === "Claude Desktop / codex-bridge-desktop");
  assert.equal(component.nativeCodeOnly, true);
  assert.equal(component.sharedChatDelivery, "unsupported");
  assert.ok(component.notices.some((notice) => /Ordinary Claude Desktop Chat cannot deliver/.test(notice)));
  const output = [];
  printSetup(result, { output: (line) => output.push(line) });
  assert.ok(output.some((line) => /native Code-only policy was preserved/.test(line)));
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8")), desktop);
});

test("comprehensive setup visibly reports a preserved native-only restriction without declaring configuration failure", (t) => {
  const setup = fixture(t);
  const policy = { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_SANDBOX: "read-only" };
  const run = (command, args, env) => {
    const output = setup.run(command, args, env);
    if (path.basename(args[0]) === "install-claude-desktop.mjs") {
      const desktop = JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8"));
      desktop.mcpServers["codex-bridge-desktop"].env = policy;
      setup.write(setup.paths.desktop, desktop);
    }
    return output;
  };
  const result = runSetup({ ...setup, run, args: ["--postinstall", "--no-download"], platform: "win32", root });
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  const verified = result.verification.find((item) => item.name === "Claude Desktop / codex-bridge-desktop");
  assert.equal(verified.sharedChatDelivery, "unsupported");
  assert.equal(verified.nativeCodeOnly, true);
  const output = [];
  printSetup(result, { output: (line) => output.push(line) });
  assert.ok(output.some((line) => /Ordinary Claude Desktop Chat cannot deliver/.test(line)));
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8")).mcpServers["codex-bridge-desktop"].env, policy);
});

test("read-only verification detects historical window-opening settings without rewriting them", (t) => {
  const setup = fixture(t);
  runSetup({ ...setup, args: ["--no-download"], platform: "win32", root });
  for (const [file, name] of [[setup.paths.code, "codex-bridge"], [setup.paths.desktop, "codex-bridge-desktop"]]) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.mcpServers[name].env = { CODEX_BRIDGE_OPEN_IN_APP: "1" };
    setup.write(file, saved);
  }
  setup.calls.length = 0;
  const result = checkSetup({ ...setup, platform: "win32", root });
  assert.equal(result.configured, false);
  assert.equal(result.components.filter((item) => /silent configuration/.test(item.detail ?? "")).length, 2);
  assert.ok(setup.calls.every((call) => call.args[0] === "mcp" && ["list", "get"].includes(call.args[1])
    || path.basename(call.args[0]) === "setup-background-relay.mjs" && JSON.stringify(call.args.slice(1)) === JSON.stringify(["--check", "--json"])));
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.code, "utf8")).mcpServers["codex-bridge"].env.CODEX_BRIDGE_OPEN_IN_APP, "1");
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8")).mcpServers["codex-bridge-desktop"].env.CODEX_BRIDGE_OPEN_IN_APP, "1");
});

test("setup exposes unavailable native background preferences without claiming loaded-process readiness", (t) => {
  const setup = fixture(t);
  const backgroundPreference = { setting: "runInBackground", status: "unavailable", liveVerified: false };
  const notice = "Antigravity native preferences are unavailable; background operation is unverified.";
  const run = (command, args, env) => {
    const output = setup.run(command, args, env);
    return path.basename(args[0]) === "install-antigravity-bridge.mjs"
      ? JSON.stringify({ notices: [notice], backgroundPreference }) : output;
  };
  const result = runSetup({ ...setup, run, args: ["--postinstall", "--no-download"], platform: "win32", root });
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  const antigravity = result.components.find((item) => item.name === "Antigravity / all components");
  assert.deepEqual(antigravity.backgroundPreference, backgroundPreference);
  const output = [];
  printSetup(result, { output: (line) => output.push(line) });
  assert.ok(output.some((line) => line.includes(notice)));
});

test("verification detects a disabled Claude background preference without changing it", (t) => {
  const setup = fixture(t);
  runSetup({ ...setup, args: ["--no-download"], platform: "win32", root });
  const saved = JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8"));
  saved.preferences.menuBarEnabled = false;
  setup.write(setup.paths.desktop, saved);
  const result = checkSetup({ ...setup, platform: "win32", root });
  assert.equal(result.configured, false);
  assert.ok(result.components.some((item) => item.name === "Claude Desktop / background preference" && item.status === "incomplete"));
  assert.equal(JSON.parse(fs.readFileSync(setup.paths.desktop, "utf8")).preferences.menuBarEnabled, false);
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

test("global postinstall failures return a failing exit status instead of reporting a successful update", (t) => {
  const setup = fixture(t);
  const env = { ...setup.env, SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
    CLAUDE_DESKTOP_CONFIG: setup.paths.desktop, CODEX_EXE: process.execPath };
  for (const args of [["--postinstall", "--check", "--no-download"], ["--postinstall", "--unknown"]]) {
    const child = spawnSync(process.execPath, [path.join(root, "scripts", "setup.mjs"), ...args], {
      env, encoding: "utf8", windowsHide: true,
    });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stdout + child.stderr, /incomplete|configuration was not completed/);
  }
  assert.deepEqual(fs.readdirSync(setup.home), []);
});
