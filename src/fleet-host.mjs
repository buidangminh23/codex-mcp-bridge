import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callBackgroundRelay } from "./background-relay-client.mjs";
import { BACKGROUND_AGENTS, readRelayConfiguration, relayFailure, RELAY_UUID } from "./background-relay-config.mjs";
import { RELAY_FRAME_LIMIT, RELAY_REPLY_LIMIT } from "./background-relay-protocol.mjs";
import { createProjectScope } from "./project-policy.mjs";
import { repositoryIdentity } from "./remote-codex.mjs";
import { listFleetSessions } from "./fleet-sessions.mjs";

const commands = new Map([
  ["win32", "worker-relay.cmd fleet-host"],
  ["darwin", `/bin/zsh -lc 'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"; exec worker-relay fleet-host'`],
  ["linux", `/bin/sh -lc 'export PATH="$PATH:/usr/local/bin:$HOME/.local/bin"; exec worker-relay fleet-host'`],
]);
const runFile = promisify(execFile);
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const macWindowList = `ObjC.import("CoreGraphics");
const list = $.CGWindowListCopyWindowInfo(17, 0);
const rows = ObjC.deepUnwrap(ObjC.castRefToObject(list)) || [];
JSON.stringify(rows.filter(row => row.kCGWindowLayer === 0 && row.kCGWindowOwnerName)
  .map(row => ({app: String(row.kCGWindowOwnerName), title: String(row.kCGWindowName || "")})))`;
const windowsWindowList = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
public static class FleetWindowList {
    private delegate bool Callback(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder title, int limit);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int cloaked, int size);
    public class Window { public string app; public string title; }
    public static List<Window> Read() {
        var rows = new List<Window>();
        EnumWindows(delegate(IntPtr handle, IntPtr unused) {
            int cloaked;
            if (!IsWindowVisible(handle) || (DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0)) return true;
            var title = new StringBuilder(512);
            if (GetWindowText(handle, title, title.Capacity) == 0) return true;
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            string app = "Process " + processId;
            try { using (var process = Process.GetProcessById((int)processId)) app = process.ProcessName; }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { }
            rows.Add(new Window { app = app, title = title.ToString() });
            return rows.Count < 256;
        }, IntPtr.Zero);
        return rows;
    }
}
'@
ConvertTo-Json -InputObject @([FleetWindowList]::Read()) -Compress
`;

const windowsProcessList = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$pattern = '(?i)^(node|codex|claude|antigravity|language_server|python|python3|git|ssh|npm|pnpm|yarn|npx|bun|deno|vitest|jest|mocha|tsc|eslint|esbuild|vite|next|turbo|webpack|rollup|cargo|rustc|go|pytest|mypy|ruff|gradle|mvn|dotnet|msbuild|docker|kubectl|gh|playwright|cloudflared|ngrok|ollama|pwsh|powershell|bash|zsh|sh)$'
$now = [DateTime]::UtcNow
$selfPid = $PID
$rows = foreach ($p in (Get-CimInstance Win32_Process)) {
  if ($p.ProcessId -eq $selfPid) { continue }
  $name = [string]($p.Name -replace '\\.exe$','')
  if ($name -notmatch $pattern) { continue }
  $cmd = [string]$p.CommandLine
  if ($cmd.Length -gt 512) { $cmd = $cmd.Substring(0, 512) }
  $cpu = [Math]::Round(([double]$p.KernelModeTime + [double]$p.UserModeTime) / 10000000.0, 1)
  $up = $null
  if ($null -ne $p.CreationDate) {
    $up = [Math]::Max(0, [int][Math]::Floor(($now - $p.CreationDate.ToUniversalTime()).TotalSeconds))
  }
  [PSCustomObject]@{
    pid = [int]$p.ProcessId
    name = $name
    memoryBytes = [int64]$p.WorkingSetSize
    cpuSeconds = $cpu
    uptimeSeconds = $up
    threads = [int]$p.ThreadCount
    cmd = $cmd
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`;
const trackedExecutablePattern = /^(?:node|codex|claude|antigravity|language_server|python|python3|git|ssh|npm|pnpm|yarn|npx|bun|deno|vitest|jest|mocha|tsc|eslint|esbuild|vite|next|turbo|webpack|rollup|cargo|rustc|go|pytest|mypy|ruff|gradle|mvn|dotnet|msbuild|docker|kubectl|gh|playwright|cloudflared|ngrok|ollama|pwsh|powershell|bash|zsh|sh)$/i;
const electronHelperPattern = /--type=(?:renderer|gpu-process|utility|zygote|crashpad|broker|ppapi)|--crash-reporter/i;
const scriptExtension = /\.(?:[mc]?[jt]sx?|py|ps1|sh|bash|zsh)$/i;
const commonScriptName = /(?:^|\/)((?:(?:src|scripts|server|test|tests|bin|app|cmd|tools)\/)?(?:index|main|server|hub|proxy|gateway|daemon|build|test|start|dev)\.(?:[mc]?[jt]sx?|py|ps1|sh|bash|zsh))$/i;
const knownOperations = new Set(["apply", "build", "check", "ci", "clippy", "compile", "compose", "dashboard", "deploy", "dev", "e2e", "exec", "fmt", "format", "get", "install", "lint", "logs", "preview", "ps", "publish", "run", "serve", "start", "test", "typecheck", "verify", "watch", "workflow"]);
const safeGitSubcommands = new Set(["fetch", "pull", "push", "clone", "status", "diff", "rebase", "merge", "gc", "commit", "checkout", "switch", "log", "worktree", "submodule"]);
const ciRunnersPattern = /^(?:vitest|jest|mocha|pytest|mypy|ruff|tsc|eslint|esbuild|turbo|webpack|rollup|gradle|mvn|msbuild|gh|playwright)$/i;
const ciSubcommandPattern = /\b(?:--test|test|build|lint|typecheck|check|ci|verify|compile|clippy|fmt|format|e2e)\b/i;
const serverPattern = /\b(?:dashboard|dev|serve|start|watch|nodemon|uvicorn|gunicorn|flask|preview|tunnel)\b|(?:^|[\\/])(?:server|hub|proxy|gateway|daemon)\.[mc]?[jt]s$/i;

