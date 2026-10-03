import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { SitesConnector, SitesOperationJournal, createSitesDesktopBackend, loadSitesConfig, pairSitesConnector, sitesHardenedEnv, validateSitesConfig, validateSitesJob } from "../src/sites-connector.mjs";

const identity = { claude: "a".repeat(64), codex: "b".repeat(64) };
const currentAccounts = () => Object.fromEntries(Object.entries(identity).map(([name, fingerprint]) => [name, { status: "verified", fingerprint }]));
const configFor = (root) => ({ siteUrl: "https://bridge.example", serviceToken: "private-service", connectorId: randomUUID(), connectorToken: "private-connector".repeat(3), ownerEmail: "owner@example.com", allowedRoots: [root], accountContext: identity });
const reply = { content: [{ type: "text", text: "accepted" }], structuredContent: { threadId: "task", state: "accepted" } };
const jobFor = (requestId = randomUUID()) => ({ id: randomUUID(), tool: "send_to_codex_thread", arguments: { threadId: "task", prompt: "test fixture only", requestId }, requestId, expiresAt: Date.now() + 120000 });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sites-connector-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = validateSitesConfig(configFor(directory));
  const journal = new SitesOperationJournal({ directory: path.join(directory, "journal"), config });
  return { directory, config, journal };
}

function transport(jobs, { failUploads = 0 } = {}) {
  const requests = [];
  return {
    requests,
    fetch: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith("/agent/result") && failUploads-- > 0) throw new Error("lost upload acknowledgement");
      return new Response(JSON.stringify(url.endsWith("/agent/poll") ? { job: jobs.shift() ?? null } : url.endsWith("/agent/heartbeat") ? { paired: true } : { ok: true }), { status: 200 });
    },
  };
}

it("requires HTTPS origin, explicit absolute roots and exact configuration fields", async (t) => {
  const f = await fixture(t);
  for (const siteUrl of ["http://bridge.example", "https://user:secret@bridge.example", "https://bridge.example/other", "https://bridge.example?secret=yes", "file:///tmp/test"]) assert.throws(() => validateSitesConfig({ ...f.config, siteUrl }));
  assert.throws(() => validateSitesConfig({ ...f.config, allowedRoots: ["relative"] }));
  assert.throws(() => validateSitesConfig({ ...f.config, connectorToken: "secret\r\nHeader: value" }));
  assert.throws(() => validateSitesConfig({ ...f.config, connectorToken: "x".repeat(32) }));
  assert.throws(() => validateSitesConfig({ ...f.config, connectorToken: "invalid=".repeat(8) }));
  assert.throws(() => validateSitesConfig({ ...f.config, extra: true }));
  assert.throws(() => validateSitesConfig({ ...f.config, siteUrl: "http://127.0.0.1:3000" }));
  assert.equal(validateSitesConfig({ ...f.config, siteUrl: "http://127.0.0.1:3000" }, { allowLoopback: true }).siteUrl, "http://127.0.0.1:3000");
});

it("loads only an absolute bounded regular configuration file", async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, "connector.json");
  await fs.writeFile(file, JSON.stringify(f.config));
  assert.deepEqual(await loadSitesConfig(file), f.config);
  await assert.rejects(loadSitesConfig("relative.json"), /absolute/);
  await fs.writeFile(file, " ".repeat(65537));
  await assert.rejects(loadSitesConfig(file), /oversized/);
});

it("validates strict tool arguments, UUID idempotency and supported native operations", () => {
  const job = jobFor();
  assert.deepEqual(validateSitesJob(job), job);
  assert.equal(validateSitesJob({ id: "read", tool: "list_codex_projects", arguments: {}, requestId: null }).requestId, null);
  for (const bad of [
    { ...job, requestId: randomUUID() }, { ...job, tool: "arbitrary_proxy" },
    { ...job, arguments: { ...job.arguments, operation: "delete" } },
    { ...job, arguments: { ...job.arguments, requestId: "unsafe/path" } },
    { id: "job", tool: "list_codex_threads", arguments: { limit: 1000 } },
    { id: "job", tool: "read_codex_thread", arguments: { threadId: "task", hostId: "remote" } },
  ]) assert.throws(() => validateSitesJob(bad));
});

