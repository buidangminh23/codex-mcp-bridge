import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { IS_MACOS, IS_WINDOWS, PLATFORM_LABEL, homeDir } from "./platform.mjs";

/**
 * The Codex Desktop app owns the per-thread writer lock of every thread it has
 * open, and it keeps it for as long as the thread is open. Anything that wants
 * to write into such a thread by attaching a second app-server loses: the
 * app-server answers `thread <id> already has an active writer`. Closing the
 * thread first is not an answer either, because the whole point of binding a
 * thread is that the human keeps watching it in Codex Desktop.
 *
 * The way through is to stop bringing a second writer. A companion MCP process
 * launched by Codex Desktop's own app-server already sits inside the app's
 * context, so it can ask that app-server to deliver the message on the app's
 * behalf. No resume, no attach, no second app-server, no lock to fight over.
 *
 * This module is the client half - the part `claude-bridge` talks to. The
 * companion half lives in `native-relay-companion.mjs`.
 */

/**
 * Measured, not documented. `codex_app.send_message_to_thread` is an internal
 * of the Codex Desktop native tools pipe, on the same footing as the Claude
 * peer protocol in `peer-protocol.mjs`: it works today and carries no public
 * contract. When Codex changes it, this constant and `nativeDispatchParams`
 * below are the two places to fix, and `CODEX_NATIVE_RELAY_METHOD` overrides
 * the name without a release.
 */
export const NATIVE_DISPATCH_METHOD = "tools/call";

export const RELAY_PROTOCOL_VERSION = 1;

/**
 * A relay frame carries one chat message, so a megabyte-scale line is either a
 * bug or something trying to make the companion buffer without limit. The cap
 * is applied on both halves: the client refuses to send an oversized message,
 * and the companion refuses to accumulate one.
 */
export const MAX_FRAME_BYTES = 128 * 1024;

const DEFAULT_TIMEOUT_MS = 30000;
const RELAY_SOCKET_NAME = "native-relay.sock";
const WINDOWS_RELAY_SOCKET = "\\\\.\\pipe\\LOCAL\\codex-native-relay";
const RELAY_CONFIG_NAME = "native-relay.json";

export class NativeRelayError extends Error {
  constructor(message, code, { reachedCompanion = false } = {}) {
    super(message);
    this.name = "NativeRelayError";
    this.code = code;
    this.reachedCompanion = reachedCompanion;
  }
}

export function codexHome(env = process.env) {
  return env.CODEX_HOME ?? path.join(homeDir(), ".codex");
}

export function relaySocketPath(env = process.env) {
  return env.CODEX_NATIVE_RELAY_SOCKET ?? (IS_WINDOWS ? WINDOWS_RELAY_SOCKET : path.join(codexHome(env), RELAY_SOCKET_NAME));
}

export function desktopTaskSocketPath(env = process.env) {
  return env.CODEX_NATIVE_RELAY_SOCKET ?? `${relaySocketPath(env)}-desktop-tasks`;
}

export function desktopTasksConfigured(env = process.env) {
  return env.CODEX_BRIDGE_DESKTOP_TASKS !== undefined
    ? env.CODEX_BRIDGE_DESKTOP_TASKS === "1"
    : readRelayConfig(env)?.desktopTasks === true;
}

export function relayConfigPath(env = process.env) {
  return path.join(codexHome(env), RELAY_CONFIG_NAME);
}

function isSocketFile(target) {
  try {
    return fs.statSync(target).isSocket();
  } catch {
    return false;
  }
}

function isRelayEndpoint(target) {
  if (IS_WINDOWS) {
    return typeof target === "string" && target.toLowerCase().startsWith("\\\\.\\pipe\\") && fs.existsSync(target);
  }
  return isSocketFile(target);
}

