import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackgroundRelay, serveBackgroundRelay } from "../src/background-relay.mjs";
import { callBackgroundRelay, relayConnection } from "../src/background-relay-client.mjs";
import { BACKGROUND_AGENTS, configureRelay, readRelayConfiguration, relayFailure, relayPaths, writeRelayJson } from "../src/background-relay-config.mjs";

const next = () => new Promise(setImmediate);

async function until(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for fixture state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t, options = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "worker-relay-")));
  const project = path.join(directory, "project");
  const otherProject = path.join(directory, "other-project");
  fs.mkdirSync(project);
  fs.mkdirSync(otherProject);
  const env = { AGENT_RELAY_DIRECTORY: path.join(directory, "relay"), USERPROFILE: directory, HOME: directory,
    CODEX_APP_TOOLS_PIPE_PATH: "unavailable-native-host", CODEX_THREAD_ID: randomUUID(), CLAUDE_CODE_ENTRYPOINT: "claude-desktop", ELECTRON_RUN_AS_NODE: "1", ...options.env };
  const config = configureRelay({ env, projectPolicy: path.join(directory, "project-policy.json") });
  const revoked = new Set();
  const scope = {
    capture(candidate) {
      const target = fs.realpathSync.native(candidate);
      if (![project, otherProject].includes(target) || revoked.has(target)) throw relayFailure("WORKER_PROJECT_DENIED", "The fixture project is not authorized");
      return { path: target, identity: `fixture:${target}` };
    },
    recheck(binding) {
      if (revoked.has(binding.path) || binding.identity !== `fixture:${binding.path}`) throw relayFailure("WORKER_PROJECT_REVOKED", "The fixture project was revoked");
      return binding;
    },
  };
  const runs = [];
  const relays = [];
  const adapters = Object.fromEntries(BACKGROUND_AGENTS.map(agent => [agent, {
    inspect: async (settings) => options.inspect?.[agent]?.(settings) ?? { agent, available: true, authenticated: true, ready: true, version: "fixture", executable: process.execPath },
    run: async (settings) => {
      let finish;
      let reject;
      const pending = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
      const record = { agent, ...settings, finish: value => finish(value ?? { output: `${agent} completed`, sessionId: settings.sessionId, deliveryState: "sent" }), reject };
      runs.push(record);
      if (options.run?.[agent]) return options.run[agent](settings, record);
      const abort = () => reject(relayFailure("FIXTURE_CANCELLED", "The fixture worker was cancelled", "unknown"));
      settings.signal?.addEventListener("abort", abort, { once: true });
      if (!options.hold) {
        await settings.onEvent({ type: "session", sessionId: settings.sessionId });
        await settings.onEvent({ type: "accepted", sessionId: settings.sessionId });
        record.finish();
      }
      try { return await pending; }
      finally { settings.signal?.removeEventListener("abort", abort); }
    },
  }]));
  const makeRelay = (extra = {}) => {
    const relay = new BackgroundRelay({ config, adapters, scope, env, ...options.limits, ...extra });
    relays.push(relay);
    return relay;
  };
  const relay = makeRelay();
  t.after(async () => {
    for (const instance of relays) {
      instance.schedule = () => {};
      for (const job of instance.jobs.values()) if (job.status === "queued") job.status = "failed";
      for (const active of instance.active.values()) active.controller.abort();
    }
    for (const run of runs) run.finish();
    await until(() => relays.every(instance => instance.active.size === 0));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  if (options.initialize !== false) { await relay.initialize(); await relay.refreshHealth(); }
  const request = (method, params = {}, credentials = {}) => ({ schemaVersion: 1, id: randomUUID(), method, params, token: config.token, ...credentials });
  const call = (method, params, credentials) => relay.handle(request(method, params, credentials));
  const send = (params = {}, credentials) => call("send", { agent: "claude", requestId: randomUUID(), prompt: "Authorized fixture task", cwd: project, ...params }, credentials);
  const credentials = (run) => ({ token: run.relayMcp.env.AGENT_RELAY_TOKEN, workerId: run.relayMcp.env.AGENT_RELAY_WORKER_ID });
  const wait = async (requestId) => { await until(() => ["completed", "failed", "unknown"].includes(relay.jobs.get(requestId)?.status) && !relay.active.has(requestId)); return call("read", { requestId }); };
  return { directory, project, otherProject, env, config, scope, revoked, runs, adapters, relay, makeRelay, request, call, send, credentials, wait };
}

test("relay configuration is private stable and preserves an intentional disabled provider", async (t) => {
  const box = await fixture(t);
  assert.match(box.config.token, /^[A-Za-z0-9_-]{43}$/);
  const saved = JSON.parse(fs.readFileSync(box.config.paths.config, "utf8"));
  saved.providers.claude.enabled = false;
  saved.providers.codex.executable = process.execPath;
  writeRelayJson(box.config.paths.config, saved);
  const updated = configureRelay({ env: box.env });
  assert.equal(updated.token, box.config.token);
  assert.equal(updated.providers.claude.enabled, false);
  assert.equal(updated.providers.codex.executable, process.execPath);
  assert.equal(updated.projectPolicy, box.config.projectPolicy);
  assert.equal(relayPaths(box.env).endpoint, updated.endpoint);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(updated.paths.root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(updated.paths.config).mode & 0o777, 0o600);
  }
  const status = await box.call("status");
  assert.equal(JSON.stringify(status).includes(box.config.token), false);
  assert.equal(readRelayConfiguration({ env: box.env }).providers.claude.enabled, false);
});

