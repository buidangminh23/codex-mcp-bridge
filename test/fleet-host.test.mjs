import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createFleetHostClient, describeCodeProcess, fleetSshArgs, handleFleetHostRequest, listFleetActivity, listFleetProcesses, listFleetWindows, runFleetHost } from "../src/fleet-host.mjs";
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

test("process inventory keeps only agent, CI, dev-server and hidden code runs without leaking arguments", async () => {
  assert.equal(describeCodeProcess("explorer", "C:\\Windows\\explorer.exe"), null);
  assert.equal(describeCodeProcess("MsMpEng", ""), null);
  assert.equal(describeCodeProcess("Antigravity", "Antigravity.exe --type=renderer"), null);
  assert.equal(describeCodeProcess("pwsh", "pwsh.exe -Command \"echo secret_token=abc\""), null);
  const ci = describeCodeProcess("node", "node --test --token=supersecret test/app.test.mjs");
  assert.equal(ci.category, "ci");
  assert.doesNotMatch(ci.label, /supersecret/);
  for (const [name, command, label] of [
    ["npm", "npm --prefix /work/acme-client run build", "npm run build"],
    ["kubectl", "kubectl --namespace internalteam get pods", "kubectl get"],
    ["gh", "gh --repo internal-repository workflow list", "gh workflow"],
    ["node", "node -e internalvalue", "node script"],
    ["node", "node /work/internalteam.js", "node script"],
    ["node", "node /work/mcp-server-internalteam/index.js", "MCP Server"],
    ["pwsh", "pwsh -File internalteam.ps1", "pwsh script"],
  ]) assert.equal(describeCodeProcess(name, command)?.label, label);

  const mac = await listFleetProcesses({ platform: "darwin", run: async (bin, args) => {
    assert.equal(bin, "/bin/ps");
    assert.deepEqual(args, ["-axww", "-o", "pid=", "-o", "pcpu=", "-o", "rss=", "-o", "etime=", "-o", "state=", "-o", "ucomm=", "-o", "args="]);
    return { stdout: [
      "  42 12.5 512000 01:12:05 R codex /usr/local/bin/codex exec --api-key=secret-value",
      "  55  4.0 120000    05:10 S node /Users/Test User/bin/node --test test/suite.mjs",
      "  77  1.0  50000 10:00:00 S Finder /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
      "  99  0.4  65536    20:00 S node /usr/local/bin/node server/hub.ts",
    ].join("\n") };
  } });
  assert.equal(mac.totalProcesses, 3);
  assert.equal(mac.processes[0].category, "agent");
  assert.equal(mac.processes[0].agent, "codex");
  assert.equal(mac.processes[0].uptimeSeconds, 4325);
  assert.doesNotMatch(mac.processes[0].label, /secret/);
  assert.equal(mac.processes[1].category, "ci");
  assert.equal(mac.processes[2].category, "server");
  assert.equal(mac.processes[2].label, "node server/hub.ts");

  const win = await listFleetProcesses({ platform: "win32", run: async () => ({
    stdout: JSON.stringify([
      { pid: 77, name: "codex", memoryBytes: 128000000, cpuSeconds: 4.5, uptimeSeconds: 90, threads: 8, cmd: "codex.exe app-server" },
      { pid: 88, name: "Antigravity", memoryBytes: 256000000, cpuSeconds: 12, uptimeSeconds: 90, threads: 8, cmd: "Antigravity.exe --type=gpu-process" },
    ]),
  }) });
  assert.equal(win.totalProcesses, 1);
  assert.equal(win.processes[0].category, "agent");
  assert.equal(win.processes[0].label, "Codex App Server");
  assert.equal(win.processes[0].uptimeSeconds, 90);
});

test("native ps identifies a runtime and script launched from paths containing spaces", { skip: !["linux", "darwin"].includes(process.platform) }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fleet test "));
  const runtime = path.join(directory, "node");
  const script = path.join(directory, "server.js");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink(process.execPath, runtime);
  await writeFile(script, 'process.send("ready"); process.on("disconnect", () => process.exit(0));');
  const child = spawn(runtime, [script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const closed = once(child, "close");
  t.after(async () => { if (child.connected) child.disconnect(); await closed; });
  await once(child, "message");
  const inventory = await listFleetProcesses({ run: async (bin, args, options) => {
    const { stdout } = await promisify(execFile)(bin, ["-ww", "-p", String(child.pid), ...args.slice(1)], options);
    return { stdout };
  } });
  assert.deepEqual(inventory.processes.map(p => [p.pid, p.name, p.label]), [[child.pid, "node", "node server.js"]]);
});

test("activity inventory reads background relay status, tasks and running processes with permission recheck", async () => {
  const taskId = randomUUID();
  const sample = await listFleetActivity({
    relay: async (method, params) => {
      assert.deepEqual(params, { summary: true });
      return method === "status"
      ? { pid: 500, version: "2.5.1", accepting: true, active: 1, queued: 0, workers: [{ agent: "codex", ready: true, canAcceptWork: true, readiness: "ready", version: "0.167" }] }
      : { tasks: [{ requestId: taskId, agent: "codex", status: "running", deliveryState: "sent", source: { kind: "local-client" }, output: "Working", createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-20T00:00:05Z" }] };
    },
    processes: async () => ({ totalProcesses: 1, processes: [{ pid: 500, name: "node", label: "Worker Relay Daemon", agent: null, memoryBytes: 50000000, cpuPercent: null, cpuSeconds: 2.1, uptimeSeconds: 120, threads: 10, state: "running", category: "agent", background: true }] }),
  });
  assert.equal(sample.relay.online, true);
  assert.equal(sample.tasks.length, 1);
  assert.equal(sample.tasks[0].requestId, taskId);
  assert.equal(sample.processes[0].role, "worker-relay");
  assert.equal(sample.processes[0].category, "agent");
  const partial = await listFleetActivity({
    relay: async method => {
      if (method === "status") return { active: 2 };
      throw new Error("list is unavailable");
    },
    processes: async () => ({ processes: [] }),
  });
  assert.equal(partial.relay.active, 2);
  assert.match(partial.note, /danh sách tác vụ/);

  const { client } = fixture({ activity: async () => sample });
  for (const host of [local, remote]) assert.equal((await client.activity(host)).tasks[0].requestId, taskId);
  let allowed = true;
  const revoked = fixture({ activity: async () => { allowed = false; return sample; },
    authorize: project => { if (!allowed) throw new Error("revoked"); return project; } });
  await assert.rejects(revoked.client.activity(remote), /revoked/);
  const mismatch = fixture({ identity: () => "other/project", activity: () => assert.fail() });
  await assert.rejects(mismatch.client.activity(remote), { code: "FLEET_REPOSITORY_MISMATCH" });
});