it("sets the strict Desktop profile and removes inherited wildcard authority", async (t) => {
  const f = await fixture(t);
  const env = sitesHardenedEnv(f.config, { CODEX_BRIDGE_ALLOWED_THREADS: "*", CODEX_BRIDGE_PATH_MAP: "unsafe" });
  assert.equal(env.CODEX_BRIDGE_HARDENED, "1");
  assert.equal(env.CODEX_BRIDGE_ALLOWED_THREADS, "");
  assert.equal(env.CODEX_BRIDGE_PATH_MAP, "");
  assert.equal(env.CODEX_BRIDGE_ALLOWED_ROOTS, f.directory);
  assert.equal(env.CODEX_BRIDGE_AUTOSTART, "0");
});

it("posts both credentials with redirect rejection and bounded HTTP timeout", async (t) => {
  const f = await fixture(t);
  const net = transport([]);
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {} }, fetchImpl: net.fetch });
  assert.deepEqual(await connector.step(), { state: "idle" });
  const { options } = net.requests[0];
  assert.equal(options.headers.Authorization, `Bearer ${f.config.connectorToken}`);
  assert.equal(options.headers["X-Codex-Connector-ID"], f.config.connectorId);
  assert.equal(options.headers["OAI-Sites-Authorization"], "Bearer private-service");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), {});
});

it("rejects invalid jobs before local dispatch without exposing validation details", async (t) => {
  const f = await fixture(t);
  const net = transport([{ ...jobFor(), tool: "arbitrary_proxy" }]);
  let calls = 0;
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, execute() { calls++; } }, fetchImpl: net.fetch });
  assert.equal((await connector.step()).state, "blocked");
  assert.equal(calls, 0);
  assert.equal(net.requests.at(-1).body.result.isError, true);
});

it("journals a mutation before dispatch and never executes duplicate requests twice", async (t) => {
  const f = await fixture(t);
  const job = jobFor();
  const net = transport([job, { ...job, id: randomUUID() }]);
  let calls = 0;
  const backend = { checkAccount() {}, async execute(value) { calls++; assert.equal((await f.journal.read(f.journal.key(value))).state, "started"); return reply; } };
  const connector = new SitesConnector({ ...f, backend, fetchImpl: net.fetch });
  assert.equal((await connector.step()).state, "completed");
  assert.equal((await connector.step()).state, "completed");
  assert.equal(calls, 1);
  assert.deepEqual(net.requests.filter((request) => request.url.endsWith("/agent/result")).map((request) => request.body.result), [reply, reply]);
});

it("blocks edited duplicate request IDs while preserving their original result", async (t) => {
  const f = await fixture(t);
  const job = jobFor();
  const net = transport([job, { ...job, id: randomUUID(), arguments: { ...job.arguments, prompt: "changed fixture" } }]);
  let calls = 0;
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, async execute() { calls++; return reply; } }, fetchImpl: net.fetch });
  await connector.step();
  assert.equal((await connector.step()).state, "blocked");
  assert.equal(calls, 1);
  assert.deepEqual((await f.journal.read(f.journal.key(job))).result, reply);
});

it("recovers a crash after claiming a mutation as uncertain without redispatching", async (t) => {
  const f = await fixture(t);
  const job = jobFor();
  await f.journal.begin(job);
  const net = transport([job]);
  let calls = 0;
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, async execute() { calls++; return reply; } }, fetchImpl: net.fetch });
  assert.equal((await connector.step()).state, "uncertain");
  assert.equal(calls, 0);
  assert.equal(net.requests.find((request) => request.url.endsWith("/agent/result")).body.result.structuredContent.state, "uncertain");
});

