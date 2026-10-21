import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { codexHome, resolveRelayThreadId } from "./native-relay.mjs";
import { IS_MACOS, isDesktopAppServerRunning, openThreadInCodexApp } from "./platform.mjs";
import { readRolloutFirstRecord } from "./rollout-reader.mjs";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
export const RELAY_WAKE_WAIT_MS = 20000;
export const RELAY_WAKE_COOLDOWN_MS = 60000;
const MAX_DAY_DIRECTORIES = 14;
const MAX_CANDIDATES = 40;

export function relayWakeEnabled(env = process.env, platform = process.platform) {
  const value = (env.CODEX_BRIDGE_RELAY_WAKE ?? "").toLowerCase();
  if (["0", "off", "false"].includes(value)) return false;
  return platform === "darwin";
}

function dayDirectories(sessions) {
  const directories = [];
  const children = (directory, pattern) => {
    try { return fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && pattern.test(entry.name)).map((entry) => entry.name).sort().reverse(); }
    catch { return []; }
  };
  for (const year of children(sessions, /^\d{4}$/)) {
    for (const month of children(path.join(sessions, year), /^\d{2}$/)) {
      for (const day of children(path.join(sessions, year, month), /^\d{2}$/)) {
        directories.push(path.join(sessions, year, month, day));
        if (directories.length >= MAX_DAY_DIRECTORIES) return directories;
      }
    }
  }
  return directories;
}

function samePath(left, right) {
  try { return fs.realpathSync.native(left) === fs.realpathSync.native(right); }
  catch { return false; }
}

export async function recentDesktopTaskFor(cwd, { env = process.env, sessions = path.join(codexHome(env), "sessions"), exclude = [] } = {}) {
  if (typeof cwd !== "string" || !cwd) return null;
  const excluded = new Set(exclude.filter(Boolean));
  const candidates = [];
  for (const directory of dayDirectories(sessions)) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const match = entry.isFile() ? ROLLOUT.exec(entry.name) : null;
      if (!match || excluded.has(match[1])) continue;
      const file = path.join(directory, entry.name);
      try { candidates.push({ file, threadId: match[1], mtimeMs: fs.lstatSync(file).mtimeMs }); } catch {}
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    let record;
    try { record = await readRolloutFirstRecord(candidate.file, { maxBytes: 256 * 1024 }); } catch { continue; }
    const meta = record?.type === "session_meta" ? record.payload : null;
    if (meta?.id !== candidate.threadId || meta.originator !== "Codex Desktop" || typeof meta.cwd !== "string") continue;
    if (samePath(meta.cwd, cwd)) return candidate.threadId;
  }
  return null;
}

export function endpointAnswers(socketPath, { timeoutMs = 1000 } = {}) {
  if (typeof socketPath !== "string" || !socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = net.connect({ path: socketPath });
    const done = (answer) => {
      globalThis.clearTimeout(timer);
      probe.destroy();
      resolve(answer);
    };
    const timer = globalThis.setTimeout(() => done(false), timeoutMs);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

export function createRelayWake({
  env = process.env,
  enabled = relayWakeEnabled(env),
  desktopRunning = () => IS_MACOS && isDesktopAppServerRunning(),
  senderCwd = () => null,
  findTask = (cwd, exclude) => recentDesktopTaskFor(cwd, { env, exclude }),
  executorThreadId = () => { try { return resolveRelayThreadId(env).threadId; } catch { return null; } },
  open = (threadId) => openThreadInCodexApp(threadId, { activate: false }),
  answers = endpointAnswers,
  waitMs = RELAY_WAKE_WAIT_MS,
  cooldownMs = RELAY_WAKE_COOLDOWN_MS,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  let inFlight = null;
  let failedAt = -Infinity;
  const attempt = async ({ socketPath, threadId, deadline }) => {
    if (!enabled || now() - failedAt < cooldownMs || !desktopRunning()) return null;
    const executor = executorThreadId();
    const target = typeof threadId === "string" && THREAD_ID.test(threadId) && threadId !== executor
      ? threadId : await findTask(senderCwd(), [executor]);
    if (!target) return null;
    try { await open(target); }
    catch (error) {
      failedAt = now();
      log(`could not open Codex task ${target} to start the native relay: ${error.message}`);
      return null;
    }
    const until = Math.min(now() + waitMs, deadline ?? Infinity);
    while (now() < until) {
      if (await answers(socketPath)) {
        log(`started the Codex Desktop native relay by opening task ${target} in the background`);
        return { threadId: target };
      }
      await sleep(pollMs);
    }
    failedAt = now();
    log(`opened Codex task ${target}, but the native relay did not start within ${waitMs} ms`);
    return null;
  };
  return (request) => inFlight ??= attempt(request).finally(() => { inFlight = null; });
}
