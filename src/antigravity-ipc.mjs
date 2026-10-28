import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { protectCurrentUserPipe } from "./windows-pipe-acl.mjs";
import { relayFileIdentity, removeRelayFile } from "./native-relay-files.mjs";

const LIMIT = 2 * 1024 * 1024;

async function socketRefused(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const done = (refused) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => done(false), 1000);
    socket.on("connect", () => done(false));
    socket.on("error", (error) => done(error.code === "ECONNREFUSED"));
  });
}

export function antigravityBridgeDirectory(home = os.homedir()) {
  return path.join(home, ".codex", "antigravity-bridge");
}

export function antigravitySocket(directory = antigravityBridgeDirectory()) {
  const hash = crypto.createHash("sha256").update(path.resolve(directory).toLowerCase()).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\codex-bridge-antigravity-${hash}` : path.join(directory, "desktop.sock");
}

export function ensureBridgeDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Bridge directory must be a real directory");
  if (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new Error("Bridge directory must be owned by this user with mode 0700");
  return directory;
}

export function callAntigravityDesktop(request, { directory = antigravityBridgeDirectory(), timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(antigravitySocket(directory));
    let buffer = Buffer.alloc(0);
    let finished = false;
    let dispatched = false;
    const done = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) {
        error.deliveryState ??= dispatched ? "unknown" : "not_sent";
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => done(Object.assign(new Error("Antigravity sidecar did not reply; inspect the original requestId before retrying"), { deliveryState: "unknown" })), timeoutMs);
    socket.on("error", (error) => done(error));
    socket.on("end", () => done(new Error("Antigravity sidecar disconnected before replying")));
    socket.on("connect", () => {
      const frame = JSON.stringify(request) + "\n";
      if (Buffer.byteLength(frame) > LIMIT) return done(new Error("Request exceeds size limit"));
      dispatched = true;
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > LIMIT) return done(new Error("Sidecar response exceeds size limit"));
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, end).toString("utf8"));
        if (response.error) return done(Object.assign(new Error(response.error), { deliveryState: response.deliveryState }));
        done(null, response.result);
      } catch (error) { done(error); }
    });
  });
}

export async function serveAntigravityDesktop(handler, { directory = antigravityBridgeDirectory() } = {}) {
  ensureBridgeDirectory(directory);
  const socketPath = antigravitySocket(directory);
  let ready = false;
  const connections = new Set();
  const server = net.createServer((socket) => {
    if (!ready || connections.size >= 32) return socket.destroy();
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(35000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let received = false;
    socket.on("data", async (chunk) => {
      if (received) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > LIMIT) return socket.destroy();
      const end = buffer.indexOf(10);
      if (end < 0) return;
      received = true;
      try {
        const result = await handler(JSON.parse(buffer.subarray(0, end).toString("utf8")));
        const frame = JSON.stringify({ result }) + "\n";
        if (Buffer.byteLength(frame) > LIMIT) throw new Error("Sidecar response exceeds size limit");
        socket.end(frame);
      } catch (error) { socket.end(JSON.stringify({ error: error.message, deliveryState: error.deliveryState }) + "\n"); }
    });
  });
  const privatePath = process.platform === "win32" ? socketPath : path.join(directory, `.${crypto.randomBytes(6).toString("hex")}.sock`);
  let identity;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(privatePath, () => { server.off("error", reject); resolve(); });
  });
  try {
    if (process.platform === "win32") await protectCurrentUserPipe(socketPath);
    else {
      fs.chmodSync(privatePath, 0o600);
      try { fs.linkSync(privatePath, socketPath); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = relayFileIdentity(socketPath, "socket");
        if (!await socketRefused(socketPath)) throw new Error("Another Antigravity sidecar owns the socket");
        removeRelayFile(socketPath, { expected: existing });
        fs.linkSync(privatePath, socketPath);
      }
      fs.unlinkSync(privatePath);
      identity = relayFileIdentity(socketPath, "socket");
    }
    ready = true;
  } catch (error) { server.close(); throw error; }
  return { server, close: () => new Promise((resolve) => {
    ready = false;
    for (const socket of connections) socket.destroy();
    if (identity) removeRelayFile(socketPath, { expected: identity });
    server.close(resolve);
  }) };
}
