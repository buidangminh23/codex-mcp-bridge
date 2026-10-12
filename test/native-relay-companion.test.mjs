import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { it } from "node:test";

import { RelaySocketServer, createNativeRelayLifecycle, createNativeScopeAuthorizer, startRelayWhenAvailable } from "../src/native-relay-companion.mjs";
import { NativeDesktopRelay, responseTooLargeError, MAX_RESPONSE_FRAME_BYTES } from "../src/native-relay.mjs";
import { createReloadControl } from "../src/reload-control.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-reload-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\native-reload-${randomUUID()}` : path.join(directory, "relay.sock");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return socketPath;
}

function nativeStub() {
  return { pending: new Map(), connecting: null, socketPath: "test-native", connect: async () => {}, close() {} };
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition did not settle");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
  }
}

function relayOptions(socketPath) {
  return { socketPath, resolveExecutor: () => ({ threadId: "executor", source: "test" }), dispatch: async () => ({ success: true }) };
}

it("bounds scope metadata reads while requiring exact task and account identity", async () => {
  const root = fs.realpathSync.native(process.cwd());
  const accountContext = { claude: "a".repeat(64), codex: "b".repeat(64) };
  const reads = [];
  let wrongTarget = false;
  const authorize = createNativeScopeAuthorizer({
    env: {
      CODEX_BRIDGE_HARDENED: "1", CODEX_BRIDGE_ALLOWED_ROOTS: root,
      CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_THREAD_POLICY: "roots",
      CODEX_BRIDGE_REMAP: "0", CODEX_BRIDGE_AUTOSTART: "0",
    },
    dispatchDesktop: async ({ executorThreadId, operation, arguments: args }, options) => {
      assert.equal(executorThreadId, "executor");
      assert.deepEqual(options.accountContext, accountContext);
      if (operation === "list_projects") return { success: true, structuredContent: {
        projects: [{ projectId: "project", projectKind: "local", hostId: "local", path: root }],
      } };
      assert.equal(operation, "read_thread");
      reads.push(args);
      return { success: true, structuredContent: { thread: {
        id: wrongTarget && args.threadId === "target" ? "other" : args.threadId,
        kind: "codex", hostId: "local", cwd: root, projectId: "project",
      } } };
    },
  });
  const request = { executorThreadId: "executor", operation: "read_thread", arguments: { threadId: "target" }, accountContext };
  const result = await authorize(request);
  assert.equal(result.executor.threadId, "executor");
  assert.equal(result.targets[0].threadId, "target");
  assert.deepEqual(reads, ["executor", "target"].map((threadId) => ({
    threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1,
  })));
  wrongTarget = true;
  await assert.rejects(() => authorize(request), { code: "NATIVE_SCOPE_UNVERIFIED" });
});

it("keeps disconnected native requests busy until dispatch finishes", async (t) => {
  let release;
  let dispatched;
  const started = new Promise((resolve) => { dispatched = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const server = new RelaySocketServer({
    ...relayOptions(fixture(t)),
    dispatch: async () => { dispatched(); await pending; return { success: true }; },
  });
  const lifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [server] });
  t.after(() => lifecycle.stop());
  await lifecycle.activate();
  const client = net.connect(server.socketPath);
  client.on("error", () => {});
  await once(client, "connect");
  client.write(`${JSON.stringify({ targetThreadId: "destination", message: "once" })}\n`);
  await started;
  client.destroy();
  await waitUntil(() => server.connections.size === 0);
  assert.match(lifecycle.inspect(), /requests are still active/);
  await assert.rejects(lifecycle.quiesce(), /requests are still active/);
  assert.equal(server.started, true);
  release();
  await waitUntil(() => server.handlers.size === 0);
  await lifecycle.activate();
  await lifecycle.quiesce();
  assert.equal(server.started, false);
  assert.deepEqual(lifecycle.exportState(), { ownedSockets: [server.socketPath] });
});

