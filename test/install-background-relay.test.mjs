import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBackgroundRelay } from "../scripts/install-background-relay.mjs";
import { configureRelay, writeRelayJson } from "../src/background-relay-config.mjs";
import { RELAY_SERVICE_OWNER, relayServiceRuntimeId } from "../src/background-relay-service.mjs";

const SECRET = "never-persist-worker-or-account-secret";
const healthy = { schemaVersion: 1, pid: 123, version: "1.25.3", transportReady: true, accepting: true, desktopRequired: false };
const decodeXml = (value) => value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

function fixture(t, platform = "win32") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "background-relay-install-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "package space");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: healthy.version }));
  for (const file of ["src/background-relay-service.mjs", "src/background-relay-daemon.mjs", "scripts/background-relay-hidden.vbs"]) fs.writeFileSync(path.join(root, file), "fixture");
  const env = { ...process.env, HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: path.join(directory, "config"),
    AGENT_RELAY_DIRECTORY: path.join(directory, "relay"), AGENT_RELAY_TOKEN: SECRET, OPENAI_API_KEY: SECRET };
  const config = configureRelay({ env, platform });
  const calls = [];
  let healthCalls = 0;
  const state = { task: { exists: false, user: "TEST\\User" }, loaded: false, macDisabled: false,
    linux: { LoadState: "not-found", UnitFileState: "", ActiveState: "inactive", FragmentPath: "" } };
  const running = () => fs.writeFileSync(path.join(config.paths.root, "service-status.json"), JSON.stringify({ owner: RELAY_SERVICE_OWNER,
    status: "running", daemonPid: healthy.pid, runtimeId: relayServiceRuntimeId(JSON.parse(fs.readFileSync(path.join(config.paths.root, "service-runtime.json")))) }));
  const status = () => ({ ...healthy, runtimeId: JSON.parse(fs.readFileSync(path.join(config.paths.root, "service-status.json"))).runtimeId });
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "--version") return { status: state.nodeStatus ?? 0, stdout: state.nodeVersion ?? "v24.1.0" };
    if (platform === "win32") {
      const request = JSON.parse(options.input);
      if (request.action === "register") {
        const text = (name) => decodeXml(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(request.xml)[1]);
        state.xml = request.xml;
        state.task = { exists: true, user: "TEST\\User", description: text("Description"), command: text("Command"), arguments: text("Arguments"),
          enabled: /<Settings>[\s\S]*?<Enabled>true<\/Enabled>/.test(request.xml), state: state.task.state ?? 3,
          principalId: "TEST\\User", principalSid: "S-1-5-21-1", userSid: "S-1-5-21-1",
          actions: 1, logonType: 3, runLevel: 0, hidden: true, executionTimeLimit: "PT0S", multipleInstances: 2 };
      }
      if (request.action === "start") { state.task.state = 4; running(); }
      return { status: 0, stdout: JSON.stringify(state.task) };
    }
    if (platform === "darwin") {
      if (args[0] === "print-disabled") return { status: 0, stdout: state.macDisabled ? `"${state.label}" => true` : "{}" };
      if (args[0] === "print") { state.label = args[1].split("/").at(-1); return { status: state.loaded ? 0 : 113, stdout: state.loaded ? "state = running" : "" }; }
      if (["bootstrap", "kickstart"].includes(args[0])) { state.loaded = true; running(); }
      return { status: 0, stdout: "" };
    }
    if (args[1] === "show") {
      state.label = args[2].replace(/\.service$/, "");
      return { status: 0, stdout: Object.entries(state.linux).map(([name, value]) => `${name}=${value}`).join("\n") };
    }
    if (args[1] === "daemon-reload") {
      state.linux.LoadState = "loaded";
      state.linux.FragmentPath = path.join(env.XDG_CONFIG_HOME, "systemd", "user", `${state.label}.service`);
    }
    if (args[1] === "enable") state.linux.UnitFileState = "enabled";
    if (args[1] === "start") { state.linux.ActiveState = "active"; running(); }
    return { status: 0, stdout: "" };
  };
  const options = { env, platform, root, run, uid: 501, health: async () => { healthCalls++; return status(); }, sleep: async () => {}, pollAttempts: 2 };
  return { directory, config, root, env, calls, state, options, healthCalls: () => healthCalls,
    status,
    install: (extra = {}) => installBackgroundRelay({ ...options, ...extra }) };
}