test("standalone jobs complete with absent native hosts and scrub native IPC environment", async (t) => {
  const box = await fixture(t);
  const created = await box.send();
  const result = await box.wait(created.requestId);
  assert.equal(result.status, "completed");
  assert.equal(result.surface, "background-cli");
  assert.equal(result.source.kind, "local-client");
  assert.equal(result.output, "claude completed");
  const run = box.runs[0];
  for (const key of ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_THREAD_ID", "CLAUDE_CODE_ENTRYPOINT", "ELECTRON_RUN_AS_NODE"]) assert.equal(run.env[key], undefined);
  assert.equal(run.relayMcp.env.AGENT_RELAY_TOKEN === box.config.token, false);
  assert.equal(run.relayMcp.env.AGENT_RELAY_REQUEST_ID, created.requestId);
  assert.ok(run.prompt.includes("not a Desktop chat"));
  const status = await box.call("status");
  assert.equal(status.desktopRequired, false);
  assert.equal(status.opensApps, false);
  assert.equal(status.opensChats, false);
  assert.equal(JSON.stringify(status).includes(run.relayMcp.env.AGENT_RELAY_TOKEN), false);
});

test("wrong master credentials and incomplete worker credentials fail closed", async (t) => {
  const box = await fixture(t);
  await assert.rejects(box.call("status", {}, { token: "wrong" }), { code: "WORKER_IDENTITY_INVALID", deliveryState: "not_sent" });
  await assert.rejects(box.call("status", {}, { token: box.config.token, workerId: randomUUID() }), { code: "WORKER_IDENTITY_INVALID" });
  assert.throws(() => relayConnection({ AGENT_RELAY_TOKEN: box.config.token }), { code: "WORKER_IDENTITY_INCOMPLETE" });
  assert.equal(box.runs.length, 0);
});

test("active worker capabilities permit only their project and delegation tree", async (t) => {
  const box = await fixture(t, { hold: true });
  const root = await box.send({ agent: "codex" });
  await until(() => box.runs.length === 1);
  const credentials = box.credentials(box.runs[0]);
  const unrelated = await box.send({ cwd: box.otherProject, prompt: "Unrelated project" });
  await assert.rejects(box.send({ agent: "antigravity", cwd: box.otherProject }, credentials), { code: "WORKER_PROJECT_MISMATCH", sent: false });
  const child = await box.send({ agent: "claude", prompt: "Delegated same-project task" }, credentials);
  assert.equal(child.rootId, root.requestId);
  assert.equal(child.parentRequestId, root.requestId);
  assert.equal(child.source.kind, "background-worker");
  assert.equal(child.source.agent, "codex");
  assert.equal((await box.call("read", { requestId: child.requestId }, credentials)).requestId, child.requestId);
  await assert.rejects(box.call("read", { requestId: unrelated.requestId }, credentials), { code: "WORKER_RECEIPT_NOT_FOUND" });
  const list = await box.call("list", {}, credentials);
  assert.deepEqual(new Set(list.tasks.map(item => item.requestId)), new Set([root.requestId, child.requestId]));
  await assert.rejects(box.call("drain", {}, credentials), { code: "WORKER_METHOD_NOT_ALLOWED" });
});

test("worker tokens expire after completion and cannot be reused for new work", async (t) => {
  const box = await fixture(t, { hold: true });
  const root = await box.send();
  await until(() => box.runs.length === 1);
  const run = box.runs[0];
  const credentials = box.credentials(run);
  await assert.rejects(box.call("status", {}, { ...credentials, token: "wrong-worker-token" }), { code: "WORKER_IDENTITY_INVALID" });
  await assert.rejects(box.call("status", {}, { ...credentials, workerId: randomUUID() }), { code: "WORKER_IDENTITY_INVALID" });
  assert.equal((await box.call("status", {}, credentials)).transportReady, true);
  run.finish();
  await box.wait(root.requestId);
  await assert.rejects(box.send({}, credentials), { code: "WORKER_IDENTITY_INVALID" });
  const disk = fs.readFileSync(path.join(box.config.paths.jobs, `${root.requestId}.json`), "utf8");
  assert.equal(disk.includes(credentials.token), false);
});

test("stable request IDs deduplicate queued running and completed deliveries", async (t) => {
  const box = await fixture(t, { hold: true });
  const requestId = randomUUID();
  const params = { requestId, prompt: "Once only" };
  const first = await box.send(params);
  assert.equal((await box.send(params)).workerId, first.workerId);
  await until(() => box.runs.length === 1);
  assert.equal((await box.send(params)).workerId, first.workerId);
  await assert.rejects(box.send({ ...params, prompt: "Different work" }), { code: "WORKER_REQUEST_CONFLICT" });
  await assert.rejects(box.send({ ...params, agent: "codex" }), { code: "WORKER_REQUEST_CONFLICT" });
  box.runs[0].finish();
  await box.wait(requestId);
  assert.equal((await box.send(params)).status, "completed");
  assert.equal(box.runs.length, 1);
});

test("queue and per-provider concurrency limits bound dispatch while dedupe still works", async (t) => {
  const box = await fixture(t, { hold: true, limits: { maxConcurrent: 1, maxQueued: 1 } });
  const first = await box.send();
  await until(() => box.runs.length === 1);
  const queuedId = randomUUID();
  const queued = await box.send({ requestId: queuedId, agent: "codex" });
  assert.equal(queued.status, "queued");
  await assert.rejects(box.send({ agent: "antigravity" }), { code: "WORKER_QUEUE_FULL", sent: false });
  assert.equal((await box.send({ requestId: queuedId, agent: "codex" })).workerId, queued.workerId);
  box.runs[0].finish();
  await box.wait(first.requestId);
  await until(() => box.runs.length === 2);
  box.runs[1].finish();
  await box.wait(queuedId);
  const parallel = await fixture(t, { hold: true });
  await parallel.send();
  await parallel.send();
  await parallel.send();
  await until(() => parallel.runs.length === 2);
  await next();
  assert.equal(parallel.runs.length, 2);
  assert.equal([...parallel.relay.jobs.values()].filter(job => job.status === "queued").length, 1);
});

test("delegation depth and total tree limits prevent worker fanout loops", async (t) => {
  const depth = await fixture(t, { hold: true });
  let job = await depth.send({ agent: "codex" });
  for (const agent of ["claude", "antigravity", "codex", "claude"]) {
    await until(() => depth.runs.some(run => run.requestId === job.requestId));
    const parent = depth.runs.find(run => run.requestId === job.requestId);
    job = await depth.send({ agent }, depth.credentials(parent));
  }
  await until(() => depth.runs.some(run => run.requestId === job.requestId));
  const leaf = depth.runs.find(run => run.requestId === job.requestId);
  await assert.rejects(depth.send({ agent: "antigravity" }, depth.credentials(leaf)), { code: "WORKER_DELEGATION_LIMIT" });
  const fanout = await fixture(t, { hold: true });
  await fanout.send({ agent: "codex" });
  await until(() => fanout.runs.length === 1);
  const credentials = fanout.credentials(fanout.runs[0]);
  for (let index = 0; index < 15; index++) await fanout.send({ prompt: `Authorized child ${index}` }, credentials);
  await assert.rejects(fanout.send({ prompt: "Too many children" }, credentials), { code: "WORKER_DELEGATION_LIMIT" });
});

test("denied and revoked projects never reach a CLI adapter", async (t) => {
  const box = await fixture(t);
  box.revoked.add(box.otherProject);
  await assert.rejects(box.send({ cwd: box.otherProject }), { code: "WORKER_PROJECT_NOT_AUTHORIZED", deliveryState: "not_sent" });
  const queued = await box.send();
  box.revoked.add(box.project);
  const result = await box.wait(queued.requestId);
  assert.equal(result.status, "failed");
  assert.equal(result.sent, false);
  assert.equal(result.diagnostic.code, "WORKER_PROJECT_REVOKED");
  assert.equal(box.runs.length, 0);
});

test("missing authentication fails before dispatch and persists a report readable after restart", async (t) => {
  const box = await fixture(t, { inspect: { claude: async () => ({ available: true, authenticated: false, ready: false, code: "CLAUDE_CLI_AUTH_REQUIRED", reason: "CLI login required" }) } });
  const job = await box.send();
  const receipt = await box.wait(job.requestId);
  assert.equal(receipt.deliveryState, "not_sent");
  assert.equal(receipt.diagnostic.code, "CLAUDE_CLI_AUTH_REQUIRED");
  assert.equal(box.runs.length, 0);
  const status = await box.call("status");
  assert.equal(status.recentErrors[0].diagnostic.reportId, receipt.diagnostic.reportId);
  const restarted = box.makeRelay();
  await restarted.initialize();
  const restored = await restarted.handle(box.request("read", { requestId: job.requestId }));
  assert.equal(restored.diagnostic.reportId, receipt.diagnostic.reportId);
  assert.equal(restored.diagnostic.timestamp, receipt.diagnostic.timestamp);
  assert.equal(restored.sent, false);
});

test("unready providers are blocked except explicitly unverified Antigravity authentication", async (t) => {
  for (const readiness of [
    { agent: "claude", available: true, authenticated: null, code: "CLAUDE_CLI_AUTH_CHECK_FAILED" },
    { agent: "claude", available: true, authenticated: null, code: "CLAUDE_CLI_AUTH_UNVERIFIED" },
    { agent: "antigravity", available: false, authenticated: null, code: "ANTIGRAVITY_CLI_AUTH_UNVERIFIED" },
    { agent: "antigravity", available: true, authenticated: false, code: "ANTIGRAVITY_CLI_AUTH_UNVERIFIED" },
    { agent: "antigravity", available: true, authenticated: null, code: "ANTIGRAVITY_CLI_AUTH_CHECK_FAILED" },
  ]) {
    const blocked = await fixture(t, { inspect: { [readiness.agent]: async () => ({ ...readiness, ready: false, reason: "Worker readiness could not be established" }) } });
    const denied = await blocked.send({ agent: readiness.agent });
    const result = await blocked.wait(denied.requestId);
    assert.equal(result.status, "failed");
    assert.equal(result.sent, false);
    assert.equal(blocked.runs.length, 0);
  }
  const deferred = await fixture(t, { hold: true, inspect: { antigravity: async () => ({ available: true, authenticated: null, ready: false, code: "ANTIGRAVITY_CLI_AUTH_UNVERIFIED", reason: "No non-inference auth probe is available" }) } });
  const created = await deferred.send({ agent: "antigravity" });
  await until(() => deferred.runs.length === 1);
  const status = await deferred.call("status");
  assert.equal(status.workers.find(worker => worker.agent === "antigravity").ready, false);
  assert.equal(status.workers.find(worker => worker.agent === "antigravity").authenticated, null);
  deferred.runs[0].finish();
  assert.equal((await deferred.wait(created.requestId)).status, "completed");
});

test("post-dispatch crashes remain unknown with no replay while explicit preflight failures remain unsent", async (t) => {
  for (const accepted of [false, true]) {
    const box = await fixture(t, { run: { claude: async settings => { if (accepted) await settings.onEvent({ type: "accepted", sessionId: settings.sessionId }); throw new Error("Unexpected process failure"); } } });
    const params = { requestId: randomUUID(), prompt: "Do not replay" };
    const job = await box.send(params);
    const result = await box.wait(job.requestId);
    assert.equal(result.status, "unknown");
    assert.equal(result.deliveryState, "unknown");
    assert.equal(result.sent, null);
    assert.equal((await box.send(params)).status, "unknown");
    assert.equal(box.runs.length, 1);
  }
  const beforeWrite = await fixture(t, { run: { claude: async () => { throw relayFailure("CLAUDE_WORKER_SPAWN_FAILED", "No process was created"); } } });
  const job = await beforeWrite.send();
  const receipt = await beforeWrite.wait(job.requestId);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.deliveryState, "not_sent");
  assert.equal(receipt.sent, false);
});

