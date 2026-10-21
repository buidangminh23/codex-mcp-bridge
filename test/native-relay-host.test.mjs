import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { RelaySocketServer, createNativeRelayLifecycle, createRelayHandoff } from "../src/native-relay-companion.mjs";
import { evictRelayHost, readRelayOwner, relayOwnerPath, spawnRelayHost, writeRelayOwner } from "../src/native-relay-owner.mjs";
import { runRelayHost } from "../src/native-relay-host.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = process.platform !== "win32";

function shortDirectory(t) {
  const directory = fs.mkdtempSync(path.join(posix ? "/tmp" : os.tmpdir(), "nrh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function fakeDesktopPipe(t, directory) {
  const pipePath = path.join(directory, `p-${randomBytes(3).toString("hex")}.sock`);
  const sockets = new Set();
  const server = net.createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); });
  await new Promise((resolve) => server.listen(pipePath, resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  return { pipePath, close };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function eventually(predicate, timeoutMs = 15000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${label} did not settle within ${timeoutMs} ms`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
}

function socketLive(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect({ path: socketPath });
    const done = (answer) => { probe.destroy(); resolve(answer); };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

function relayEnvironment(directory, pipePath) {
  const codexHome = path.join(directory, "h");
  fs.mkdirSync(codexHome, { recursive: true });
  return {
    ...process.env,
    HOME: directory,
    CODEX_HOME: codexHome,
    CODEX_NATIVE_RELAY_SOCKET: path.join(directory, "r.sock"),
    CODEX_APP_TOOLS_PIPE_PATH: pipePath,
    CODEX_BRIDGE_DESKTOP_TASKS: "0",
    CODEX_BRIDGE_HARDENED: "0",
    CODEX_NATIVE_RELAY_DETACH: "1",
  };
}

function socketsFor(env) {
  const relay = env.CODEX_NATIVE_RELAY_SOCKET;
  return [relay, `${relay}-accounts-v2`];
}

function startCompanion(t, env) {
  const child = spawn(process.execPath, [path.join(repository, "src", "native-relay-companion.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  return { child, stderr: () => stderr };
}

function killHosts(t, env) {
  t.after(() => {
    for (const socket of socketsFor(env)) {
      const owner = readRelayOwner(socket);
      if (owner?.role === "host" && alive(owner.pid)) { try { process.kill(owner.pid, "SIGKILL"); } catch {} }
    }
  });
}

describe("detached native relay host", { skip: !posix && "POSIX sockets only" }, () => {
  it("keeps the relay listening after the companion's MCP client closes while Codex Desktop is running", { timeout: 60000 }, async (t) => {
    const directory = shortDirectory(t);
    const desktop = await fakeDesktopPipe(t, directory);
    const env = relayEnvironment(directory, desktop.pipePath);
    killHosts(t, env);
    const companion = startCompanion(t, env);
    await eventually(async () => (await Promise.all(socketsFor(env).map(socketLive))).every(Boolean), 15000, "companion sockets");
    for (const socket of socketsFor(env)) assert.deepEqual(readRelayOwner(socket), { pid: companion.child.pid, role: "companion" });
    companion.child.stdin.end();
    await eventually(() => companion.child.exitCode !== null, 45000, "companion exit");
    assert.match(companion.stderr(), /handed the relay sockets to the detached native relay host/);
    const hostPid = await eventually(() => {
      const owners = socketsFor(env).map(readRelayOwner);
      return owners.every((owner) => owner?.role === "host" && owner.pid === owners[0].pid) ? owners[0].pid : null;
    }, 15000, "host ownership");
    assert.notEqual(hostPid, companion.child.pid);
    for (const socket of socketsFor(env)) assert.equal(await socketLive(socket), true, socket);
    await desktop.close();
    await eventually(() => !alive(hostPid), 30000, "host exit after Desktop quit");
    for (const socket of socketsFor(env)) {
      assert.equal(fs.existsSync(socket), false, socket);
      assert.equal(fs.existsSync(relayOwnerPath(socket)), false, relayOwnerPath(socket));
    }
    assert.match(fs.readFileSync(path.join(env.CODEX_HOME, "native-relay-host.log"), "utf8"), /Codex Desktop pipe is gone/);
  });

  it("lets a newly launched companion take the sockets back from the detached host", { timeout: 90000 }, async (t) => {
    const directory = shortDirectory(t);
    const desktop = await fakeDesktopPipe(t, directory);
    const env = relayEnvironment(directory, desktop.pipePath);
    killHosts(t, env);
    const hostPid = spawnRelayHost({ pipePath: desktop.pipePath, env });
    await eventually(() => socketsFor(env).every((socket) => readRelayOwner(socket)?.pid === hostPid), 15000, "host ownership");
    const companion = startCompanion(t, env);
    await eventually(() => socketsFor(env).every((socket) => readRelayOwner(socket)?.pid === companion.child.pid), 40000, "companion takeover");
    await eventually(() => !alive(hostPid), 30000, "evicted host exit");
    assert.match(companion.stderr(), /took .* over from the detached native relay host/);
    for (const socket of socketsFor(env)) assert.equal(await socketLive(socket), true, socket);
  });

  it("does not detach when Codex Desktop is gone or detaching is disabled", { timeout: 60000 }, async (t) => {
    for (const [name, disable] of [["gone", false], ["disabled", true]]) {
      const directory = shortDirectory(t);
      const desktop = await fakeDesktopPipe(t, directory);
      const env = { ...relayEnvironment(directory, desktop.pipePath), ...(disable ? { CODEX_NATIVE_RELAY_DETACH: "0" } : {}) };
      killHosts(t, env);
      const companion = startCompanion(t, env);
      await eventually(async () => (await Promise.all(socketsFor(env).map(socketLive))).every(Boolean), 15000, `${name} sockets`);
      if (!disable) await desktop.close();
      companion.child.stdin.end();
      await eventually(() => companion.child.exitCode !== null, 45000, `${name} companion exit`);
      assert.doesNotMatch(companion.stderr(), /handed the relay sockets/, name);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
      for (const socket of socketsFor(env)) {
        assert.equal(fs.existsSync(socket), false, `${name} ${socket}`);
        assert.equal(readRelayOwner(socket), null, `${name} ${socket}`);
      }
    }
  });

  it("refuses to host when the Desktop pipe is unreachable or a companion already owns the socket", async (t) => {
    const directory = shortDirectory(t);
    const unreachable = await runRelayHost({ pipePath: path.join(directory, "missing.sock"), servers: { relays: [] } });
    assert.equal(unreachable.started, false);
    assert.equal(await unreachable.done, 0);

    const socketPath = path.join(directory, "owned.sock");
    const owner = new RelaySocketServer({ socketPath, dispatch: async () => ({ success: true }), resolveExecutor: () => ({ threadId: "e" }), signalExit: false });
    await owner.start();
    t.after(() => owner.stop());
    const contender = new RelaySocketServer({ socketPath, dispatch: async () => ({ success: true }), resolveExecutor: () => ({ threadId: "e" }), role: "host", signalExit: false });
    const nativeTools = { pending: new Map(), connecting: null, close() {} };
    const refused = await runRelayHost({ pipePath: socketPath, nativeTools, servers: { relays: [contender] }, reachable: async () => true });
    assert.equal(refused.started, false);
    assert.deepEqual(readRelayOwner(socketPath), { pid: process.pid, role: "companion" });
    assert.equal(await socketLive(socketPath), true);
  });

  it("drains an accepted delivery before a host shuts down and stops when another owner replaces the socket", async (t) => {
    const directory = shortDirectory(t);
    const socketPath = path.join(directory, "drain.sock");
    let release;
    let started;
    const dispatched = new Promise((resolve) => { started = resolve; });
    const server = new RelaySocketServer({
      socketPath, role: "host", signalExit: false, resolveExecutor: () => ({ threadId: "executor" }),
      dispatch: async () => { started(); await new Promise((resolve) => { release = resolve; }); return { success: true }; },
    });
    const nativeTools = { pending: new Map(), connecting: null, close() {} };
    const host = await runRelayHost({ pipePath: socketPath, nativeTools, servers: { relays: [server] }, reachable: async () => true, watchMs: 20, pollMs: 5 });
    assert.equal(host.started, true);
    const client = net.connect(socketPath);
    client.on("error", () => {});
    const reply = new Promise((resolve) => { let data = ""; client.on("data", (chunk) => { data += chunk; }); client.on("end", () => resolve(data)); });
    client.write(`${JSON.stringify({ targetThreadId: "destination", message: "once" })}\n`);
    await dispatched;
    const stopping = host.shutdown("SIGTERM");
    const late = net.connect(socketPath);
    late.on("error", () => {});
    const [refusal] = await new Promise((resolve) => late.once("data", (...args) => resolve(args)));
    assert.equal(JSON.parse(refusal).error.code, "RELAY_STOPPING");
    late.destroy();
    release();
    assert.equal(JSON.parse(await reply).ok, true);
    assert.equal(await stopping, 0);
    assert.equal(fs.existsSync(socketPath), false);

    const replacedPath = path.join(directory, "replaced.sock");
    const replaced = new RelaySocketServer({ socketPath: replacedPath, role: "host", signalExit: false, resolveExecutor: () => ({ threadId: "e" }), dispatch: async () => ({ success: true }) });
    const watcher = await runRelayHost({ pipePath: replacedPath, nativeTools, servers: { relays: [replaced] }, reachable: async () => true, watchMs: 20 });
    fs.rmSync(replacedPath, { force: true });
    fs.writeFileSync(replacedPath, "");
    assert.equal(await watcher.done, 0);
    fs.rmSync(replacedPath, { force: true });
  });

  it("evicts only a verified detached host and never a companion or an unrelated process", async (t) => {
    const directory = shortDirectory(t);
    const socketPath = path.join(directory, "evict.sock");
    const signals = [];
    writeRelayOwner(socketPath, "companion", { pid: process.pid });
    assert.equal(await evictRelayHost(socketPath, { isLive: async () => true, signal: (pid) => signals.push(pid) }), false);
    writeRelayOwner(socketPath, "host", { pid: process.pid });
    assert.equal(await evictRelayHost(socketPath, { isLive: async () => true, signal: (pid) => signals.push(pid) }), false);
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    t.after(() => sleeper.kill("SIGKILL"));
    writeRelayOwner(socketPath, "host", { pid: sleeper.pid });
    assert.equal(await evictRelayHost(socketPath, { isLive: async () => true, signal: (pid) => signals.push(pid) }), false);
    assert.deepEqual(signals, []);
    assert.equal(await evictRelayHost(socketPath, {
      isLive: async () => false, readArguments: async () => `${process.execPath} /x/native-relay-host.mjs`, signal: (pid) => signals.push(pid), waitMs: 200,
    }), true);
    assert.deepEqual(signals, [sleeper.pid]);
    fs.writeFileSync(relayOwnerPath(socketPath), "not json");
    assert.equal(readRelayOwner(socketPath), null);
  });

  it("hands off only when it owned the sockets and the Desktop pipe answers", async () => {
    const stopped = [];
    const spawned = [];
    const lifecycle = { stop: async () => { stopped.push(true); } };
    const owning = [{ ownsPublicPath: () => true }];
    const cases = [
      [{ relays: owning, reachable: async () => true, enabled: true }, 1],
      [{ relays: [{ ownsPublicPath: () => false }], reachable: async () => true, enabled: true }, 0],
      [{ relays: owning, reachable: async () => false, enabled: true }, 0],
      [{ relays: owning, reachable: async () => true, enabled: false }, 0],
    ];
    for (const [options, expected] of cases) {
      spawned.length = 0;
      const handOff = createRelayHandoff({ lifecycle, pipePath: "/tmp/desktop.sock", spawnHost: ({ pipePath }) => { spawned.push(pipePath); return 42; }, ...options });
      await handOff();
      assert.equal(spawned.length, expected);
    }
    assert.equal(stopped.length, cases.length);
    const failing = createRelayHandoff({ lifecycle, relays: owning, pipePath: "/tmp/desktop.sock", enabled: true, reachable: async () => true, spawnHost: () => { throw new Error("spawn failed"); } });
    assert.equal(await failing(), null);
    assert.throws(() => spawnRelayHost({ pipePath: "relative.sock" }), /absolute/);
  });

  it("keeps the lifecycle refusal generic for a shutting-down host", async (t) => {
    const directory = shortDirectory(t);
    const server = new RelaySocketServer({ socketPath: path.join(directory, "g.sock"), role: "host", signalExit: false, resolveExecutor: () => ({ threadId: "e" }), dispatch: async () => ({ success: true }) });
    const lifecycle = createNativeRelayLifecycle({ nativeTools: { pending: new Map(), connecting: null, close() {} }, relays: [server] });
    lifecycle.refuseNewDeliveries();
    await assert.rejects(lifecycle.activate(), /^Error: The native relay is shutting down$/);
  });
});

describe("relay listener startup failures", { skip: !posix && "POSIX sockets only" }, () => {
  it("removes the linked public socket when startup is refused or cancelled", async (t) => {
    const directory = shortDirectory(t);
    const refusedPath = path.join(directory, "refused.sock");
    const refused = new RelaySocketServer({ socketPath: refusedPath, signalExit: false, restrictSocket: () => { throw new Error("chmod denied"); }, resolveExecutor: () => ({ threadId: "e" }), dispatch: async () => ({ success: true }) });
    await assert.rejects(refused.start(), /could not be restricted/);
    assert.equal(fs.existsSync(refusedPath), false);
    assert.equal(readRelayOwner(refusedPath), null);

    const cancelledPath = path.join(directory, "cancelled.sock");
    let cancel;
    const cancelled = new RelaySocketServer({ socketPath: cancelledPath, signalExit: false, restrictSocket: () => cancel(), resolveExecutor: () => ({ threadId: "e" }), dispatch: async () => ({ success: true }) });
    cancel = () => cancelled.stop();
    await assert.rejects(cancelled.start(), /could not be restricted/);
    assert.equal(fs.existsSync(cancelledPath), false);
  });
});