test("Windows installs and starts a per-user hidden task without secrets or a shell", async (t) => {
  const f = fixture(t);
  const result = await f.install();
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, true);
  assert.equal(result.ready, true);
  assert.equal(result.started, true);
  assert.match(f.state.task.command, /wscript\.exe$/i);
  assert.match(f.state.task.arguments, /\/\/B \/\/Nologo/);
  assert.match(f.state.xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(f.state.xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(f.state.xml, /<Hidden>true<\/Hidden>/);
  assert.match(f.state.xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.ok(f.calls.every(({ options }) => options.windowsHide === true && options.shell === false));
  assert.equal(f.state.xml.includes(SECRET), false);
  assert.equal(f.state.xml.includes(f.config.token), false);
  assert.equal(JSON.stringify(f.calls.map(({ args }) => args)).includes(SECRET), false);
});

test("Windows preserves a disabled task and never restarts an already running service", async (t) => {
  const f = fixture(t);
  await f.install();
  f.calls.length = 0;
  await f.install();
  assert.deepEqual(f.calls.map(({ options }) => JSON.parse(options.input).action), ["query"]);
  f.state.task.enabled = false;
  const result = await f.install();
  assert.equal(result.configured, true);
  assert.equal(result.deliveryEnabled, false);
  assert.equal(result.liveVerified, false);
  assert.match(result.notice, /intentionally disabled/);
  assert.equal(f.calls.some(({ options }) => JSON.parse(options.input).action === "start"), false);
});

test("Windows verifies normalized principal names using their resolved SID", async (t) => {
  const f = fixture(t);
  const result = await f.install({ run: async (...args) => {
    const response = await f.options.run(...args);
    if (JSON.parse(args[2].input).action === "register") f.state.task.principalId = "User";
    return response;
  } });
  assert.equal(result.configured, true);
  assert.equal(result.ready, true);
  assert.equal(result.started, true);
  f.calls.length = 0;
  assert.equal((await f.install({ check: true })).configured, true);
  assert.deepEqual(f.calls.map(({ options }) => JSON.parse(options.input).action), ["query"]);
  const script = Buffer.from(f.calls[0].args.at(-1), "base64").toString("utf16le");
  assert.match(script, /NTAccount\]::new\(\$relayPrincipalId\)\.Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/);
});

test("Windows rejects foreign or unresolved principal SIDs despite matching account text", async (t) => {
  const f = fixture(t);
  await f.install();
  for (const principalSid of ["S-1-5-21-2", null, ""]) {
    f.state.task.principalSid = principalSid;
    f.calls.length = 0;
    assert.equal((await f.install()).code, "SERVICE_CONFIGURATION_CONFLICT");
    assert.deepEqual(f.calls.map(({ options }) => JSON.parse(options.input).action), ["query"]);
  }
});

test("Windows refuses foreign registrations and failed readback", async (t) => {
  const foreign = fixture(t);
  foreign.state.task = { exists: true, description: "foreign" };
  assert.equal((await foreign.install()).code, "SERVICE_CONFIGURATION_CONFLICT");
  assert.equal(foreign.calls.length, 1);
  const altered = fixture(t);
  const run = altered.options.run;
  const result = await altered.install({ run: async (...args) => {
    const response = await run(...args);
    if (JSON.parse(args[2].input).action === "register") altered.state.task.command = "foreign.exe";
    return response;
  } });
  assert.equal(result.code, "SERVICE_READBACK_FAILED");
  assert.equal(altered.calls.some(({ options }) => JSON.parse(options.input).action === "start"), false);
});

test("dry-run and check do not register or start tasks", async (t) => {
  const f = fixture(t);
  const result = await f.install({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.changed, true);
  assert.deepEqual(f.calls.map(({ options }) => JSON.parse(options.input).action), ["query"]);
  assert.equal(f.healthCalls(), 0);
  f.calls.length = 0;
  await f.install({ check: true });
  assert.deepEqual(f.calls.map(({ options }) => JSON.parse(options.input).action), ["query"]);
});

test("checks use the installed environment across startup backends without writing caller changes", async (t) => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const f = fixture(t, platform);
    const normalPath = process.env.PATH || path.dirname(process.execPath);
    f.env.PATH = `${path.join(f.directory, "npm", "node_modules", ".bin")}${path.delimiter}${normalPath}`;
    f.env.CODEX_HOME = path.join(f.directory, "custom-codex");
    f.env.CLAUDE_CONFIG_DIR = path.join(f.directory, "custom-claude");
    assert.equal((await f.install()).ready, true);
    const snapshot = () => Object.fromEntries(fs.readdirSync(f.directory, { recursive: true }).sort()
      .filter((name) => fs.lstatSync(path.join(f.directory, name)).isFile())
      .map((name) => [name, fs.readFileSync(path.join(f.directory, name), "utf8")]));
    const before = snapshot();
    const callerEnv = { ...f.env, PATH: normalPath, HOME: path.join(f.directory, "caller-home"),
      XDG_CONFIG_HOME: path.join(f.directory, "caller-config"), CODEX_HOME: path.join(f.directory, "caller-codex"),
      CLAUDE_CONFIG_DIR: path.join(f.directory, "caller-claude") };
    f.calls.length = 0;
    const checked = await f.install({ check: true, env: callerEnv });
    assert.equal(checked.configured, true, platform);
    assert.equal(checked.liveVerified, true, platform);
    assert.equal(checked.ready, true, platform);
    assert.equal(checked.runtimeChanged, false, platform);
    assert.equal(checked.activationPending, false, platform);
    assert.deepEqual(snapshot(), before, platform);
    assert.deepEqual(f.calls.map(({ args, options }) => platform === "win32" ? JSON.parse(options.input).action : args[platform === "linux" ? 1 : 0]),
      platform === "win32" ? ["query"] : platform === "darwin" ? ["print-disabled", "print"] : ["show"]);
    f.env.PATH = normalPath;
    assert.equal((await f.install()).configured, true);
    const saved = JSON.parse(fs.readFileSync(path.join(f.config.paths.root, "service-runtime.json"), "utf8"));
    assert.equal(saved.environment.PATH, normalPath);
    assert.equal(saved.environment.CODEX_HOME, f.env.CODEX_HOME);
  }
});

