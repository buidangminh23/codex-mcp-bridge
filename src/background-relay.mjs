import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { bridgeDiagnostic } from "./recipient-preflight.mjs";
import { createProjectScope, readRegularConfigFile } from "./project-policy.mjs";
import { protectCurrentUserPipe } from "./windows-pipe-acl.mjs";
import { BACKGROUND_AGENTS, RELAY_UUID, privateRelayDirectory, relayFailure, writeRelayJson } from "./background-relay-config.mjs";
import { RELAY_FRAME_LIMIT, RELAY_REPLY_LIMIT, validRelayHello, relayChallenge, verifyRelayOperation, relayResponse } from "./background-relay-protocol.mjs";
import { assertPrivateRelayFile } from "./background-relay-storage.mjs";

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const terminal = new Set(["completed", "failed", "unknown"]);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equalSecret = (left, right) => typeof left === "string" && typeof right === "string" && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export async function backgroundAdapters() {
  const [codex, claude, antigravity] = await Promise.all([import("./background-codex-worker.mjs"), import("./background-claude-worker.mjs"), import("./background-antigravity-worker.mjs")]);
  return { codex: { inspect: codex.inspectCodexWorker, run: codex.runCodexWorker },
    claude: { inspect: claude.inspectClaudeWorker, run: claude.runClaudeWorker },
    antigravity: { inspect: antigravity.inspectAntigravityWorker, run: antigravity.runAntigravityWorker } };
}

export class BackgroundRelay {
  constructor({ config, adapters, scope, env = process.env, maxConcurrent = 6, maxQueued = 64, maxRecords = 1024, now = () => new Date().toISOString() }) {
    if (!config?.enabled) throw relayFailure("WORKER_RELAY_DISABLED", "The independent relay is disabled");
    this.config = config;
    this.adapters = adapters;
    this.scope = scope ?? createProjectScope(config.projectPolicy);
    this.env = { ...env };
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
    this.maxRecords = maxRecords;
    this.now = now;
    this.jobs = new Map();
    this.capabilities = new Map();
    this.active = new Map();
    this.health = new Map();
    this.accepting = true;
    this.pumping = false;
    this.startedAt = this.now();
    privateRelayDirectory(config.paths.jobs);
  }

  persist(job) { writeRelayJson(path.join(this.config.paths.jobs, `${job.requestId}.json`), job); }

