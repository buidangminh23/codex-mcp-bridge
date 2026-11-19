import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createFleetServer } from "../src/fleet-dashboard.mjs";
import { createFleetQueue } from "../src/fleet-queue.mjs";

const hosts = [{ id: "local", cwd: "/repo" }, { id: "office", sshHost: "office", platform: "win32", cwd: "D:\\repo" },
  { id: "laptop", sshHost: "laptop", platform: "darwin", cwd: "/work/repo" }];
const newJob = { title: "Inspect build inputs", steps: ["List the build inputs"], agent: "codex", target: "auto" };
const listen = async server => {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  return server.address().port;
};

function request(origin, token, pathname, { method = "GET", headers = {}, body } = {}) {
  return fetch(origin + pathname, { method, headers: { Authorization: "Bearer " + token, Origin: origin,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
}

async function appFixture(t, desktopConnect) {
  const token = randomBytes(32).toString("base64url");
  const windows = [];
  const client = { async windows(host) { windows.push(host.id); return { windows: [{ app: "Editor", title: host.id }] }; },
    async sessions(host) { return { sessions: [{ agent: "codex", title: host.id, status: "running" }] }; } };
  const queue = createFleetQueue({ hosts, client, load: () => null, save() {} });
  const app = createFleetServer({ hosts, queue, client, token, desktopConnect });
  await listen(app.server);
  t.after(async () => {
    const closed = once(app.server, "close");
    app.close();
    app.server.closeAllConnections();
    await closed;
  });
  const origin = app.origin();
  return { origin, token, windows, api: (pathname, opts) => request(origin, token, pathname, opts),
    post: (pathname, body = {}) => request(origin, token, pathname, { method: "POST", body }) };
}

test("dashboard requires its exact loopback origin and a valid operator token", async t => {
  const box = await appFixture(t);
  assert.equal((await fetch(box.origin + "/api/state")).status, 401);
  assert.equal((await request(box.origin, "wrong", "/api/state")).status, 401);
  assert.equal((await box.api("/api/state", { headers: { Origin: "http://localhost:1" } })).status, 403);
  assert.equal((await fetch(box.origin + "/api/jobs", { method: "POST", headers: {
    Authorization: "Bearer " + box.token, "Content-Type": "application/json" }, body: JSON.stringify(newJob) })).status, 403);
  const untrustedHost = await new Promise((resolve, reject) => {
    const req = http.get(box.origin + "/api/state", { headers: { Host: "other.example", Authorization: "Bearer " + box.token } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
  });
  assert.equal(untrustedHost, 403);
  const state = await box.api("/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.headers.get("cache-control"), "no-store");
  assert.deepEqual((await state.json()).jobs, []);
});

test("dashboard creates, retargets and cancels a job and reads windows from the requested host", async t => {
  const box = await appFixture(t);
  const added = await box.post("/api/jobs", newJob);
  assert.equal(added.status, 201);
  const job = await added.json();
  const changed = await box.post(`/api/jobs/${job.id}/target`, { target: "office" });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).target, "office");
  assert.equal((await box.post(`/api/jobs/${job.id}/cancel`)).status, 200);
  const state = await (await box.api("/api/state")).json();
  assert.equal(state.jobs[0].status, "cancelled");
  assert.equal(state.jobs[0].id, job.id);
  assert.deepEqual(await (await box.post("/api/settings/memory", { minFreeGiB: 1.5 })).json(), { minFreeBytes: 1.5 * 1024 ** 3 });
  assert.equal((await box.post("/api/settings/memory", { minFreeGiB: -1 })).status, 400);
  assert.equal((await (await box.api("/api/state")).json()).minFreeBytes, 1.5 * 1024 ** 3);
  assert.equal((await box.post(`/api/jobs/${job.id}/target`, { target: "laptop" })).status, 409);
  assert.deepEqual(await (await box.post("/api/hosts/laptop/windows")).json(), { windows: [{ app: "Editor", title: "laptop" }] });
  assert.equal((await box.post("/api/hosts/missing/windows")).status, 404);
  assert.deepEqual(box.windows, ["laptop"]);
  assert.equal((await box.post("/api/hosts/missing/sessions")).status, 404);
  assert.deepEqual(await (await box.post("/api/hosts/laptop/sessions")).json(),
    { sessions: [{ agent: "codex", title: "laptop", status: "running" }] });
  assert.equal((await box.post("/api/hosts/local/screen")).status, 400);
  assert.equal((await box.post("/api/hosts/laptop/rdp")).status, 400);
});

test("screen ticket opens one bidirectional VNC stream for its enrolled host", { timeout: 10000 }, async t => {
  const received = Buffer.from([1, 0, 255, 2]);
  const reply = Buffer.from([8, 0, 255, 0, 3]);
  const remote = net.createServer(socket => { socket.once("data", data => {
    assert.deepEqual(data, received);
    socket.write(reply);
  }); });
  const port = await listen(remote);
  t.after(() => remote.close());
  const opened = [];
  const box = await appFixture(t, (host, destinationPort) => {
    opened.push([host.id, destinationPort]);
    return net.connect(port, "127.0.0.1");
  });
  const { path: ticketPath } = await (await box.post("/api/hosts/laptop/screen")).json();
  const url = box.origin.replace("http:", "ws:") + ticketPath;
  const denied = new WebSocket(url, { origin: "http://localhost:1" });
  await once(denied, "error");
  assert.deepEqual(opened, []);
  const viewer = new WebSocket(url, { origin: box.origin });
  t.after(() => viewer.terminate());
  await once(viewer, "open");
  const response = once(viewer, "message");
  viewer.send(received);
  const [data, binary] = await response;
  assert.deepEqual(data, reply);
  assert.equal(binary, true);
  const replay = new WebSocket(url, { origin: box.origin });
  await once(replay, "error");
  assert.deepEqual(opened, [["laptop", 5900]]);
  const closed = once(viewer, "close");
  viewer.close();
  await closed;
});

test("Windows RDP download opens its one-use local tunnel to the selected machine", { timeout: 10000 }, async t => {
  const remote = net.createServer(socket => socket.pipe(socket));
  const port = await listen(remote);
  t.after(() => remote.close());
  const opened = [];
  const box = await appFixture(t, (host, destinationPort) => {
    opened.push([host.id, destinationPort]);
    return net.connect(port, "127.0.0.1");
  });
  const response = await box.post("/api/hosts/office/rdp");
  assert.equal(response.status, 200);
  const { file } = await response.json();
  const match = /^full address:s:127\.0\.0\.1:(\d+)\r?$/m.exec(file);
  assert.ok(match);
  assert.match(file, /prompt for credentials:i:1/);
  const socket = net.connect(Number(match[1]), "127.0.0.1");
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const bytes = once(socket, "data");
  socket.write(Buffer.from([3, 0, 2]));
  assert.deepEqual((await bytes)[0], Buffer.from([3, 0, 2]));
  const second = net.connect(Number(match[1]), "127.0.0.1");
  await once(second, "error");
  assert.deepEqual(opened, [["office", 3389]]);
  socket.destroy();
});

async function startDashboard(directory, port) {
  const cli = fileURLToPath(new URL("../scripts/worker-relay.mjs", import.meta.url));
  const env = { ...process.env, AGENT_RELAY_DIRECTORY: path.join(directory, "relay") };
  for (const key of ["AGENT_RELAY_TOKEN", "AGENT_RELAY_WORKER_ID", "AGENT_RELAY_ENDPOINT"]) delete env[key];
  const child = spawn(process.execPath, [cli, "dashboard", "--no-open", "--cwd", directory, "--port", String(port)],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const stop = async () => { child.kill(); await exited; };
  let errorText = "";
  child.stderr.on("data", chunk => { errorText += chunk.toString(); });
  try {
    let output = "";
    for await (const chunk of child.stdout) {
      output += chunk.toString();
      const match = /http:\/\/127\.0\.0\.1:\d+\/#session=([\w-]+)/.exec(output);
      if (match) return { token: match[1], stop };
    }
    throw new Error("Dashboard did not start: " + errorText);
  } catch (error) {
    await stop();
    throw error;
  }
}

test("restarting the dashboard CLI restores the project queue and rotates the browser token", { timeout: 60000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-dashboard-"));
  let app;
  try {
    const allocator = net.createServer();
    const port = await listen(allocator);
    await new Promise(resolve => allocator.close(resolve));
    const origin = "http://127.0.0.1:" + port;
    app = await startDashboard(directory, port);
    const initialToken = app.token;
    const added = await request(origin, initialToken, "/api/jobs", { method: "POST", body: newJob });
    assert.equal(added.status, 201);
    const { id } = await added.json();
    await app.stop();
    app = await startDashboard(directory, port);
    assert.notEqual(app.token, initialToken);
    assert.equal((await request(origin, initialToken, "/api/state")).status, 401);
    const state = await (await request(origin, app.token, "/api/state")).json();
    assert.deepEqual(state.jobs.map(job => [job.id, job.status]), [[id, "queued"]]);
  } finally {
    await app?.stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