test("checks reject malformed installed environments without changing saved state", async (t) => {
  const f = fixture(t);
  await f.install();
  const file = path.join(f.config.paths.root, "service-runtime.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const environment of [null, [], "invalid", { UNMANAGED: SECRET }, { PATH: 7 }, { PATH: "" }, { PATH: "unsafe\npath" }]) {
    const raw = JSON.stringify({ ...saved, environment });
    fs.writeFileSync(file, raw);
    f.calls.length = 0;
    const result = await f.install({ check: true });
    assert.equal(result.code, "SERVICE_RUNTIME_INVALID");
    assert.equal(result.liveVerified, false);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
});

test("installed-environment checks still detect changed runtime and startup ownership", async (t) => {
  const f = fixture(t);
  await f.install();
  const file = path.join(f.config.paths.root, "service-runtime.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const changed of [{ packageRoot: path.join(f.directory, "other-package") },
    { nodeExecutable: path.join(f.directory, "other-node") }, { packageVersion: "0.0.0" }]) {
    const raw = JSON.stringify({ ...saved, ...changed });
    fs.writeFileSync(file, raw);
    const result = await f.install({ check: true });
    assert.equal(result.configured, false);
    assert.equal(result.liveVerified, false);
    assert.equal(result.runtimeChanged, true);
    assert.equal(fs.readFileSync(file, "utf8"), raw);
  }
  fs.writeFileSync(file, JSON.stringify(saved));
  f.state.task.description = "foreign-owner";
  assert.equal((await f.install({ check: true })).code, "SERVICE_CONFIGURATION_CONFLICT");
});

