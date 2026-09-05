#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  MAX_FRAME_BYTES,
  NATIVE_DISPATCH_METHOD,
  NativeToolsClient,
  RELAY_PROTOCOL_VERSION,
  relaySocketPath,
  resolveRelayThreadId,
  desktopTaskSocketPath,
  validateDesktopOperation,
  decodeNativeToolResult,
} from "./native-relay.mjs";
import { IS_WINDOWS, PLATFORM_LABEL } from "./platform.mjs";

const VERSION = "1.13.0";
const log = (msg) => process.stderr.write(`[native-relay] ${msg}\n`);

function errorResponse(code, message) {
  return { ok: false, v: RELAY_PROTOCOL_VERSION, error: { code, message } };
}

/**
 * A JSON-RPC error arrives with a numeric code, and passing that straight back
 * would put `-32601` in a field whose other values read `RELAY_TIMEOUT`. Only a
 * string code from this project's own errors is carried through.
 */
function errorCode(err) {
  return typeof err?.code === "string" ? err.code : "NATIVE_DISPATCH_FAILED";
}

/**
 * The whole request handler, kept free of sockets and of the MCP connection so
 * the rules it enforces can be tested against a stub dispatcher rather than
 * against a running Codex Desktop.
 */
export async function handleRelayRequest(
  payload,
  { dispatch, dispatchDesktop, resolveExecutor = resolveRelayThreadId, env = process.env } = {},
) {
  if (payload && typeof payload === "object" && Object.hasOwn(payload, "operation")) {
    return handleDesktopRequest(payload, { dispatchDesktop, resolveExecutor, env });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["v", "targetThreadId", "message"].includes(key)) ||
      (payload.v !== undefined && payload.v !== RELAY_PROTOCOL_VERSION)) {
    return errorResponse("RELAY_BAD_REQUEST", "expected a relay request with targetThreadId and message");
  }
  const targetThreadId = typeof payload?.targetThreadId === "string" ? payload.targetThreadId.trim() : "";
  const message = typeof payload?.message === "string" ? payload.message : "";

  if (!targetThreadId) return errorResponse("RELAY_BAD_REQUEST", "targetThreadId must be a non-empty string");
  if (!message.trim()) return errorResponse("RELAY_BAD_REQUEST", "message must be a non-empty string");

  let executorThreadId;
  try {
    executorThreadId = resolveExecutor(env).threadId;
  } catch (err) {
    return errorResponse(errorCode(err), err.message);
  }

  /**
   * Codex validates the executor thread, so a destination that is also the
   * executor would be dispatched rather than refused - and the message would
   * land in the relay thread instead of the thread the human is watching.
   * Nothing downstream can tell those two apart afterwards.
   */
  if (executorThreadId === targetThreadId) {
    return errorResponse(
      "RELAY_BAD_REQUEST",
      `${targetThreadId} is the relay's own executor thread, not a destination. Bind the thread you are watching in Codex Desktop.`,
    );
  }

  try {
    const result = await dispatch({ executorThreadId, targetThreadId, message });
    if (result?.success !== true || result?.isError === true) {
      const detail = typeof result?.error === "string" ? result.error : result?.error?.message;
      return errorResponse("NATIVE_DISPATCH_FAILED", detail ?? "Codex Desktop did not confirm successful native dispatch");
    }
    return { ok: true, v: RELAY_PROTOCOL_VERSION, targetThreadId, executorThreadId, result: result ?? null };
  } catch (err) {
    return errorResponse(errorCode(err), err?.message ?? String(err));
  }
}

async function handleDesktopRequest(payload, { dispatchDesktop, resolveExecutor, env }) {
  if (Array.isArray(payload) || payload.v !== RELAY_PROTOCOL_VERSION ||
      Object.keys(payload).some((key) => !["v", "operation", "arguments"].includes(key))) {
    return errorResponse("RELAY_BAD_REQUEST", "expected an allowlisted Desktop operation");
  }
  try {
    validateDesktopOperation(payload.operation, payload.arguments);
    if (typeof dispatchDesktop !== "function") {
      return errorResponse("NATIVE_OPERATION_UNAVAILABLE", "This companion does not support Desktop operations; reload the native relay");
    }
    const executorThreadId = resolveExecutor(env).threadId;
    if (payload.operation === "send_message_to_thread" && payload.arguments.threadId === executorThreadId) {
      return errorResponse("RELAY_BAD_REQUEST", "The relay executor cannot receive its own relayed message");
    }
    const nativeResult = await dispatchDesktop({
      executorThreadId,
      operation: payload.operation,
      arguments: payload.arguments,
    });
    return {
      ok: true,
      v: RELAY_PROTOCOL_VERSION,
      operation: payload.operation,
      executorThreadId,
      result: decodeNativeToolResult(nativeResult),
    };
  } catch (err) {
    return errorResponse(errorCode(err), err?.message ?? String(err));
  }
}