it("retries an upload after restart using the saved result without repeating the operation", async (t) => {
  const f = await fixture(t);
  const net = transport([jobFor()], { failUploads: 1 });
  let calls = 0;
  const backend = { checkAccount() {}, async execute() { calls++; return reply; } };
  await assert.rejects(new SitesConnector({ ...f, backend, fetchImpl: net.fetch }).step(), /lost upload/);
  const journal = new SitesOperationJournal({ directory: f.journal.directory, config: f.config });
  assert.equal((await new SitesConnector({ ...f, journal, backend, fetchImpl: net.fetch }).step()).state, "idle");
  assert.equal(calls, 1);
  assert.deepEqual(net.requests.filter((request) => request.url.endsWith("/agent/result")).map((request) => request.body.result), [reply, reply]);
});

it("withholds saved replies after the original local account changes", async (t) => {
  const f = await fixture(t);
  const job = jobFor();
  const { entry } = await f.journal.begin(job);
  await f.journal.save({ ...entry, state: "finished", result: reply });
  const net = transport([]);
  const connector = new SitesConnector({ ...f, backend: { checkAccount() { throw new Error("account changed"); } }, fetchImpl: net.fetch });
  await assert.rejects(connector.step(), /account changed/);
  assert.equal(net.requests.length, 0);
});

it("retains unverified sends as uncertain and never exposes internal exceptions", async (t) => {
  const f = await fixture(t);
  const net = transport([jobFor()]);
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, async execute() { throw new Error("secret-token private-path"); } }, fetchImpl: net.fetch });
  assert.equal((await connector.step()).state, "uncertain");
  assert.equal(JSON.stringify(net.requests.at(-1).body).includes("secret-token"), false);
});

it("fails closed on corrupt journal entries before dispatch", async (t) => {
  const f = await fixture(t);
  const job = jobFor();
  await f.journal.prepare();
  await fs.writeFile(path.join(f.journal.directory, `${f.journal.key(job)}.json`), "{invalid");
  let calls = 0;
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, async execute() { calls++; } }, fetchImpl: transport([job]).fetch });
  await assert.rejects(connector.step());
  assert.equal(calls, 0);
});

it("guards every relay operation with independent metadata checks and account context", async (t) => {
  const f = await fixture(t);
  const phases = [];
  const calls = [];
  let suppliedDelivery;
  const backend = createSitesDesktopBackend(f.config, {
    configDirectory: f.directory, readAccounts: currentAccounts, resolveExecutor: () => ({ threadId: "executor" }),
    relay: { async requestDesktop(operation, args, options) { await options.beforeSend?.(); calls.push({ operation, args, options }); return { executorThreadId: "executor", result: { projects: [] } }; } },
    authorizeFactory: ({ dispatchDesktop }) => async (request) => { phases.push(request.phase ?? "before"); if (!request.phase) assert.deepEqual(await dispatchDesktop({ operation: "list_projects", arguments: {} }), { success: true, structuredContent: { projects: [] } }); return { result: request.result }; },
    Delivery: class {
      constructor(options) { suppliedDelivery = options; }
      request(operation, args, options) { return suppliedDelivery.relay.requestDesktop(operation, args, options).then((response) => response.result); }
    },
  });
  assert.equal(suppliedDelivery.senderContext, undefined);
  await backend.execute(validateSitesJob({ id: "read", tool: "list_codex_projects", arguments: {} }));
  assert.deepEqual(phases, ["before", "write", "return"]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual(call.options.accountContext, identity);
});

it("blocks local startup when either original account is missing or different", async (t) => {
  const f = await fixture(t);
  for (const accounts of [{ codex: currentAccounts().codex }, { ...currentAccounts(), codex: { status: "verified", fingerprint: "c".repeat(64) } }]) assert.throws(() => createSitesDesktopBackend(f.config, { readAccounts: () => accounts }));
});

it("pairs a public device with fresh private credentials and reuses the exact credential on retry", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const configFile = path.join(f.directory, "paired", "connector.json");
  const dependencies = {
    configFile, siteUrl: f.config.siteUrl, allowedRoots: [f.directory], readAccounts: currentAccounts,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url, options, body });
      return new Response(JSON.stringify({ pairingUrl: `${f.config.siteUrl}/connect?code=${body.connectorId}` }));
    },
  };
  const first = await pairSitesConnector(dependencies);
  const second = await pairSitesConnector(dependencies);
  assert.equal(first.config.connectorToken.length, 43);
  assert.equal(first.config.connectorId, second.config.connectorId);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.equal(calls[0].options.headers["OAI-Sites-Authorization"], undefined);
  assert.equal(first.config.ownerEmail, undefined);
  assert.deepEqual(await loadSitesConfig(configFile), first.config);
});