export function readRelayConfig(env = process.env) {
  const file = relayConfigPath(env);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `codex_app.send_message_to_thread` runs against an executor thread, which has
 * to be a real Codex thread and is not the destination: a synthetic UUID is
 * rejected with `NATIVE_DISPATCH_FAILED`, so the id cannot be invented at call
 * time. A thread dedicated to the relay keeps that requirement off the
 * destination thread, which stays open in Codex Desktop and untouched.
 *
 * The order is deliberate: an explicit `CODEX_RELAY_ID` wins so a single run
 * can be pointed elsewhere without editing state, then the id bootstrapped
 * once into `~/.codex/native-relay.json`, and then an error. Never a guess -
 * an invented executor fails inside Codex with a message that says nothing
 * about the missing configuration that actually caused it.
 */
export function resolveRelayThreadId(env = process.env) {
  const explicit = env.CODEX_RELAY_ID?.trim();
  if (explicit) return { threadId: explicit, source: "CODEX_RELAY_ID" };

  const persisted = readRelayConfig(env)?.relayThreadId;
  if (typeof persisted === "string" && persisted.trim()) {
    return { threadId: persisted.trim(), source: relayConfigPath(env) };
  }

  throw new NativeRelayError(
    `No Codex relay thread is configured. Set CODEX_RELAY_ID, or bootstrap one into ${relayConfigPath(env)} ` +
      "with: node scripts/install-native-relay.mjs",
    "RELAY_THREAD_UNCONFIGURED",
  );
}

/**
 * Builds the parameters of the native dispatch. Kept apart from the transport
 * so the one shape this project cannot verify against a published schema sits
 * in a single named function with a single test, rather than inline in the
 * middle of a request.
 */
export function nativeDispatchParams({ executorThreadId, targetThreadId, message }) {
  return {
    arguments: { threadId: targetThreadId, prompt: message },
    callId: `codex-native-relay-${randomUUID()}`,
    namespace: "codex_app",
    threadId: executorThreadId,
    tool: "send_message_to_thread",
    turnId: `codex-native-relay-turn-${randomUUID()}`,
  };
}

const DESKTOP_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

function exactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalText(value) {
  return value === undefined || nonempty(value);
}

function optionalInteger(value, min, max) {
  return value === undefined || Number.isSafeInteger(value) && value >= min && value <= max;
}

export function validateDesktopOperation(operation, args) {
  let valid = false;
  const modelSettings = () => optionalText(args.model) &&
    (args.thinking === undefined || DESKTOP_EFFORTS.has(args.thinking));
  switch (operation) {
    case "list_projects":
      valid = exactObject(args, []);
      break;
    case "create_thread":
      valid = exactObject(args, ["prompt", "target", "model", "thinking", "title"]) &&
        nonempty(args.prompt) && optionalText(args.title) && modelSettings() &&
        exactObject(args.target, ["type", "projectId", "environment"]) &&
        args.target.type === "project" && nonempty(args.target.projectId) &&
        exactObject(args.target.environment, ["type"]) && args.target.environment.type === "local";
      break;
    case "send_message_to_thread":
      valid = exactObject(args, ["threadId", "prompt", "model", "thinking"]) &&
        nonempty(args.threadId) && nonempty(args.prompt) && modelSettings();
      break;
    case "read_thread":
      valid = exactObject(args, ["threadId", "hostId", "cursor", "turnLimit", "includeOutputs", "maxOutputCharsPerItem"]) &&
        nonempty(args.threadId) && (args.hostId === undefined || args.hostId === "local") &&
        optionalText(args.cursor) && optionalInteger(args.turnLimit, 1, 10) &&
        (args.includeOutputs === undefined || typeof args.includeOutputs === "boolean") &&
        optionalInteger(args.maxOutputCharsPerItem, 1, 16000);
      break;
    case "wait_threads":
      valid = exactObject(args, ["targets", "timeoutMs"]) && args.timeoutMs === 0 &&
        Array.isArray(args.targets) && args.targets.length >= 1 && args.targets.length <= 8 &&
        args.targets.every((target) => exactObject(target, ["threadId", "hostId", "afterCursor"]) &&
          nonempty(target.threadId) && (target.hostId === undefined || target.hostId === "local") &&
          optionalText(target.afterCursor));
      break;
    case "navigate_to_codex_page":
      valid = exactObject(args, ["threadId"]) && nonempty(args.threadId);
      break;
    case "set_thread_title":
      valid = exactObject(args, ["threadId", "title"]) && nonempty(args.threadId) && nonempty(args.title);
      break;
  }
  if (!valid) throw new NativeRelayError(`Unsupported or invalid Desktop operation: ${operation}`, "RELAY_BAD_REQUEST");
  return args;
}

export function nativeDesktopOperationParams({ executorThreadId, operation, arguments: args }) {
  validateDesktopOperation(operation, args);
  return {
    arguments: args,
    callId: `codex-native-relay-${randomUUID()}`,
    namespace: "codex_app",
    threadId: executorThreadId,
    tool: operation,
    turnId: `codex-native-relay-turn-${randomUUID()}`,
  };
}

export function decodeNativeToolResult(result) {
  if (result?.success !== true || result?.isError === true) {
    const detail = (result?.contentItems ?? result?.content ?? []).filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n").slice(0, 2000);
    throw new NativeRelayError(detail || "Codex Desktop did not confirm the requested operation", "NATIVE_DISPATCH_FAILED");
  }
  let decoded = result.structuredContent;
  if (decoded === undefined) {
    const items = result.contentItems ?? result.content;
    if (Array.isArray(items)) {
      const text = items.filter((item) => item?.type === "inputText" || item?.type === "text")
        .map((item) => item.text).filter((value) => typeof value === "string").join("\n");
      if (text) {
        try {
          decoded = JSON.parse(text);
        } catch {
          decoded = { text };
        }
      }
    }
  }
  decoded ??= result;
  if (decoded?.isError === true || decoded?.success === false) {
    throw new NativeRelayError("Codex Desktop rejected the requested operation", "NATIVE_DISPATCH_FAILED");
  }
  return decoded;
}

const execFileAsync = promisify(execFile);

function splitDesktopCommandLine(commandLine, platform) {
  const args = [];
  let value = "";
  let quote = null;
  let depth = 0;
  for (let index = 0; index < commandLine.length; index++) {
    const char = commandLine[index];
    if (platform === "win32" && char === "\\") {
      let end = index;
      while (commandLine[end] === "\\") end++;
      const count = end - index;
      if (commandLine[end] === '"') {
        value += "\\".repeat(Math.floor(count / 2));
        if (count % 2) value += '"';
        else quote = quote ? null : '"';
        index = end;
      } else {
        value += "\\".repeat(count);
        index = end - 1;
      }
      continue;
    }
    if (platform !== "win32" && depth > 0) {
      value += char;
      if (quote) {
        if (char === "\\" && quote === '"') value += commandLine[++index] ?? "";
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") quote = char;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") depth--;
      continue;
    }
    if (char === '"' || (platform !== "win32" && char === "'")) {
      if (!quote) quote = char;
      else if (quote === char) quote = null;
      else value += char;
    } else if (!quote && /\s/.test(char)) {
      if (value) args.push(value);
      value = "";
    } else {
      value += char;
      if (platform !== "win32" && !quote && char === "{") depth++;
    }
  }
  if (quote || depth) return [];
  if (value) args.push(value);
  return args;
}

function inlineTableValues(table) {
  const text = table.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  const entries = [];
  let start = 1;
  let quote = null;
  let depth = 0;
  for (let index = 1; index < text.length - 1; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      if (--depth < 0) return null;
    } else if (char === "," && depth === 0) {
      entries.push(text.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || depth) return null;
  entries.push(text.slice(start, -1));
  const values = new Map();
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const match = entry.match(/^\s*(?:"([A-Za-z_][A-Za-z0-9_-]*)"|'([A-Za-z_][A-Za-z0-9_-]*)'|([A-Za-z_][A-Za-z0-9_-]*))\s*=\s*([\s\S]+)$/);
    if (!match) return null;
    const key = match[1] ?? match[2] ?? match[3];
    if (values.has(key)) return null;
    values.set(key, match[4].trim());
  }
  return values;
}

export function nativeToolsPipeFromCommandLine(commandLine, { platform = process.platform } = {}) {
  if (typeof commandLine !== "string" || /[\r\n\0]/.test(commandLine)) return null;
  const args = splitDesktopCommandLine(commandLine, platform);
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!/^codex(?:\.exe)?$/i.test(paths.basename(args[0] ?? ""))) return null;
  const overrides = [];
  let appServer = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-c" || arg === "--config") {
      overrides.push(args[++index] ?? "");
    } else if (arg.startsWith("--config=")) overrides.push(arg.slice(9));
    else if (arg === "app-server") appServer = true;
    else if (!arg.startsWith("-") && !appServer) return null;
  }
  if (!appServer) return null;
  const candidates = [];
  for (const override of overrides) {
    const match = override.match(/^mcp_servers\.codex_app\s*=\s*([\s\S]+)$/);
    if (!match) continue;
    const config = inlineTableValues(match[1]);
    if (!config) return null;
    const env = inlineTableValues(config.get("env") ?? "{}");
    if (!env) return null;
    const raw = env.get("CODEX_APP_TOOLS_PIPE_PATH");
    if (raw === undefined) continue;
    let candidate;
    try {
      candidate = raw.startsWith('"') ? JSON.parse(raw) : /^'[^']*'$/.test(raw) ? raw.slice(1, -1) : null;
    } catch {
      return null;
    }
    if (typeof candidate !== "string" || /[\r\n\0]/.test(candidate)) return null;
    if (platform === "win32" ? !/^\\\\\.\\pipe\\[^\\]/i.test(candidate) : !path.posix.isAbsolute(candidate)) return null;
    candidates.push(candidate);
  }
  return candidates.length && new Set(candidates).size === 1 ? candidates[0] : null;
}