  async initialize() {
    const files = fs.readdirSync(this.config.paths.jobs).filter(name => RELAY_UUID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"));
    if (files.length > this.maxRecords) throw relayFailure("WORKER_STORAGE_LIMIT", "Too many stored worker receipts; inspect and archive completed receipts before starting more work");
    for (const file of files) {
      let job;
      try {
        const receiptFile = path.join(this.config.paths.jobs, file);
        assertPrivateRelayFile(receiptFile);
        job = JSON.parse(readRegularConfigFile(receiptFile, { maxBytes: 4 * 1024 * 1024, label: "Worker receipt" }));
      }
      catch (error) {
        if (error.code === "WORKER_STORAGE_UNSAFE") throw error;
        throw relayFailure("WORKER_RECEIPT_INVALID", "A stored worker receipt is malformed; it has not been overwritten");
      }
      if (!job || job.schemaVersion !== 1 || !RELAY_UUID.test(job.requestId) || file !== `${job.requestId}.json`
          || !BACKGROUND_AGENTS.includes(job.agent) || !["queued", "running", ...terminal].includes(job.status)
          || typeof job.prompt !== "string" || !job.binding?.path || !RELAY_UUID.test(job.rootId)
          || !Number.isInteger(job.depth) || job.depth < 0 || job.depth > 4) {
        throw relayFailure("WORKER_RECEIPT_INVALID", "A stored worker receipt has an unsupported schema; it has not been overwritten");
      }
      if (job.status === "running") {
        job.status = "unknown";
        job.deliveryState = "unknown";
        job.updatedAt = this.now();
        job.diagnostic = bridgeDiagnostic(relayFailure("WORKER_INTERRUPTED", "The relay restarted while this worker was active. Its work may have continued; inspect the result before any new request.", "unknown", "relay_restart"), { component: "background-relay", operation: "send_to_worker", requestId: job.requestId });
        this.persist(job);
      }
      this.jobs.set(job.requestId, job);
    }
    void this.refreshHealth();
    this.schedule();
  }

  authenticate(request) {
    if (!request.workerId && equalSecret(request.token, this.config.token)) return { kind: "local-client", id: "local-user" };
    const capability = this.capabilities.get(request.workerId);
    if (!capability || !equalSecret(request.token, capability.token) || !this.active.has(capability.requestId)) {
      throw relayFailure("WORKER_IDENTITY_INVALID", "Worker capability is missing, expired, or does not match an active background worker");
    }
    return { kind: "background-worker", id: request.workerId, agent: capability.agent, requestId: capability.requestId, rootId: capability.rootId, binding: capability.binding };
  }

  transportSecret(workerId) {
    const token = workerId === null ? this.config.token : this.capabilities.get(workerId)?.token;
    this.authenticate({ workerId, token });
    return token;
  }

  async refreshHealth() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = Promise.all(BACKGROUND_AGENTS.map(async agent => {
      const provider = this.config.providers[agent];
      if (!provider.enabled) { this.health.set(agent, { agent, available: false, ready: false, authenticated: null, code: "WORKER_DISABLED", checkedAt: this.now() }); return; }
      try {
        const result = await this.adapters[agent].inspect({ env: this.env, executable: provider.executable ?? undefined });
        this.health.set(agent, { agent, available: result.available === true, ready: result.ready === true,
          authenticated: result.authenticated ?? null, version: result.version ?? null,
          code: result.code ?? null, checkedAt: this.now(), diagnostic: result.reason ? bridgeDiagnostic(relayFailure(result.code ?? "WORKER_NOT_READY", result.reason), { component: `background-${agent}`, operation: "worker_status", readOnly: true }) : null });
      } catch (error) {
        this.health.set(agent, { agent, available: false, ready: false, authenticated: null, code: error.code ?? "WORKER_INSPECTION_FAILED", checkedAt: this.now(),
          diagnostic: bridgeDiagnostic(error, { component: `background-${agent}`, operation: "worker_status", readOnly: true }) });
      }
    })).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  canRead(actor, job) { return actor.kind === "local-client" || job.rootId === actor.rootId && job.binding.path === actor.binding.path; }

  receipt(job) {
    return { requestId: job.requestId, workerId: job.workerId, rootId: job.rootId, parentRequestId: job.parentRequestId,
      agent: job.agent, source: job.source, surface: "background-cli", status: job.status,
      deliveryState: job.deliveryState, sent: job.deliveryState === "sent" ? true : job.deliveryState === "not_sent" ? false : null,
      sessionId: job.sessionId ?? null, createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...(terminal.has(job.status) ? { output: job.output ?? "", outputTruncated: job.outputTruncated === true } : {}),
      ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}) };
  }

  status(actor) {
    const visible = [...this.jobs.values()].filter(job => this.canRead(actor, job));
    return { schemaVersion: 1, version, pid: process.pid, runtimeId: this.env.AGENT_RELAY_RUNTIME_ID ?? null, startedAt: this.startedAt, transportReady: true,
      accepting: this.accepting, desktopRequired: false, opensApps: false, opensChats: false,
      active: this.active.size, queued: visible.filter(job => job.status === "queued").length,
      workers: BACKGROUND_AGENTS.map(agent => this.health.get(agent) ?? { agent, available: null, authenticated: null, ready: false, code: "WORKER_INSPECTION_PENDING" }),
      recentErrors: visible.filter(job => job.diagnostic).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10).map(job => this.receipt(job)) };
  }

  async handle(request) {
    if (!request || request.schemaVersion !== 1 || !RELAY_UUID.test(request.id ?? "") || typeof request.method !== "string") throw relayFailure("WORKER_REQUEST_INVALID", "Unsupported background relay request");
    const actor = this.authenticate(request);
    const params = request.params ?? {};
    if (request.method === "status") return this.status(actor);
    if (request.method === "list") return { workers: this.status(actor).workers,
      tasks: [...this.jobs.values()].filter(job => this.canRead(actor, job)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50).map(job => this.receipt(job)) };
    if (request.method === "read") {
      const job = this.jobs.get(params.requestId);
      if (!job || !this.canRead(actor, job)) throw relayFailure("WORKER_RECEIPT_NOT_FOUND", "No worker receipt is available to this caller for that request ID");
      if (params.waitSec !== undefined && (!Number.isInteger(params.waitSec) || params.waitSec < 0 || params.waitSec > 60)) throw relayFailure("WORKER_REQUEST_INVALID", "waitSec must be an integer between 0 and 60");
      const deadline = Date.now() + (params.waitSec ?? 0) * 1000;
      while (!terminal.has(job.status) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      return this.receipt(job);
    }
    if (request.method === "send") return this.enqueue(actor, params);
    if (request.method === "drain" && actor.kind === "local-client") {
      this.accepting = false;
      return { draining: true, active: this.active.size, queued: [...this.jobs.values()].filter(job => job.status === "queued").length };
    }
    throw relayFailure("WORKER_METHOD_NOT_ALLOWED", "This background relay operation is not available to the caller");
  }

  enqueue(actor, params) {
    if (!this.accepting) throw relayFailure("WORKER_RELAY_DRAINING", "The relay is finishing existing work before an update");
    if (!BACKGROUND_AGENTS.includes(params.agent) || !RELAY_UUID.test(params.requestId ?? "") || typeof params.prompt !== "string" || !params.prompt.trim()
        || Buffer.byteLength(params.prompt) > 256 * 1024 || typeof params.cwd !== "string" || !path.isAbsolute(params.cwd)) {
      throw relayFailure("WORKER_REQUEST_INVALID", "Provide an agent, request UUID, nonempty bounded prompt and absolute project directory");
    }
    let binding;
    try { binding = this.scope.capture(params.cwd); }
    catch (cause) { throw Object.assign(relayFailure("WORKER_PROJECT_NOT_AUTHORIZED", "The selected project is not authorized by the shared project policy"), { cause }); }
    if (actor.kind === "background-worker") {
      try { this.scope.recheck(actor.binding); }
      catch (cause) { throw Object.assign(relayFailure("WORKER_PROJECT_REVOKED", "The worker project grant was revoked or its directory identity changed"), { cause }); }
      if (binding.path !== actor.binding.path || binding.identity !== actor.binding.identity) throw relayFailure("WORKER_PROJECT_MISMATCH", "A background worker can delegate only inside its authorized project");
    }
    const fingerprint = digest({ agent: params.agent, cwd: binding.path, prompt: params.prompt, owner: actor.kind === "local-client" ? "local-user" : actor.rootId });
    const existing = this.jobs.get(params.requestId);
    if (existing) {
      if (!this.canRead(actor, existing) || existing.fingerprint !== fingerprint) throw relayFailure("WORKER_REQUEST_CONFLICT", "This request ID already belongs to a different delivery");
      return this.receipt(existing);
    }
    if (!this.config.providers[params.agent].enabled) throw relayFailure("WORKER_DISABLED", "The selected worker is intentionally disabled");
    const parent = actor.kind === "background-worker" ? this.jobs.get(actor.requestId) : null;
    const depth = parent ? parent.depth + 1 : 0;
    if (depth > 4 || parent && [...this.jobs.values()].filter(job => job.rootId === parent.rootId).length >= 16) throw relayFailure("WORKER_DELEGATION_LIMIT", "This worker task has reached its delegation limit");
    if (this.jobs.size >= this.maxRecords || [...this.jobs.values()].filter(job => job.status === "queued").length >= this.maxQueued) throw relayFailure("WORKER_QUEUE_FULL", "The background relay queue or receipt store is full");
    const job = { schemaVersion: 1, requestId: params.requestId, workerId: randomUUID(), logicalSessionId: randomUUID(),
      rootId: parent?.rootId ?? params.requestId, parentRequestId: parent?.requestId ?? null, depth,
      agent: params.agent, source: { kind: actor.kind, id: actor.id, ...(actor.agent ? { agent: actor.agent } : {}) },
      binding, fingerprint, prompt: params.prompt, status: "queued", deliveryState: "not_sent", createdAt: this.now(), updatedAt: this.now() };
    this.persist(job);
    this.jobs.set(job.requestId, job);
    this.schedule();
    return this.receipt(job);
  }

  schedule() {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      for (const job of this.jobs.values()) {
        if (this.active.size >= this.maxConcurrent) break;
        if (job.status !== "queued") continue;
        const running = [...this.active.values()].filter(item => item.agent === job.agent).length;
        if (running >= 2) continue;
        const controller = new AbortController();
        this.active.set(job.requestId, { agent: job.agent, controller });
        void this.execute(job, controller.signal).finally(() => { this.active.delete(job.requestId); this.capabilities.delete(job.workerId); this.schedule(); });
      }
    });
  }

  async execute(job, signal) {
    try {
      try { this.scope.recheck(job.binding); }
      catch (cause) { throw Object.assign(relayFailure("WORKER_PROJECT_REVOKED", "The queued worker project is no longer authorized"), { cause }); }
      job.status = "running";
      job.updatedAt = this.now();
      this.persist(job);
      const provider = this.config.providers[job.agent];
      const readiness = await this.adapters[job.agent].inspect({ env: this.env, executable: provider.executable ?? undefined });
      const unverifiedAuth = job.agent === "antigravity" && readiness.authenticated === null && /AUTH_UNVERIFIED$/.test(readiness.code ?? "");
      if (!readiness.available || readiness.authenticated === false || readiness.ready !== true && !unverifiedAuth) throw relayFailure(readiness.code ?? "WORKER_NOT_READY", readiness.reason ?? "The requested CLI worker is not ready");
      try { this.scope.recheck(job.binding); }
      catch (cause) { throw Object.assign(relayFailure("WORKER_PROJECT_REVOKED", "The worker project was revoked before dispatch"), { cause }); }
      const capability = { token: randomBytes(32).toString("base64url"), requestId: job.requestId, rootId: job.rootId, binding: job.binding, agent: job.agent };
      this.capabilities.set(job.workerId, capability);
      const workerEnv = Object.fromEntries(Object.entries(this.env).filter(([key]) => !/^(?:AGENT_RELAY_|CODEX_THREAD_ID$|CODEX_APP_|CODEX_BRIDGE_|CLAUDE_BRIDGE_|CLAUDE_CODE_ENTRYPOINT$|ELECTRON_)/i.test(key)));
      const relayEnv = { AGENT_RELAY_ENDPOINT: this.config.endpoint, AGENT_RELAY_TOKEN: capability.token,
        AGENT_RELAY_WORKER_ID: job.workerId, AGENT_RELAY_REQUEST_ID: job.requestId };
      const prompt = ["You are an independently identified background CLI worker, not a Desktop chat.",
        "Use only worker-relay tools for authorized cross-agent delegation in this project. Desktop hosts may be closed or frozen.",
        "Do not open, restart, focus, create, resume or navigate Desktop apps/chats, use Computer Use, or copy Desktop credentials.",
        "Keep request IDs and inspect delivery receipts. Never replay uncertain work. Follow the existing tool permissions and project instructions.",
        "Report actual relay/tool failures with their codes. Do not claim a handoff succeeded without a correlated receipt.",
        "Authorized task:", job.prompt].join("\n\n");
      job.deliveryState = "unknown";
      job.updatedAt = this.now();
      this.persist(job);
      const result = await this.adapters[job.agent].run({ executable: readiness.executable ?? provider.executable ?? undefined,
        cwd: job.binding.path, prompt, requestId: job.requestId, sessionId: job.logicalSessionId, env: workerEnv,
        relayMcp: { command: process.execPath, args: [fileURLToPath(new URL("./background-relay-mcp.mjs", import.meta.url))], env: relayEnv }, signal,
        onEvent: event => {
          if (event?.sessionId && RELAY_UUID.test(event.sessionId)) job.sessionId = event.sessionId;
          if (event?.type === "accepted") job.deliveryState = "sent";
          job.updatedAt = this.now();
          this.persist(job);
        } });
      job.status = "completed";
      job.deliveryState = "sent";
      const output = String(result.output ?? "");
      job.output = output.slice(0, 256 * 1024);
      job.outputTruncated = output.length > job.output.length;
      if (RELAY_UUID.test(result.sessionId ?? "")) job.sessionId = result.sessionId;
      this.health.set(job.agent, { agent: job.agent, available: true, authenticated: true, ready: true, checkedAt: this.now(), evidence: "completed-background-job" });
    } catch (error) {
      const rawState = error.deliveryState ?? (job.deliveryState === "not_sent" ? "not_sent" : "unknown");
      const state = rawState === "not-sent" ? "not_sent" : ["not_sent", "sent", "unknown"].includes(rawState) ? rawState : "unknown";
      job.status = state === "unknown" ? "unknown" : "failed";
      job.deliveryState = state;
      job.diagnostic = bridgeDiagnostic(error, { component: `background-${job.agent}`, operation: "send_to_worker", requestId: job.requestId, deliveryState: state });
    } finally {
      job.updatedAt = this.now();
      try { this.persist(job); }
      catch (error) {
        job.status = "unknown";
        job.deliveryState = "unknown";
        job.diagnostic = bridgeDiagnostic(error, { component: "background-relay", operation: "persist_receipt", code: "WORKER_RECEIPT_WRITE_FAILED", requestId: job.requestId, deliveryState: "unknown" });
        this.accepting = false;
      }
    }
  }
}