it("does not silently overwrite pairing for another site or root", async (t) => {
  const f = await fixture(t);
  const configFile = path.join(f.directory, "connector.json");
  await fs.writeFile(configFile, JSON.stringify(f.config));
  await assert.rejects(pairSitesConnector({ configFile, siteUrl: "https://another.example", allowedRoots: [f.directory], readAccounts: currentAccounts }), /different Site/);
  assert.deepEqual(await loadSitesConfig(configFile), f.config);
});

it("keeps device journal namespaces distinct for different public users", async (t) => {
  const f = await fixture(t);
  const job = jobFor();
  const other = new SitesOperationJournal({ directory: f.journal.directory, config: { ...f.config, connectorId: randomUUID() } });
  assert.notEqual(f.journal.key(job), other.key(job));
});

it("waits for browser-confirmed pairing and sends no Desktop operation", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, execute() { calls++; } }, fetchImpl: async () => new Response(JSON.stringify({ paired: false, job: null })) });
  assert.deepEqual(await connector.step(), { state: "pairing" });
  assert.equal(calls, 0);
});

it("rejects missing and expired worker deadlines before journaling or dispatch", async (t) => {
  const f = await fixture(t);
  const missing = jobFor();
  delete missing.expiresAt;
  const expired = { ...jobFor(), expiresAt: Date.now() - 1 };
  const net = transport([missing, expired]);
  let calls = 0;
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, execute() { calls++; } }, fetchImpl: net.fetch });
  assert.equal((await connector.step()).state, "blocked");
  assert.equal((await connector.step()).state, "blocked");
  assert.equal(calls, 0);
  assert.equal((await f.journal.pending()).length, 0);
});

it("returns a bounded honest error for oversized Desktop results without replaying them", async (t) => {
  const f = await fixture(t);
  const net = transport([jobFor()]);
  let calls = 0;
  const connector = new SitesConnector({ ...f, backend: { checkAccount() {}, async execute() { calls++; return { content: [{ type: "text", text: "x".repeat(200000) }] }; } }, fetchImpl: net.fetch });
  assert.equal((await connector.step()).state, "result_too_large");
  assert.equal(calls, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(net.requests.at(-1).body)) < 100000);
});

it("independently refuses a target outside the allowed roots before any native mutation", async (t) => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sites-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const writes = [];
  let deliveryOptions;
  const backend = createSitesDesktopBackend(f.config, {
    readAccounts: currentAccounts, resolveExecutor: () => ({ threadId: "executor" }),
    relay: {
      async requestDesktop(operation, args, options) {
        await options.beforeSend?.();
        let value;
        if (operation === "list_projects") value = { projects: [{ projectId: "allowed", projectKind: "local", hostId: "local", path: f.directory }] };
        else if (operation === "read_thread") value = { thread: { id: args.threadId, kind: "codex", hostId: "local", projectId: "allowed", cwd: args.threadId === "executor" ? f.directory : outside } };
        else { writes.push(operation); value = { success: true }; }
        return { executorThreadId: "executor", result: value };
      },
    },
    Delivery: class { constructor(options) { deliveryOptions = options; } },
  });
  await assert.rejects(deliveryOptions.relay.requestDesktop("send_message_to_thread", { threadId: "outside", prompt: "fixture" }), /outside CODEX_BRIDGE_ALLOWED_ROOTS/);
  backend.checkAccount();
  assert.deepEqual(writes, []);
});

