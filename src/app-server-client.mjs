import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { PLATFORM_LABEL, resolveCodexBin, spawnEnv } from "./platform.mjs";

const DEFAULT_URL = "ws://127.0.0.1:8791";

function httpBase(wsUrl) {
  return wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/+$/, "");
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
    this.codexBin = resolveCodexBin(options.codexBin);
    this.autoStart = options.autoStart ?? process.env.CODEX_BRIDGE_AUTOSTART !== "0";
    this.approval = options.approval ?? process.env.CODEX_BRIDGE_APPROVAL ?? "approve";
    this.log = options.log ?? (() => {});
    this.clientInfo = options.clientInfo ?? { name: "codex-mcp-bridge", version: "1.0.0" };

    this.ws = null;
    this.connecting = null;
    this.nextId = 0;
    this.pending = new Map();
    this.threadListeners = new Map();
    this.attachedThreads = new Set();
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

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
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
      });

      ws.onmessage = (event) => this.#handleMessage(event.data);
      ws.onclose = () => {
        this.log("app-server connection closed");
        this.ws = null;
        this.attachedThreads.clear();
        for (const [, entry] of this.pending) {
          entry.reject(new AppServerError("Connection to Codex app-server closed"));
        }
        this.pending.clear();
      };
      ws.onerror = (event) => this.log(`websocket error: ${event?.message ?? "unknown"}`);

      this.ws = ws;
      const init = await this.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: { experimentalApi: true },
      });
      this.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
      this.log(`connected to app-server (codexHome=${init?.codexHome ?? "?"})`);
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
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

  #handleServerRequest(msg) {
    const approve = this.approval === "approve";
    const respond = (result) => this.#send({ jsonrpc: "2.0", id: msg.id, result });
    const refuse = (message) =>
      this.#send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message } });

    this.log(`server request ${msg.method} -> ${approve ? "approve" : "deny"}`);

    switch (msg.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        respond({ decision: approve ? "accept" : "decline" });
        return;
      case "execCommandApproval":
      case "applyPatchApproval":
        respond({ decision: approve ? "approved" : "denied" });
        return;
      case "item/tool/requestUserInput":
        respond({ answers: {} });
        return;
      default:
        refuse(`codex-mcp-bridge does not handle ${msg.method}`);
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
    if (this.attachedThreads.has(threadId)) return { resumed: false };
    const result = await this.request("thread/resume", { threadId, ...resumeParams });
    this.attachedThreads.add(threadId);
    return { resumed: true, thread: result?.thread };
  }

  markAttached(threadId) {
    this.attachedThreads.add(threadId);
  }
}
