import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { callBackgroundRelay } from "./background-relay-client.mjs";
import { privateRelayDirectory, readRelayConfiguration, relayPaths, writeRelayJson } from "./background-relay-config.mjs";
import { isMainModule, stableNodeBin } from "./install-paths.mjs";
import { readRegularConfigFile } from "./project-policy.mjs";

export const RELAY_SERVICE_OWNER = "@minhspark/codex-mcp-bridge/background-relay-service/v1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fileURLToPath(import.meta.url);
const sourceHash = () => createHash("sha256").update(fs.readFileSync(SOURCE)).digest("hex");
const SOURCE_HASH = sourceHash();
const MESSAGES = {
  SERVICE_CONFIG_INVALID: "The background relay configuration could not be loaded",
  SERVICE_STORAGE_UNSAFE: "Background relay service storage could not be verified",
  SERVICE_LOCK_OCCUPIED: "Another background relay service owns the service lock",
  SERVICE_PROCESS_IDENTITY_UNAVAILABLE: "The background relay service process identity could not be verified",
  DAEMON_START_FAILED: "The background relay daemon could not be started",
  DAEMON_EXITED: "The background relay daemon exited unexpectedly; active work must be checked before retrying",
  SERVICE_RUNTIME_FAILED: "The background relay service could not continue",
  SERVICE_RUNTIME_INVALID: "The desired background relay runtime could not be verified",
  SERVICE_MIGRATION_PENDING: "The service could not request an idle runtime update; existing jobs were left running",
};

function serviceFailure(code) {
  return Object.assign(new Error(MESSAGES[code]), { code });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function processIdentity(pid) {
  try {
    const options = { windowsHide: true, shell: false, encoding: "utf8", timeout: 30000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] };
    const output = process.platform === "win32"
      ? execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], options)
      : execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { ...options, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const value = output.trim();
    return value && value.length < 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  } catch { return null; }
}

export function relayServiceRuntimeId(runtime) {
  return createHash("sha256").update(JSON.stringify([runtime.packageRoot, runtime.nodeExecutable, runtime.packageVersion ?? null, runtime.environment ?? {}])).digest("hex");
}

export function readRelayServiceRuntime(directory, { root = ROOT, nodeExecutable = stableNodeBin() } = {}) {
  let text;
  try { text = readRegularConfigFile(path.join(directory, "service-runtime.json"), { missing: true, maxBytes: 64 * 1024 }); }
  catch { throw serviceFailure("SERVICE_RUNTIME_INVALID"); }
  if (text === null) return { schemaVersion: 1, owner: RELAY_SERVICE_OWNER, packageRoot: root, nodeExecutable };
  let value;
  try { value = JSON.parse(text); } catch { throw serviceFailure("SERVICE_RUNTIME_INVALID"); }
  if (value?.schemaVersion !== 1 || value.owner !== RELAY_SERVICE_OWNER
      || value.packageVersion !== undefined && (typeof value.packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(value.packageVersion) || value.packageVersion.length > 96)
      || ![value.packageRoot, value.nodeExecutable].every((entry) => typeof entry === "string" && path.isAbsolute(entry) && !/[\u0000-\u001f\u007f]/.test(entry))
      || value.environment !== undefined && (!value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)
        || Object.entries(value.environment).some(([name, entry]) => !["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"].includes(name)
          || typeof entry !== "string" || !entry || /[\u0000-\u001f\u007f]/.test(entry)))
      || ![path.join(value.packageRoot, "src", "background-relay-service.mjs"), path.join(value.packageRoot, "src", "background-relay-daemon.mjs"), value.nodeExecutable].every((entry) => {
        try { return fs.statSync(entry).isFile(); } catch { return false; }
      })) throw serviceFailure("SERVICE_RUNTIME_INVALID");
  return value;
}

