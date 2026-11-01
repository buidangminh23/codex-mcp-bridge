import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { acquireRelayServiceLock, readRelayServiceRuntime, RELAY_SERVICE_OWNER, runBackgroundRelayService } from "../src/background-relay-service.mjs";

const SECRET = "private-service-auth-value";

function fixture(options = {}) {
  const calls = [];
  const writes = [];
  const delays = [];
  const controller = new AbortController();
  let releases = 0;
  const root = path.resolve("service-test-storage");
  const config = { enabled: true, token: SECRET, paths: { root, jobs: path.join(root, "jobs") } };
  const settings = {
    root: process.cwd(),
    env: { HOME: "user-home", CODEX_HOME: "preserved-auth-home", AGENT_RELAY_TOKEN: SECRET,
      AGENT_RELAY_WORKER_ID: "parent-worker", AGENT_RELAY_RUNTIME_ID: "stale-runtime", CODEX_APP_TOOLS_PIPE_PATH: "desktop-pipe", CODEX_THREAD_ID: "desktop-thread" },
    signal: controller.signal,
    readConfig: () => config,
    acquireLock: () => ({ acquired: true, release: () => { releases++; } }),
    writeState: (file, value) => writes.push({ file, value }),
    changed: () => false,
    sleep: async (delay) => { delays.push(delay); if (delays.length >= (options.cycles ?? 1)) controller.abort(); },
    spawn(executable, args, settings) {
      const child = new EventEmitter();
      child.pid = 900;
      child.stderr = new PassThrough();
      child.kill = (signal) => { child.stoppedWith = signal; child.emit("close", 0); };
      calls.push({ executable, args, settings, child });
      queueMicrotask(() => {
        child.emit("spawn");
        child.stderr.write(SECRET);
        if (options.onSpawn) options.onSpawn(child, calls.length);
        else child.emit("close", 1);
      });
      return child;
    },
    ...options.settings,
  };
  return { config, settings, controller, calls, writes, delays, releases: () => releases, run: () => runBackgroundRelayService(settings) };
}

test("supervises only its daemon with hidden process settings and no Desktop identity", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, "stopped");
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.deepEqual(call.args, [path.join(process.cwd(), "src", "background-relay-daemon.mjs")]);
  assert.equal(call.settings.shell, false);
  assert.equal(call.settings.windowsHide, true);
  assert.equal(call.settings.env.AGENT_RELAY_DIRECTORY, f.config.paths.root);
  assert.equal(call.settings.env.CODEX_HOME, "preserved-auth-home");
  assert.equal(call.settings.env.AGENT_RELAY_TOKEN, undefined);
  assert.equal(call.settings.env.AGENT_RELAY_WORKER_ID, undefined);
  assert.match(call.settings.env.AGENT_RELAY_RUNTIME_ID, /^[a-f0-9]{64}$/);
  assert.equal(call.settings.env.AGENT_RELAY_RUNTIME_ID, f.writes.find(({ value }) => value.status === "running").value.runtimeId);
  assert.equal(call.settings.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  assert.equal(call.settings.env.CODEX_THREAD_ID, undefined);
  assert.equal(JSON.stringify(call.args).includes(SECRET), false);
  assert.equal(JSON.stringify(f.writes).includes(SECRET), false);
  assert.equal(f.releases(), 1);
});

