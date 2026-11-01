import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callBackgroundRelay } from "../src/background-relay-client.mjs";
import { serveBackgroundRelay } from "../src/background-relay.mjs";
import { relayFailure } from "../src/background-relay-config.mjs";
import { relayHello, relayChallenge, relayOperation, relayResponse, verifyRelayChallenge, verifyRelayOperation, verifyRelayResponse } from "../src/background-relay-protocol.mjs";

const TOKEN = "fixture-private-relay-secret-not-on-the-wire";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wire-"));
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\relay-wire-${randomUUID()}` : path.join(directory, "relay.sock");
  const calls = [];
  const relay = {
    config: { endpoint, token: TOKEN },
    transportSecret: options.secret ?? (() => TOKEN),
    async handle(request) { calls.push(request); assert.equal(request.token, TOKEN); return options.handle ? options.handle(request) : { accepted: true }; },
  };
  const sockets = new Set();
  const serving = options.server ? { server: net.createServer(options.server) } : await serveBackgroundRelay(relay, { protectPipe: async () => {} });
  if (options.server) await new Promise((resolve, reject) => { serving.server.once("error", reject); serving.server.listen(endpoint, resolve); });
  serving.server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (serving.close) await serving.close();
    else await new Promise(resolve => serving.server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { endpoint, calls, connection: { endpoint, token: TOKEN, workerId: null } };
}

function signedServer(handler) {
  return socket => {
    socket.setEncoding("utf8");
    let buffer = "";
    let hello;
    let challenge;
    socket.on("data", data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!hello) { hello = frame; challenge = relayChallenge(TOKEN, hello); socket.write(JSON.stringify(challenge) + "\n"); }
        else handler(socket, frame, hello, challenge);
      }
    });
  };
}

test("mutual authentication carries no bearer token and signs one operation and receipt", async t => {
  const box = await fixture(t);
  const wire = [];
  const result = await callBackgroundRelay("send", { prompt: "Private fixture task" }, { connection: box.connection, connect(endpoint) {
    const socket = net.createConnection(endpoint);
    const write = socket.write.bind(socket);
    socket.write = data => { wire.push(String(data)); return write(data); };
    return socket;
  } });
  assert.deepEqual(result, { accepted: true });
  assert.equal(box.calls.length, 1);
  assert.equal(wire.length, 2);
  assert.equal(JSON.parse(wire[0]).type, "hello");
  assert.equal(JSON.parse(wire[1]).type, "operation");
  assert.equal(wire[0].includes("Private fixture task"), false);
  assert.equal(wire.join("").includes(TOKEN), false);
});

test("an impersonated endpoint never receives the operation or bearer secret", async t => {
  const frames = [];
  const box = await fixture(t, { server: socket => socket.on("data", data => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    socket.write(JSON.stringify(relayChallenge("wrong-secret", frame)) + "\n");
  }) });
  let connects = 0;
  await assert.rejects(callBackgroundRelay("send", { prompt: "Must remain local" }, { connection: box.connection, connect(endpoint) { connects++; return net.createConnection(endpoint); } }), { code: "WORKER_RELAY_AUTH_FAILED", deliveryState: "not_sent", sent: false });
  assert.equal(connects, 1);
  assert.equal(frames.length, 1);
  assert.equal(JSON.stringify(frames).includes(TOKEN), false);
  assert.equal(JSON.stringify(frames).includes("Must remain local"), false);
});

test("tampered operations cannot execute and post-write uncertainty is never retried", async t => {
  const box = await fixture(t);
  let connects = 0;
  await assert.rejects(callBackgroundRelay("send", { prompt: "Original" }, { connection: box.connection, connect(endpoint) {
    connects++;
    const socket = net.createConnection(endpoint);
    const write = socket.write.bind(socket);
    socket.write = data => {
      const frame = JSON.parse(String(data));
      if (frame.type === "operation") frame.operation.params.prompt = "Tampered";
      return write(JSON.stringify(frame) + "\n");
    };
    return socket;
  } }), { code: "WORKER_RELAY_INTERRUPTED", deliveryState: "unknown", sent: null });
  assert.equal(connects, 1);
  assert.equal(box.calls.length, 0);
});

test("server nonces and domain separation reject replayed requests and reflected proofs", () => {
  const hello = relayHello();
  const first = relayChallenge(TOKEN, hello);
  const second = relayChallenge(TOKEN, hello);
  assert.notEqual(first.serverNonce, second.serverNonce);
  const operation = { schemaVersion: 1, id: hello.id, workerId: null, clientPid: 1, method: "status", params: {} };
  const frame = relayOperation(TOKEN, hello, first, operation);
  assert.equal(verifyRelayOperation(TOKEN, hello, first, frame), true);
  assert.equal(verifyRelayOperation(TOKEN, hello, second, frame), false);
  assert.equal(verifyRelayOperation(TOKEN, hello, first, { ...frame, proof: first.proof }), false);
  const response = relayResponse(TOKEN, hello, first, { schemaVersion: 1, id: hello.id, result: {} });
  assert.equal(verifyRelayResponse(TOKEN, hello, first, response), true);
  assert.equal(verifyRelayResponse(TOKEN, hello, second, response), false);
  assert.equal(verifyRelayChallenge(TOKEN, relayHello(), first), false);
});

test("tampered replies and post-operation disconnects remain unknown without replay", async t => {
  for (const tamper of [false, true]) {
    let connects = 0;
    const box = await fixture(t, { server: signedServer((socket, frame, hello, challenge) => {
      if (!tamper) { socket.destroy(); return; }
      const response = relayResponse(TOKEN, hello, challenge, { schemaVersion: 1, id: hello.id, result: { okay: true } });
      response.response.result.okay = false;
      socket.end(JSON.stringify(response) + "\n");
    }) });
    await assert.rejects(callBackgroundRelay("send", {}, { connection: box.connection, connect(endpoint) { connects++; return net.createConnection(endpoint); } }), { deliveryState: "unknown", sent: null });
    assert.equal(connects, 1);
  }
});

test("authenticated provider errors are returned once with their diagnostic", async t => {
  const box = await fixture(t, { handle: () => { throw relayFailure("WORKER_QUEUE_FULL", "The fixture queue is full"); } });
  let connects = 0;
  await assert.rejects(callBackgroundRelay("send", {}, { connection: box.connection, connect(endpoint) { connects++; return net.createConnection(endpoint); } }), error => error.code === "WORKER_QUEUE_FULL" && error.deliveryState === "not_sent" && error.diagnostic.code === "WORKER_QUEUE_FULL");
  assert.equal(connects, 1);
  assert.equal(box.calls.length, 1);
});

test("a worker capability is revalidated immediately before operation dispatch", async t => {
  let checks = 0;
  const box = await fixture(t, { secret: () => { if (++checks > 1) throw relayFailure("WORKER_IDENTITY_INVALID", "Expired fixture capability"); return TOKEN; } });
  await assert.rejects(callBackgroundRelay("send", {}, { connection: { ...box.connection, workerId: randomUUID() } }), { code: "WORKER_IDENTITY_INVALID", deliveryState: "not_sent" });
  assert.equal(checks, 2);
  assert.equal(box.calls.length, 0);
});

test("transient pre-connect failures retry at most twelve times under one deadline", async t => {
  const box = await fixture(t);
  let attempts = 0;
  const result = await callBackgroundRelay("status", {}, { connection: box.connection, connect(endpoint) {
    if (++attempts < 3) throw Object.assign(new Error("Starting"), { code: "ENOENT" });
    return net.createConnection(endpoint);
  } });
  assert.equal(result.accepted, true);
  assert.equal(attempts, 3);
  let exhausted = 0;
  await assert.rejects(callBackgroundRelay("send", {}, { connection: box.connection, timeoutMs: 20000, connect() { exhausted++; throw Object.assign(new Error("Unavailable"), { code: "ECONNREFUSED" }); } }), { code: "WORKER_RELAY_UNAVAILABLE", deliveryState: "not_sent" });
  assert.equal(exhausted, 12);
  let bounded = 0;
  await assert.rejects(callBackgroundRelay("send", {}, { connection: box.connection, timeoutMs: 25, connect() { bounded++; throw Object.assign(new Error("Unavailable"), { code: "ENOENT" }); } }), { code: "WORKER_RELAY_TIMEOUT", deliveryState: "not_sent" });
  await pause(300);
  assert.equal(bounded, 1);
});

test("permanent failures and partial or malformed replies are not retried", async t => {
  const box = await fixture(t);
  let denied = 0;
  await assert.rejects(callBackgroundRelay("send", {}, { connection: box.connection, connect() { denied++; throw Object.assign(new Error("Denied"), { code: "EACCES" }); } }), { deliveryState: "not_sent" });
  assert.equal(denied, 1);
  for (const reply of ["{", "invalid JSON\n"]) {
    const broken = await fixture(t, { server: socket => socket.once("data", () => socket.end(reply)) });
    let connected = 0;
    await assert.rejects(callBackgroundRelay("send", {}, { connection: broken.connection, connect(endpoint) { connected++; return net.createConnection(endpoint); } }), { code: reply.includes("\n") ? "WORKER_REPLY_INVALID" : "WORKER_RELAY_INTERRUPTED", deliveryState: "not_sent" });
    assert.equal(connected, 1);
  }
});

test("normal update gaps recover through unavailable reset and hello-only closes without replaying work", async t => {
  let connections = 0;
  let attempts = 0;
  let operations = 0;
  const wire = [];
  const serve = signedServer((socket, frame, hello, challenge) => {
    assert.equal(verifyRelayOperation(TOKEN, hello, challenge, frame), true);
    operations++;
    socket.end(JSON.stringify(relayResponse(TOKEN, hello, challenge, { schemaVersion: 1, id: hello.id, result: { recovered: true } })) + "\n");
  });
  const box = await fixture(t, { server: socket => {
    if (++connections <= 2) socket.once("data", () => socket.destroy());
    else serve(socket);
  } });
  const result = await callBackgroundRelay("send", { prompt: "Authorized update-gap fixture" }, { connection: box.connection, connect(endpoint) {
    attempts++;
    if (attempts <= 2) throw Object.assign(new Error("Reloading"), { code: attempts === 1 ? "ENOENT" : "ECONNRESET" });
    const socket = net.createConnection(endpoint);
    const write = socket.write.bind(socket);
    socket.write = data => { wire.push(JSON.parse(String(data))); return write(data); };
    return socket;
  } });
  assert.deepEqual(result, { recovered: true });
  assert.equal(attempts, 5);
  assert.equal(connections, 3);
  assert.equal(operations, 1);
  assert.equal(wire.filter(frame => frame.type === "operation").length, 1);
  const hellos = wire.filter(frame => frame.type === "hello");
  assert.equal(new Set(hellos.map(frame => frame.id)).size, 1);
  assert.equal(new Set(hellos.map(frame => frame.clientNonce)).size, 3);
  assert.equal(JSON.stringify(wire).includes(TOKEN), false);
});

test("hello-only recovery cannot extend the original deadline or send an operation", async t => {
  const box = await fixture(t, { server: socket => socket.once("data", () => socket.destroy()) });
  const frames = [];
  let attempts = 0;
  const started = Date.now();
  await assert.rejects(callBackgroundRelay("send", { prompt: "Never dispatched" }, { connection: box.connection, timeoutMs: 600, connect(endpoint) {
    attempts++;
    const socket = net.createConnection(endpoint);
    const write = socket.write.bind(socket);
    socket.write = data => { frames.push(JSON.parse(String(data))); return write(data); };
    return socket;
  } }), { code: "WORKER_RELAY_TIMEOUT", deliveryState: "not_sent", sent: false });
  assert.ok(attempts >= 1 && attempts <= 12);
  assert.ok(Date.now() - started < 2000);
  assert.ok(frames.length > 0);
  assert.ok(frames.every(frame => frame.type === "hello"));
});

test("extra and oversized unauthenticated frames fail before broker dispatch", async t => {
  const box = await fixture(t);
  for (const wire of [JSON.stringify(relayHello()) + "\n" + JSON.stringify(relayHello()) + "\n", "x".repeat(4097)]) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(box.endpoint);
      socket.on("error", reject);
      socket.once("connect", () => socket.write(wire));
      socket.once("close", resolve);
    });
  }
  assert.equal(box.calls.length, 0);
});