async function readParentCommandLine(parentPid, platform) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return null;
  const options = { timeout: 5000, maxBuffer: 128 * 1024, windowsHide: true };
  if (platform === "win32") {
    const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${parentPid}'; if ($p.Name -eq 'codex.exe') { $p.CommandLine | ConvertTo-Json -Compress }`;
    const { stdout } = await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options);
    return stdout.trim() ? JSON.parse(stdout.trim()) : null;
  }
  const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-p", String(parentPid), "-o", "args="], options);
  return stdout.trim();
}

export async function resolveNativeToolsPipePath({
  env = process.env,
  parentPid = process.ppid,
  platform = process.platform,
  readParentCommandLine: readParent = readParentCommandLine,
} = {}) {
  if (env.CODEX_APP_TOOLS_PIPE_PATH) return env.CODEX_APP_TOOLS_PIPE_PATH;
  try {
    return nativeToolsPipeFromCommandLine(await readParent(parentPid, platform), { platform });
  } catch {
    return null;
  }
}

export class NativeToolsClient {
  constructor({ env = process.env, socketPath = env.CODEX_APP_TOOLS_PIPE_PATH, timeoutMs = DEFAULT_TIMEOUT_MS, resolveSocketPath = () => resolveNativeToolsPipePath({ env }) } = {}) {
    this.env = env;
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.resolveSocketPath = resolveSocketPath;
    this.socket = null;
    this.connectingSocket = null;
    this.connecting = null;
    this.connectionGeneration = 0;
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    const generation = this.connectionGeneration;
    this.connecting = (async () => {
      const socketPath = this.socketPath || await this.resolveSocketPath();
      if (generation !== this.connectionGeneration) {
        throw new NativeRelayError("Native tools client closed while discovering the Desktop pipe", "NATIVE_PIPE_UNAVAILABLE");
      }
      this.socketPath = socketPath;
      if (!this.socketPath) {
        throw new NativeRelayError("CODEX_APP_TOOLS_PIPE_PATH is missing from the environment and parent Desktop app-server configuration; launch the companion from Codex Desktop", "NATIVE_PIPE_UNAVAILABLE");
      }
      return new Promise((resolve, reject) => {
      const socket = net.connect({ path: this.socketPath });
      this.connectingSocket = socket;
      let buffer = Buffer.alloc(0);
      let connected = false;
      const timer = globalThis.setTimeout(() => {
        reject(new NativeRelayError("Timed out connecting to the Codex Desktop native tools pipe", "NATIVE_PIPE_UNAVAILABLE"));
        socket.destroy();
      }, this.timeoutMs);
      const fail = (err) => {
        globalThis.clearTimeout(timer);
        if (!connected) reject(err);
        if (this.socket === socket) this.socket = null;
        for (const pending of this.pending.values()) {
          if (pending.socket === socket) pending.reject(err);
        }
        socket.destroy();
      };
      socket.on("connect", () => {
        connected = true;
        globalThis.clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (!length || length > MAX_FRAME_BYTES) {
            fail(new NativeRelayError("Invalid Codex Desktop native frame length", "NATIVE_BAD_RESPONSE"));
            return;
          }
          if (buffer.length < length + 4) return;
          let response;
          try {
            response = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
          } catch {
            fail(new NativeRelayError("Malformed Codex Desktop native response", "NATIVE_BAD_RESPONSE"));
            return;
          }
          buffer = buffer.subarray(length + 4);
          if (!response || typeof response !== "object" || response.jsonrpc !== "2.0") {
            fail(new NativeRelayError("Invalid Codex Desktop JSON-RPC response", "NATIVE_BAD_RESPONSE"));
            return;
          }
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          if (response.error) {
            pending.reject(new NativeRelayError(response.error.message ?? "Codex Desktop rejected the native dispatch", "NATIVE_DISPATCH_FAILED"));
          } else if (Object.hasOwn(response, "result")) {
            pending.resolve(response.result);
          } else {
            pending.reject(new NativeRelayError("Codex Desktop native response has no result", "NATIVE_BAD_RESPONSE"));
          }
        }
      });
      socket.on("error", (err) => fail(new NativeRelayError(`Codex Desktop native pipe failed: ${err.message}`, connected ? "NATIVE_DELIVERY_UNCONFIRMED" : "NATIVE_PIPE_UNAVAILABLE")));
      socket.on("close", () => fail(new NativeRelayError("Codex Desktop native tools pipe closed before confirming delivery", connected ? "NATIVE_DELIVERY_UNCONFIRMED" : "NATIVE_PIPE_UNAVAILABLE")));
      });
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
      this.connectingSocket = null;
    }
  }

