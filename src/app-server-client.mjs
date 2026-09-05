import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { PLATFORM_LABEL, resolveCodexBin, spawnEnv } from "./platform.mjs";
import { assertAllowedAppServerUrl } from "./security-policy.mjs";

const DEFAULT_URL = "ws://127.0.0.1:8791";
const CONNECT_ATTEMPTS = 2;
const CONNECT_RETRY_DELAY_MS = 750;

export function parseListeningPids(output, port) {
  const suffix = `:${port}`;
  return [
    ...new Set(
      String(output)
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => fields[0]?.toUpperCase() === "TCP")
        .filter((fields) => fields.some((field) => field.toUpperCase() === "LISTENING"))
        .filter((fields) => fields[1]?.endsWith(suffix))
        .map((fields) => Number(fields.at(-1)))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

function appServerPort(url) {
  return url.replace(/^wss?:\/\//, "").split("/")[0].split(":").pop();
}

function listeningPids(port) {
  if (process.platform === "win32") {
    return parseListeningPids(
      execFileSync("netstat.exe", ["-ano", "-p", "tcp"], {
        env: spawnEnv(),
        windowsHide: true,
      }),
      port,
    );
  }
  return execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    env: spawnEnv(),
  })
    .toString()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter(Boolean);
}

function httpBase(wsUrl) {
  return wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
}

/**
 * Opening a thread in the desktop app while this bridge still holds it produces
 * a message with no cause attached to it - the app just says the thread is open
 * somewhere else. Saying so at the moment of opening turns that into something
 * the reader can act on.
 */
export function writerLockWarning(threadId) {
  return [
    "",
    `NOTE: the app-server may still hold the writer lock on thread ${threadId}. The Codex app may`,
    'report "open in another application" until the thread unloads.',
    "Automatic release unsubscribes only this connection; the server's idle unload delay and other",
    "subscribers can keep the writer lock alive. stop_codex_app_server stops the shared server and",
    "interrupts every active turn, so use it only when all work on that server can stop.",
  ].join("\n");
}

export class AppServerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AppServerError";
    this.code = code;
  }
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.url = options.url ?? process.env.CODEX_APP_SERVER_URL ?? DEFAULT_URL;
    assertAllowedAppServerUrl(this.url);
    this.codexBin = resolveCodexBin(options.codexBin);
    this.autoStart = options.autoStart ?? process.env.CODEX_BRIDGE_AUTOSTART !== "0";
    this.log = options.log ?? (() => {});
    const requestedApproval = options.approval ?? process.env.CODEX_BRIDGE_APPROVAL ?? "deny";
    const autoApproveAcknowledged = options.allowAutoApprove ?? process.env.CODEX_BRIDGE_AUTO_APPROVE_ACK === "1";
    this.approval = requestedApproval === "approve" && !autoApproveAcknowledged ? "deny" : requestedApproval;
    this.clientInfo = options.clientInfo ?? { name: "codex-mcp-bridge", version: "1.0.0" };

    if (requestedApproval === "approve" && !autoApproveAcknowledged) {
      this.log("CODEX_BRIDGE_APPROVAL=approve ignored without CODEX_BRIDGE_AUTO_APPROVE_ACK=1");
    }

    this.ws = null;
    this.connecting = null;
    this.nextId = 0;
    this.pending = new Map();
    this.threadListeners = new Map();
    this.disconnectListeners = new Set();
    this.attachedThreads = new Set();
    this.unsubscribedThreads = new Set();
    this.threadCwds = new Map();
    this.threadOperations = new Map();
    this.attachingThreads = new Map();
    this.activeTurns = new Map();
    this.connectionEpoch = 0;
  }

  async isServerUp() {
    try {
      const res = await fetch(`${httpBase(this.url)}/readyz`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async startServer() {
    this.log(`starting shared app-server on ${PLATFORM_LABEL}: ${this.codexBin} app-server --listen ${this.url}`);
    const needsShell = /\.(cmd|bat)$/i.test(this.codexBin);
    const child = spawn(this.codexBin, ["app-server", "--listen", this.url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: needsShell,
      env: spawnEnv(),
    });
    child.on("error", (err) => this.log(`spawn error: ${err.message}`));
    child.unref();

    for (let i = 0; i < 40; i += 1) {
      await delay(500);
      if (await this.isServerUp()) return true;
    }
    return false;
  }

  /**
   * The shared app-server keeps running after the bridge stops using it, and
   * alongside the desktop app it competes for the same ~/.codex sqlite state.
   * Stopping it on demand is what keeps the Codex app responsive between
   * delegations.
   */
  async stopServer() {
    this.close();
    if (!(await this.isServerUp())) return { stopped: false, reason: "no app-server was listening" };
    const port = appServerPort(this.url);
    const pids = listeningPids(port);
    if (!pids.length) return { stopped: false, reason: `nothing is listening on port ${port}` };
    for (const pid of pids) {
      try {
        if (process.platform === "win32") {
          execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch (err) {
        this.log(`could not stop pid ${pid}: ${err.message}`);
      }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!(await this.isServerUp())) return { stopped: true, pids };
      await delay(100);
    }
    return { stopped: true, pids, stillListening: true };
  }

  /**
   * A freshly booted machine hands out transient failures: the app-server is
   * still opening its sqlite state under ~/.codex, or an old one is shutting
   * down yet still answering /readyz. Retrying once turns those into a slower
   * first call instead of a failed tool call the user has to repeat by hand.
   */
  async connect() {
    if (this.connecting) return this.connecting;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws) this.#disconnect(this.ws);

    const epoch = this.connectionEpoch;
    const connecting = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
        try {
          this.#assertConnectionEpoch(epoch);
          await this.#openConnection(epoch);
          return;
        } catch (err) {
          lastError = err;
          this.#assertConnectionEpoch(epoch);
          this.log(`connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed: ${err.message}`);
          if (attempt < CONNECT_ATTEMPTS) await delay(CONNECT_RETRY_DELAY_MS);
        }
      }
      throw lastError;
    })();
    this.connecting = connecting;

    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  #assertConnectionEpoch(epoch) {
    if (epoch !== this.connectionEpoch) {
      throw new AppServerError("App-server connection attempt was cancelled", "CONNECTION_CLOSED");
    }
  }

  #disconnect(ws, error = new AppServerError("Connection to Codex app-server closed", "CONNECTION_CLOSED")) {
    if (!ws || this.ws !== ws) return;
    this.log("app-server connection closed");
    this.ws = null;
    this.attachedThreads.clear();
    this.unsubscribedThreads.clear();
    this.threadCwds.clear();
    this.attachingThreads.clear();
    for (const active of this.activeTurns.values()) active.needsReconcile = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
    this.#notifyDisconnect();
  }

  close() {
    this.connectionEpoch += 1;
    const ws = this.ws;
    this.#disconnect(ws);
    ws?.close();
  }

  async #openConnection(epoch) {
    if (!(await this.isServerUp())) {
      this.#assertConnectionEpoch(epoch);
      if (!this.autoStart) {
        throw new AppServerError(
          `No Codex app-server reachable at ${this.url}. Start one with: codex app-server --listen ${this.url}`,
        );
      }
      const ok = await this.startServer();
      if (!ok) {
        throw new AppServerError(`Failed to start a Codex app-server at ${this.url} within 20s.`);
      }
    }

    this.#assertConnectionEpoch(epoch);
    const ws = new WebSocket(this.url);
    this.ws = ws;
    try {
      await new Promise((resolve, reject) => {
        const timer = globalThis.setTimeout(
          () => reject(new AppServerError(`Timed out connecting to ${this.url}`)),
          15000,
        );
        ws.onopen = () => {
          globalThis.clearTimeout(timer);
          resolve();
        };
        ws.onerror = (event) => {
          globalThis.clearTimeout(timer);
          reject(new AppServerError(`WebSocket error against ${this.url}: ${event?.message ?? "unknown"}`));
        };
        ws.onclose = () => {
          globalThis.clearTimeout(timer);
          reject(new AppServerError(`Connection to ${this.url} closed during the handshake`));
        };
      });
    } catch (err) {
      this.#disconnect(ws, err);
      ws.close();
      throw err;
    }

    ws.onmessage = (event) => {
      if (this.ws === ws) this.#handleMessage(event.data);
    };
    ws.onclose = () => this.#disconnect(ws);
    ws.onerror = (event) => this.log(`websocket error: ${event?.message ?? "unknown"}`);

    try {
      this.#assertConnectionEpoch(epoch);
      this.ws = ws;
      const init = await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      });
      this.#assertConnectionEpoch(epoch);
      this.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
      this.log(`connected to app-server (codexHome=${init?.codexHome ?? "?"})`);
    } catch (err) {
      this.#disconnect(ws, err);
      ws.close();
      throw err;
    }
  }

  #send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new AppServerError("Not connected to Codex app-server");
    }
    this.ws.send(JSON.stringify(payload));
  }

  #handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log(`ignored non-JSON frame (${String(raw).slice(0, 80)})`);
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

    if (msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new AppServerError(msg.error.message ?? JSON.stringify(msg.error), msg.error.code));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && msg.method) {
      this.#handleServerRequest(msg);
      return;
    }

    if (msg.method) this.#dispatchNotification(msg);
  }

  #dispatchNotification(msg) {
    const threadId = msg.params?.threadId;
    if (!threadId) return;
    if (msg.method === "thread/closed") {
      this.attachedThreads.delete(threadId);
      this.unsubscribedThreads.delete(threadId);
      this.threadCwds.delete(threadId);
      this.activeTurns.delete(threadId);
    }
    const active = this.activeTurns.get(threadId);
    if (active && msg.method === "turn/started" && msg.params?.turn?.id && !active.turnId) {
      active.turnId = msg.params.turn.id;
    }
    if (active && msg.method === "turn/completed" && msg.params?.turn?.id &&
        ["completed", "interrupted", "failed"].includes(msg.params.turn.status)) {
      const completedId = msg.params.turn.id;
      if (!active.turnId) active.completedIds.add(completedId);
      if (active.turnId === completedId || (!active.turnId && !active.awaitingStartResponse && !active.needsReconcile)) {
        this.activeTurns.delete(threadId);
      }
    }
    const listeners = this.threadListeners.get(threadId);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(msg);
      } catch (err) {
        this.log(`listener error: ${err.message}`);
      }
    }
  }

  /**
   * Every server->client request must get a reply. The app-server blocks the
   * turn until it hears back, so an unanswered method does not surface as an
   * error - the turn simply stops mid-run and looks like Codex paused itself.
   * The ten methods below are the full ServerRequest set of the app-server
   * protocol (identical in codex-cli 0.147 and 0.148), each answered with the
   * response shape its own schema declares - they are not interchangeable.
   */
  #handleServerRequest(msg) {
    const approve = this.approval === "approve";
    const respond = (result) => {
      try {
        this.#send({ jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        this.log(`failed to answer ${msg.method}: ${err.message}`);
      }
    };
    const refuse = (message) => {
      try {
        this.#send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message } });
      } catch (err) {
        this.log(`failed to refuse ${msg.method}: ${err.message}`);
      }
    };

    this.log(`server request ${msg.method} -> ${approve ? "approve" : "deny"}`);

    try {
      switch (msg.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          respond({ decision: approve ? "accept" : "decline" });
          return;
        case "item/permissions/requestApproval":
          respond({
            permissions: approve ? (msg.params?.permissions ?? {}) : {},
            scope: "turn",
          });
          return;
        case "execCommandApproval":
        case "applyPatchApproval":
          respond({ decision: approve ? "approved" : "denied" });
          return;
        case "item/tool/requestUserInput":
          respond({ answers: {} });
          return;
        case "mcpServer/elicitation/request":
          respond({ action: "decline", content: null });
          return;
        case "item/tool/call":
          respond({
            success: false,
            contentItems: [
              { type: "text", text: "codex-mcp-bridge registers no dynamic tools." },
            ],
          });
          return;
        case "attestation/generate":
        case "account/chatgptAuthTokens/refresh":
          refuse(`codex-mcp-bridge cannot serve ${msg.method}; run this thread from the Codex app instead.`);
          return;
        default:
          refuse(`codex-mcp-bridge does not handle ${msg.method}`);
      }
    } catch (err) {
      refuse(`codex-mcp-bridge failed handling ${msg.method}: ${err.message}`);
    }
  }

  async request(method, params, { timeoutMs = 60000 } = {}) {
    const threadId = method === "turn/start" ? params?.threadId : null;
    let active = null;
    if (threadId) {
      if (this.activeTurns.has(threadId)) {
        throw new AppServerError(`Thread ${threadId} already has a running or unconfirmed turn`, "THREAD_BUSY");
      }
      active = { turnId: null, completedIds: new Set(), awaitingStartResponse: true };
      this.activeTurns.set(threadId, active);
    }
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`Request ${method} timed out after ${timeoutMs}ms`, "REQUEST_TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          globalThis.clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          globalThis.clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (err) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry.reject(err);
      }
    });
    try {
      const result = await promise;
      if (active && this.activeTurns.get(threadId) === active) {
        active.turnId = result?.turn?.id ?? null;
        active.awaitingStartResponse = false;
        if (active.completedIds.has(active.turnId) || ["completed", "interrupted", "failed"].includes(result?.turn?.status)) {
          this.activeTurns.delete(threadId);
        }
      }
      return result;
    } catch (err) {
      if (active && !["REQUEST_TIMEOUT", "CONNECTION_CLOSED"].includes(err.code) && this.activeTurns.get(threadId) === active) {
        this.activeTurns.delete(threadId);
      }
      throw err;
    }
  }

  async call(method, params, opts) {
    await this.connect();
    return this.request(method, params, opts);
  }

  /**
   * A turn waits on `turn/completed`, which can only arrive over a live socket.
   * Without an explicit disconnect signal a dropped app-server - the machine
   * sleeping, a reboot, the desktop app reclaiming the state - leaves the
   * caller blocked until its own timeout expires, four minutes by default.
   */
  subscribeDisconnect(listener) {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  #notifyDisconnect() {
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener();
      } catch (err) {
        this.log(`disconnect listener error: ${err.message}`);
      }
    }
  }

  subscribe(threadId, listener) {
    if (!this.threadListeners.has(threadId)) this.threadListeners.set(threadId, new Set());
    this.threadListeners.get(threadId).add(listener);
    return () => {
      const set = this.threadListeners.get(threadId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.threadListeners.delete(threadId);
    };
  }

  async ensureThreadAttached(threadId, resumeParams = {}) {
    await this.connect();
    if (this.attachedThreads.has(threadId)) {
      if (this.activeTurns.get(threadId)?.needsReconcile) await this.#reconcileThreadTurn(threadId);
      return { resumed: false, thread: this.threadCwds.get(threadId) };
    }
    if (this.attachingThreads.has(threadId)) return this.attachingThreads.get(threadId);
    const ws = this.ws;
    const attaching = (async () => {
      const result = await this.request("thread/resume", { ...resumeParams, threadId });
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
        throw new AppServerError("Connection closed while attaching the thread", "CONNECTION_CLOSED");
      }
      this.markAttached(threadId, result?.thread);
      await this.#reconcileThreadTurn(threadId, result?.thread);
      return { resumed: true, thread: result?.thread };
    })();
    this.attachingThreads.set(threadId, attaching);
    try {
      return await attaching;
    } finally {
      if (this.attachingThreads.get(threadId) === attaching) this.attachingThreads.delete(threadId);
    }
  }

  async #reconcileThreadTurn(threadId, thread = null) {
    const inspect = (snapshot) => {
      if (!snapshot || (snapshot.id && snapshot.id !== threadId)) return false;
      const status = typeof snapshot.status === "string" ? snapshot.status : snapshot.status?.type;
      const turns = Array.isArray(snapshot.turns) ? snapshot.turns : [];
      const running = turns.find((turn) => turn?.status === "inProgress");
      const active = this.activeTurns.get(threadId);
      if (running || status === "active") {
        this.activeTurns.set(threadId, {
          turnId: running?.id ?? null,
          completedIds: new Set(),
          awaitingStartResponse: false,
          needsReconcile: false,
        });
        return true;
      }
      if (status === "idle" || status === "notLoaded" || (active?.turnId && turns.some((turn) =>
        turn?.id === active.turnId && ["completed", "interrupted", "failed"].includes(turn.status)))) {
        this.activeTurns.delete(threadId);
        return true;
      }
      return false;
    };
    if (inspect(thread) || !this.activeTurns.has(threadId)) return;
    const active = this.activeTurns.get(threadId);
    active.needsReconcile = true;
    const ws = this.ws;
    const result = await this.request("thread/read", { threadId, includeTurns: true });
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
      throw new AppServerError("Connection closed while reconciling the thread", "CONNECTION_CLOSED");
    }
    if (!inspect(result?.thread)) {
      throw new AppServerError(
        `Cannot confirm whether thread ${threadId} still has its previous turn running; refusing to start another turn`,
        "THREAD_STATE_UNCONFIRMED",
      );
    }
  }

  async withThread(threadId, action) {
    const previous = this.threadOperations.get(threadId);
    const operation = (previous ? previous.catch(() => {}) : Promise.resolve()).then(action);
    this.threadOperations.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (this.threadOperations.get(threadId) === operation) this.threadOperations.delete(threadId);
    }
  }

  async releaseThread(threadId, { timeoutMs = 1000 } = {}) {
    const outcome = (status, unsubscribed, released, reason) => ({
      threadId, status, unsubscribed, released, ...(reason ? { reason } : {}),
    });
    if (this.activeTurns.has(threadId) || this.threadListeners.get(threadId)?.size || this.attachingThreads.has(threadId)) {
      return outcome("busy", false, false, "The thread has an active or unconfirmed turn or operation.");
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.connecting) {
      return outcome("disconnected", false, false, "No initialized connection is available to release this thread.");
    }
    let closed = false;
    let disconnected = false;
    let finishWait;
    let timer;
    const changed = new Promise((resolve) => { finishWait = resolve; });
    const unsubscribe = this.subscribe(threadId, (msg) => {
      if (msg.method !== "thread/closed") return;
      closed = true;
      finishWait();
    });
    const unsubscribeDisconnect = this.subscribeDisconnect(() => {
      disconnected = true;
      finishWait();
    });
    try {
      const result = await this.request("thread/unsubscribe", { threadId }, { timeoutMs: 5000 });
      if (!["unsubscribed", "notSubscribed", "notLoaded"].includes(result?.status)) {
        return outcome("invalidResponse", false, false, "The server did not confirm thread unsubscription.");
      }
      this.attachedThreads.delete(threadId);
      this.threadCwds.delete(threadId);
      if (result.status === "notLoaded" || closed) {
        this.unsubscribedThreads.delete(threadId);
        return outcome(result.status, true, true);
      }
      if (!disconnected) this.unsubscribedThreads.add(threadId);
      const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(timeoutMs, 5000)) : 1000;
      timer = globalThis.setTimeout(finishWait, waitMs);
      await changed;
      return outcome(result.status, true, closed, closed ? null : disconnected
        ? "Subscription removed; the connection closed before thread unload was confirmed."
        : "Subscription removed; thread unload is pending the server's idle delay or other subscribers.");
    } catch (err) {
      return outcome(err.code === -32601 ? "unsupported" : "failed", false, false, err.message);
    } finally {
      globalThis.clearTimeout(timer);
      unsubscribe();
      unsubscribeDisconnect();
    }
  }

  holdsThread(threadId) {
    return this.attachedThreads.has(threadId) || this.unsubscribedThreads.has(threadId);
  }

  markAttached(threadId, thread = null) {
    this.unsubscribedThreads.delete(threadId);
    this.attachedThreads.add(threadId);
    if (thread?.cwd) this.threadCwds.set(threadId, thread);
  }
}