/**
 * Listens on a private local socket or Windows named pipe and answers one NDJSON line per request.
*
 * POSIX sockets are mode 0600 inside the Codex home directory. Windows uses the
 * Claude-compatible local named-pipe namespace instead of a filesystem mode.
 */
export class RelaySocketServer {
  constructor({
    socketPath,
    dispatch,
    dispatchDesktop,
    resolveExecutor = resolveRelayThreadId,
    restrictSocket = (target) => {
      if (!IS_WINDOWS) fs.chmodSync(target, 0o600);
    },
    log: logFn = () => {},
  } = {}) {
    this.socketPath = socketPath;
    this.dispatch = dispatch;
    this.dispatchDesktop = dispatchDesktop;
    this.resolveExecutor = resolveExecutor;
    this.restrictSocket = restrictSocket;
    this.log = logFn;
    this.server = null;
    this.started = false;
    this.connections = new Set();
    this.processHandlers = new Map();
  }

  async start() {
    if (this.started) return this.socketPath;
    if (!IS_WINDOWS) fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    this.server = net.createServer((socket) => this.#handleConnection(socket));
    await this.#listen({ replaceStale: true });

    /**
     * The file mode is the whole security boundary, so a socket whose mode
     * could not be set is not a degraded relay - it is an open one. Refuse it
     * and let the caller fall back to the app-server path, rather than serving
     * thread writes on an address anyone can open.
     */
    try {
      this.restrictSocket(this.socketPath);
    } catch (err) {
      try {
        this.server.close();
      } catch {}
      throw new Error(`refusing to serve on ${this.socketPath}: its mode could not be restricted (${err.message})`);
    }
    this.started = true;

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        this.stop();
        process.exit(0);
      };
      this.processHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    const onExit = () => this.stop();
    this.processHandlers.set("exit", onExit);
    process.on("exit", onExit);

    this.log(`relay socket listening on ${this.socketPath}`);
    return this.socketPath;
  }

  /**
   * A companion killed with SIGKILL leaves its socket file behind, and the next
   * one then fails to bind a path nothing is listening on. Removing it blindly
   * would be worse: Codex Desktop can launch more than one companion, and the
   * second would silently steal the address from the first. So an in-use path
   * is probed - a refused connection means the owner is gone and the file is
   * swept, an accepted one means a live companion already has the socket and
   * this process leaves it alone.
   */
  async #listen({ replaceStale }) {
    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.socketPath, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      if (err.code !== "EADDRINUSE" || !replaceStale) throw err;
      if (IS_WINDOWS) {
        if (await this.#socketIsLive()) {
          throw new Error(`another native relay companion already owns ${this.socketPath}`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
        return this.#listen({ replaceStale: false });
      }
      if (await this.#socketIsLive()) {
        throw new Error(`another native relay companion already owns ${this.socketPath}`);
      }
      this.log(`removing the stale relay socket left at ${this.socketPath}`);
      fs.rmSync(this.socketPath, { force: true });
      await this.#listen({ replaceStale: false });
    }
  }

  #socketIsLive() {
    return new Promise((resolve) => {
      const probe = net.connect({ path: this.socketPath });
      const timer = globalThis.setTimeout(() => done(false), 1000);
      const done = (answer) => {
        globalThis.clearTimeout(timer);
        probe.destroy();
        resolve(answer);
      };
      probe.on("connect", () => done(true));
      probe.on("error", () => done(false));
    });
  }

  async isListening() {
    return this.started || this.#socketIsLive();
  }

  #handleConnection(socket) {
    let buffer = Buffer.alloc(0);
    let handled = false;
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    socket.setTimeout(30000, () => socket.destroy());
    socket.on("error", (err) => this.log(`relay socket error: ${err.message}`));
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        handled = true;
        this.#reply(socket, errorResponse("RELAY_MESSAGE_TOO_LARGE", `a relay frame may not exceed ${MAX_FRAME_BYTES} bytes`));
        return;
      }
      const index = buffer.indexOf(10);
      if (index < 0) return;
      handled = true;
      void this.#handleLine(socket, buffer.subarray(0, index).toString("utf8"));
      buffer = Buffer.alloc(0);
    });
  }

  async #handleLine(socket, line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (err) {
      this.#reply(socket, errorResponse("RELAY_BAD_REQUEST", `malformed JSON: ${err.message}`));
      return;
    }
    const response = await handleRelayRequest(payload, {
      dispatch: this.dispatch,
      dispatchDesktop: this.dispatchDesktop,
      resolveExecutor: this.resolveExecutor,
    });
    if (!response.ok) this.log(`relay refused ${payload?.targetThreadId ?? "?"}: ${response.error.message}`);
    else this.log(response.operation ? `completed Desktop operation ${response.operation}` : `relayed a message into thread ${response.targetThreadId}`);
    this.#reply(socket, response);
  }

  #reply(socket, response) {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}\n`);
  }

  stop() {
    for (const [event, handler] of this.processHandlers) process.off(event, handler);
    this.processHandlers.clear();
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    try {
      this.server?.close();
    } catch {}
    try {
      if (this.started && !IS_WINDOWS) fs.rmSync(this.socketPath, { force: true });
    } catch {}
    this.started = false;
  }
}