function keptNodeRuntime(f, runtime = {}) {
  const node = path.join(f.directory, "kept node.exe");
  fs.writeFileSync(node, "");
  writeRelayJson(path.join(f.config.paths.root, "service-runtime.json"), { schemaVersion: 1, owner: RELAY_SERVICE_OWNER,
    packageRoot: fs.realpathSync.native(f.root), nodeExecutable: node, packageVersion: healthy.version, environment: {}, ...runtime });
  return node;
}
const savedNode = (f) => JSON.parse(fs.readFileSync(path.join(f.config.paths.root, "service-runtime.json"))).nodeExecutable;
const registrations = (f) => f.calls.filter(({ options }) => options.input && JSON.parse(options.input).action === "register").length;

test("an update under another Node keeps the Node that already runs the relay", async (t) => {
  const f = fixture(t);
  const node = keptNodeRuntime(f);
  const first = await f.install();
  assert.equal(first.configured, true);
  assert.equal(savedNode(f), node);
  assert.equal(f.state.task.arguments.includes(node), true);
  assert.equal(registrations(f), 1);
  const second = await f.install();
  assert.equal(second.configured, true);
  assert.equal(second.changed, false);
  assert.equal(savedNode(f), node);
  assert.equal(registrations(f), 1);
  assert.equal((await f.install({ check: true })).configured, true);
});

test("the relay moves to the current Node when the saved one cannot run this package", async (t) => {
  const old = fixture(t);
  fs.writeFileSync(path.join(old.root, "package.json"), JSON.stringify({ version: healthy.version, engines: { node: ">=22.13" } }));
  const tooOld = keptNodeRuntime(old);
  old.state.nodeVersion = "v22.12.9";
  await old.install();
  assert.notEqual(savedNode(old), tooOld);
  assert.equal(savedNode(old), process.execPath);

  const enough = fixture(t);
  fs.writeFileSync(path.join(enough.root, "package.json"), JSON.stringify({ version: healthy.version, engines: { node: ">=22.13" } }));
  const accepted = keptNodeRuntime(enough);
  enough.state.nodeVersion = "v22.13.0";
  await enough.install();
  assert.equal(savedNode(enough), accepted);

  const broken = fixture(t);
  const failing = keptNodeRuntime(broken);
  broken.state.nodeStatus = 1;
  await broken.install();
  assert.notEqual(savedNode(broken), failing);

  const missing = fixture(t);
  const removed = keptNodeRuntime(missing);
  fs.rmSync(removed);
  await missing.install();
  assert.notEqual(savedNode(missing), removed);
});

test("saved configuration and live transport readiness are reported separately", async (t) => {
  const f = fixture(t);
  const result = await f.install({ health: async () => { throw new Error(SECRET); } });
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  assert.equal(result.ready, false);
  assert.equal(result.code, "SERVICE_NOT_READY");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("macOS writes an owned LaunchAgent and bootstraps without touching native apps", async (t) => {
  const f = fixture(t, "darwin");
  const result = await f.install();
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, true);
  const file = path.join(f.directory, "Library", "LaunchAgents", `${result.registration}.plist`);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(RELAY_SERVICE_OWNER));
  assert.match(text, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(f.config.token), false);
  assert.equal(f.calls.some(({ args }) => args.includes("bootout") || args.includes("kill") || args.includes("-k")), false);
  f.calls.length = 0;
  assert.equal((await f.install()).started, false);
  assert.equal(f.calls.some(({ args }) => ["bootstrap", "kickstart"].includes(args[0])), false);
});