function cleanText(value, limit) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim().slice(0, limit);
}

function splitCommandTokens(raw) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(String(raw || ""))) && tokens.length < 24) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function scriptLabel(token) {
  return commonScriptName.exec(token.replaceAll("\\", "/"))?.[1].toLowerCase() || "script";
}

function mcpLabel(cmd) {
  const normalized = cmd.replaceAll("\\", "/");
  const known = /\b(next-devtools-mcp|context7-mcp|server-(?:memory|filesystem|fetch|sequential-thinking|everything|time))\b/i.exec(normalized);
  if (known) return "MCP: " + known[1].toLowerCase();
  return /@[\w.-]+\/[\w.-]*mcp|\bmcp-server-|\b[\w-]+-mcp\b|\/sidecars\/[\w-]+\//i.test(normalized) ? "MCP Server" : null;
}

export function describeCodeProcess(rawName, rawCmd = "") {
  const name = cleanText(String(rawName || "").replace(/\.exe$/i, ""), 128);
  if (!name || !trackedExecutablePattern.test(name)) return null;
  const cmd = String(rawCmd || "");
  const lower = name.toLowerCase();
  if (electronHelperPattern.test(cmd)) return null;
  if (/[\\/]Elgato[\\/]StreamDeck[\\/]/i.test(cmd)) return null;
  if (lower === "antigravity") {
    const mcp = mcpLabel(cmd);
    if (mcp) return { category: "mcp", agent: "antigravity", label: mcp };
    return null;
  }
  if (lower === "claude" && (!cmd.trim() || /[\\/]AnthropicClaude[\\/]app-/i.test(cmd) && !/\s(?:-p|--print|--output-format|mcp|serve|exec)\b/i.test(cmd))) {
    return null;
  }
  if ((lower === "pwsh" || lower === "powershell" || lower === "bash" || lower === "zsh" || lower === "sh")) {
    const fileMatch = /(?:^|\s)(?:-File|-f)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(cmd)
      || (lower !== "pwsh" && lower !== "powershell" ? /\s([^\s-]+\.(?:sh|bash|zsh))(?:\s|$)/i.exec(cmd) : null);
    if (!fileMatch) return null;
    const script = fileMatch[1] || fileMatch[2] || fileMatch[3];
    return { category: ciSubcommandPattern.test(script) ? "ci" : "script", agent: null, label: lower + " " + scriptLabel(script) };
  }

  if (/background-relay-daemon\.m?js/i.test(cmd)) return { category: "agent", agent: null, label: "Worker Relay Daemon" };
  if (/background-relay-service\.m?js/i.test(cmd)) return { category: "agent", agent: null, label: "Worker Relay Service" };
  if (/background-relay-mcp\.m?js/i.test(cmd)) return { category: "mcp", agent: null, label: "Worker Relay MCP" };
  if (/worker-relay\.m?js\s+dashboard\b/i.test(cmd)) return { category: "server", agent: null, label: "Fleet Dashboard (worker-relay)" };
  if (/antigravity-sidecar\.m?js/i.test(cmd)) return { category: "agent", agent: "antigravity", label: "Antigravity Sidecar" };
  if (/mcp-supervisor\.m?js/i.test(cmd)) return { category: "mcp", agent: null, label: "MCP Bridge Supervisor" };
  if (/claude-control-hook\.m?js/i.test(cmd)) return { category: "agent", agent: "claude", label: "Claude Control Hook" };
  if (/codex-bridge|claude-bridge/i.test(cmd)) {
    const isClaude = /claude-bridge/i.test(cmd);
    return { category: "agent", agent: isClaude ? "claude" : "codex", label: isClaude ? "Claude Bridge" : "Codex Bridge" };
  }

  if (lower === "language_server") return { category: "agent", agent: "antigravity", label: "Antigravity Language Server" };
  if (lower === "codex") {
    if (/\bapp-server\b/i.test(cmd)) return { category: "agent", agent: "codex", label: "Codex App Server" };
    if (/\bexec\b/i.test(cmd)) return { category: "agent", agent: "codex", label: "Codex CLI (chạy ngầm)" };
    if (/\bmcp\b/i.test(cmd)) return { category: "mcp", agent: "codex", label: "Codex MCP" };
    return { category: "agent", agent: "codex", label: "Codex Agent CLI" };
  }
  if (lower === "claude") {
    if (/(?:^|\s)(?:-p|--print|--output-format)\b/i.test(cmd)) return { category: "agent", agent: "claude", label: "Claude CLI (chạy ngầm)" };
    if (/\bmcp\b/i.test(cmd)) return { category: "mcp", agent: "claude", label: "Claude MCP" };
    return { category: "agent", agent: "claude", label: "Claude Code CLI" };
  }
  if (lower === "ollama") return { category: "agent", agent: null, label: "Ollama Local Model" };

  const mcp = mcpLabel(cmd);
  if (mcp) return { category: "mcp", agent: null, label: mcp };

  const tokens = splitCommandTokens(cmd).slice(1);
  const operations = tokens.map(t => t.toLowerCase()).filter(t => knownOperations.has(t));
  if (lower === "git") {
    const sub = tokens.find(t => safeGitSubcommands.has(t.toLowerCase()));
    return { category: "script", agent: null, label: sub ? "git " + sub.toLowerCase() : "git" };
  }
  if (lower === "ssh" || lower === "cloudflared" || lower === "ngrok") {
    return { category: "server", agent: null, label: lower === "ssh" ? "SSH Tunnel / Relay" : lower + " tunnel" };
  }
  if (lower === "docker" || lower === "kubectl") {
    const sub = operations[0];
    const isCi = sub && /^(?:build|test|compose)$/i.test(sub);
    return { category: isCi ? "ci" : "server", agent: null, label: sub ? lower + " " + sub : lower };
  }

  if (ciRunnersPattern.test(lower)) {
    const sub = operations[0];
    return { category: "ci", agent: null, label: sub ? lower + " " + sub : lower };
  }
  if (lower === "npm" || lower === "pnpm" || lower === "yarn" || lower === "npx" || lower === "bun" || lower === "cargo" || lower === "go" || lower === "dotnet") {
    const joined = operations.slice(0, 2).join(" ");
    const isServer = serverPattern.test(joined);
    const isCi = !isServer && (ciSubcommandPattern.test(joined) || lower === "cargo" || lower === "go" || lower === "dotnet");
    return { category: isServer ? "server" : isCi ? "ci" : "script", agent: null, label: joined ? lower + " " + joined : lower };
  }

  if (lower === "node" || lower === "deno" || lower === "python" || lower === "python3") {
    if (/(?:^|\s)--test\b/i.test(cmd)) return { category: "ci", agent: null, label: "Node Test Runner" };
    if (/(?:^|\s)-m\s+(pytest|unittest|mypy|ruff)\b/i.test(cmd)) {
      const m = /-m\s+(pytest|unittest|mypy|ruff)\b/i.exec(cmd);
      return { category: "ci", agent: null, label: "python -m " + m[1].toLowerCase() };
    }
    if (/(?:^|\s)-m\s+(uvicorn|http\.server|flask)\b/i.test(cmd)) {
      const m = /-m\s+(uvicorn|http\.server|flask)\b/i.exec(cmd);
      return { category: "server", agent: null, label: "python -m " + m[1].toLowerCase() };
    }
    const scriptToken = tokens.find(t => !t.startsWith("-") && scriptExtension.test(t));
    if (!scriptToken && !tokens.length) return null;
    const subToken = tokens.find(t => /^(?:dev|start|serve|watch|dashboard|build|test|lint|check)$/i.test(t));
    const isServer = serverPattern.test(scriptToken) || (subToken && /^(?:dev|start|serve|watch|dashboard)$/i.test(subToken));
    const isCi = !isServer && (ciSubcommandPattern.test(scriptToken) || (subToken && /^(?:build|test|lint|check)$/i.test(subToken)));
    return {
      category: isServer ? "server" : isCi ? "ci" : "script",
      agent: null,
      label: lower + " " + scriptLabel(scriptToken || "") + (subToken ? " " + subToken.toLowerCase() : ""),
    };
  }

  if (lower === "vite" || lower === "next") {
    const isBuild = /\bbuild\b/i.test(cmd);
    return { category: isBuild ? "ci" : "server", agent: null, label: isBuild ? lower + " build" : lower + " dev" };
  }
  return { category: "script", agent: null, label: name };
}

