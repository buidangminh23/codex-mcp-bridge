import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";

import { desktopAppServerCandidates, relayHostEnabled, startDesktopRelayHost } from "../src/desktop-relay-host.mjs";
import { accountRelaySocketPath, relaySocketPath } from "../src/native-relay.mjs";
import { createRelayServers } from "../src/native-relay-companion.mjs";

const socketName = (directory, name) => process.platform === "win32" ? `\\\\.\\pipe\\relay-host-${randomUUID()}` : path.join(directory, name);

function environment(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-host-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "native-relay.json"), JSON.stringify({ relayThreadId: "executor", desktopTasks: true }));
  return { directory, env: { ...process.env, CODEX_HOME: directory, CODEX_NATIVE_RELAY_SOCKET: socketName(directory, "relay.sock") } };
}

function nativeDesktop(t, directory) {
  const pipe = socketName(directory, "native.sock");
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
        buffer = buffer.subarray(length + 4);
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { success: true, structuredContent: { projects: [] } } }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        socket.write(Buffer.concat([header, body]));
      }
    });
  });
  const close = () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
  t.after(close);
  return { pipe, close, listen: () => new Promise((resolve) => server.listen(pipe, resolve)) };
}

const canConnect = (socketPath) => new Promise((resolve) => {
  const probe = net.connect({ path: socketPath });
  probe.once("connect", () => { probe.destroy(); resolve(true); });
  probe.once("error", () => resolve(false));
});