  async dispatch(args) {
    return this.#request(nativeDispatchParams(args));
  }

  async dispatchDesktop(args) {
    return this.#request(nativeDesktopOperationParams(args));
  }

  async #request(params) {
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: this.env.CODEX_NATIVE_RELAY_METHOD ?? NATIVE_DISPATCH_METHOD,
      params,
    }));
    if (payload.length > MAX_FRAME_BYTES) {
      throw new NativeRelayError("Native dispatch exceeds the frame limit", "RELAY_MESSAGE_TOO_LARGE");
    }
    await this.connect();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length);
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        if (!this.pending.delete(id)) return;
        globalThis.clearTimeout(timer);
        fn(value);
      };
      const timer = globalThis.setTimeout(() => {
        finish(reject, new NativeRelayError("Codex Desktop native dispatch timed out; delivery may have occurred", "NATIVE_DELIVERY_UNCONFIRMED"));
      }, this.timeoutMs);
      this.pending.set(id, {
        socket: this.socket,
        resolve: (value) => finish(resolve, value),
        reject: (err) => finish(reject, err),
      });
      try {
        if (!this.socket || this.socket.destroyed) throw new Error("native tools pipe is closed");
        this.socket.write(Buffer.concat([header, payload]), (err) => {
          if (err) finish(reject, new NativeRelayError(`Native dispatch write failed: ${err.message}`, "NATIVE_DELIVERY_UNCONFIRMED"));
        });
      } catch (err) {
        finish(reject, new NativeRelayError(`Native dispatch write failed: ${err.message}`, "NATIVE_DELIVERY_UNCONFIRMED"));
      }
    });
  }

  close() {
    this.connectionGeneration++;
    const socket = this.socket;
    this.socket = null;
    for (const pending of this.pending.values()) {
      pending.reject(new NativeRelayError("Native tools client closed before confirming delivery", "NATIVE_DELIVERY_UNCONFIRMED"));
    }
    socket?.destroy();
    this.connectingSocket?.destroy();
  }
}