function parsePosixState(raw) {
  const code = String(raw || "").charAt(0).toUpperCase();
  if (code === "R") return "running";
  if (code === "T" || code === "Z") return "stopped";
  if (code === "U" || code === "D") return "unresponsive";
  return "sleeping";
}

function parsePosixEtime(raw) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(raw || "").trim());
  if (!match) return null;
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const mins = Number(match[3] || 0);
  const secs = Number(match[4] || 0);
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

export async function listFleetProcesses({ platform = process.platform, env = process.env, run = runFile } = {}) {
  const options = { timeout: 6500, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8", env };
  let rows = [];
  let note;
  try {
    if (platform === "win32") {
      const ps = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = Buffer.from(windowsProcessList, "utf16le").toString("base64");
      const { stdout } = await run(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script], options);
      const parsed = JSON.parse(stdout || "[]");
      const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      rows = list.flatMap(row => {
        if (!Number.isSafeInteger(row?.pid) || row.pid <= 0 || typeof row.name !== "string") return [];
        const info = describeCodeProcess(row.name, row.cmd);
        if (!info) return [];
        const memoryBytes = Number.isSafeInteger(row.memoryBytes) && row.memoryBytes >= 0 ? row.memoryBytes : 0;
        const cpuSeconds = typeof row.cpuSeconds === "number" && Number.isFinite(row.cpuSeconds) && row.cpuSeconds >= 0 ? Math.round(row.cpuSeconds * 10) / 10 : null;
        const uptimeSeconds = Number.isSafeInteger(row.uptimeSeconds) && row.uptimeSeconds >= 0 ? row.uptimeSeconds : null;
        const threads = Number.isSafeInteger(row.threads) && row.threads >= 0 ? row.threads : null;
        return [{ pid: row.pid, name: cleanText(row.name, 128), label: cleanText(info.label, 128),
          agent: info.agent, category: info.category, memoryBytes, cpuPercent: null, cpuSeconds,
          uptimeSeconds, threads, state: "running", background: true }];
      });
    } else if (platform === "darwin" || platform === "linux") {
      const bin = platform === "darwin" ? "/bin/ps" : "ps";
      const nameField = platform === "darwin" ? "ucomm=" : "comm=";
      const { stdout } = await run(bin, ["-axww", "-o", "pid=", "-o", "pcpu=", "-o", "rss=", "-o", "etime=", "-o", "state=", "-o", nameField, "-o", "args="], { ...options, env: { ...env, LC_ALL: "C" } });
      rows = stdout.split(/\r?\n/).flatMap(line => {
        const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
        if (!match) return [];
        const pid = Number(match[1]);
        const cpuPercent = Math.round(Number(match[2]) * 10) / 10;
        const memoryBytes = Number(match[3]) * 1024;
        const uptimeSeconds = parsePosixEtime(match[4]);
        const rawState = match[5];
        const name = match[6];
        const rawArgs = match[7];
        if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(memoryBytes) || memoryBytes < 0) return [];
        const info = describeCodeProcess(name, rawArgs);
        if (!info) return [];
        return [{ pid, name, label: cleanText(info.label, 128), agent: info.agent, category: info.category,
          memoryBytes, cpuPercent: Number.isFinite(cpuPercent) && cpuPercent >= 0 ? cpuPercent : null,
          cpuSeconds: null, uptimeSeconds, threads: null, state: parsePosixState(rawState), background: true }];
      });
    } else return { processes: [], totalProcesses: 0, note: "Hệ điều hành này chưa hỗ trợ đọc tiến trình code chạy ẩn." };
  } catch {
    return { processes: [], totalProcesses: 0, note: "Không đọc được danh sách tiến trình Agent và phiên code chạy ẩn trên máy này." };
  }
  const rank = { agent: 0, ci: 1, server: 2, script: 3, mcp: 4 };
  rows.sort((a, b) => (rank[a.category] ?? 9) - (rank[b.category] ?? 9) || b.memoryBytes - a.memoryBytes);
  return { processes: rows.slice(0, 120), totalProcesses: rows.length, ...(note ? { note } : {}) };
}