test("backs off consecutive crashes with a bounded delay and durable static diagnostics", async () => {
  const f = fixture({ cycles: 9 });
  await f.run();
  assert.deepEqual(f.delays, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  const diagnostics = f.writes.filter(({ file }) => file.endsWith("last-service-error.json"));
  assert.equal(diagnostics.length, 9);
  assert.ok(diagnostics.every(({ value }) => value.code === "DAEMON_EXITED" && value.owner === RELAY_SERVICE_OWNER));
  assert.equal(diagnostics.at(-1).value.consecutiveFailures, 9);
});

test("handles spawn failures without replaying or retaining raw errors", async () => {
  const f = fixture({ settings: { spawn: () => { throw new Error(SECRET); } } });
  await f.run();
  const diagnostic = f.writes.find(({ file }) => file.endsWith("last-service-error.json")).value;
  assert.equal(diagnostic.code, "DAEMON_START_FAILED");
  assert.equal(JSON.stringify(f.writes).includes(SECRET), false);
});

test("retains only bounded technical fields from structured daemon stderr diagnostics", async () => {
  const f = fixture({ onSpawn: (child) => {
    const frame = JSON.stringify({ diagnostic: { schemaVersion: 1, component: "background-relay", operation: "startup",
      code: "EACCES", causeCodes: ["WORKER_STORAGE_UNSAFE", SECRET, "EACCES"], phase: "storage", deliveryState: "not_sent",
      sent: true, reason: SECRET, stack: SECRET, ids: { requestId: SECRET }, extra: SECRET } });
    child.stderr.write(`\n${frame.slice(0, 47)}`);
    child.stderr.write(`${frame.slice(47)}\n`);
    child.stderr.write(JSON.stringify({ diagnostic: { schemaVersion: 1, component: "background-relay", code: SECRET } }));
    child.emit("close", 1);
  } });
  await f.run();
  const diagnostic = f.writes.find(({ file }) => file.endsWith("last-service-error.json")).value;
  assert.equal(diagnostic.code, "DAEMON_EXITED");
  assert.deepEqual(diagnostic.daemonDiagnostic, { schemaVersion: 1, component: "background-relay", code: "EACCES",
    causeCodes: ["WORKER_STORAGE_UNSAFE"], operation: "startup", phase: "storage", deliveryState: "not_sent", sent: false });
  assert.equal(JSON.stringify(f.writes).includes(SECRET), false);
});

test("bounds daemon stderr collection and discards unstructured or oversized content", async () => {
  const f = fixture({ onSpawn: (child) => {
    child.stderr.write(`\n${SECRET.repeat(8192)}\n`);
    child.stderr.write(`${JSON.stringify({ diagnostic: { schemaVersion: 1, component: "background-relay", code: "EACCES" } })}\n`);
    child.emit("close", 1);
  } });
  await f.run();
  const diagnostic = f.writes.find(({ file }) => file.endsWith("last-service-error.json")).value;
  assert.equal(diagnostic.code, "DAEMON_EXITED");
  assert.equal(diagnostic.daemonDiagnostic, undefined);
  assert.equal(diagnostic.daemonDiagnosticTruncated, true);
  assert.equal(JSON.stringify(f.writes).includes(SECRET), false);
});

test("idle exit 75 reloads code without classifying existing work as failed", async () => {
  const f = fixture({ onSpawn: (child) => child.emit("close", 75) });
  await f.run();
  assert.deepEqual(f.delays, [250]);
  assert.equal(f.writes.some(({ file }) => file.endsWith("last-service-error.json")), false);
  const updated = fixture({ settings: { changed: () => true }, onSpawn: (child) => child.emit("close", 75) });
  assert.equal((await updated.run()).status, "reload");
  assert.equal(updated.calls.length, 1);
  assert.equal(updated.releases(), 1);
});

test("preserves disabled configuration and a live service lock", async () => {
  const disabled = fixture();
  disabled.config.enabled = false;
  assert.equal((await disabled.run()).status, "disabled");
  assert.equal(disabled.calls.length, 0);
  const busy = fixture({ settings: { acquireLock: () => ({ acquired: false }) } });
  assert.equal((await busy.run()).status, "already-running");
  assert.equal(busy.calls.length, 0);
});

test("service stop forwards only SIGTERM to its owned child and does not restart it", async () => {
  const f = fixture({ onSpawn: () => f.controller.abort() });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].child.stoppedWith, "SIGTERM");
  assert.deepEqual(f.delays, []);
  assert.equal(f.writes.some(({ file }) => file.endsWith("last-service-error.json")), false);
});

