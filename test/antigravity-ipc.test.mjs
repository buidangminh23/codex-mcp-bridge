import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { antigravitySocket, callAntigravityDesktop, serveAntigravityDesktop } from "../src/antigravity-ipc.mjs";
import { bridgeDiagnostic } from "../src/recipient-preflight.mjs";

const FRAME_LIMIT = 2 * 1024 * 1024;

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-ipc-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    const resolved = fs.realpathSync.native(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("antigravity-ipc-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return directory;
}

async function sendRawUntilClosed(socketPath, bytes) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Oversized input was not disconnected")); }, 3000);
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", () => { socket.destroy(); reject(new Error("Oversized input unexpectedly received a response")); });
    socket.on("error", (error) => { if (!["ECONNRESET", "EPIPE"].includes(error.code)) reject(error); });
    socket.on("close", () => { clearTimeout(timer); resolve(); });
  });
}

test("private desktop IPC preserves results, delivery uncertainty and frame bounds", { timeout: 60000 }, async (t) => {
  const directory = fixture(t);
  let calls = 0;
  const service = await serveAntigravityDesktop(async (request) => {
    calls++;
    if (request.operation === "echo") return { received: request.value };
    if (request.operation === "preflight") throw Object.assign(new Error("Recipient is busy"), { code: "ANTIGRAVITY_CONVERSATION_BUSY", phase: "preflight", deliveryState: "not_sent" });
    if (request.operation === "uncertain") throw new Error("Native connection disappeared");
    if (request.operation === "private-failure") {
      const error = Object.assign(new Error("Native request failed; token=PRIVATE_TOKEN; C:\\private\\file; https://private.example/path"), { code: "ANTIGRAVITY_NATIVE_FAILED", phase: "dispatch", deliveryState: "unknown", stdout: "PRIVATE_STDOUT", stderr: "PRIVATE_STDERR" });
      error.diagnostic = bridgeDiagnostic(error, { component: "native-fixture", operation: "send", requestId: request.requestId });
      throw error;
    }
    if (request.operation === "oversized-response") return "x".repeat(FRAME_LIMIT);
    if (["disconnect", "timeout"].includes(request.operation)) return new Promise(() => {});
    throw new Error("Unexpected operation");
  }, { directory });
  t.after(() => service.close());
  const call = (request) => callAntigravityDesktop(request, { directory, timeoutMs: 3000 });

  await t.test("real protected endpoint accepts a request from the current user", async () => {
    assert.deepEqual(await call({ operation: "echo", value: "Unicode ✓\nnext line" }), { received: "Unicode ✓\nnext line" });
    if (process.platform === "win32") assert.match(antigravitySocket(directory), /^\\\\\.\\pipe\\LOCAL\\codex-bridge-antigravity-/);
    else assert.equal(fs.lstatSync(antigravitySocket(directory)).mode & 0o777, 0o600);
  });

  await t.test("a handler's verified not-sent outcome survives IPC", async () => {
    await assert.rejects(call({ operation: "preflight" }), (error) => {
      assert.equal(error.message, "Recipient is busy");
      assert.equal(error.deliveryState, "not_sent");
      assert.equal(error.code, "ANTIGRAVITY_CONVERSATION_BUSY");
      assert.equal(error.diagnostic.code, error.code);
      assert.equal(error.diagnostic.phase, "preflight");
      assert.equal(error.diagnostic.sent, false);
      return true;
    });
  });

  await t.test("an unclassified post-write handler error remains unknown", async () => {
    await assert.rejects(call({ operation: "uncertain" }), (error) => error.message === "Native connection disappeared" && error.deliveryState === "unknown");
  });

  await t.test("a request exceeding the client bound is never dispatched", async () => {
    const previous = calls;
    await assert.rejects(call({ operation: "echo", value: "x".repeat(FRAME_LIMIT) }), (error) => /size limit/.test(error.message) && error.deliveryState === "not_sent");
    assert.equal(calls, previous);
  });

  await t.test("an oversized raw frame is disconnected before reaching the handler", async () => {
    const previous = calls;
    await sendRawUntilClosed(antigravitySocket(directory), Buffer.alloc(FRAME_LIMIT + 1, 0x78));
    assert.equal(calls, previous);
  });

  await t.test("an oversized handler response stays bounded and uncertain", async () => {
    await assert.rejects(call({ operation: "oversized-response" }), (error) => /size limit/.test(error.message) && error.deliveryState === "unknown");
    assert.deepEqual(await call({ operation: "echo", value: "still available" }), { received: "still available" });
  });

  await t.test("disconnect after writing cannot be reported as not sent", async () => {
    const disconnect = (socket) => socket.once("data", () => socket.end());
    service.server.once("connection", disconnect);
    await assert.rejects(call({ operation: "disconnect" }), (error) => /disconnected/.test(error.message) && error.deliveryState === "unknown");
  });

  await t.test("connection failure before writing is definitely not sent", async () => {
    await assert.rejects(callAntigravityDesktop({ operation: "echo" }, { directory: path.join(directory, "absent"), timeoutMs: 3000 }), (error) => error.deliveryState === "not_sent" && ["ENOENT", "ECONNREFUSED"].includes(error.code));
  });

  await t.test("timeouts before connection are not sent and never write", async (t) => {
    let writes = 0;
    const socket = Object.assign(new EventEmitter(), { destroy() {}, write() { writes++; } });
    t.mock.method(net, "createConnection", () => socket);
    await assert.rejects(callAntigravityDesktop({ operation: "send" }, { directory, timeoutMs: 10 }), (error) => {
      assert.equal(error.code, "ANTIGRAVITY_IPC_TIMEOUT");
      assert.equal(error.deliveryState, "not_sent");
      assert.equal(error.diagnostic.phase, "connect");
      assert.equal(error.diagnostic.sent, false);
      return true;
    });
    assert.equal(writes, 0);
  });

  await t.test("timeouts after writing remain uncertain", async () => {
    await assert.rejects(callAntigravityDesktop({ operation: "timeout" }, { directory, timeoutMs: 30 }), (error) => {
      assert.equal(error.code, "ANTIGRAVITY_IPC_TIMEOUT");
      assert.equal(error.deliveryState, "unknown");
      assert.equal(error.diagnostic.phase, "dispatch");
      assert.equal(error.diagnostic.sent, null);
      assert.equal(error.diagnostic.retrySafe, false);
      return true;
    });
  });

  await t.test("native error diagnostics survive IPC without subprocess output or credentials", async () => {
    const requestId = "16b17ca4-f18c-4c89-aa02-42ecac0a6ce9";
    await assert.rejects(call({ operation: "private-failure", requestId, prompt: "PRIVATE_PROMPT" }), (error) => {
      assert.equal(error.code, "ANTIGRAVITY_NATIVE_FAILED");
      assert.equal(error.diagnostic.component, "native-fixture");
      assert.equal(error.diagnostic.operation, "send");
      assert.equal(error.diagnostic.ids.requestId, requestId);
      assert.match(error.diagnostic.reportId, /^[a-f0-9-]{36}$/);
      assert.doesNotMatch(JSON.stringify({ message: error.message, diagnostic: error.diagnostic }), /PRIVATE_|private\.example|C:\\\\private/i);
      return true;
    });
  });

  await t.test("a second Unix sidecar cannot steal a live socket", { skip: process.platform === "win32" }, async () => {
    await assert.rejects(serveAntigravityDesktop(async () => "wrong owner", { directory }), /owns the socket/);
    assert.deepEqual(await call({ operation: "echo", value: "original owner" }), { received: "original owner" });
  });
});

