#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  MAX_FRAME_BYTES,
  NATIVE_DISPATCH_METHOD,
  RELAY_PROTOCOL_VERSION,
  nativeDispatchParams,
  relaySocketPath,
  resolveRelayThreadId,
} from "./native-relay.mjs";
import { IS_WINDOWS, PLATFORM_LABEL } from "./platform.mjs";

/**
 * The companion half of the Codex Desktop native relay.
 *
 * Codex Desktop launches this as one of its own MCP servers, so the connection
 * it answers on belongs to the app's real app-server - the one already holding
 * the writer lock of every thread the human has open. Asking that app-server to
 * deliver a message is therefore not a second writer, and the thread stays open
 * and owned by Codex Desktop throughout.
 *
 * Everything else is deliberately small: a private socket, one accepted shape
 * (`{ targetThreadId, message }`), one dispatch, one acknowledgement.
 */

const VERSION = "1.12.1";
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
  { dispatch, resolveExecutor = resolveRelayThreadId, env = process.env } = {},
) {
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
    return { ok: true, v: RELAY_PROTOCOL_VERSION, targetThreadId, executorThreadId, result: result ?? null };
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
    resolveExecutor = resolveRelayThreadId,
    restrictSocket = (target) => {
      if (!IS_WINDOWS) fs.chmodSync(target, 0o600);
    },
    log: logFn = () => {},
  } = {}) {
    this.socketPath = socketPath;
    this.dispatch = dispatch;
    this.resolveExecutor = resolveExecutor;
    this.restrictSocket = restrictSocket;
    this.log = logFn;
    this.server = null;
    this.started = false;
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
      process.on(signal, () => {
        this.stop();
        process.exit(0);
      });
    }
    process.on("exit", () => this.stop());

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

  #handleConnection(socket) {
    let buffer = "";
    socket.on("error", (err) => this.log(`relay socket error: ${err.message}`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        this.#reply(socket, errorResponse("RELAY_MESSAGE_TOO_LARGE", `a relay frame may not exceed ${MAX_FRAME_BYTES} bytes`));
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        void this.#handleLine(socket, line);
      }
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
      resolveExecutor: this.resolveExecutor,
    });
    if (!response.ok) this.log(`relay refused ${payload?.targetThreadId ?? "?"}: ${response.error.message}`);
    else this.log(`relayed a message into thread ${response.targetThreadId}`);
    this.#reply(socket, response);
  }

  #reply(socket, response) {
    if (socket.destroyed) return;
    socket.write(`${JSON.stringify(response)}\n`);
  }

  stop() {
    try {
      this.server?.close();
    } catch {}
    try {
      if (this.started && !IS_WINDOWS) fs.rmSync(this.socketPath, { force: true });
    } catch {}
    this.started = false;
  }
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

  /**
   * The dispatch goes back over the very connection Codex Desktop opened to
   * launch this process, which is what keeps the app the single writer. Sent as
   * a plain JSON-RPC request rather than through a typed helper because the
   * method is an internal of the app, not part of the MCP specification.
   */
  const dispatch = ({ executorThreadId, targetThreadId, message }) =>
    mcp.server.request(
      {
        method: process.env.CODEX_NATIVE_RELAY_METHOD ?? NATIVE_DISPATCH_METHOD,
        params: nativeDispatchParams({ executorThreadId, targetThreadId, message }),
      },
      z.any(),
    );

  const relay = new RelaySocketServer({ socketPath: relaySocketPath(), dispatch, log });

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
              `relay socket:   ${relay.started ? relay.socketPath : `${relay.socketPath} (not listening)`}`,
              `executor:       ${executor}`,
              `dispatch:       ${process.env.CODEX_NATIVE_RELAY_METHOD ?? NATIVE_DISPATCH_METHOD}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  /**
   * Never let the socket take the MCP server down. Codex Desktop waits on the
   * `initialize` handshake, so a process that dies before answering reads as a
   * hang rather than an error - the same failure mode `claude-bridge` already
   * guards its peer endpoint against.
   */
  try {
    await relay.start();
  } catch (err) {
    log(`relay socket unavailable (${err.message}) - claude-bridge will fall back to the app-server path`);
  }

  await mcp.connect(new StdioServerTransport());
  log(`ready on ${PLATFORM_LABEL} (${relay.started ? relay.socketPath : "socket down"})`);
}
