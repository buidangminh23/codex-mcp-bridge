import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBackgroundRelay } from "../scripts/install-background-relay.mjs";
import { configureRelay } from "../src/background-relay-config.mjs";
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
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (platform === "win32") {
      const request = JSON.parse(options.input);
      if (request.action === "register") {
        const text = (name) => decodeXml(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(request.xml)[1]);
        state.xml = request.xml;
        state.task = { exists: true, user: "TEST\\User", description: text("Description"), command: text("Command"), arguments: text("Arguments"),
          enabled: /<Settings>[\s\S]*?<Enabled>true<\/Enabled>/.test(request.xml), state: state.task.state ?? 3,
          principalId: "TEST\\User", userSid: "S-1-5-21-1",
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
  const options = { env, platform, root, run, uid: 501, health: async () => { healthCalls++; return healthy; }, sleep: async () => {}, pollAttempts: 2 };
  return { directory, config, root, env, calls, state, options, healthCalls: () => healthCalls,
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