/**
 * Whether the native path is usable right now, and when it is not, why. The
 * reason is carried rather than dropped because "the relay did nothing" is the
 * one answer nobody can act on: a missing companion socket, an unsupported
 * platform and an operator switching the backend off all look identical from
 * the outside, and they need three different responses.
 */
export function nativeRelayStatus(env = process.env) {
  const mode = (env.CODEX_BRIDGE_NATIVE_RELAY ?? "auto").toLowerCase();
  const socketPath = relaySocketPath(env);

  if (mode === "0" || mode === "off") {
    return { enabled: false, mode, socketPath, reason: "disabled by CODEX_BRIDGE_NATIVE_RELAY=0" };
  }
  const forced = mode === "1" || mode === "on";
  if (!IS_MACOS && !IS_WINDOWS && !forced) {
    return {
      enabled: false,
      mode,
      socketPath,
      reason: `the Codex Desktop native relay is unavailable on ${PLATFORM_LABEL}`,
    };
  }
  if (!isRelayEndpoint(socketPath)) {
    return {
      enabled: false,
      mode,
      socketPath,
      reason: `no companion socket at ${socketPath} - is the native relay installed and Codex Desktop running?`,
    };
  }
  return { enabled: true, mode, socketPath, reason: null };
}

/**
 * Speaks one request per connection to the companion: a single NDJSON line out,
 * a single NDJSON line back. Connections are not pooled - a relayed message is
 * a rare event bounded by the bridge's own ping-pong guard, and a short-lived
 * socket cannot go stale while Codex Desktop restarts underneath it.
 */