test("locks exclude a second service, reclaim only dead owned locks and preserve foreign state", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-service-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const identity = (pid) => String(pid);
  const first = acquireRelayServiceLock(root, { pid: 101, isAlive: () => true, identity });
  assert.equal(first.acquired, true);
  assert.equal(acquireRelayServiceLock(root, { isAlive: () => true, identity }).acquired, false);
  const reclaimed = acquireRelayServiceLock(root, { pid: 102, isAlive: () => false, identity });
  assert.equal(reclaimed.acquired, true);
  first.release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "service.lock"))).pid, 102);
  reclaimed.release();
  assert.equal(fs.existsSync(path.join(root, "service.lock")), false);
  fs.writeFileSync(path.join(root, "service.lock"), JSON.stringify({ owner: "foreign", pid: 1 }));
  assert.throws(() => acquireRelayServiceLock(root, { isAlive: () => false, identity }), { code: "SERVICE_STORAGE_UNSAFE" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "service.lock"))).owner, "foreign");
});

test("a reused PID cannot strand a stale lock or cause an unrelated process to be killed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-service-pid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = acquireRelayServiceLock(root, { pid: 101, identity: () => "old-start" });
  const replacement = acquireRelayServiceLock(root, { pid: 102, isAlive: () => true, identity: () => "new-start" });
  assert.equal(replacement.acquired, true);
  first.release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "service.lock"))).pid, 102);
  replacement.release();
});

test("migrates package roots only after requesting drain and receiving idle exit", async () => {
  let desiredRoot = process.cwd();
  const nextRoot = path.resolve("new-global-package");
  const relayCalls = [];
  const f = fixture({
    settings: {
      watchIntervalMs: 5,
      readRuntime: () => ({ packageRoot: desiredRoot, nodeExecutable: process.execPath }),
      callRelay: async (method, params, options) => {
        relayCalls.push({ method, params, options });
        assert.equal(f.calls[0].child.stoppedWith, undefined);
        f.calls[0].child.emit("close", 75);
      },
    },
    onSpawn: () => { desiredRoot = nextRoot; },
  });
  const result = await f.run();
  assert.equal(result.status, "reload");
  assert.equal(result.moduleFile, path.join(nextRoot, "src", "background-relay-service.mjs"));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(relayCalls.map(({ method }) => method), ["drain"]);
  assert.equal(relayCalls[0].options.connection.workerId, null);
  assert.equal(f.releases(), 1);
});

test("owned runtime metadata cannot persist credentials or change arbitrary environment variables", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-service-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "service-runtime.json"), JSON.stringify({ schemaVersion: 1, owner: RELAY_SERVICE_OWNER,
    packageRoot: process.cwd(), nodeExecutable: process.execPath, environment: { OPENAI_API_KEY: SECRET } }));
  assert.throws(() => readRelayServiceRuntime(directory), { code: "SERVICE_RUNTIME_INVALID" });
});

test("a same-path version update drains the current daemon and records a new runtime identity", async () => {
  let version = "1.25.3";
  let drains = 0;
  const f = fixture({
    cycles: 2,
    settings: {
      watchIntervalMs: 5,
      readRuntime: () => ({ packageRoot: process.cwd(), nodeExecutable: process.execPath, packageVersion: version }),
      callRelay: async (method) => {
        assert.equal(method, "drain");
        drains++;
        f.calls[0].child.emit("close", 75);
      },
    },
    onSpawn: (child, count) => {
      if (count === 1) version = "1.25.4";
      else child.emit("close", 75);
    },
  });
  await f.run();
  assert.equal(drains, 1);
  assert.equal(f.calls.length, 2);
  const running = f.writes.filter(({ value }) => value.status === "running");
  assert.notEqual(running[0].value.runtimeId, running[1].value.runtimeId);
  assert.ok(f.calls.every(({ child }) => child.stoppedWith === undefined));
});