export function startRelayWhenAvailable({ nativeTools, relay, log: logFn = () => {}, retryDelayMs = 250, maxRetryDelayMs = 30000 }) {
  let stopped = false;
  let timer = null;
  let delayMs = retryDelayMs;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const attempt = async () => {
    if (stopped) return;
    try {
      await nativeTools.connect();
      if (stopped) {
        nativeTools.close();
        return;
      }
      await relay.start();
      if (stopped) {
        relay.stop();
        nativeTools.close();
        return;
      }
      resolveReady(true);
    } catch (err) {
      if (stopped) return;
      nativeTools.close();
      if (!nativeTools.socketPath) {
        logFn(`native relay unavailable (${err.message})`);
        resolveReady(false);
        return;
      }
      logFn(`native relay unavailable (${err.message}); retrying in ${delayMs}ms`);
      timer = globalThis.setTimeout(() => {
        timer = null;
        void attempt();
      }, delayMs);
      timer.unref();
      delayMs = Math.min(delayMs * 2, maxRetryDelayMs);
    }
  };
  void attempt();
  return {
    ready,
    stop() {
      if (stopped) return;
      stopped = true;
      globalThis.clearTimeout(timer);
      nativeTools.close();
      relay.stop();
      resolveReady(false);
    },
  };
}

/**
 * `import.meta.main` is Node 24 and up, and this project supports Node 22, so
 * the entry point is detected by comparing the resolved argv path instead.
 */
const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const mcp = new McpServer(
    { name: "codex-native-relay", version: VERSION },
    {
      instructions:
        "Companion process for the Codex Desktop native relay. It carries no work of its own: it accepts " +
        "messages from claude-bridge on a private local socket and asks the Codex Desktop app-server that " +
        "launched it to deliver them into an already-open thread, so that thread keeps its writer lock.",
    },
  );

  const nativeTools = new NativeToolsClient();
  const dispatch = (args) => nativeTools.dispatch(args);

  const relay = new RelaySocketServer({
    socketPath: relaySocketPath(),
    dispatch,
    dispatchDesktop: (args) => nativeTools.dispatchDesktop(args),
    log,
  });
  const desktopRelay = desktopTaskSocketPath() === relay.socketPath ? relay : new RelaySocketServer({
    socketPath: desktopTaskSocketPath(),
    dispatchDesktop: (args) => nativeTools.dispatchDesktop(args),
    log,
  });

  mcp.registerTool(
    "native_relay_status",
    {
      title: "Check the Codex Desktop native relay",
      description:
        "Report the local socket this companion listens on, the executor thread it dispatches through, and " +
        "whether the relay is ready to deliver messages into threads Codex Desktop has open.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const listening = await relay.isListening();
      let executor = "(unconfigured)";
      try {
        const resolved = resolveRelayThreadId();
        executor = `${resolved.threadId}  (from ${resolved.source})`;
      } catch (err) {
        executor = err.message;
      }
      return {
        content: [
          {
            type: "text",
            text: [
              `platform:       ${PLATFORM_LABEL} (${process.platform}/${process.arch})`,
              `companion:      codex-native-relay ${VERSION}`,
              `relay socket:   ${relay.started ? relay.socketPath : `${relay.socketPath} (${listening ? "shared companion listening" : "not listening"})`}`,
              `desktop tasks:  ${desktopRelay.socketPath} (${await desktopRelay.isListening() ? "listening" : "not listening"})`,
              `executor:       ${executor}`,
              `dispatch:       ${process.env.CODEX_NATIVE_RELAY_METHOD ?? NATIVE_DISPATCH_METHOD}`,
              `native pipe:    ${nativeTools.socketPath ?? "unavailable (requires Codex Desktop)"}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  const startup = startRelayWhenAvailable({ nativeTools, relay, log });
  const desktopStartup = desktopRelay === relay ? startup : startRelayWhenAvailable({ nativeTools, relay: desktopRelay, log });
  mcp.server.onclose = () => { startup.stop(); desktopStartup.stop(); };
  await mcp.connect(new StdioServerTransport());
  log(`ready on ${PLATFORM_LABEL} (${relay.started ? relay.socketPath : "socket down"})`);
}