function summarizeRelayTask(task) {
  const rawOutput = typeof task?.output === "string" ? task.output : "";
  const preview = cleanText(rawOutput, 600);
  return {
    requestId: task.requestId,
    agent: task.agent,
    status: task.status,
    deliveryState: typeof task.deliveryState === "string" ? task.deliveryState : "unknown",
    sourceKind: typeof task.source?.kind === "string" ? task.source.kind : "local-client",
    sourceAgent: BACKGROUND_AGENTS.includes(task.source?.agent) ? task.source.agent : null,
    parentRequestId: RELAY_UUID.test(task.parentRequestId ?? "") ? task.parentRequestId : null,
    createdAt: typeof task.createdAt === "string" ? task.createdAt : null,
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : null,
    outputPreview: preview,
    outputTruncated: task.outputTruncated === true || rawOutput.length > preview.length,
    diagnosticCode: typeof task.diagnostic?.code === "string" ? cleanText(task.diagnostic.code, 80) : null,
    diagnosticReason: typeof task.diagnostic?.reason === "string" ? cleanText(task.diagnostic.reason, 300) : null,
  };
}

export async function listFleetActivity({ relay = callBackgroundRelay, processes = listFleetProcesses } = {}) {
  const [statusResult, listResult, procResult] = await Promise.all([
    Promise.resolve().then(() => relay("status", { summary: true })).then(value => ({ value }), error => ({ error })),
    Promise.resolve().then(() => relay("list", { summary: true })).then(value => ({ value }), error => ({ error })),
    Promise.resolve().then(() => processes()).then(value => ({ value }), error => ({ error })),
  ]);
  const notes = [];
  let relayView = null;
  if (statusResult.value) {
    const s = statusResult.value;
    relayView = {
      online: true,
      pid: Number.isSafeInteger(s.pid) && s.pid > 0 ? s.pid : null,
      version: typeof s.version === "string" ? cleanText(s.version, 48) : null,
      startedAt: typeof s.startedAt === "string" ? s.startedAt : null,
      accepting: s.accepting !== false,
      active: Number.isSafeInteger(s.active) && s.active >= 0 ? s.active : 0,
      queued: Number.isSafeInteger(s.queued) && s.queued >= 0 ? s.queued : 0,
      workers: Array.isArray(s.workers) ? s.workers.filter(w => BACKGROUND_AGENTS.includes(w?.agent)).map(w => ({
        agent: w.agent,
        ready: w.ready === true,
        canAcceptWork: w.canAcceptWork === true,
        readiness: typeof w.readiness === "string" ? cleanText(w.readiness, 40) : (w.ready ? "ready" : "blocked"),
        authenticated: typeof w.authenticated === "boolean" ? w.authenticated : null,
        version: typeof w.version === "string" ? cleanText(w.version, 48) : null,
        code: typeof w.code === "string" ? cleanText(w.code, 64) : null,
      })) : [],
    };
  } else {
    relayView = { online: false, pid: null, version: null, startedAt: null, accepting: false, active: 0, queued: 0, workers: [] };
    notes.push("Dịch vụ worker-relay chạy ngầm hiện chưa sẵn sàng.");
  }
  if (!Array.isArray(listResult.value?.tasks)) notes.push("Không đọc được danh sách tác vụ của worker-relay trên máy này.");
  const tasks = Array.isArray(listResult.value?.tasks)
    ? listResult.value.tasks
      .filter(task => RELAY_UUID.test(task?.requestId ?? "") && BACKGROUND_AGENTS.includes(task.agent)
        && ["queued", "running", "completed", "failed", "unknown"].includes(task.status))
      .slice(0, 50)
      .map(summarizeRelayTask)
    : [];
  const rawProcs = Array.isArray(procResult.value?.processes) ? procResult.value.processes : [];
  if (procResult.value?.note) notes.push(procResult.value.note);
  else if (procResult.error) notes.push("Không đọc được danh sách phiên code chạy ẩn trên máy này.");
  const relayPid = relayView.pid;
  const enriched = rawProcs.slice(0, 120).map(item => item.pid === relayPid
    ? { ...item, category: "agent", label: item.label || "Worker Relay Daemon", role: "worker-relay" }
    : item.pid === process.pid
      ? { ...item, category: "server", label: item.label || "Fleet Dashboard (worker-relay)", role: "fleet-dashboard" }
      : { ...item, label: item.label || item.name, role: item.role ?? null });
  const totalProcesses = Number.isSafeInteger(procResult.value?.totalProcesses) && procResult.value.totalProcesses >= enriched.length
    ? procResult.value.totalProcesses : enriched.length;
  return {
    supported: true,
    checkedAt: new Date().toISOString(),
    system: {
      cpuCount: os.cpus().length,
      uptimeSeconds: Math.floor(os.uptime()),
      loadAvg: os.loadavg().map(value => Math.round(value * 100) / 100),
    },
    relay: relayView,
    tasks,
    processes: enriched,
    totalProcesses,
    ...(notes.length ? { note: cleanText(notes.join(" "), 512) } : {}),
  };
}