test("macOS preserves disabled choices and foreign plist files", async (t) => {
  const f = fixture(t, "darwin");
  const first = await f.install();
  f.state.macDisabled = true;
  f.calls.length = 0;
  const disabled = await f.install();
  assert.equal(disabled.configured, true);
  assert.equal(disabled.enabled, false);
  assert.equal(f.calls.some(({ args }) => ["bootstrap", "kickstart", "enable"].includes(args[0])), false);
  const file = path.join(f.directory, "Library", "LaunchAgents", `${first.registration}.plist`);
  fs.writeFileSync(file, "foreign-plist");
  assert.equal((await f.install()).code, "SERVICE_CONFIGURATION_CONFLICT");
  assert.equal(fs.readFileSync(file, "utf8"), "foreign-plist");
});

test("Linux installs, enables and starts a user unit with verified readback", async (t) => {
  const f = fixture(t, "linux");
  const result = await f.install();
  assert.equal(result.configured, true);
  assert.equal(result.ready, true);
  const text = fs.readFileSync(f.state.linux.FragmentPath, "utf8");
  assert.match(text, /Restart=on-failure/);
  assert.match(text, /RestartSec=10/);
  assert.match(text, /TimeoutStopSec=infinity/);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(f.config.token), false);
  assert.deepEqual(f.calls.map(({ args }) => args[1]), ["show", "daemon-reload", "enable", "start", "show"]);
  f.calls.length = 0;
  await f.install();
  assert.deepEqual(f.calls.map(({ args }) => args[1]), ["show", "show"]);
});

test("Linux preserves disabled and masked user startup choices", async (t) => {
  const f = fixture(t, "linux");
  await f.install();
  f.state.linux.UnitFileState = "disabled";
  f.state.linux.ActiveState = "inactive";
  f.calls.length = 0;
  const disabled = await f.install();
  assert.equal(disabled.configured, true);
  assert.equal(disabled.enabled, false);
  assert.equal(f.calls.some(({ args }) => ["enable", "start", "restart"].includes(args[1])), false);
  f.state.linux.UnitFileState = "masked";
  f.calls.length = 0;
  const masked = await f.install();
  assert.equal(masked.code, "SERVICE_MASKED");
  assert.equal(masked.enabled, false);
  assert.equal(f.calls.length, 1);
});

test("Linux refuses foreign unit ownership and unverified registration", async (t) => {
  const f = fixture(t, "linux");
  await f.install();
  fs.writeFileSync(f.state.linux.FragmentPath, "[Unit]\nDescription=foreign\n");
  const result = await f.install();
  assert.equal(result.code, "SERVICE_CONFIGURATION_CONFLICT");
  assert.match(fs.readFileSync(f.state.linux.FragmentPath, "utf8"), /Description=foreign/);
  const broken = fixture(t, "linux");
  const run = broken.options.run;
  const readback = await broken.install({ run: async (...args) => {
    const response = await run(...args);
    if (args[1][1] === "enable") broken.state.linux.UnitFileState = "disabled";
    return response;
  } });
  assert.equal(readback.code, "SERVICE_READBACK_FAILED");
});

test("startup registration rejects relative custom roots and linked descendant directories", async (t) => {
  for (const platform of ["darwin", "linux"]) {
    const relative = fixture(t, platform);
    relative.env[platform === "darwin" ? "HOME" : "XDG_CONFIG_HOME"] = "relative-startup";
    assert.equal((await relative.install()).code, "SERVICE_STORAGE_UNSAFE");
    assert.equal(relative.calls.length, 0);
    const linked = fixture(t, platform);
    const outside = path.join(linked.directory, "outside");
    const parent = platform === "darwin" ? path.join(linked.directory, "Library") : path.join(linked.env.XDG_CONFIG_HOME, "systemd");
    fs.mkdirSync(outside);
    fs.mkdirSync(parent, { recursive: true });
    fs.symlinkSync(outside, path.join(parent, platform === "darwin" ? "LaunchAgents" : "user"), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await linked.install()).code, "SERVICE_STORAGE_UNSAFE");
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(linked.calls.length, 0);
  }
});