async function eventually(predicate, detail = () => "") {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Condition did not settle ${detail()}`);
}

it("keeps the relay ready through Desktop with no conversation hosting it", async (t) => {
  const { directory, env } = environment(t);
  const desktop = nativeDesktop(t, directory);
  await desktop.listen();
  let running = true;
  const states = [];
  const host = startDesktopRelayHost({ env, enabled: true, pollMs: 25, drainMs: 200, alive: () => running,
    discover: async () => running ? { pipe: desktop.pipe, pid: 4242 } : null, onState: (state) => states.push(state) });
  t.after(() => host.stop());
  await eventually(() => canConnect(accountRelaySocketPath(env)), () => JSON.stringify(states));
  assert.equal(await canConnect(relaySocketPath(env)), true);
  await eventually(() => host.status().state === "listening", () => JSON.stringify(states));
  assert.ok(host.status().ownedSockets >= 2);
  assert.equal(host.status().pid, 4242);

  const reply = await new Promise((resolve, reject) => {
    const client = net.connect({ path: relaySocketPath(env) });
    let data = "";
    client.on("data", (chunk) => { data += chunk; });
    client.on("end", () => resolve(JSON.parse(data)));
    client.on("error", reject);
    client.write(`${JSON.stringify({ v: 1, operation: "list_projects", arguments: {} })}\n`);
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(reply.result.projects, []);

  running = false;
  await eventually(async () => !await canConnect(relaySocketPath(env)), () => JSON.stringify(states));
  await eventually(() => host.status().state === "waiting-for-desktop", () => JSON.stringify(states));
  assert.equal(host.status().ownedSockets, 0);

  running = true;
  await eventually(() => canConnect(relaySocketPath(env)), () => JSON.stringify(states));
  await eventually(() => host.status().state === "listening", () => JSON.stringify(states));
});

it("does not take the sockets from a companion that already owns them", async (t) => {
  const { directory, env } = environment(t);
  const desktop = nativeDesktop(t, directory);
  await desktop.listen();
  const owner = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise((resolve) => owner.listen(relaySocketPath(env), resolve));
  t.after(() => new Promise((resolve) => owner.close(resolve)));
  const logs = [];
  const host = startDesktopRelayHost({ env, enabled: true, pollMs: 25, drainMs: 200, alive: () => true,
    discover: async () => ({ pipe: desktop.pipe, pid: 4242 }), log: (message) => logs.push(message) });
  t.after(() => host.stop());
  await eventually(() => logs.some((line) => line.includes("already owns")), () => logs.join("\n"));
  assert.equal(owner.listening, true);
});

it("stands by behind loaded conversations, then takes over and reports it when they leave", async (t) => {
  const { directory, env } = environment(t);
  const desktop = nativeDesktop(t, directory);
  await desktop.listen();
  const sockets = [...new Set(createRelayServers({ nativeTools: {}, env, signalExit: false }).relays.map((relay) => relay.socketPath))];
  const owners = await Promise.all(sockets.map((socketPath) => new Promise((resolve) => {
    const owner = net.createServer((socket) => socket.on("error", () => {}));
    owner.listen(socketPath, () => resolve(owner));
  })));
  const reports = [];
  const host = startDesktopRelayHost({ env, enabled: true, pollMs: 25, drainMs: 200, alive: () => true,
    discover: async () => ({ pipe: desktop.pipe, pid: 4242 }), onState: (state) => reports.push(state) });
  t.after(() => host.stop());

  await eventually(() => host.status().state === "standby", () => JSON.stringify(reports));
  assert.equal(host.status().ownedSockets, 0);
  assert.equal(reports.at(-1).state, "standby");
  assert.ok(owners.every((owner) => owner.listening));
  assert.equal(reports.some((report) => report.state === "listening"), false);

  await Promise.all(owners.map((owner) => new Promise((resolve) => owner.close(resolve))));
  await eventually(() => host.status().state === "listening", () => JSON.stringify(reports));
  await eventually(() => reports.at(-1).ownedSockets === host.status().ownedSockets, () => JSON.stringify(reports));
  assert.ok(host.status().ownedSockets >= 1);
  assert.equal(reports.at(-1).state, "listening");

  const reply = await new Promise((resolve, reject) => {
    const client = net.connect({ path: relaySocketPath(env) });
    let data = "";
    client.on("data", (chunk) => { data += chunk; });
    client.on("end", () => resolve(JSON.parse(data)));
    client.on("error", reject);
    client.write(`${JSON.stringify({ v: 1, operation: "list_projects", arguments: {} })}\n`);
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
});

it("leaves everything alone until Desktop appears and never throws from a failed discovery", async (t) => {
  const { env } = environment(t);
  let calls = 0;
  const host = startDesktopRelayHost({ env, enabled: true, pollMs: 25, drainMs: 200, discover: async () => { calls++; throw new Error("process listing failed"); } });
  t.after(() => host.stop());
  await eventually(() => calls >= 3);
  assert.equal(host.status().state, "waiting-for-desktop");
  assert.match(host.status().reason, /process listing failed/);
  assert.equal(await canConnect(relaySocketPath(env)), false);
});

it("stays off without a configured Desktop relay and outside Windows", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-host-off-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const enabled = (env) => relayHostEnabled({ CODEX_HOME: directory, ...env }, "win32");
  assert.equal(enabled(), false);
  fs.writeFileSync(path.join(directory, "native-relay.json"), JSON.stringify({ relayThreadId: "executor", desktopTasks: false }));
  assert.equal(enabled(), false);
  fs.writeFileSync(path.join(directory, "native-relay.json"), JSON.stringify({ desktopTasks: true }));
  assert.equal(enabled(), false);
  fs.writeFileSync(path.join(directory, "native-relay.json"), JSON.stringify({ relayThreadId: "executor", desktopTasks: true }));
  assert.equal(enabled(), true);
  assert.equal(enabled({ CODEX_BRIDGE_HARDENED: "1" }), false);
  for (const platform of ["darwin", "linux"]) assert.equal(relayHostEnabled({ CODEX_HOME: directory }, platform), false);
  fs.writeFileSync(path.join(directory, "config.toml"), '[mcp_servers.codex-native-relay.env]\nCODEX_BRIDGE_HARDENED = "1"\n');
  assert.equal(enabled(), false);
  let discovered = false;
  const host = startDesktopRelayHost({ enabled: false, pollMs: 25, discover: async () => { discovered = true; return null; } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(discovered, false);
  assert.equal(host.status().state, "disabled");
  await host.stop();
});

it("recognizes only a Desktop app-server when listing processes", () => {
  const appServer = String.raw`"C:\Users\me\AppData\Local\OpenAI\Codex\bin\abc\codex.exe" -c features.code_mode_host=true app-server --analytics-default-enabled`;
  assert.deepEqual(desktopAppServerCandidates([
    { pid: 10, args: appServer },
    { pid: 11, args: String.raw`"C:\tools\codex.exe" app-server --listen ws://127.0.0.1:8791` },
    { pid: 12, args: String.raw`"C:\tools\codex.exe" exec hello` },
    { pid: 13, args: String.raw`C:\Windows\notepad.exe app-server` },
    { pid: 14, args: null },
  ]), [10]);
});
