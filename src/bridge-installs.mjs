import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { accountIdentity, readBridgeAccounts } from "./bridge-account-context.mjs";
import { installedBridgeVersion, newerVersion } from "./current-install.mjs";
import { NativeDesktopRelay } from "./native-relay.mjs";
import { readRegularConfigFile } from "./project-policy.mjs";

const SEGMENTS = ["@minhspark", "codex-mcp-bridge"];
const CONFIG_REFERENCE = /(?:[A-Za-z]:|\/)[^"'\r\n]*?[\\/]+node_modules[\\/]+@minhspark[\\/]+codex-mcp-bridge/g;
const WORKER = /[\\/]bridge-runtimes[\\/]([0-9a-f]{64})[\\/]src[\\/]([\w.-]+\.mjs)/;
const DAEMON = /[\\/]node_modules[\\/]@minhspark[\\/]codex-mcp-bridge[\\/]src[\\/](background-relay-daemon\.mjs)/;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const NOT_LISTENING = new Set(["RELAY_UNREACHABLE"]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function installPrefix(root, platform = process.platform) {
  const modules = path.dirname(path.dirname(root));
  return platform === "win32" ? path.dirname(modules) : path.dirname(path.dirname(modules));
}

function pathCandidates(env, platform) {
  const entries = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry));
  const prefixes = platform === "win32"
    ? [...entries, path.join(env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming"), "npm")]
    : [...entries.map((entry) => path.dirname(entry)), path.join(env.HOME || os.homedir(), ".local")];
  return prefixes.map((prefix) => path.join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules", ...SEGMENTS));
}

function configCandidates(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const files = [path.join(env.CLAUDE_CONFIG_DIR || home, ".claude.json"), path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
    path.join(home, ".gemini", "config", "mcp_config.json"), env.CLAUDE_DESKTOP_CONFIG].filter(Boolean);
  return files.flatMap((file) => {
    let text;
    try { text = readRegularConfigFile(file, { missing: true, maxBytes: MAX_CONFIG_BYTES }); }
    catch { return []; }
    return text === null ? [] : [...text.matchAll(CONFIG_REFERENCE)].map((match) => match[0].replace(/\\\\/g, "\\"));
  });
}

export function discoverBridgeInstalls({ env = process.env, platform = process.platform, exclude = [] } = {}) {
  const identity = (value) => platform === "win32" ? value.toLowerCase() : value;
  const seen = new Set(exclude.map((root) => { try { return identity(fs.realpathSync.native(root)); } catch { return identity(root); } }));
  const found = [];
  for (const candidate of [...pathCandidates(env, platform), ...configCandidates(env)]) {
    let root;
    try { root = fs.realpathSync.native(candidate); } catch { continue; }
    if (seen.has(identity(root)) || !installedBridgeVersion(root)) continue;
    seen.add(identity(root));
    found.push(root);
  }
  return found;
}

function executeList(command, args, options) {
  return new Promise((resolve) => execFile(command, args, options, (error, stdout) => resolve({ status: error ? 1 : 0, stdout: String(stdout ?? "") })));
}

export async function listProcessCommands({ env = process.env, platform = process.platform, run = executeList } = {}) {
  const options = { env, encoding: "utf8", windowsHide: true, shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024 };
  if (platform !== "win32") {
    const result = await run("/bin/ps", ["-axww", "-o", "command="], options);
    return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : null;
  }
  const powershell = path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }) | ConvertTo-Json -Compress";
  const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], options);
  if (result.status !== 0) return null;
  try {
    const value = JSON.parse(result.stdout.trim() || "[]");
    return (Array.isArray(value) ? value : [value]).filter((line) => typeof line === "string");
  } catch {
    return null;
  }
}

function pathBefore(command, index) {
  const head = command.slice(0, index);
  const quotes = head.match(/"/g)?.length ?? 0;
  return quotes % 2 === 1 ? head.slice(head.lastIndexOf('"') + 1) : head.slice(head.lastIndexOf(" ") + 1);
}

function runtimeVersion(directory) {
  try {
    const version = JSON.parse(readRegularConfigFile(path.join(directory, "package.json"), { maxBytes: 128 * 1024 })).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export function classifyBridgeRuntimes(commands) {
  return commands.flatMap((command) => {
    const worker = WORKER.exec(command);
    if (worker) return [{ entry: worker[2], version: runtimeVersion(path.join(pathBefore(command, worker.index), "bridge-runtimes", worker[1])) }];
    const daemon = DAEMON.exec(command);
    if (daemon) return [{ entry: daemon[1], version: runtimeVersion(path.join(pathBefore(command, daemon.index), "node_modules", ...SEGMENTS)) }];
    return [];
  });
}

export async function awaitBridgeRuntimes({ version, list = listProcessCommands, now = Date.now, sleep = pause, waitMs = 60000, pollMs = 2000 } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    const commands = await list();
    if (!commands) return { inspected: false, current: 0, pending: [] };
    const runtimes = classifyBridgeRuntimes(commands);
    const pending = runtimes.filter((runtime) => !runtime.version || newerVersion(version, runtime.version));
    if (!pending.length || now() >= deadline) return { inspected: true, current: runtimes.length - pending.length, pending };
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}

export async function probeNativeRelay({ env = process.env, platform = process.platform, readAccounts = readBridgeAccounts,
  relay = new NativeDesktopRelay({ env }), now = Date.now, sleep = pause, waitMs = 30000, timeoutMs = 8000, pollMs = 2000 } = {}) {
  if (platform !== "win32" && platform !== "darwin") return { state: "not_applicable" };
  const deadline = now() + waitMs;
  for (;;) {
    const identity = accountIdentity(readAccounts());
    let failure;
    try {
      if (identity) {
        await relay.requestDesktop("list_projects", {}, { accountContext: identity, timeoutMs });
        return { state: "ready" };
      }
      failure = { state: "account_unverified", code: "BRIDGE_ACCOUNT_UNVERIFIED" };
    } catch (error) {
      failure = { state: NOT_LISTENING.has(error.code) ? "not_listening" : "failed", code: typeof error.code === "string" ? error.code : "NATIVE_DISPATCH_FAILED" };
    }
    if (now() >= deadline) return failure;
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
}