test("startup registration detects directory replacement between inspection and writing", async (t) => {
  const f = fixture(t, "darwin");
  const directory = path.join(f.directory, "Library", "LaunchAgents");
  fs.mkdirSync(directory, { recursive: true });
  let replaced = false;
  const result = await f.install({ run: async (...args) => {
    const response = await f.options.run(...args);
    if (!replaced) {
      fs.renameSync(directory, `${directory}-previous`);
      fs.mkdirSync(directory);
      replaced = true;
    }
    return response;
  } });
  assert.equal(result.code, "SERVICE_CONFIGURATION_CHANGED");
  assert.deepEqual(fs.readdirSync(directory), []);
  assert.deepEqual(fs.readdirSync(`${directory}-previous`), []);
});

test("atomic startup cleanup preserves a substituted temporary file", async (t) => {
  const f = fixture(t, "darwin");
  const directory = path.join(f.directory, "Library", "LaunchAgents");
  const sync = fs.fsyncSync;
  let replaced;
  fs.fsyncSync = (descriptor) => {
    sync(descriptor);
    if (replaced || !fs.existsSync(directory)) return;
    const name = fs.readdirSync(directory).find((entry) => entry.endsWith(".tmp"));
    if (!name) return;
    replaced = path.join(directory, name);
    fs.renameSync(replaced, `${replaced}.owned`);
    fs.writeFileSync(replaced, "foreign-file");
  };
  t.after(() => { fs.fsyncSync = sync; });
  const result = await f.install();
  fs.fsyncSync = sync;
  assert.equal(result.code, "SERVICE_CONFIGURATION_CHANGED");
  assert.equal(fs.readFileSync(replaced, "utf8"), "foreign-file");
  assert.equal(f.calls.some(({ args }) => ["bootstrap", "kickstart"].includes(args[0])), false);
});

test("explicitly disabled relay config does not start any platform service", async (t) => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const f = fixture(t, platform);
    const saved = JSON.parse(fs.readFileSync(f.config.paths.config, "utf8"));
    saved.enabled = false;
    fs.writeFileSync(f.config.paths.config, JSON.stringify(saved));
    const result = await f.install();
    assert.equal(result.configured, true);
    assert.equal(result.enabled, false);
    assert.equal(result.started, false);
    assert.equal(f.healthCalls(), 0);
  }
});

test("updates the desired package root while leaving an active service untouched", async (t) => {
  const f = fixture(t);
  await f.install();
  const next = path.join(f.directory, "global-npm-package");
  fs.mkdirSync(path.join(next, "src"), { recursive: true });
  fs.mkdirSync(path.join(next, "scripts"));
  fs.writeFileSync(path.join(next, "package.json"), JSON.stringify({ version: healthy.version }));
  for (const file of ["src/background-relay-service.mjs", "src/background-relay-daemon.mjs", "scripts/background-relay-hidden.vbs"]) fs.writeFileSync(path.join(next, file), "new fixture");
  f.calls.length = 0;
  const result = await f.install({ root: next });
  assert.equal(result.configured, true);
  assert.equal(result.activationPending, true);
  assert.equal(result.code, "SERVICE_UPDATE_PENDING");
  assert.equal(result.liveVerified, false);
  assert.equal(result.started, false);
  const runtime = JSON.parse(fs.readFileSync(path.join(f.config.paths.root, "service-runtime.json")));
  assert.equal(runtime.packageRoot, fs.realpathSync.native(next));
  assert.equal(JSON.stringify(runtime).includes(SECRET), false);
  assert.equal(f.calls.some(({ options }) => JSON.parse(options.input).action === "start"), false);
});

test("health must belong to the owned runtime and uses local configuration authentication", async (t) => {
  const f = fixture(t);
  let connection;
  const result = await f.install({ health: async (_method, _params, options) => { connection = options.connection; return { ...healthy, pid: 999 }; } });
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  assert.equal(connection.workerId, null);
  assert.equal(connection.token, f.config.token);
  assert.notEqual(connection.token, SECRET);
});

