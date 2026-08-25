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
    `NOTE: this bridge still holds the writer lock on thread ${threadId}, because its app-server has the`,
    "thread loaded. Until that app-server stops, the Codex app will refuse to write to it and show",
    '"open in another application". Release it with stop_codex_app_server when the hand-off is done;',
    "the bridge starts a new app-server the next time it needs one.",
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
    this.threadCwds = new Map();
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
    if (!(await this.isServerUp())) return { stopped: false, reason: "no app-server was listening" };
    const port = appServerPort(this.url);
    const pids = listeningPids(port);
    if (!pids.length) return { stopped: false, reason: `nothing is listening on port ${port}` };
    this.ws?.close();
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
    this.ws = null;
    this.attachedThreads.clear();
    this.threadCwds.clear();
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
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      let lastError = null;
      for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
        try {
          await this.#openConnection();
          return;
        } catch (err) {
          lastError = err;
          this.log(`connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed: ${err.message}`);
          if (attempt < CONNECT_ATTEMPTS) await delay(CONNECT_RETRY_DELAY_MS);
        }
      }
      throw lastError;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async #openConnection() {
    if (!(await this.isServerUp())) {
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

    const ws = new WebSocket(this.url);
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

    ws.onmessage = (event) => this.#handleMessage(event.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.log("app-server connection closed");
      this.ws = null;
      this.attachedThreads.clear();
      this.threadCwds.clear();
      for (const [, entry] of this.pending) {
        entry.reject(new AppServerError("Connection to Codex app-server closed"));
      }
      this.pending.clear();
      this.#notifyDisconnect();
    };
    ws.onerror = (event) => this.log(`websocket error: ${event?.message ?? "unknown"}`);

    this.ws = ws;
    const init = await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
    this.log(`connected to app-server (codexHome=${init?.codexHome ?? "?"})`);
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
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`Request ${method} timed out after ${timeoutMs}ms`));
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
    });
    this.#send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return promise;
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
    if (this.attachedThreads.has(threadId)) return { resumed: false, thread: this.threadCwds.get(threadId) };
    const result = await this.request("thread/resume", { threadId, ...resumeParams });
    this.attachedThreads.add(threadId);
    if (result?.thread?.cwd) this.threadCwds.set(threadId, result.thread);
    return { resumed: true, thread: result?.thread };
  }

  /**
   * The app-server takes the per-thread writer lock when it loads a thread and
   * keeps it until it exits, so a thread this bridge has attached cannot be
   * written to from anywhere else - the desktop app included.
   */
  holdsThread(threadId) {
    return this.attachedThreads.has(threadId);
  }

  markAttached(threadId, thread = null) {
    this.attachedThreads.add(threadId);
    if (thread?.cwd) this.threadCwds.set(threadId, thread);
  }
}
