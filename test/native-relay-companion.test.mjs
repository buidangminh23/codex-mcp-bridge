import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { it } from "node:test";

import { RelaySocketServer, createNativeRelayLifecycle, startRelayWhenAvailable } from "../src/native-relay-companion.mjs";
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
