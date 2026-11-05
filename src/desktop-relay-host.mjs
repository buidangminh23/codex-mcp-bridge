import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { CLIENT_CLOSE_DRAIN_MS } from "./reload-control.mjs";
import { NativeToolsClient, readRelayConfig, relayConfigPath, resolveNativeToolsPipePath } from "./native-relay.mjs";
import { createNativeRelayLifecycle, createRelayServers } from "./native-relay-companion.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_MS = 15000;
const DRAIN_POLL_MS = 50;
const PROCESS_LIST_TIMEOUT_MS = 10000;
const NATIVE_PIPE_PREFIX = "\\\\.\\pipe\\";
const NATIVE_PIPE_NAME = /^codex-(?:app-tools|browser-use)-[a-z0-9-]+$/i;
const LISTENING_APP_SERVER = /\s--listen(?:\s|=)/;
const APP_SERVER_ARGUMENT = /\sapp-server(?:\s|$)/;
const WINDOWS_CODEX = /^"?[^"]*[\\/]codex\.exe"?\s/i;

function hardenedProfileConfigured(env) {
  if (env.CODEX_BRIDGE_HARDENED === "1") return true;
  try {
    const config = fs.readFileSync(path.join(path.dirname(relayConfigPath(env)), "config.toml"), "utf8");
    return /CODEX_BRIDGE_HARDENED\s*=\s*["']1["']/.test(config);
  } catch { return false; }
}

export function relayHostEnabled(env = process.env, platform = process.platform) {
  if (platform !== "win32") return false;
  const config = readRelayConfig(env);
  return config?.desktopTasks === true && typeof config.relayThreadId === "string" && Boolean(config.relayThreadId.trim()) && !hardenedProfileConfigured(env);
}

export function desktopAppServerCandidates(processes) {
  return processes
    .filter(({ pid, args }) => Number.isSafeInteger(pid) && pid > 0 && typeof args === "string"
      && WINDOWS_CODEX.test(args) && APP_SERVER_ARGUMENT.test(args) && !LISTENING_APP_SERVER.test(args))
    .map(({ pid }) => pid);
}

async function listWindowsCodexProcesses() {
  const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "@(Get-CimInstance Win32_Process -Filter \"Name='codex.exe'\" | ForEach-Object { @{ pid = [int]$_.ProcessId; args = $_.CommandLine } }) | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
  const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function discoverDesktopToolsPipe({ env = process.env } = {}) {
  const pipes = fs.readdirSync(NATIVE_PIPE_PREFIX);
  if (!pipes.some((name) => NATIVE_PIPE_NAME.test(name))) return null;
  for (const pid of desktopAppServerCandidates(await listWindowsCodexProcesses())) {
    const pipe = await resolveNativeToolsPipePath({
      env: { ...env, CODEX_APP_TOOLS_PIPE_PATH: undefined }, parentPid: pid, platform: "win32", readParentCommandLine: async () => null,
    });
    if (pipe) return { pipe, pid };
  }
  return null;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function createRuntime({ found, discover, env, log }) {
  const nativeEnv = { ...env, CODEX_APP_TOOLS_PIPE_PATH: undefined };
  const nativeTools = new NativeToolsClient({ env: nativeEnv, resolveSocketPath: async () => (await discover())?.pipe ?? null });
  nativeTools.socketPath = found.pipe;
  const { relays } = createRelayServers({ nativeTools, env, signalExit: false, log });
  return { pid: found.pid, relays, lifecycle: createNativeRelayLifecycle({ nativeTools, relays, log }) };
}

export function startDesktopRelayHost({ env = process.env, enabled = relayHostEnabled(env), discover = () => discoverDesktopToolsPipe({ env }), alive = processAlive,
  pollMs = DEFAULT_POLL_MS, drainMs = CLIENT_CLOSE_DRAIN_MS, log = () => {}, onState = () => {} } = {}) {
  let state = enabled ? "starting" : "disabled";
  let reason = null;
  let runtime = null;
  let stopped = !enabled;
  let timer = null;
  let ticking = Promise.resolve();
  let reportedSockets = 0;
  const ownedSockets = () => runtime?.relays.filter((relay) => relay.started).length ?? 0;
  const status = () => ({ state, reason, pid: runtime?.pid ?? null, ownedSockets: ownedSockets() });
  const setState = (next, detail = null) => {
    if (state === next && reason === detail && reportedSockets === ownedSockets()) return;
    state = next;
    reason = detail;
    reportedSockets = ownedSockets();
    onState(status());
  };
  const reportHosted = () => {
    const next = ownedSockets() ? "listening" : "standby";
    if (next !== state) log(next === "listening" ? `hosting the native relay for Codex Desktop app-server ${runtime.pid}` : `standing by for Codex Desktop app-server ${runtime.pid} while loaded conversations own the relay sockets`);
    setState(next);
  };
  const retire = async () => {
    const current = runtime;
    runtime = null;
    if (!current) return;
    current.lifecycle.refuseNewDeliveries();
    const deadline = Date.now() + drainMs;
    while (current.lifecycle.deliveryReason() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    await current.lifecycle.stop();
  };
  const tick = async () => {
    try {
      if (runtime) {
        if (alive(runtime.pid)) { reportHosted(); return; }
        log("Codex Desktop stopped; closing the hosted relay until it returns");
        await retire();
      }
      const found = await discover();
      if (stopped) return;
      if (!found) { setState("waiting-for-desktop"); return; }
      runtime = createRuntime({ found, discover, env, log });
      await runtime.lifecycle.activate();
      reportHosted();
    } catch (error) {
      log(`native relay host could not start: ${error.message}`);
      await retire().catch((stopError) => log(`native relay host cleanup failed: ${stopError.message}`));
      setState("waiting-for-desktop", error.message);
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      ticking = tick().finally(schedule);
    }, pollMs);
    timer.unref?.();
  };
  if (enabled) ticking = tick().finally(schedule);
  return {
    status,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      await ticking;
      await retire();
      setState("stopped");
    },
  };
}