it("prepares a dormant companion and transfers idle listeners through reload control", async (t) => {
  const socketPath = fixture(t);
  const first = new RelaySocketServer(relayOptions(socketPath));
  const oldLifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [first] });
  const oldControl = createReloadControl({ entry: "native-relay-companion.mjs", ...oldLifecycle });
  const second = new RelaySocketServer(relayOptions(socketPath));
  const newLifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [second] });
  const newControl = createReloadControl({
    entry: "native-relay-companion.mjs", ...newLifecycle,
    env: { CODEX_BRIDGE_WORKER: "1", CODEX_BRIDGE_STAGED: "1" }, channel: { send() {} },
  });
  t.after(async () => { await oldLifecycle.stop(); await newLifecycle.stop(); });
  await oldLifecycle.activate();
  assert.equal(first.started, true);
  assert.equal(newControl.staged, true);
  assert.equal(second.started, false);
  assert.equal(oldControl.inspect().reloadable, true);
  const { state } = await oldControl.control("quiesce");
  assert.equal(first.started, false);
  await newControl.control("restore", state);
  assert.equal(second.started, false);
  await newControl.control("activate");
  assert.equal(second.started, true);
  assert.equal(newControl.inspect().reloadable, true);
  const client = net.connect(socketPath);
  let response = "";
  client.on("data", (chunk) => { response += chunk; });
  await once(client, "connect");
  client.write(`${JSON.stringify({ targetThreadId: "destination", message: "after reload" })}\n`);
  await once(client, "close");
  assert.equal(JSON.parse(response).ok, true);
});

it("blocks reload while an accepted client has not sent its frame", async (t) => {
  const server = new RelaySocketServer(relayOptions(fixture(t)));
  const lifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [server] });
  t.after(() => lifecycle.stop());
  await lifecycle.activate();
  const client = net.connect(server.socketPath);
  await once(client, "connect");
  await waitUntil(() => server.connections.size === 1);
  assert.match(lifecycle.inspect(), /clients are still connected/);
  await assert.rejects(lifecycle.quiesce(), /clients are still connected/);
  await lifecycle.activate();
  assert.equal(server.accepting, true);
  client.destroy();
});

it("accepts a healthy shared listener acquired by another companion during owner reload", async (t) => {
  const socketPath = fixture(t);
  const original = new RelaySocketServer(relayOptions(socketPath));
  const shared = new RelaySocketServer(relayOptions(socketPath));
  const replacement = new RelaySocketServer(relayOptions(socketPath));
  const originalLifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [original] });
  const sharedLifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [shared] });
  const replacementLifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [replacement] });
  t.after(async () => { await replacementLifecycle.stop(); await sharedLifecycle.stop(); await originalLifecycle.stop(); });
  await originalLifecycle.activate();
  await originalLifecycle.quiesce();
  await sharedLifecycle.activate();
  replacementLifecycle.restore(originalLifecycle.exportState());
  await replacementLifecycle.activate();
  assert.equal(replacement.started, false);
  assert.equal(shared.started, true);
  assert.equal(await replacement.isListening(), true);
  assert.equal(replacementLifecycle.inspect(), null);
  const client = net.connect(socketPath);
  let response = "";
  client.on("data", (chunk) => { response += chunk; });
  await once(client, "connect");
  client.write(`${JSON.stringify({ targetThreadId: "destination", message: "during simultaneous reload" })}\n`);
  await once(client, "close");
  assert.equal(JSON.parse(response).ok, true);
});

it("rejects a missing formerly owned listener when rebinding fails", async (t) => {
  const server = new RelaySocketServer(relayOptions(fixture(t)));
  server.start = async () => { throw new Error("listener bind failed"); };
  const lifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [server] });
  t.after(() => lifecycle.stop());
  lifecycle.restore({ ownedSockets: [server.socketPath] });
  await assert.rejects(lifecycle.activate(), /could not reclaim its listening sockets/);
  assert.equal(await server.isListening(), false);
});