test("restart preserves uncertain work and resumes only receipts that were still queued", async (t) => {
  const box = await fixture(t, { initialize: false });
  box.relay.schedule = () => {};
  const interrupted = await box.send({ prompt: "Previously running" });
  const untouched = await box.send({ prompt: "Still queued" });
  const running = box.relay.jobs.get(interrupted.requestId);
  running.status = "running";
  running.deliveryState = "sent";
  box.relay.persist(running);
  const restarted = box.makeRelay();
  await restarted.initialize();
  await until(() => restarted.jobs.get(untouched.requestId)?.status === "completed" && restarted.active.size === 0);
  assert.deepEqual(box.runs.map(run => run.requestId), [untouched.requestId]);
  const unknown = await restarted.handle(box.request("read", { requestId: interrupted.requestId }));
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.sent, null);
  assert.equal(unknown.diagnostic.code, "WORKER_INTERRUPTED");
  assert.equal((await restarted.handle(box.request("status"))).recentErrors[0].requestId, interrupted.requestId);
  const secondRestart = box.makeRelay();
  await secondRestart.initialize();
  await next();
  assert.equal(box.runs.length, 1);
  assert.equal((await secondRestart.handle(box.request("read", { requestId: interrupted.requestId }))).diagnostic.reportId, unknown.diagnostic.reportId);
});