export async function listFleetWindows({ platform = process.platform, env = process.env, run = runFile } = {}) {
  const options = { timeout: 6500, windowsHide: true, maxBuffer: 512 * 1024, encoding: "utf8", env };
  let rows;
  let note;
  try {
    if (platform === "win32") {
      const ps = path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = Buffer.from(windowsWindowList, "utf16le").toString("base64");
      const { stdout } = await run(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script], options);
      rows = JSON.parse(stdout);
      if (!rows.length) note = "Windows chỉ hiển thị cửa sổ trong phiên đăng nhập tương tác đang truy vấn.";
    } else if (platform === "darwin") {
      const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", macWindowList], options);
      rows = JSON.parse(stdout);
      if (!rows.length) note = "Màn hình macOS hiện tại chưa có cửa sổ ứng dụng hiển thị. Kiểm tra phiên đăng nhập và trạng thái khóa màn hình.";
      else if (rows.some(row => !row.title)) note = "macOS có thể ẩn tiêu đề cửa sổ khi tiến trình chưa có quyền Ghi màn hình.";
    } else if (platform === "linux") {
      if (!env.DISPLAY) return { windows: [], note: "Cần phiên X11 có DISPLAY để đọc cửa sổ. Wayland giới hạn danh sách cửa sổ theo ứng dụng." };
      const { stdout } = await run("wmctrl", ["-l", "-x"], options);
      rows = stdout.split(/\r?\n/).flatMap(line => {
        const match = /^0x[0-9a-f]+\s+-?\d+\s+(\S+)\s+\S+\s*(.*)$/i.exec(line);
        return match ? [{ app: match[1], title: match[2] }] : [];
      });
      if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") note = "Phiên Wayland chỉ cung cấp danh sách cửa sổ XWayland.";
    } else return { windows: [], note: "Hệ điều hành này chưa hỗ trợ đọc cửa sổ." };
  } catch {
    const notes = { win32: "Cần phiên Windows tương tác có quyền đọc danh sách cửa sổ.", darwin: "Kiểm tra phiên đăng nhập và quyền Ghi màn hình trên macOS.",
      linux: "Kiểm tra wmctrl và quyền truy cập DISPLAY của phiên X11." };
    return { windows: [], note: notes[platform] };
  }
  return { windows: rows.slice(0, 256).map(row => ({ app: String(row.app).slice(0, 256), title: String(row.title).slice(0, 512) })),
    ...(note ? { note } : {}) };
}