it("rejects failed native connectivity even when another companion owns the listener", async (t) => {
  const socketPath = fixture(t);
  const shared = new RelaySocketServer(relayOptions(socketPath));
  const replacement = new RelaySocketServer(relayOptions(socketPath));
  const nativeTools = { ...nativeStub(), connect: async () => { throw new Error("native Desktop unavailable"); } };
  const lifecycle = createNativeRelayLifecycle({ nativeTools, relays: [replacement] });
  t.after(async () => { await lifecycle.stop(); shared.stop(); await shared.closed; });
  await shared.start();
  lifecycle.restore({ ownedSockets: [socketPath] });
  await assert.rejects(lifecycle.activate(), /could not reclaim its listening sockets/);
  assert.equal(shared.started, true);
});

it("waits for pending listener startup to unwind after cancellation", async () => {
  let finishStart;
  let listening = false;
  const relay = {
    closed: Promise.resolve(),
    async start() { await new Promise((resolve) => { finishStart = resolve; }); listening = true; },
    stop() { listening = false; },
  };
  const startup = startRelayWhenAvailable({ nativeTools: nativeStub(), relay });
  await waitUntil(() => finishStart !== undefined);
  let stopped = false;
  const stop = startup.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  finishStart();
  await stop;
  assert.equal(listening, false);
  assert.equal(startup.busy, false);
});

it("rejects listener state for a different endpoint", (t) => {
  const server = new RelaySocketServer(relayOptions(fixture(t)));
  const lifecycle = createNativeRelayLifecycle({ nativeTools: nativeStub(), relays: [server] });
  for (const payload of [{}, { ownedSockets: ["unknown"] }, { ownedSockets: [], unexpected: true }, { ownedSockets: [server.socketPath, server.socketPath] }]) {
    assert.throws(() => lifecycle.restore(payload), /listener state/);
  }
});

it("bounds the serialized companion response before writing and preserves overflow details", async (t) => {
  const result = { text: "x".repeat(MAX_RESPONSE_FRAME_BYTES) };
  const server = new RelaySocketServer({ ...relayOptions(fixture(t)), dispatchDesktop: async () => ({ success: true, structuredContent: result }) });
  await server.start();
  t.after(() => server.stop());
  const relay = new NativeDesktopRelay({ socketPath: server.socketPath, env: {} });
  await assert.rejects(relay.requestDesktop("read_thread", { threadId: "target" }), (error) => {
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    assert.equal(error.boundary, "companion-to-bridge");
    assert.equal(error.limit, MAX_RESPONSE_FRAME_BYTES);
    assert.equal(error.bytes, Buffer.byteLength(JSON.stringify({ ok: true, v: 1, operation: "read_thread", executorThreadId: "executor", result }) + "\n"));
    assert.equal(error.reachedCompanion, true);
    return true;
  });
});

it("carries native overflow through the companion without a resend", async (t) => {
  let calls = 0;
  const server = new RelaySocketServer({ ...relayOptions(fixture(t)), dispatchDesktop: async () => { calls++; throw responseTooLargeError("native-pipe", MAX_RESPONSE_FRAME_BYTES + 1); } });
  await server.start();
  t.after(() => server.stop());
  const relay = new NativeDesktopRelay({ socketPath: server.socketPath, env: {} });
  await assert.rejects(relay.requestDesktop("read_thread", { threadId: "target" }), { code: "RESPONSE_TOO_LARGE", boundary: "native-pipe", bytes: MAX_RESPONSE_FRAME_BYTES + 1, limit: MAX_RESPONSE_FRAME_BYTES });
  assert.equal(calls, 1);
});

it("rejects over-limit bytes from an older companion response reader", async (t) => {
  const socketPath = fixture(t);
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(Buffer.alloc(MAX_RESPONSE_FRAME_BYTES + 1, 120)));
  });
  server.listen(socketPath);
  await once(server, "listening");
  t.after(() => server.close());
  const relay = new NativeDesktopRelay({ socketPath, env: {} });
  await assert.rejects(relay.requestDesktop("read_thread", { threadId: "target" }), (error) => {
    assert.equal(error.code, "RESPONSE_TOO_LARGE");
    assert.equal(error.boundary, "companion-to-bridge");
    assert.equal(error.limit, MAX_RESPONSE_FRAME_BYTES);
    assert.ok(error.bytes > MAX_RESPONSE_FRAME_BYTES);
    return true;
  });
});