export class NativeDesktopRelay {
  constructor({ env = process.env, socketPath = null, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
    this.env = env;
    this.explicitSocketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  get socketPath() {
    return this.explicitSocketPath ?? relaySocketPath(this.env);
  }

  status() {
    if (!this.explicitSocketPath) return nativeRelayStatus(this.env);
    const status = nativeRelayStatus({ ...this.env, CODEX_NATIVE_RELAY_SOCKET: this.explicitSocketPath });
    return { ...status, socketPath: this.explicitSocketPath };
  }

  get available() {
    return this.status().enabled;
  }

  async sendMessage(targetThreadId, message, { timeoutMs = this.timeoutMs } = {}) {
    const request = { v: RELAY_PROTOCOL_VERSION, targetThreadId, message };
    return this.#request(request, timeoutMs);
  }

  async requestDesktop(operation, args, { timeoutMs = this.timeoutMs } = {}) {
    validateDesktopOperation(operation, args);
    return this.#request({ v: RELAY_PROTOCOL_VERSION, operation, arguments: args }, timeoutMs);
  }

  async #request(request, timeoutMs) {
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      throw new NativeRelayError(
        `Relay message is larger than ${MAX_FRAME_BYTES} bytes; shorten it before relaying.`,
        "RELAY_MESSAGE_TOO_LARGE",
      );
    }

    const response = await this.#roundTrip(line, timeoutMs);
    if (response?.ok === true && response.v === RELAY_PROTOCOL_VERSION) {
      if (request.operation && response.operation !== request.operation) throw new NativeRelayError("The relay answered a different Desktop operation; do not retry this request", "RELAY_BAD_RESPONSE", { reachedCompanion: true });
      return response;
    }
    throw new NativeRelayError(
      response?.error?.message ?? "the Codex Desktop relay refused the message",
      response?.error?.code ?? "NATIVE_DISPATCH_FAILED",
      { reachedCompanion: true },
    );
  }

  #roundTrip(line, timeoutMs) {
    const socketPath = this.socketPath;
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      let dispatched = false;
      const socket = net.connect({ path: socketPath });

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        socket.destroy();
        fn(value);
      };

      const timer = globalThis.setTimeout(
        () =>
          finish(
            reject,
            new NativeRelayError(
              `The Codex Desktop relay did not answer within ${timeoutMs}ms`,
              "RELAY_TIMEOUT",
              { reachedCompanion: dispatched },
            ),
          ),
        timeoutMs,
      );

      socket.on("connect", () => {
        dispatched = true;
        socket.write(line);
      });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_FRAME_BYTES) {
          finish(
            reject,
            new NativeRelayError("The Codex Desktop relay answered with an oversized frame", "RELAY_BAD_RESPONSE", {
              reachedCompanion: true,
            }),
          );
          return;
        }
        const index = buffer.indexOf(10);
        if (index < 0) return;
        try {
          finish(resolve, JSON.parse(buffer.subarray(0, index).toString("utf8")));
        } catch (err) {
          finish(
            reject,
            new NativeRelayError(
              `The Codex Desktop relay answered with malformed JSON: ${err.message}`,
              "RELAY_BAD_RESPONSE",
              { reachedCompanion: true },
            ),
          );
        }
      });
      socket.on("error", (err) =>
        finish(
          reject,
          new NativeRelayError(`Codex Desktop relay connection failed at ${socketPath}: ${err.message}`, dispatched ? "RELAY_DELIVERY_UNCONFIRMED" : "RELAY_UNREACHABLE", { reachedCompanion: dispatched }),
        ),
      );
      socket.on("close", () =>
        finish(
          reject,
          new NativeRelayError(
            `The Codex Desktop relay at ${socketPath} closed before answering`,
            dispatched ? "RELAY_DELIVERY_UNCONFIRMED" : "RELAY_UNREACHABLE",
            { reachedCompanion: dispatched },
          ),
        ),
      );
    });
  }
}

export async function bootstrapRelayThread(client, { cwd = homeDir(), env = process.env, name = "Native Relay" } = {}) {
  const res = await client.call("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = res?.thread?.id;
  if (!threadId) throw new NativeRelayError("Codex app-server created no relay thread id", "RELAY_BOOTSTRAP_FAILED");

  let release;
  try {
    try {
      await client.call("thread/name/set", { threadId, name });
    } catch {}
    writeRelayConfig({ ...readRelayConfig(env), relayThreadId: threadId, createdAt: new Date().toISOString() }, env);
  } finally {
    release = await client.releaseThread(threadId);
  }
  return { threadId, configPath: relayConfigPath(env), release };
}

export function writeRelayConfig(config, env = process.env) {
  const file = relayConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}