test("health rejects a missing or stale daemon runtime identity despite matching supervisor metadata", async (t) => {
  const f = fixture(t);
  assert.equal((await f.install()).liveVerified, true);
  f.calls.length = 0;
  for (const runtimeId of [undefined, "0".repeat(64)]) {
    const result = await f.install({ check: true, health: async () => ({ ...f.status(), runtimeId }) });
    assert.equal(result.liveVerified, false);
    assert.equal(result.ready, false);
    assert.equal(result.activationPending, true);
    assert.equal(result.code, "SERVICE_UPDATE_PENDING");
  }
  assert.ok(f.calls.every(({ options }) => JSON.parse(options.input).action === "query"));
});

test("same-path package updates remain pending until the owned daemon reports the new version", async (t) => {
  const f = fixture(t);
  await f.install();
  const nextVersion = "1.25.4";
  fs.writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ version: nextVersion }));
  f.calls.length = 0;
  const pending = await f.install();
  assert.equal(pending.configured, true);
  assert.equal(pending.expectedVersion, nextVersion);
  assert.equal(pending.version, healthy.version);
  assert.equal(pending.liveVerified, false);
  assert.equal(pending.activationPending, true);
  assert.equal(pending.code, "SERVICE_UPDATE_PENDING");
  assert.equal(f.calls.some(({ options }) => JSON.parse(options.input).action !== "query"), false);
  const runtime = JSON.parse(fs.readFileSync(path.join(f.config.paths.root, "service-runtime.json")));
  assert.equal(runtime.packageVersion, nextVersion);
  fs.writeFileSync(path.join(f.config.paths.root, "service-status.json"), JSON.stringify({ owner: RELAY_SERVICE_OWNER,
    status: "running", daemonPid: healthy.pid, runtimeId: relayServiceRuntimeId(runtime) }));
  const oldProcess = await f.install({ check: true });
  assert.equal(oldProcess.liveVerified, false);
  assert.equal(oldProcess.code, "SERVICE_UPDATE_PENDING");
  const current = await f.install({ check: true, health: async () => ({ ...f.status(), version: nextVersion }) });
  assert.equal(current.liveVerified, true);
  assert.equal(current.ready, true);
  assert.equal(current.activationPending, false);
  assert.equal(current.version, nextVersion);
});

const claudeRoot = (directory, name, account = "11111111-1111-4111-8111-111111111111") => {
  const root = path.join(directory, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ lastKnownAccountUuid: account, windowSizeWasSignedIn: true }));
  return root;
};
const savedRuntime = (f) => JSON.parse(fs.readFileSync(path.join(f.config.paths.root, "service-runtime.json")));
const isolatedClaude = (f) => { f.env.APPDATA = path.join(f.directory, "Roaming"); f.env.LOCALAPPDATA = path.join(f.directory, "Local"); };

test("an update drops a stale Claude data pin instead of saving it for the service", async (t) => {
  const f = fixture(t);
  isolatedClaude(f);
  f.env.CLAUDE_DESKTOP_USER_DATA = path.join(f.directory, "moved-away");
  fs.mkdirSync(f.env.CLAUDE_DESKTOP_USER_DATA);
  assert.equal((await f.install()).configured, true);
  assert.equal(Object.hasOwn(savedRuntime(f), "claudeDesktopUserData"), false);
});

test("a pin that discovery also finds is not saved, so the service keeps discovering", async (t) => {
  const f = fixture(t);
  isolatedClaude(f);
  f.env.CLAUDE_DESKTOP_USER_DATA = claudeRoot(f.directory, path.join("Roaming", "Claude"));
  assert.equal((await f.install()).configured, true);
  assert.equal(Object.hasOwn(savedRuntime(f), "claudeDesktopUserData"), false);
});

test("an explicit pin that selects a different account root is kept for the daemon", async (t) => {
  const f = fixture(t);
  isolatedClaude(f);
  claudeRoot(f.directory, path.join("Roaming", "Claude"));
  f.env.CLAUDE_DESKTOP_USER_DATA = claudeRoot(f.directory, "explicit", "22222222-2222-4222-8222-222222222222");
  assert.equal((await f.install()).configured, true);
  assert.equal(savedRuntime(f).claudeDesktopUserData, f.env.CLAUDE_DESKTOP_USER_DATA);
});
