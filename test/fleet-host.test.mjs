import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createFleetHostClient, fleetSshArgs, handleFleetHostRequest, listFleetWindows, runFleetHost } from "../src/fleet-host.mjs";
import { listFleetSessions } from "../src/fleet-sessions.mjs";

const cwd = path.resolve(os.tmpdir(), "fleet project");
const revision = "d".repeat(40);
const repository = "example.com/team/project";
const local = { id: "workstation", cwd };
const remote = { id: "portable", cwd, platform: "darwin", sshHost: "portable" };
const job = { id: randomUUID(), agent: "codex", prompt: "Summarize changes." };
const authorize = value => { assert.equal(value, cwd); return cwd; };
const identity = () => repository;

function fixture(overrides = {}) {
  const calls = [];
  const relay = async (method, params) => {
    calls.push([method, params]);
    if (method === "status") return { accepting: true, workers: [
      { agent: "codex", ready: true, canAcceptWork: true }, { agent: "claude", ready: false, canAcceptWork: false },
    ] };
    return { requestId: params.requestId, agent: "codex", status: method === "send" ? "queued" : "completed" };
  };
  const options = { authorize, identity, env: {}, relay, checkout: async () => ({ clean: true, revision }), ...overrides };
  const client = createFleetHostClient({ cwd, hosts: [local, remote], authorize, identity, env: {},
    localCall: (input, context) => handleFleetHostRequest(input, { ...options, ...context }),
    remoteCall: (_host, input) => handleFleetHostRequest(input, options) });
  return { client, calls };
}

test("local and SSH transports resolve the enrolled destination and use the same relay UUID on send/read", async () => {
  for (const selected of [local, remote]) {
    const { client, calls } = fixture();
    const probe = await client.probe(selected);
    assert.ok(probe.freeBytes >= 0 && probe.totalBytes >= probe.freeBytes);
    assert.deepEqual(probe.agents, ["codex"]);
    assert.equal(probe.revision, revision);
    const sent = await client.send({ ...selected, cwd: "ignored", sshHost: "ignored" }, { ...job, expectedRevision: revision });
    assert.equal(sent.status, "queued");
    assert.equal((await client.read(selected, job)).status, "completed");
    assert.deepEqual(calls, [["status", undefined], ["send", { cwd, agent: job.agent, prompt: job.prompt, requestId: job.id }],
      ["read", { requestId: job.id }]]);
  }
});

test("receiver blocks a changed mapping, stale clean revision, unexpected receipts and scoped worker identities", async () => {
  for (const [options, code] of [
    [{ identity: () => "example.com/other" }, "FLEET_REPOSITORY_MISMATCH"],
    [{ checkout: () => ({ revision, clean: false }) }, "FLEET_CHECKOUT_CHANGED"],
    [{ checkout: () => ({ revision: "a".repeat(40), clean: true }) }, "FLEET_CHECKOUT_CHANGED"],
    [{ env: { AGENT_RELAY_WORKER_ID: randomUUID() } }, "FLEET_OPERATOR_REQUIRED"],
  ]) {
    const { client, calls } = fixture(options);
    await assert.rejects(client.send(remote, { ...job, expectedRevision: revision }), { code, deliveryState: "not_sent" });
    assert.deepEqual(calls, []);
  }
  const { client } = fixture({ relay: () => ({ requestId: randomUUID(), agent: job.agent, status: "running" }) });
  await assert.rejects(client.send(remote, job), { code: "FLEET_RECEIPT_MISMATCH", deliveryState: "unknown" });
  await assert.rejects(client.probe({ id: "unknown" }), { code: "FLEET_HOST_INVALID" });
});

test("sender cannot delegate across machines with a disabled local project grant or scoped worker credential", async () => {
  const unexpected = () => assert.fail("Remote transport should not have run");
  const blocked = createFleetHostClient({ cwd, hosts: [remote], env: {}, authorize: () => { throw new Error("revoked"); }, remoteCall: unexpected });
  await assert.rejects(blocked.send(remote, job), /revoked/);
  const scoped = createFleetHostClient({ cwd, hosts: [remote], env: { AGENT_RELAY_TOKEN: "scoped" }, remoteCall: unexpected });
  await assert.rejects(scoped.send(remote, job), { code: "FLEET_OPERATOR_REQUIRED" });
});

test("fleet SSH accepts configured aliases and platform commands with payload carried exclusively on stdin", () => {
  for (const [platform, expected] of [["win32", /worker-relay\.cmd fleet-host/], ["darwin", /zsh -lc/], ["linux", /sh -lc/]]) {
    const args = fleetSshArgs({ ...remote, platform });
    assert.match(args.at(-1), expected);
    assert.deepEqual(args.slice(-3, -1), ["--", remote.sshHost]);
    assert.ok(args.includes("StrictHostKeyChecking=yes") && args.includes("ForwardAgent=no"));
    assert.ok(args.every(arg => !arg.includes(cwd) && !arg.includes(job.prompt)));
  }
  assert.throws(() => fleetSshArgs({ ...remote, sshHost: "-invalid" }), { code: "FLEET_HOST_INVALID" });
});