test("malformed durable receipts fail visibly without replacing their evidence", async (t) => {
  const box = await fixture(t, { initialize: false });
  const file = path.join(box.config.paths.jobs, `${randomUUID()}.json`);
  fs.writeFileSync(file, "malformed receipt");
  await assert.rejects(box.relay.initialize(), { code: "WORKER_RECEIPT_INVALID" });
  assert.equal(fs.readFileSync(file, "utf8"), "malformed receipt");
});

test("draining refuses new work while finishing queued work already accepted", async (t) => {
  const box = await fixture(t, { hold: true, limits: { maxConcurrent: 1 } });
  const first = await box.send();
  await until(() => box.runs.length === 1);
  const second = await box.send({ agent: "codex" });
  assert.equal((await box.call("drain")).queued, 1);
  await assert.rejects(box.send(), { code: "WORKER_RELAY_DRAINING", sent: false });
  box.runs[0].finish();
  await box.wait(first.requestId);
  await until(() => box.runs.length === 2);
  box.runs[1].finish();
  assert.equal((await box.wait(second.requestId)).status, "completed");
});

test("private IPC serves independently while callers disconnect and native endpoints stay frozen", async (t) => {
  const box = await fixture(t, { hold: true, limits: { maxConcurrent: 1 } });
  const frozenEndpoint = process.platform === "win32" ? `\\\\.\\pipe\\fixture-frozen-native-${randomUUID()}` : path.join(box.directory, "native.sock");
  let nativeConnections = 0;
  const frozen = net.createServer(socket => { nativeConnections++; socket.on("error", () => {}); });
  await new Promise((resolve, reject) => { frozen.once("error", reject); frozen.listen(frozenEndpoint, resolve); });
  t.after(() => new Promise(resolve => frozen.close(resolve)));
  box.relay.env.CODEX_APP_TOOLS_PIPE_PATH = frozenEndpoint;
  let protectedPipe = false;
  const serving = await serveBackgroundRelay(box.relay, { protectPipe: async () => { protectedPipe = true; } });
  t.after(() => serving.close());
  if (process.platform === "win32") assert.equal(protectedPipe, true);
  else assert.equal(fs.statSync(box.config.endpoint).mode & 0o777, 0o600);
  const connection = { endpoint: box.config.endpoint, token: box.config.token, workerId: null };
  const status = await callBackgroundRelay("status", {}, { connection });
  assert.equal(status.transportReady, true);
  assert.equal(status.desktopRequired, false);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const first = await callBackgroundRelay("send", { agent: "claude", requestId: firstId, prompt: "First IPC task", cwd: box.project }, { connection });
  await until(() => box.runs.length === 1);
  const second = await callBackgroundRelay("send", { agent: "codex", requestId: secondId, prompt: "Queued IPC task", cwd: box.project }, { connection });
  assert.equal(first.requestId, firstId);
  assert.equal(second.status, "queued");
  box.runs[0].finish();
  await box.wait(firstId);
  await until(() => box.runs.length === 2);
  box.runs[1].finish();
  await box.wait(secondId);
  assert.equal((await callBackgroundRelay("read", { requestId: secondId }, { connection })).status, "completed");
  assert.equal(nativeConnections, 0);
  await assert.rejects(callBackgroundRelay("status", {}, { connection: { ...connection, token: "incorrect" } }), { code: "WORKER_RELAY_AUTH_FAILED", deliveryState: "not_sent" });
});

test("client transport keeps failed connect and interrupted authentication unsent", async (t) => {
  const box = await fixture(t);
  const connection = { endpoint: box.config.endpoint, token: box.config.token, workerId: null };
  await assert.rejects(callBackgroundRelay("send", {}, { connection, connect() { throw new Error("unavailable"); } }), { code: "WORKER_RELAY_UNAVAILABLE", deliveryState: "not_sent" });
  const dropping = net.createServer(socket => { socket.once("data", () => socket.destroy()); socket.on("error", () => {}); });
  await new Promise((resolve, reject) => { dropping.once("error", reject); dropping.listen(box.config.endpoint, resolve); });
  t.after(() => new Promise(resolve => dropping.close(resolve)));
  await assert.rejects(callBackgroundRelay("send", { requestId: randomUUID() }, { connection }), { code: "WORKER_RELAY_INTERRUPTED", deliveryState: "not_sent", sent: false });
  await assert.rejects(callBackgroundRelay("status", {}, { connection }), { code: "WORKER_RELAY_INTERRUPTED", deliveryState: "not_sent" });
});