async function checkoutState(cwd) {
  const options = { cwd, windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024, encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))) };
  try {
    const [head, status] = await Promise.all([
      runFile("git", ["--no-optional-locks", "rev-parse", "--verify", "HEAD"], options),
      runFile("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"], options),
    ]);
    const revision = head.stdout.trim();
    return revisionPattern.test(revision) ? { revision, clean: status.stdout === "" } : { revision: null, clean: null };
  } catch { return { revision: null, clean: null }; }
}

function assertLocalOperator(env) {
  if (env.AGENT_RELAY_WORKER_ID || env.AGENT_RELAY_TOKEN || env.AGENT_RELAY_ENDPOINT) {
    throw relayFailure("FLEET_OPERATOR_REQUIRED", "A scoped background worker cannot act as a fleet operator");
  }
}

export function authorizedProject(cwd) {
  const config = readRelayConfiguration({ missing: true });
  if (!config?.enabled) throw relayFailure("WORKER_RELAY_DISABLED", "Enable and configure the background relay for this user");
  try {
    return createProjectScope(config.projectPolicy).assert(cwd);
  } catch {
    throw relayFailure("WORKER_PROJECT_NOT_AUTHORIZED", "The configured project needs a grant in the worker relay project policy");
  }
}

function projectIdentity(cwd) {
  try { return repositoryIdentity(cwd); }
  catch { throw relayFailure("FLEET_REPOSITORY_REQUIRED", "A remote project mapping requires a Git repository with a supported network origin"); }
}

function validateRequest(input, remote) {
  if (input?.version !== 1 || !RELAY_UUID.test(input.nonce ?? "") || !["probe", "send", "read", "windows", "sessions", "activity"].includes(input.action)
    || typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || input.cwd.length > 4096 || /[\0\r\n]/.test(input.cwd)
    || remote && (typeof input.repository !== "string" || !input.repository || input.repository.length > 4096)
    || ["send", "read"].includes(input.action) && (!RELAY_UUID.test(input.requestId ?? "") || !BACKGROUND_AGENTS.includes(input.agent))
    || input.expectedRevision != null && !revisionPattern.test(input.expectedRevision)
    || input.action === "send" && (typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 256 * 1024)) {
    throw relayFailure("FLEET_REQUEST_INVALID", "Invalid fleet host request");
  }
}