export function acquireRelayServiceLock(root, { pid = process.pid, isAlive = alive, identity = processIdentity } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw serviceFailure("SERVICE_PROCESS_IDENTITY_UNAVAILABLE");
  privateRelayDirectory(root);
  const file = path.join(root, "service.lock");
  const nonce = randomUUID();
  const processStart = identity(pid);
  if (typeof processStart !== "string" || !processStart) throw serviceFailure("SERVICE_PROCESS_IDENTITY_UNAVAILABLE");
  const value = JSON.stringify({ schemaVersion: 1, owner: RELAY_SERVICE_OWNER, pid, processStart, nonce });
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, value);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return { acquired: true, release() {
        if (readRegularConfigFile(file, { missing: true, maxBytes: 4096 }) === value) fs.unlinkSync(file);
      } };
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      if (error.code !== "EEXIST") throw serviceFailure("SERVICE_STORAGE_UNSAFE");
      let raw;
      let existing;
      try {
        raw = readRegularConfigFile(file, { maxBytes: 4096 });
        existing = JSON.parse(raw);
      } catch { throw serviceFailure("SERVICE_STORAGE_UNSAFE"); }
      if (existing?.owner !== RELAY_SERVICE_OWNER || existing.schemaVersion !== 1
          || !Number.isSafeInteger(existing.pid) || existing.pid < 1 || typeof existing.nonce !== "string"
          || typeof existing.processStart !== "string" || !existing.processStart) throw serviceFailure("SERVICE_STORAGE_UNSAFE");
      if (isAlive(existing.pid)) {
        const currentIdentity = identity(existing.pid);
        if (!currentIdentity) throw serviceFailure("SERVICE_PROCESS_IDENTITY_UNAVAILABLE");
        if (currentIdentity === existing.processStart) return { acquired: false, release() {} };
      }
      if (readRegularConfigFile(file, { maxBytes: 4096 }) !== raw) throw serviceFailure("SERVICE_STORAGE_UNSAFE");
      try { fs.unlinkSync(file); }
      catch { throw serviceFailure("SERVICE_STORAGE_UNSAFE"); }
    }
  }
  throw serviceFailure("SERVICE_LOCK_OCCUPIED");
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function serviceEnvironment(env, root) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined
    && !/^(?:AGENT_RELAY_|CODEX_BRIDGE_|CLAUDE_BRIDGE_|CODEX_NATIVE_RELAY_|CODEX_APP_TOOLS_PIPE_PATH$|CODEX_APP_SERVER_URL$|CODEX_INTERNAL_ORIGINATOR_OVERRIDE$|CODEX_THREAD_ID$|CODEX_SESSION_ID$|CODEX_RELAY_ID$)/i.test(name))), AGENT_RELAY_DIRECTORY: root };
}