test("Unix sidecar replaces a socket left with a private link by a killed owner", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  const directory = fixture(t);
  const socketPath = antigravitySocket(directory);
  const privatePath = path.join(path.dirname(socketPath), ".abcdef012345.sock");
  const child = spawn(process.execPath, ["--input-type=module", "-e", "import fs from 'node:fs'; import net from 'node:net'; const [priv, pub] = process.argv.slice(1); net.createServer().listen(priv, () => { fs.linkSync(priv, pub); process.kill(process.pid, 'SIGKILL'); });", privatePath, socketPath], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(fs.lstatSync(socketPath).nlink, 2);
  const service = await serveAntigravityDesktop(async () => ({ recovered: true }), { directory });
  t.after(() => service.close());
  assert.equal(fs.existsSync(privatePath), false);
  assert.equal(fs.lstatSync(socketPath).nlink, 1);
  assert.deepEqual(await callAntigravityDesktop({ operation: "status" }, { directory, timeoutMs: 2000 }), { recovered: true });
});

test("Unix sidecar does not remove a live owner that replaces the stale socket during the probe", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  const directory = fixture(t);
  const socketPath = antigravitySocket(directory);
  const child = spawn(process.execPath, ["--input-type=module", "-e", "import net from 'node:net'; net.createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'));", socketPath], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve) => child.once("exit", resolve));
  const ownerPrivate = path.join(path.dirname(socketPath), ".bbbbbbbbbbbb.sock");
  const owner = net.createServer();
  await new Promise((resolve) => owner.listen(ownerPrivate, resolve));
  t.after(() => owner.close());
  const originalConnect = net.createConnection;
  t.after(() => { net.createConnection = originalConnect; });
  net.createConnection = (...args) => {
    const socket = originalConnect(...args);
    socket.prependOnceListener("error", () => {
      net.createConnection = originalConnect;
      fs.rmSync(socketPath);
      fs.linkSync(ownerPrivate, socketPath);
      fs.rmSync(ownerPrivate);
    });
    return socket;
  };
  await assert.rejects(serveAntigravityDesktop(async () => "replacement", { directory }), /Unsafe relay socket file/);
  await new Promise((resolve, reject) => { const probe = originalConnect(socketPath); probe.once("connect", () => { probe.destroy(); resolve(); }); probe.once("error", reject); });
});

test("Unix sidecar safely replaces the socket left by a crashed owner", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  const directory = fixture(t);
  const socketPath = antigravitySocket(directory);
  const child = spawn(process.execPath, ["--input-type=module", "-e", "import net from 'node:net'; net.createServer().listen(process.argv[1], () => process.stdout.write('ready\\n'));", socketPath], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket fixture failed to start")), 3000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
  });
  fs.chmodSync(socketPath, 0o600);
  const stopped = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await stopped;
  assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  const service = await serveAntigravityDesktop(async () => ({ recovered: true }), { directory });
  t.after(() => service.close());
  assert.deepEqual(await callAntigravityDesktop({ operation: "status" }, { directory, timeoutMs: 2000 }), { recovered: true });
});