export async function handleFleetHostRequest(input, { remote = true, relay = callBackgroundRelay, authorize = authorizedProject,
  identity = projectIdentity, checkout = checkoutState, windows = listFleetWindows, sessions = listFleetSessions,
  processes = listFleetProcesses, activity = listFleetActivity, env = process.env } = {}) {
  assertLocalOperator(env);
  validateRequest(input, remote);
  const check = () => {
    const cwd = authorize(input.cwd);
    if (remote && identity(cwd) !== input.repository) {
      throw relayFailure("FLEET_REPOSITORY_MISMATCH", "The configured checkouts have different Git origins");
    }
    return cwd;
  };
  if (input.action === "windows") {
    if (remote && identity(input.cwd) !== input.repository) throw relayFailure("FLEET_REPOSITORY_MISMATCH", "The configured checkouts have different Git origins");
    return windows();
  }
  if (input.action === "sessions") {
    const cwd = check();
    const result = await sessions(cwd, { authorize });
    if (check() !== cwd) throw relayFailure("FLEET_PROJECT_CHANGED", "The project mapping changed while reading AI sessions");
    return result;
  }
  if (input.action === "activity") {
    const cwd = check();
    const result = await activity({ relay, processes });
    if (check() !== cwd) throw relayFailure("FLEET_PROJECT_CHANGED", "The project mapping changed while reading background activity");
    return result;
  }
  if (input.action === "probe") {
    const totalBytes = os.totalmem();
    const available = process.availableMemory();
    const freeBytes = Number.isSafeInteger(available) && available >= 0 ? Math.min(available, totalBytes) : os.freemem();
    const metrics = { hostname: os.hostname(), platform: process.platform, freeBytes, totalBytes, revision: null, clean: null };
    try {
      const cwd = check();
      const [health, state] = await Promise.all([relay("status").then(status => ({ status }), error => ({ error })), checkout(cwd)]);
      Object.assign(metrics, state);
      if (health.error) return { ...metrics, agents: [], reason: health.error.message };
      const status = health.status;
      const ready = status.workers.filter(worker => worker.ready === true && worker.canAcceptWork === true && BACKGROUND_AGENTS.includes(worker.agent));
      return { ...metrics, agents: status.accepting ? ready.map(worker => worker.agent) : [],
        ...(status.accepting ? {} : { reason: "The relay is draining existing work" }) };
    } catch (error) {
      return { ...metrics, agents: [], reason: error.message };
    }
  }
  const cwd = check();
  if (input.action === "send" && input.expectedRevision) {
    const state = await checkout(cwd);
    if (!state.clean || state.revision !== input.expectedRevision) {
      throw relayFailure("FLEET_CHECKOUT_CHANGED", "The destination needs a clean checkout at the checkpoint revision");
    }
    check();
  }
  const receipt = input.action === "send"
    ? await relay("send", { cwd, agent: input.agent, requestId: input.requestId, prompt: input.prompt })
    : await relay("read", { requestId: input.requestId });
  if (receipt?.requestId !== input.requestId || receipt.agent !== input.agent
    || !["queued", "running", "completed", "failed", "unknown"].includes(receipt.status)) {
    throw relayFailure("FLEET_RECEIPT_MISMATCH", "The worker receipt does not match this request", "unknown");
  }
  return receipt;
}

export async function runFleetHost(inputStream = process.stdin) {
  let input;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of inputStream) {
      size += Buffer.byteLength(chunk);
      if (size > RELAY_FRAME_LIMIT) throw relayFailure("FLEET_REQUEST_TOO_LARGE", "Fleet host request exceeds its input limit");
      chunks.push(Buffer.from(chunk));
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await handleFleetHostRequest(input);
    return { version: 1, nonce: input.nonce, result };
  } catch (error) {
    return { version: 1, nonce: input?.nonce ?? null, error: { code: error.code ?? "FLEET_HOST_FAILED",
      message: error.message, deliveryState: error.deliveryState ?? (input?.action === "send" ? "unknown" : "not_sent") } };
  }
}

export function fleetSshArgs(host, operation = "fleet-host") {
  if (!["fleet-host", "fleet-session-host"].includes(operation)) throw relayFailure("FLEET_HOST_INVALID", "Invalid fleet receiver operation");
  const platform = host.platform ?? "linux";
  if (!commands.has(platform) || typeof host.sshHost !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(host.sshHost)) {
    throw relayFailure("FLEET_HOST_INVALID", "Choose a configured SSH alias and supported platform");
  }
  let command = commands.get(platform).replace("fleet-host", operation);
  if (platform === "win32" && operation === "fleet-session-host") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$userCli = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'npm/node_modules/@minhspark/codex-mcp-bridge/scripts/worker-relay.mjs'",
      "if (Test-Path -LiteralPath $userCli -PathType Leaf) { & node $userCli fleet-session-host } else { & worker-relay.cmd fleet-session-host }",
      "exit $LASTEXITCODE",
    ].join("\n");
    command = "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + Buffer.from(script, "utf16le").toString("base64");
  }
  if (host.runtime) {
    const paths = [host.runtime.node, host.runtime.cli];
    if (platform === "win32" || paths.some(value => typeof value !== "string" || !path.posix.isAbsolute(value) || /[\0\r\n]/.test(value))) {
      throw relayFailure("FLEET_HOST_INVALID", "The installed bridge profile needs absolute POSIX runtime paths");
    }
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const shell = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    command = shell + " -lc " + quote("exec " + paths.map(quote).join(" ") + " " + operation);
  }
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", "-o",
    "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--", host.sshHost, command];
}

