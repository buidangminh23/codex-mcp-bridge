#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NativeToolsClient } from "./native-relay.mjs";
import { createNativeRelayLifecycle, createRelayServers } from "./native-relay-companion.mjs";
import { nativePipeReachable } from "./native-relay-owner.mjs";
import { CLIENT_CLOSE_DRAIN_MS, CLIENT_CLOSE_STOP_MS } from "./reload-control.mjs";

export const RELAY_HOST_WATCH_MS = 5000;
export const RELAY_HOST_PIPE_STRIKES = 2;
const MAX_LOG_BYTES = 512 * 1024;

export function relayHostLogPath(env = process.env) {
  return path.join(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "native-relay-host.log");
}

export function createRelayHostLog(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {}
  return (message) => {
    try { fs.appendFileSync(file, `${new Date().toISOString()} [native-relay-host ${process.pid}] ${message}\n`, { mode: 0o600 }); } catch {}
  };
}

const bounded = (promise, ms) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(() => true),
    new Promise((resolve) => { timer = globalThis.setTimeout(() => resolve(false), ms); }),
  ]).finally(() => globalThis.clearTimeout(timer));
};

export async function runRelayHost({
  env = process.env,
  pipePath = env.CODEX_APP_TOOLS_PIPE_PATH,
  log = () => {},
  reachable = nativePipeReachable,
  watchMs = RELAY_HOST_WATCH_MS,
  strikes = RELAY_HOST_PIPE_STRIKES,
  drainMs = CLIENT_CLOSE_DRAIN_MS,
  stopMs = CLIENT_CLOSE_STOP_MS,
  pollMs = 50,
  nativeTools = new NativeToolsClient({ env, socketPath: pipePath }),
  servers = null,
} = {}) {
  if (!await reachable(pipePath)) {
    log(`Codex Desktop pipe ${pipePath ?? "(none)"} is not reachable; nothing to host`);
    return { started: false, done: Promise.resolve(0), shutdown: async () => 0 };
  }
  const { relays } = servers ?? createRelayServers({ nativeTools, env, role: "host", signalExit: false, log });
  const unique = [...new Set(relays)];
  const lifecycle = createNativeRelayLifecycle({ nativeTools, relays: unique, log });
  for (const relay of unique) {
    try { await relay.start(); }
    catch (error) {
      log(`${error.message}; leaving the relay to its current owner`);
      await lifecycle.stop();
      return { started: false, done: Promise.resolve(0), shutdown: async () => 0 };
    }
  }
  log(`serving ${unique.map((relay) => relay.socketPath).join(", ")} for Codex Desktop pipe ${pipePath}`);
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let closing = null;
  let misses = 0;
  let watching = false;
  const shutdown = (why) => closing ??= (async () => {
    globalThis.clearInterval(timer);
    log(`stopping: ${why}`);
    let code = 0;
    try {
      lifecycle.refuseNewDeliveries();
      const deadline = Date.now() + drainMs;
      let reason = lifecycle.deliveryReason();
      while (reason && Date.now() < deadline) {
        await new Promise((resolve) => globalThis.setTimeout(resolve, pollMs));
        reason = lifecycle.deliveryReason();
      }
      if (reason) log(`stopping after ${drainMs} ms with work still open: ${reason}`);
      if (!await bounded(lifecycle.stop(), stopMs)) log(`listener shutdown exceeded ${stopMs} ms`);
    } catch (error) {
      code = 1;
      log(`shutdown failed: ${error?.message ?? String(error)}`);
    }
    resolveDone(code);
    return code;
  })();
  const watch = async () => {
    if (watching || closing) return;
    watching = true;
    try {
      if (!unique.some((relay) => relay.ownsPublicPath())) return void shutdown("another native relay owner replaced the sockets");
      misses = await reachable(pipePath) ? 0 : misses + 1;
      if (misses >= strikes) void shutdown("Codex Desktop pipe is gone");
    } finally {
      watching = false;
    }
  };
  const timer = globalThis.setInterval(() => { void watch(); }, watchMs);
  return { started: true, done, shutdown, lifecycle, relays: unique };
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const log = createRelayHostLog(relayHostLogPath());
  let host = null;
  const fail = (error) => {
    log(`fatal: ${error?.stack ?? error?.message ?? String(error)}`);
    void Promise.resolve(host?.shutdown("fatal error")).finally(() => process.exit(1));
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  for (const output of [process.stdout, process.stderr]) output?.on?.("error", () => {});
  try {
    host = await runRelayHost({ log });
  } catch (error) {
    fail(error);
  }
  if (host) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { void host.shutdown(signal); });
    process.exit(await host.done);
  }
}