test("internal CLI validates bounded JSON frames and reports a correlated validation error", async () => {
  const nonce = randomUUID();
  const result = await runFleetHost(Readable.from([JSON.stringify({ version: 1, action: "unrecognized", nonce })]));
  assert.equal(result.nonce, nonce);
  assert.equal(result.error.code, "FLEET_REQUEST_INVALID");
  const oversized = await runFleetHost(Readable.from([Buffer.alloc(1024 * 1024 + 1)]));
  assert.equal(oversized.error.code, "FLEET_REQUEST_TOO_LARGE");
});

test("window inventory runs on demand for the enrolled host without queueing a worker", async () => {
  const inventory = { windows: [{ app: "Editor", title: "Project" }] };
  let enumerations = 0;
  const { client, calls } = fixture({ windows: () => { enumerations++; return inventory; } });
  await client.probe(remote);
  assert.equal(enumerations, 0);
  assert.deepEqual(await client.windows(remote), inventory);
  assert.deepEqual(await client.windows(local), inventory);
  assert.equal(enumerations, 2);
  assert.deepEqual(calls, [["status", undefined]]);
});

test("AI session inventory excludes dormant, foreign and duplicate sessions and identifies partial discovery", async () => {
  const project = process.cwd();
  const codexId = randomUUID(), claudeId = randomUUID(), waitingId = randomUUID();
  const row = { kind: "codex", hostId: "local", cwd: project, status: "active", title: "Active task", id: codexId };
  const inventory = await listFleetSessions(project, {
    codex: () => ({ rows: [row, row, { ...row, id: randomUUID(), hostId: "remote" },
      { ...row, id: randomUUID(), cwd: os.tmpdir() }, { ...row, id: randomUUID(), status: "notLoaded" },
      { ...row, id: waitingId, status: { type: "active", activeFlags: ["waitingOnApproval"] } }], note: "Recent snapshot only." }),
    claude: () => ({ rows: [{ id: claudeId, cwd: project, title: "Claude task" }] }),
    antigravity: () => { throw new Error("Private diagnostic, never expose"); },
  });
  assert.deepEqual(inventory.sessions, [
    { id: codexId, agent: "codex", title: "Active task", status: "running" },
    { id: waitingId, agent: "codex", title: "Active task", status: "waiting" },
    { id: claudeId, agent: "claude", title: "Claude task", status: "connected" },
  ]);
  assert.match(inventory.note, /Antigravity/);
  assert.match(inventory.note, /Recent snapshot/);
  assert.doesNotMatch(inventory.note, /Private diagnostic/);
});

test("AI session inventory uses the mapped project on each host and rechecks permission before returning", async () => {
  const inventory = { sessions: [{ id: randomUUID(), agent: "codex", title: "Inspect project", status: "running" }] };
  const { client, calls } = fixture({ sessions: async project => { assert.equal(project, cwd); return inventory; } });
  for (const host of [local, remote]) assert.deepEqual(await client.sessions(host), inventory);
  assert.deepEqual(calls, []);
  let allowed = true;
  const changed = fixture({ sessions: async () => { allowed = false; return inventory; },
    authorize: project => { if (!allowed) throw new Error("revoked"); return project; } });
  await assert.rejects(changed.client.sessions(remote), /revoked/);
  const mismatch = fixture({ identity: () => "other/project", sessions: () => assert.fail() });
  await assert.rejects(mismatch.client.sessions(remote), { code: "FLEET_REPOSITORY_MISMATCH" });
});

test("Linux window inventory parses wmctrl and reports compositor/session limits", async () => {
  const env = { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" };
  const result = await listFleetWindows({ platform: "linux", env, run: async (bin, args) => {
    assert.equal(bin, "wmctrl"); assert.deepEqual(args, ["-l", "-x"]);
    return { stdout: "0x03aa  -1 editor.Editor devbox Project title\n" };
  } });
  assert.deepEqual(result.windows, [{ app: "editor.Editor", title: "Project title" }]);
  assert.match(result.note, /XWayland/);
  const headless = await listFleetWindows({ platform: "linux", env: {}, run: () => assert.fail() });
  assert.deepEqual(headless.windows, []);
  assert.match(headless.note, /DISPLAY/);
});

test("desktop window inventory handles lack of titles or an interactive session", async () => {
  const mac = await listFleetWindows({ platform: "darwin", run: async () => ({ stdout: '[{"app":"Editor","title":""}]' }) });
  assert.deepEqual(mac.windows, [{ app: "Editor", title: "" }]);
  assert.match(mac.note, /macOS/);
  const win = await listFleetWindows({ platform: "win32", run: async () => ({ stdout: "[]" }) });
  assert.deepEqual(win.windows, []);
  assert.match(win.note, /Windows/);
});