async function exchange(host, input) {
  const args = fleetSshArgs(host);
  const data = JSON.stringify(input) + "\n";
  if (Buffer.byteLength(data) > RELAY_FRAME_LIMIT) throw relayFailure("FLEET_REQUEST_TOO_LARGE", "Fleet host request exceeds its input limit");
  const uncertain = () => relayFailure("FLEET_SSH_UNCONFIRMED", "SSH did not return a matching fleet receipt. Check connectivity and the worker-relay version on the destination.",
    input.action === "send" ? "unknown" : "not_sent", "fleet_transport");
  const output = await new Promise((resolve, reject) => {
    const child = execFile("ssh", args, { shell: false, windowsHide: true, encoding: "utf8", timeout: 22000, maxBuffer: RELAY_REPLY_LIMIT },
      (error, stdout) => error ? reject(uncertain()) : resolve(stdout));
    child.stdin.on("error", () => reject(uncertain()));
    child.stdin.end(data);
  });
  let body;
  try { body = JSON.parse(output); } catch { throw uncertain(); }
  if (body?.version !== 1 || body.nonce !== input.nonce) throw uncertain();
  if (body.error) throw relayFailure(body.error.code, body.error.message, body.error.deliveryState);
  if (input.action === "probe") {
    if (!Number.isSafeInteger(body.result?.freeBytes) || !Number.isSafeInteger(body.result?.totalBytes)
      || body.result.freeBytes < 0 || body.result.freeBytes > body.result.totalBytes || body.result.totalBytes <= 0
      || !Array.isArray(body.result.agents) || !body.result.agents.every(agent => BACKGROUND_AGENTS.includes(agent))) throw uncertain();
  } else if (input.action === "sessions") {
    if (!Array.isArray(body.result?.sessions) || body.result.sessions.length > 100
      || !body.result.sessions.every(row => RELAY_UUID.test(row?.id ?? "") && BACKGROUND_AGENTS.includes(row.agent)
        && typeof row.title === "string" && row.title.length <= 256 && ["running", "waiting", "connected", "idle"].includes(row.status))
      || body.result.note !== undefined && (typeof body.result.note !== "string" || body.result.note.length > 512)) throw uncertain();
  } else if (input.action === "windows") {
    if (!Array.isArray(body.result?.windows) || body.result.windows.length > 256
      || !body.result.windows.every(row => typeof row?.app === "string" && typeof row.title === "string")) throw uncertain();
  } else if (input.action === "activity") {
    if (!Array.isArray(body.result?.tasks) || body.result.tasks.length > 50
      || !body.result.tasks.every(row => RELAY_UUID.test(row?.requestId ?? "") && BACKGROUND_AGENTS.includes(row.agent)
        && ["queued", "running", "completed", "failed", "unknown"].includes(row.status))
      || !Array.isArray(body.result?.processes) || body.result.processes.length > 120
      || !body.result.processes.every(row => Number.isSafeInteger(row?.pid) && row.pid > 0
        && typeof row.name === "string" && row.name.length <= 128
        && (row.label === undefined || typeof row.label === "string" && row.label.length <= 128)
        && Number.isSafeInteger(row.memoryBytes) && row.memoryBytes >= 0)
      || !Number.isSafeInteger(body.result?.totalProcesses) || body.result.totalProcesses < 0
      || body.result.note !== undefined && (typeof body.result.note !== "string" || body.result.note.length > 512)) throw uncertain();
  } else if (body.result?.requestId !== input.requestId || body.result.agent !== input.agent
    || !["queued", "running", "completed", "failed", "unknown"].includes(body.result.status)) throw uncertain();
  return body.result;
}

export function createFleetHostClient({ cwd, hosts, remoteCall = exchange, localCall = handleFleetHostRequest,
  authorize = authorizedProject, identity = projectIdentity, env = process.env }) {
  const request = async (selected, action, job) => {
    assertLocalOperator(env);
    const host = hosts.find(entry => entry.id === selected.id);
    if (!host) throw relayFailure("FLEET_HOST_INVALID", "The selected host is outside this fleet");
    const input = { version: 1, nonce: randomUUID(), action, cwd: host.cwd,
      ...(job ? { requestId: job.id, agent: job.agent } : {}),
      ...(action === "send" ? { prompt: job.prompt, expectedRevision: job.expectedRevision } : {}) };
    if (!host.sshHost) return localCall(input, { remote: false });
    fleetSshArgs(host);
    const protectedRequest = action === "send" || action === "sessions" || action === "activity";
    const sourceCwd = protectedRequest ? authorize(cwd) : cwd;
    const repository = identity(sourceCwd);
    const result = await remoteCall(host, { ...input, repository });
    if ((action === "sessions" || action === "activity") && (authorize(cwd) !== sourceCwd || identity(sourceCwd) !== repository)) {
      throw relayFailure("FLEET_PROJECT_CHANGED", "The project mapping changed while reading host state");
    }
    return result;
  };
  return { probe: host => request(host, "probe"), windows: host => request(host, "windows"), sessions: host => request(host, "sessions"),
    activity: host => request(host, "activity"), send: (host, job) => request(host, "send", job), read: (host, job) => request(host, "read", job) };
}
