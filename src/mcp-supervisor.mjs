#!/usr/bin/env node
import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReleaseSnapshot, sourceRevision } from "./release-snapshot.mjs";

const ENTRIES = new Set(["index.mjs", "claude-bridge.mjs", "native-relay-companion.mjs"]);
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE = 256;
const hasId = (message) => Object.hasOwn(message, "id");
const idKey = (id) => JSON.stringify(id);
const errorMessage = (id, message) => ({ jsonrpc: "2.0", id, error: { code: -32603, message } });

function lines(stream, receive, failed) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES) { failed(new Error("MCP frame exceeds the buffer limit")); return; }
    let index;
    while ((index = buffer.indexOf(10)) !== -1) {
      const frame = buffer.subarray(0, index).toString("utf8").trim();
      buffer = buffer.subarray(index + 1);
      if (!frame) continue;
      try { receive(JSON.parse(frame)); }
      catch (error) { failed(error); }
    }
  });
}

class Worker {
  constructor(release, entry, env, handlers) {
    this.release = release;
    this.handlers = handlers;
    this.rpcPending = new Map();
    this.controlPending = new Map();
    this.clientPending = new Map();
    this.sequence = 0;
    this.retiring = false;
    this.closed = false;
    this.process = fork(path.join(release.directory, "src", entry), [], {
      execPath: process.execPath, execArgv: [], cwd: process.cwd(), windowsHide: true,
      env: { ...env, CODEX_BRIDGE_WORKER: "1", CODEX_BRIDGE_STAGED: "1" },
      stdio: ["pipe", "pipe", "pipe", "ipc"], serialization: "json",
    });
    this.process.stderr.on("data", (data) => process.stderr.write(data));
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code, signal) => this.fail(new Error(`Bridge worker exited (${signal ?? code})`)));
    this.process.on("message", (message) => {
      if (message?.type !== "bridge:control-result") return;
      const pending = this.controlPending.get(message.id);
      if (!pending) return;
      this.controlPending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    lines(this.process.stdout, (message) => {
      if (!message || message.jsonrpc !== "2.0") throw new Error("Invalid worker JSON-RPC message");
      if (!message.method && hasId(message) && this.rpcPending.has(message.id)) {
        const pending = this.rpcPending.get(message.id);
        this.rpcPending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else handlers.message(this, message);
    }, (error) => this.fail(error));
  }

  write(message) {
    if (this.closed) throw new Error("The bridge worker is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rpc(method, params, timeout = 15000) {
    const id = `supervisor:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.rpcPending.delete(id); reject(new Error(`Candidate ${method} timed out`)); }, timeout);
      this.rpcPending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  control(action, data, timeout = 15000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.controlPending.delete(id); reject(new Error(`Worker ${action} timed out`)); }, timeout);
      this.controlPending.set(id, { resolve, reject, timer });
      this.process.send({ type: "bridge:control", id, action, data }, (error) => {
        if (!error) return;
        const pending = this.controlPending.get(id);
        if (pending) { clearTimeout(timer); this.controlPending.delete(id); reject(error); }
      });
    });
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of [...this.rpcPending.values(), ...this.controlPending.values()]) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.rpcPending.clear();
    this.controlPending.clear();
    this.handlers.exit(this, error);
  }

  async stop() {
    this.retiring = true;
    if (this.process.exitCode !== null || this.process.signalCode) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.process.kill(); resolve(); }, 1000);
      this.process.once("exit", () => { clearTimeout(timer); resolve(); });
      this.process.stdin.end();
      if (this.process.connected) this.process.disconnect();
    });
  }
}

export async function runSupervisor(entry, options = {}) {
  if (!ENTRIES.has(entry)) throw new Error("Expected index.mjs, claude-bridge.mjs, or native-relay-companion.mjs");
  const root = fs.realpathSync.native(options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version}\n`);
    return;
  }
  const log = (message) => process.stderr.write(`[bridge-supervisor] ${message}\n`);
  const output = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const env = { ...process.env, CODEX_BRIDGE_SOURCE_ROOT: root };
  if (entry === "native-relay-companion.mjs" && !env.CODEX_APP_TOOLS_PIPE_PATH) {
    const { resolveNativeToolsPipePath } = await import("./native-relay.mjs");
    const pipe = await resolveNativeToolsPipePath();
    if (pipe) env.CODEX_APP_TOOLS_PIPE_PATH = pipe;
  }
  const pollMs = Math.max(100, Number(env.CODEX_BRIDGE_RELOAD_POLL_MS) || 1000);
  const settleMs = Math.max(100, Number(env.CODEX_BRIDGE_RELOAD_SETTLE_MS) || 1500);
  let active;
  let initializeParams;
  let initializeResult;
  let ready = false;
  let switching = false;
  let stopping = false;
  let failure = null;
  let sequence = 0;
  let observed = null;
  let observedAt = 0;
  let retryAt = 0;
  let reason = null;
  let reloads = 0;
  const queue = [];
  const requests = new Map();
  const reverse = new Map();
  const workers = new Set();
  const diagnostics = () => ({ enabled: true, supervisorPid: process.pid, workerPid: active?.process.pid ?? null,
    revision: active?.release.revision ?? null, availableRevision: observed, pending: Boolean(observed && observed !== active?.release.revision),
    state: failure ? "failed" : switching ? "reloading" : reason ? "deferred" : "current", reason: failure ?? reason, reloads });

  const handlers = {
    message(worker, message) {
      if (message.method && hasId(message)) {
        const id = `bridge-server:${++sequence}`;
        reverse.set(idKey(id), { worker, id: message.id });
        output({ ...message, id });
        return;
      }
      if (message.method) {
        if (worker === active) output(message);
        return;
      }
      const pending = worker.clientPending.get(message.id);
      if (!pending) return;
      worker.clientPending.delete(message.id);
      requests.delete(idKey(pending.id));
      const respond = async () => {
        if (pending.method === "initialize" && !message.error) {
          initializeResult = message.result;
          await worker.control("activate");
          ready = true;
        }
        if (message.result && ["codex_bridge_status", "claude_bridge_status", "native_relay_status"].includes(pending.tool)) {
          message.result.structuredContent = { ...message.result.structuredContent, autoReload: diagnostics() };
          message.result.content = [...(message.result.content ?? []), { type: "text", text: `automatic reload: ${diagnostics().state}\nsupervisor pid: ${process.pid}\nworker pid: ${worker.process.pid}\nreload count: ${reloads}${reason ? `\nreload detail: ${reason}` : ""}` }];
        }
        output({ ...message, id: pending.id });
      };
      void respond().catch((error) => { failure = error.message; output(errorMessage(pending.id, error.message)); });
    },
    exit(worker, error) {
      for (const [id, pending] of worker.clientPending) {
        requests.delete(idKey(pending.id));
        output(errorMessage(pending.id, `${error.message}. The operation may already have been dispatched; it was not retried. Retain the original task and receipts.`));
        worker.clientPending.delete(id);
      }
      for (const [id, pending] of reverse) if (pending.worker === worker) reverse.delete(id);
      if (worker === active && !worker.retiring && !stopping) { failure = `${error.message}; automatic replay is disabled because delivery state may be unknown`; log(failure); }
    },
  };
  const spawn = (release) => {
    if (stopping) throw new Error("The MCP client disconnected before activation");
    const worker = new Worker(release, entry, env, handlers);
    workers.add(worker);
    return worker;
  };
  const check = async () => {
    if (switching || !ready || stopping || failure) return;
    let revision;
    try { revision = sourceRevision(root); }
    catch (error) { reason = `Installation is not ready: ${error.message}`; return; }
    if (observed !== revision) { observed = revision; observedAt = Date.now(); retryAt = 0; }
    if (revision === active.release.revision) { reason = null; return; }
    if (Date.now() - observedAt < settleMs || Date.now() < retryAt) { reason ??= "Waiting for a complete, stable installation"; return; }
    if (active.clientPending.size || reverse.size) { reason = "A request is still running; its worker is retained"; return; }
    switching = true;
    let candidate;
    let quiesced = false;
    const previous = active;
    try {
      const state = await previous.control("inspect");
      if (!state.reloadable) { reason = state.reason ?? "Pending deliveries prevent a safe reload"; return; }
      const release = createReleaseSnapshot(root, { expectedRevision: revision });
      candidate = spawn(release);
      const initialized = await candidate.rpc("initialize", initializeParams);
      if (initialized.protocolVersion !== initializeResult.protocolVersion || JSON.stringify(initialized.capabilities) !== JSON.stringify(initializeResult.capabilities)) {
        throw new Error("The new MCP protocol or capabilities require an explicit client reconnect");
      }
      candidate.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      const catalog = await candidate.rpc("tools/list", {});
      if (!Array.isArray(catalog.tools) || !catalog.tools.length || catalog.nextCursor) throw new Error("The candidate tool catalog is incomplete");
      const oldCatalog = await previous.rpc("tools/list", {});
      if (sourceRevision(root) !== revision) throw new Error("The installation changed before activation");
      quiesced = true;
      const exported = await previous.control("quiesce");
      await candidate.control("restore", exported.state);
      await candidate.control("activate");
      if (stopping) throw new Error("The MCP client disconnected during activation");
      active = candidate;
      candidate = null;
      reloads++;
      reason = null;
      if (JSON.stringify(catalog) !== JSON.stringify(oldCatalog)) output({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      await previous.stop();
      workers.delete(previous);
      log(`activated ${entry} revision ${revision.slice(0, 12)}; client connection retained`);
    } catch (error) {
      reason = `Update deferred: ${error.message}`;
      retryAt = Date.now() + Math.max(pollMs, 5000);
      if (candidate) { await candidate.stop(); workers.delete(candidate); }
      if (quiesced && active === previous && !previous.closed) {
        try { await previous.control("resume"); }
        catch (resumeError) { failure = `Previous runtime could not resume: ${resumeError.message}`; }
      }
      log(reason);
    } finally {
      switching = false;
      for (const message of queue.splice(0)) dispatch(message);
    }
  };
  const dispatch = (message) => {
    if (stopping) return;
    if (!message.method && hasId(message)) {
      const pending = reverse.get(idKey(message.id));
      if (pending) { reverse.delete(idKey(message.id)); pending.worker.write({ ...message, id: pending.id }); }
      return;
    }
    if (message.method === "notifications/cancelled") {
      const pending = requests.get(idKey(message.params?.requestId));
      if (pending) pending.worker.write({ ...message, params: { ...message.params, requestId: pending.workerId } });
      else {
        const index = queue.findIndex((queued) => hasId(queued) && idKey(queued.id) === idKey(message.params?.requestId));
        if (index !== -1) { const [cancelled] = queue.splice(index, 1); output({ jsonrpc: "2.0", id: cancelled.id, error: { code: -32800, message: "Request cancelled before dispatch" } }); }
      }
      return;
    }
    if (failure) { if (hasId(message)) output(errorMessage(message.id, failure)); return; }
    if (switching || !active) {
      const bytes = queue.reduce((size, queued) => size + Buffer.byteLength(JSON.stringify(queued)), 0);
      if (queue.length >= MAX_QUEUE || bytes + Buffer.byteLength(JSON.stringify(message)) > MAX_FRAME_BYTES) { if (hasId(message)) output(errorMessage(message.id, "Reload request queue is full; no operation was dispatched")); return; }
      queue.push(message);
      return;
    }
    if (message.method === "initialize") initializeParams = message.params;
    if (hasId(message)) {
      if (requests.has(idKey(message.id))) { output(errorMessage(message.id, "Duplicate active JSON-RPC request ID")); return; }
      const id = `client:${++sequence}`;
      active.clientPending.set(id, { id: message.id, method: message.method, tool: message.params?.name });
      requests.set(idKey(message.id), { worker: active, workerId: id });
      active.write({ ...message, id });
    } else active.write(message);
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await Promise.allSettled([...workers].map((worker) => worker.stop()));
    process.stdin.pause();
  };
  const initial = createReleaseSnapshot(root);
  observed = initial.revision;
  active = spawn(initial);
  const timer = setInterval(() => { void check(); }, pollMs);
  lines(process.stdin, (message) => {
    if (!message || message.jsonrpc !== "2.0" || (!message.method && !hasId(message))) throw new Error("Invalid client JSON-RPC message");
    dispatch(message);
  }, (error) => { log(error.message); void shutdown(); });
  process.stdin.on("end", () => { void shutdown(); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown(); });
  log(`supervising ${entry}; installed updates activate after pending work completes`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSupervisor(process.argv[2]);
}
