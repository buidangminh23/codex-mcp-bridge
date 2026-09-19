import assert from "node:assert/strict";
import { test } from "node:test";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VSCodeIpc } from "../src/vscode-ipc.mjs";

async function fixture(t, handler) {
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\vscode-bridge-test-${randomUUID()}` : path.join(os.tmpdir(), `vsc-${randomUUID()}.sock`);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
        const length = buffer.readUInt32LE(0);
        const request = JSON.parse(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        const response = handler(request);
        if (!response) continue;
        const body = Buffer.from(JSON.stringify({ type: "response", requestId: request.requestId, resultType: "success", method: request.method, handledByClientId: "owner", ...response }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        const frame = Buffer.concat([header, body]);
        socket.write(frame.subarray(0, 2));
        socket.write(frame.subarray(2));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const ipc = await new VSCodeIpc({ socketPath, timeoutMs: 100 }).connect();
  t.after(() => ipc.close());
  return ipc;
}

test("targets the existing owner and sends no permission overrides", async (t) => {
  const requests = [];
  const ipc = await fixture(t, (request) => {
    requests.push(request);
    if (request.method === "initialize") return { result: { clientId: "bridge" } };
    if (request.method === "thread-owner-discovery") return { result: {} };
    return { result: { result: { turn: { id: "turn" } } } };
  });
  let checked = false;
  assert.equal((await ipc.send("task", "hello", { beforeSend: () => { checked = true; } })).turnId, "turn");
  assert.equal(checked, true);
  assert.equal(requests[2].targetClientId, "owner");
  assert.deepEqual(requests[2].params.turnStart, { request: { threadId: "task", input: [{ type: "text", text: "hello", text_elements: [] }] }, context: { inheritThreadSettings: true } });
});

test("refuses changed recipient evidence without submitting", async (t) => {
  const requests = [];
  const ipc = await fixture(t, (request) => {
    requests.push(request);
    return { result: request.method === "initialize" ? { clientId: "bridge" } : {} };
  });
  await assert.rejects(ipc.send("task", "hello", { beforeSend: () => { throw new Error("changed"); } }), /changed/);
  assert.equal(requests.length, 2);
});

test("does not retry a submission after timeout", async (t) => {
  let submissions = 0;
  const ipc = await fixture(t, (request) => {
    if (request.method === "thread-follower-start-turn") { submissions++; return null; }
    return { result: request.method === "initialize" ? { clientId: "bridge" } : {} };
  });
  await assert.rejects(ipc.send("task", "hello"), /timed out/);
  assert.equal(submissions, 1);
});
