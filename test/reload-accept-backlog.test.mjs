import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";

import { RelaySocketServer, createNativeRelayLifecycle } from "../src/native-relay-companion.mjs";
import { NativeDesktopRelay } from "../src/native-relay.mjs";
import { PeerEndpoint, buildFrame } from "../src/peer-protocol.mjs";

const skip = process.platform === "win32" && "named pipes cannot be withdrawn from the namespace before the listener closes";
const realHome = process.env.HOME;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reload-backlog-"));

before(() => {
  process.env.HOME = sandbox;
  fs.mkdirSync(path.join(sandbox, ".claude", "sessions"), { recursive: true });
});

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeWhileBlocked(socketPath, payload) {
  execFileSync(process.execPath, ["-e", "const s = require('node:net').connect(process.argv[1], () => s.end(process.argv[2], () => process.exit(0))); s.on('error', (e) => { console.error(e.message); process.exit(3); });", socketPath, payload], { timeout: 10000 });
}

it("answers a relay client queued in the accept backlog during quiesce instead of resetting it", { skip }, async (t) => {
  let dispatched = 0;
  const server = new RelaySocketServer({ socketPath: path.join(sandbox, "relay.sock"), resolveExecutor: () => ({ threadId: "executor", source: "test" }),
    dispatch: async () => { dispatched++; return { success: true }; } });
  const lifecycle = createNativeRelayLifecycle({ nativeTools: { pending: new Map(), connecting: null, socketPath: "test-native", connect: async () => {}, close() {} }, relays: [server] });
  t.after(() => lifecycle.stop());
  await lifecycle.activate();
  const client = new NativeDesktopRelay({ socketPath: server.socketPath, timeoutMs: 5000 });
  const sent = client.sendMessage("destination", "queued during reload").then((value) => ({ value }), (error) => ({ error }));
  await lifecycle.quiesce();
  const outcome = await sent;
  assert.notEqual(outcome.error?.code, "RELAY_DELIVERY_UNCONFIRMED", outcome.error?.message);
  if (outcome.error) {
    assert.equal(outcome.error.code, "RELAY_RELOADING");
    assert.equal(dispatched, 0);
  } else assert.equal(dispatched, 1);
  assert.deepEqual(lifecycle.exportState(), { ownedSockets: [server.socketPath] });
  assert.equal(fs.existsSync(server.socketPath), false);
});

it("keeps a peer message that was queued in the accept backlog before quiesce", { skip }, async (t) => {
  const endpoint = new PeerEndpoint({ name: "backlog-peer", cwd: sandbox });
  t.after(() => endpoint.stop());
  await endpoint.start();
  const frame = buildFrame({ text: "written while the bridge was busy", fromSocket: path.join(sandbox, "sender.sock") });
  writeWhileBlocked(endpoint.socketPath, `${JSON.stringify({ type: "auth", token: endpoint.peerToken })}\n${JSON.stringify(frame)}\n`);
  await endpoint.quiesce();
  const state = endpoint.exportReloadState();
  assert.deepEqual(state.inbox.map((entry) => entry.msgId), [frame.msg_id]);
  assert.equal(fs.existsSync(endpoint.socketPath), false);
});

it("restarts a withdrawn peer listener when a late connection keeps the reload from completing", { skip }, async (t) => {
  const endpoint = new PeerEndpoint({ name: "late-peer", cwd: sandbox });
  t.after(() => endpoint.stop());
  await endpoint.start();
  const net = await import("node:net");
  const idle = net.connect(endpoint.socketPath);
  idle.on("error", () => {});
  await new Promise((resolve) => idle.once("connect", resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(endpoint.quiesce(), /connections are still open/);
  idle.destroy();
  await endpoint.resume();
  assert.equal(fs.existsSync(endpoint.socketPath), true);
  assert.equal(endpoint.started, true);
});

it("keeps the socket of a companion that binds the relay path while a reload drains", { skip }, async (t) => {
  const socketPath = path.join(sandbox, "shared.sock");
  const options = { socketPath, resolveExecutor: () => ({ threadId: "executor", source: "test" }), dispatch: async () => ({ success: true }) };
  const previous = new RelaySocketServer(options);
  const successor = new RelaySocketServer(options);
  t.after(async () => { previous.stop(); successor.stop(); await Promise.all([previous.closed, successor.closed]); });
  await previous.start();
  previous.accepting = false;
  previous.withdraw();
  await successor.start();
  previous.stop();
  await previous.closed;
  assert.equal(fs.existsSync(socketPath), true);
  const outcome = await new NativeDesktopRelay({ socketPath, timeoutMs: 5000 }).sendMessage("destination", "after the old listener closed");
  assert.equal(outcome.ok ?? true, true);
});
