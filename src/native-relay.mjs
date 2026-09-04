import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { IS_MACOS, PLATFORM_LABEL, homeDir } from "./platform.mjs";

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
export const NATIVE_DISPATCH_METHOD = "codex_app.send_message_to_thread";

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
const RELAY_CONFIG_NAME = "native-relay.json";

export class NativeRelayError extends Error {
  /**
   * `reachedCompanion` is what decides whether falling back to the app-server
   * path is worth doing. A companion that never answered says nothing about
   * the target thread, so the older path deserves its turn; a companion that
   * answered with a refusal has already asked Codex, and asking again through
   * a second app-server only adds a writer-lock failure on top.
   */
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
  return env.CODEX_NATIVE_RELAY_SOCKET ?? path.join(codexHome(env), RELAY_SOCKET_NAME);
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
  return { executorThreadId, threadId: targetThreadId, message };
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
  if (!IS_MACOS && !forced) {
    return {
      enabled: false,
      mode,
      socketPath,
      reason: `the Codex Desktop native relay is macOS-only (this is ${PLATFORM_LABEL})`,
    };
  }
  if (!isSocketFile(socketPath)) {
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
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
      throw new NativeRelayError(
        `Relay message is larger than ${MAX_FRAME_BYTES} bytes; shorten it before relaying.`,
        "RELAY_MESSAGE_TOO_LARGE",
      );
    }

    const response = await this.#roundTrip(line, timeoutMs);
    if (response?.ok) return response;
    throw new NativeRelayError(
      response?.error?.message ?? "the Codex Desktop relay refused the message",
      response?.error?.code ?? "NATIVE_DISPATCH_FAILED",
      { reachedCompanion: true },
    );
  }

  #roundTrip(line, timeoutMs) {
    const socketPath = this.socketPath;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
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
              { reachedCompanion: true },
            ),
          ),
        timeoutMs,
      );

      socket.on("connect", () => socket.write(line));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
          finish(
            reject,
            new NativeRelayError("The Codex Desktop relay answered with an oversized frame", "RELAY_BAD_RESPONSE", {
              reachedCompanion: true,
            }),
          );
          return;
        }
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        try {
          finish(resolve, JSON.parse(buffer.slice(0, index)));
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
          new NativeRelayError(`Cannot reach the Codex Desktop relay at ${socketPath}: ${err.message}`, "RELAY_UNREACHABLE"),
        ),
      );
      socket.on("close", () =>
        finish(
          reject,
          new NativeRelayError(
            `The Codex Desktop relay at ${socketPath} closed before answering`,
            "RELAY_UNREACHABLE",
          ),
        ),
      );
    });
  }
}

/**
 * Creates the dedicated executor thread once and remembers it, using the
 * ordinary app-server path - which is allowed to take a writer lock here
 * precisely because this thread belongs to nobody else. The caller stops the
 * app-server afterwards, so the lock is released and Codex Desktop is left
 * with the state to itself.
 */
export async function bootstrapRelayThread(client, { cwd = homeDir(), env = process.env, name = "Native Relay" } = {}) {
  const res = await client.call("thread/start", {
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const threadId = res?.thread?.id;
  if (!threadId) throw new NativeRelayError("Codex app-server created no relay thread id", "RELAY_BOOTSTRAP_FAILED");

  try {
    await client.call("thread/name/set", { threadId, name });
  } catch {
    // A thread without a title still works as an executor context.
  }

  writeRelayConfig({ relayThreadId: threadId, createdAt: new Date().toISOString() }, env);
  return { threadId, configPath: relayConfigPath(env) };
}

export function writeRelayConfig(config, env = process.env) {
  const file = relayConfigPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}