export async function serveBackgroundRelay(relay, { protectPipe = protectCurrentUserPipe } = {}) {
  const endpoint = relay.config.endpoint;
  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    const before = fs.lstatSync(endpoint);
    if (!before.isSocket() || typeof process.getuid === "function" && before.uid !== process.getuid()) throw relayFailure("WORKER_ENDPOINT_UNSAFE", "The relay endpoint is not an owned local socket");
    const stale = await new Promise(resolve => {
      const probe = net.createConnection(endpoint);
      const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 500);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
      probe.once("error", error => { clearTimeout(timer); resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT"); });
    });
    if (!stale) throw relayFailure("WORKER_RELAY_ALREADY_RUNNING", "A relay may already own this endpoint; it was not replaced");
    try {
      const current = fs.lstatSync(endpoint);
      if (!current.isSocket() || before.dev !== current.dev || before.ino !== current.ino) throw relayFailure("WORKER_ENDPOINT_CHANGED", "The relay endpoint changed during recovery");
      fs.unlinkSync(endpoint);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const sockets = new Set();
  let protectedEndpoint = process.platform !== "win32";
  const server = net.createServer(socket => {
    if (!protectedEndpoint) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    let handled = false;
    let hello;
    let challenge;
    let secret;
    socket.on("data", data => {
      if (handled) { socket.destroy(); return; }
      buffer += data;
      if (Buffer.byteLength(buffer) > (hello ? RELAY_FRAME_LIMIT : 4096)) { socket.destroy(); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      if (buffer.slice(end + 1).length) { socket.destroy(); return; }
      let frame;
      try { frame = JSON.parse(buffer.slice(0, end)); }
      catch { socket.destroy(); return; }
      buffer = "";
      if (!hello) {
        if (!validRelayHello(frame)) { socket.destroy(); return; }
        try { secret = relay.transportSecret(frame.workerId); }
        catch { socket.destroy(); return; }
        hello = frame;
        challenge = relayChallenge(secret, hello);
        socket.write(JSON.stringify(challenge) + "\n");
        return;
      }
      if (!verifyRelayOperation(secret, hello, challenge, frame)) { socket.destroy(); return; }
      handled = true;
      socket.setTimeout(70000, () => socket.destroy());
      const request = frame.operation;
      const send = response => {
        let wire = JSON.stringify(relayResponse(secret, hello, challenge, response)) + "\n";
        if (Buffer.byteLength(wire) > RELAY_REPLY_LIMIT) wire = JSON.stringify(relayResponse(secret, hello, challenge, { schemaVersion: 1, id: request.id,
          error: { code: "WORKER_REPLY_TOO_LARGE", message: "The relay response exceeded its limit", deliveryState: request.method === "send" ? "unknown" : "not_sent", phase: "relay_transport" } })) + "\n";
        if (!socket.destroyed) socket.end(wire);
      };
      Promise.resolve().then(() => {
        relay.transportSecret(hello.workerId);
        return relay.handle({ ...request, token: secret });
      }).then(result => send({ schemaVersion: 1, id: request.id, result }), error => {
        const diagnostic = bridgeDiagnostic(error, { component: "background-relay", operation: request.method, requestId: request.params?.requestId });
        send({ schemaVersion: 1, id: request.id, error: { code: diagnostic.code, message: diagnostic.reason,
          deliveryState: diagnostic.deliveryState, phase: diagnostic.phase, diagnostic } });
      }).catch(() => socket.destroy());
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  try {
    if (process.platform === "win32") { await protectPipe(endpoint); protectedEndpoint = true; }
    else fs.chmodSync(endpoint, 0o600);
  } catch (error) { server.close(); throw error; }
  return { server, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}