export async function runBackgroundRelayService({ env = process.env, platform = process.platform, root = ROOT,
  spawn = spawnProcess, signal, sleep = wait, now = Date.now, readConfig = readRelayConfiguration,
  writeState = writeRelayJson, acquireLock = acquireRelayServiceLock, changed = () => sourceHash() !== SOURCE_HASH,
  readRuntime = readRelayServiceRuntime, callRelay = callBackgroundRelay, watchIntervalMs = 2000 } = {}) {
  let config;
  try { config = readConfig({ env, platform }); }
  catch { throw serviceFailure("SERVICE_CONFIG_INVALID"); }
  if (!config.enabled) return { status: "disabled" };
  const lock = acquireLock(config.paths.root);
  if (!lock.acquired) return { status: "already-running" };
  const statusFile = path.join(config.paths.root, "service-status.json");
  const errorFile = path.join(config.paths.root, "last-service-error.json");
  let failures = 0;
  const state = (status, extra = {}) => writeState(statusFile, { schemaVersion: 1, owner: RELAY_SERVICE_OWNER,
    pid: process.pid, status, updatedAt: new Date(now()).toISOString(), ...extra });
  const record = (code, extra = {}) => writeState(errorFile, { schemaVersion: 1, owner: RELAY_SERVICE_OWNER,
    code, message: MESSAGES[code], at: new Date(now()).toISOString(), ...extra });
  try {
    while (!signal?.aborted) {
      try { config = readConfig({ env, platform }); }
      catch { record("SERVICE_CONFIG_INVALID"); state("failed"); throw serviceFailure("SERVICE_CONFIG_INVALID"); }
      if (!config.enabled) { state("disabled"); return { status: "disabled" }; }
      const runtime = readRuntime(config.paths.root, { root, nodeExecutable: stableNodeBin(env) });
      if (path.resolve(runtime.packageRoot) !== path.resolve(root)) {
        state("reloading");
        return { status: "reload", moduleFile: path.join(runtime.packageRoot, "src", "background-relay-service.mjs") };
      }
      const childEnv = { ...serviceEnvironment(env, config.paths.root), ...runtime.environment };
      const started = now();
      const runtimeId = relayServiceRuntimeId(runtime);
      state("starting", { consecutiveFailures: failures, runtimeId });
      const outcome = await new Promise((resolve) => {
        let child;
        let settled = false;
        let checking = false;
        let poll;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          signal?.removeEventListener("abort", stop);
          resolve(value);
        };
        const stop = () => { try { child?.kill("SIGTERM"); } catch {} };
        signal?.addEventListener("abort", stop, { once: true });
        try {
          child = spawn(runtime.nodeExecutable, [path.join(root, "src", "background-relay-daemon.mjs")], {
            cwd: root, env: childEnv, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"],
          });
          child.stderr?.on("error", () => {});
          child.stderr?.resume();
          child.on("spawn", () => {
            if (signal?.aborted) return stop();
            try { state("running", { daemonPid: Number.isSafeInteger(child.pid) ? child.pid : null, consecutiveFailures: failures, runtimeId }); }
            catch { finish({ code: null, failure: "SERVICE_STORAGE_UNSAFE" }); stop(); return; }
            poll = setInterval(async () => {
              if (checking || settled || signal?.aborted) return;
              checking = true;
              try {
                const desired = readRuntime(config.paths.root, { root, nodeExecutable: stableNodeBin(env) });
                if (relayServiceRuntimeId(desired) !== runtimeId || changed()) {
                  await callRelay("drain", {}, { env: childEnv, connection: { endpoint: config.endpoint, token: config.token, workerId: null }, timeoutMs: 1000 });
                }
              } catch {
                if (!settled) { try { record("SERVICE_MIGRATION_PENDING"); } catch {} }
              } finally { checking = false; }
            }, watchIntervalMs);
          });
          child.on("error", () => finish({ code: null, failure: "DAEMON_START_FAILED" }));
          child.on("close", (code) => finish({ code: Number.isInteger(code) ? code : null }));
        } catch { finish({ code: null, failure: "DAEMON_START_FAILED" }); }
      });
      if (signal?.aborted) { state("stopped"); return { status: "stopped" }; }
      if (outcome.failure === "SERVICE_STORAGE_UNSAFE") throw serviceFailure("SERVICE_STORAGE_UNSAFE");
      if (outcome.code === 75) {
        failures = 0;
        const desired = readRuntime(config.paths.root, { root, nodeExecutable: stableNodeBin(env) });
        if (changed() || path.resolve(desired.packageRoot) !== path.resolve(root)) {
          state("reloading");
          return { status: "reload", moduleFile: path.join(desired.packageRoot, "src", "background-relay-service.mjs") };
        }
        state("restarting", { reason: "idle-code-reload", restartDelayMs: 250 });
        await sleep(250, signal);
        continue;
      }
      failures = now() - started >= 60000 ? 1 : failures + 1;
      const delay = Math.min(30000, 500 * 2 ** Math.min(failures - 1, 10));
      const code = outcome.failure ?? "DAEMON_EXITED";
      record(code, { daemonExitCode: outcome.code, consecutiveFailures: failures, restartDelayMs: delay });
      state("restarting", { code, consecutiveFailures: failures, restartDelayMs: delay });
      await sleep(delay, signal);
    }
    state("stopped");
    return { status: "stopped" };
  } finally { lock.release(); }
}

if (!new URL(import.meta.url).search && isMainModule(process.argv[1], import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let run = runBackgroundRelayService;
    while (true) {
      const result = await run({ signal: controller.signal });
      if (result.status !== "reload") break;
      run = (await import(`${result.moduleFile ? pathToFileURL(result.moduleFile).href : import.meta.url}?reload=${randomUUID()}`)).runBackgroundRelayService;
    }
  } catch (error) {
    const code = Object.hasOwn(MESSAGES, error.code) ? error.code : "SERVICE_RUNTIME_FAILED";
    try { writeRelayJson(path.join(relayPaths().root, "last-service-error.json"), {
      schemaVersion: 1, owner: RELAY_SERVICE_OWNER, code, message: MESSAGES[code], at: new Date().toISOString(),
    }); } catch {}
    process.stderr.write(`${code}: ${MESSAGES[code]}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
