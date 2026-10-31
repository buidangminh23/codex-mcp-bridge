import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { codexHome, resolveRelayThreadId } from "./native-relay.mjs";
import { isCodexDesktopRunning, openThreadInCodexApp } from "./platform.mjs";
import { captureProjectScope } from "./project-scope.mjs";
import { readRolloutFirstRecord } from "./rollout-reader.mjs";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
export const RELAY_WAKE_WAIT_MS = 20000;
export const RELAY_WAKE_COOLDOWN_MS = 60000;
export const RELAY_KEEPER_INTERVAL_MS = 30000;
export const RELAY_KEEPER_WAIT_MS = 60000;
export const RELAY_KEEPER_MAX_BACKOFF_MS = 30 * 60000;
export const DESKTOP_RECHECK_MS = 60000;
const MAX_DAY_DIRECTORIES = 14;
const MAX_CANDIDATES = 40;

export function relayWakeEnabled(env = process.env, platform = process.platform) {
  const value = (env.CODEX_BRIDGE_RELAY_WAKE ?? "").toLowerCase();
  if (["0", "off", "false"].includes(value)) return false;
  return platform === "darwin" || platform === "win32";
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

function sameProject(senderCwd, taskCwd) {
  try { captureProjectScope(senderCwd, taskCwd); return true; }
  catch { return false; }
}

export function relayKeeperEnabled(env = process.env, platform = process.platform) {
  const value = (env.CODEX_BRIDGE_RELAY_KEEPER ?? "").toLowerCase();
  if (["0", "off", "false"].includes(value)) return false;
  if (!relayWakeEnabled(env, platform)) return false;
  if (platform === "win32") return ["1", "on", "true"].includes(value);
  return true;
}

export function relayWakeStateFile(env = process.env) {
  return path.join(codexHome(env), "bridge-relay-wake.json");
}

export async function recentDesktopTaskFor(cwd, { env = process.env, sessions = path.join(codexHome(env), "sessions"), exclude = [], anyProject = false } = {}) {
  if (!anyProject && (typeof cwd !== "string" || !cwd)) return null;
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
    if (anyProject || sameProject(cwd, meta.cwd)) return candidate.threadId;
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

function readWakeState(file) {
  if (!file) return {};
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : {};
  } catch { return {}; }
}

function writeWakeState(file, state) {
  if (!file) return;
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  } catch { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

function acquireWakeLock(file, now, staleMs) {
  if (!file) return () => {};
  const lock = `${file}.lock`;
  const claim = () => {
    const descriptor = fs.openSync(lock, "wx");
    try { fs.writeSync(descriptor, JSON.stringify({ pid: process.pid, at: now() })); } finally { fs.closeSync(descriptor); }
    return () => { try { fs.rmSync(lock, { force: true }); } catch {} };
  };
  try { return claim(); }
  catch (error) { if (error.code !== "EEXIST") return null; }
  let heldSince;
  try { heldSince = JSON.parse(fs.readFileSync(lock, "utf8")).at; } catch { heldSince = 0; }
  if (Number.isFinite(heldSince) && now() - heldSince < staleMs) return null;
  try { fs.rmSync(lock, { force: true }); return claim(); } catch { return null; }
}

export function keeperBackoffMs(failures, { baseMs = RELAY_WAKE_COOLDOWN_MS, maxMs = RELAY_KEEPER_MAX_BACKOFF_MS } = {}) {
  const count = Number.isInteger(failures) && failures > 0 ? Math.min(failures, 16) : 0;
  return count === 0 ? 0 : Math.min(baseMs * 2 ** (count - 1), maxMs);
}

export function createRelayWake({
  env = process.env,
  enabled = relayWakeEnabled(env),
  desktopRunning = () => isCodexDesktopRunning(),
  senderCwd = () => null,
  findTask = (cwd, exclude) => recentDesktopTaskFor(cwd, { env, exclude }),
  findAnyTask = (exclude) => recentDesktopTaskFor(null, { env, exclude, anyProject: true }),
  executorThreadId = () => { try { return resolveRelayThreadId(env).threadId; } catch { return null; } },
  open = (threadId) => openThreadInCodexApp(threadId, { activate: false }),
  answers = endpointAnswers,
  waitMs = RELAY_WAKE_WAIT_MS,
  backgroundWaitMs = RELAY_KEEPER_WAIT_MS,
  cooldownMs = RELAY_WAKE_COOLDOWN_MS,
  desktopRecheckMs = DESKTOP_RECHECK_MS,
  stateFile = null,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  let inFlight = null;
  let failedAt = -Infinity;
  const waitFor = async (socketPath, until) => {
    while (now() < until) {
      if (await answers(socketPath)) return true;
      await sleep(pollMs);
    }
    return false;
  };
  const attempt = async ({ socketPath, threadId, deadline, background = false }) => {
    if (!enabled) return null;
    const state = readWakeState(stateFile);
    if (background) {
      if (state.desktopRunning === false && now() - (state.desktopCheckedAt ?? -Infinity) < desktopRecheckMs) return null;
      if (now() - (state.attemptAt ?? -Infinity) < Math.max(keeperBackoffMs(state.failures), cooldownMs)) return null;
    } else if (now() - failedAt < cooldownMs) return null;
    const running = await desktopRunning();
    if (stateFile) writeWakeState(stateFile, { ...readWakeState(stateFile), desktopCheckedAt: now(), desktopRunning: Boolean(running) });
    if (!running) return null;
    const wait = background ? backgroundWaitMs : waitMs;
    const release = acquireWakeLock(stateFile, now, wait + 15000);
    if (!release) {
      if (background) return null;
      return await waitFor(socketPath, Math.min(now() + wait, deadline ?? Infinity)) ? { threadId: null } : null;
    }
    try {
      const executor = executorThreadId();
      const target = typeof threadId === "string" && THREAD_ID.test(threadId) && threadId !== executor
        ? threadId : (await findTask(senderCwd(), [executor])) ?? (await findAnyTask([executor]));
      const startedAt = now();
      const failures = Number.isInteger(state.failures) ? state.failures : 0;
      if (!target) {
        if (background && stateFile) writeWakeState(stateFile, { ...readWakeState(stateFile), attemptAt: startedAt, failures: failures + 1 });
        return null;
      }
      const fail = (message) => {
        failedAt = now();
        if (stateFile) writeWakeState(stateFile, { ...readWakeState(stateFile), attemptAt: startedAt, failures: failures + 1 });
        log(message);
        return null;
      };
      try { await open(target); }
      catch (error) { return fail(`could not open Codex task ${target} to start the native relay: ${error.message}`); }
      if (await waitFor(socketPath, Math.min(now() + wait, deadline ?? Infinity))) {
        if (stateFile) writeWakeState(stateFile, { ...readWakeState(stateFile), attemptAt: startedAt, failures: 0 });
        log(`started the Codex Desktop native relay by opening task ${target} in the background`);
        return { threadId: target };
      }
      return fail(`opened Codex task ${target}, but the native relay did not start within ${wait} ms`);
    } finally {
      release();
    }
  };
  return (request) => {
    if (!inFlight) return inFlight = attempt(request).finally(() => { inFlight = null; });
    if (request.background || !request.socketPath) return inFlight;
    const until = Math.min(now() + waitMs, request.deadline ?? Infinity);
    return Promise.race([inFlight, waitFor(request.socketPath, until).then((ready) => ready ? { threadId: null } : null)]);
  };
}

export function startRelayKeeper({
  wake,
  socketPath,
  answers = endpointAnswers,
  intervalMs = RELAY_KEEPER_INTERVAL_MS,
  initialDelayMs = 3000,
  timers = globalThis,
  log = () => {},
}) {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return null;
    busy = true;
    try {
      const target = socketPath();
      if (await answers(target)) return null;
      return await wake({ socketPath: target, background: true });
    } catch (error) {
      log(`relay keeper check failed: ${error.message}`);
      return null;
    } finally {
      busy = false;
    }
  };
  const first = timers.setTimeout(tick, initialDelayMs);
  const repeat = timers.setInterval(tick, intervalMs);
  first?.unref?.();
  repeat?.unref?.();
  return {
    tick,
    stop() {
      stopped = true;
      timers.clearTimeout(first);
      timers.clearInterval(repeat);
    },
  };
}