it("omits local prompt observation and account fingerprints from hosted send acknowledgements", async (t) => {
  const f = await fixture(t);
  const backend = createSitesDesktopBackend(f.config, {
    readAccounts: currentAccounts,
    Delivery: class {
      withThread(_id, callback) { return callback(); }
      async send() { return { threadId: "task", cwd: f.directory, backend: "codex-desktop-native", responseObservation: { prompt: "private prompt", accountContext: identity } }; }
    },
  });
  const outcome = await backend.execute(validateSitesJob(jobFor()));
  assert.equal(outcome.structuredContent.state, "accepted");
  assert.equal(JSON.stringify(outcome).includes("private prompt"), false);
  assert.equal(JSON.stringify(outcome).includes(identity.codex), false);
});

it("maintains liveness during execution and upload using heartbeat without claiming more work", async (t) => {
  const f = await fixture(t);
  const net = transport([jobFor()]);
  let operations = 0;
  const connector = new SitesConnector({
    ...f, heartbeatMs: 5,
    backend: { checkAccount() {}, async execute(_job, { beforeDispatch }) { await beforeDispatch(); operations++; await new Promise((resolve) => setTimeout(resolve, 35)); return reply; } },
    fetchImpl: async (url, options) => { if (url.endsWith("/agent/result")) await new Promise((resolve) => setTimeout(resolve, 25)); return net.fetch(url, options); },
  });
  assert.equal((await connector.step()).state, "completed");
  assert.equal(operations, 1);
  assert.equal(net.requests.filter((request) => request.url.endsWith("/agent/poll")).length, 1);
  assert.ok(net.requests.filter((request) => request.url.endsWith("/agent/heartbeat")).length >= 3);
  const count = net.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(net.requests.length, count);
});

it("blocks mutation after heartbeat failure and never reruns it during result recovery", async (t) => {
  const f = await fixture(t);
  const net = transport([jobFor()]);
  let executions = 0;
  let writes = 0;
  let beats = 0;
  let breakHeartbeat = true;
  const connector = new SitesConnector({
    ...f, heartbeatMs: 5,
    backend: { checkAccount() {}, async execute(_job, { beforeDispatch }) { executions++; await new Promise((resolve) => setTimeout(resolve, 25)); await beforeDispatch(); writes++; return reply; } },
    fetchImpl: async (url, options) => {
      if (url.endsWith("/agent/heartbeat") && ++beats > 1 && breakHeartbeat) throw new Error("heartbeat unavailable");
      return net.fetch(url, options);
    },
  });
  assert.equal((await connector.step()).state, "uncertain");
  assert.equal(writes, 0);
  assert.equal(executions, 1);
  breakHeartbeat = false;
  assert.equal((await connector.step()).state, "idle");
  assert.equal(executions, 1);
});

it("preserves the claim without executing when immediate heartbeat reports revocation", async (t) => {
  const f = await fixture(t);
  const net = transport([jobFor()]);
  let calls = 0;
  const connector = new SitesConnector({
    ...f,
    backend: { checkAccount() {}, execute() { calls++; } },
    fetchImpl: async (url, options) => url.endsWith("/agent/heartbeat") ? new Response(JSON.stringify({ paired: false })) : net.fetch(url, options),
  });
  await assert.rejects(connector.step(), /pairing is no longer active/);
  assert.equal(calls, 0);
  assert.equal((await f.journal.pending())[0].state, "started");
});
