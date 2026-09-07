import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { listClaudeSessions } from "./peer-protocol.mjs";
import { readClaudeDesktopContext } from "./claude-desktop-context.mjs";

const execute = promisify(execFile);
const MAX_ANCESTORS = 8;

export async function readProcessAncestry({ parentPid = process.ppid, platform = process.platform, maxDepth = MAX_ANCESTORS } = {}) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return [];
  const limit = Number.isInteger(maxDepth) && maxDepth > 0 ? Math.min(maxDepth, MAX_ANCESTORS) : MAX_ANCESTORS;
  const options = { timeout: 5000, maxBuffer: 16384, windowsHide: true };
  if (platform === "win32") {
    const shell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `$next=${parentPid}; $seen=@{}; $rows=@(); for($i=0;$i -lt ${limit} -and $next -gt 0;$i++){if($seen.ContainsKey($next)){break}; $seen[$next]=$true; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$next); if(!$p){break}; try{$start=(Get-Process -Id $next -ErrorAction Stop).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}catch{break}; $rows+=@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;processStart=$start}; $next=[int]$p.ParentProcessId}; ConvertTo-Json -InputObject @($rows) -Compress`;
    const { stdout } = await execute(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options);
    return JSON.parse(stdout.trim());
  }
  const rows = [];
  const seen = new Set();
  let next = parentPid;
  const deadline = Date.now() + 5000;
  while (next > 0 && !seen.has(next) && rows.length < limit) {
    seen.add(next);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("process inspection deadline elapsed");
    const { stdout } = await execute("/bin/ps", ["-p", String(next), "-o", "pid=,ppid=,lstart="], {
      ...options, timeout: remaining, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) break;
    const row = { pid: Number(match[1]), parentPid: Number(match[2]), processStart: match[3].trim() };
    rows.push(row);
    next = row.parentPid;
  }
  return rows;
}

function senderResult(status, reason, values = {}) {
  return { status, pid: null, sessionId: null, taskId: null, cwd: null, processStart: null, accountFingerprint: null, reason, ...values };
}

export async function readClaudeSenderContext({ account, parentPid = process.ppid, readAncestry = readProcessAncestry, listSessions = listClaudeSessions, readContext = readClaudeDesktopContext } = {}) {
  if (account?.status !== "verified" || !account.fingerprint) return senderResult("unavailable", "The calling Claude account is not verified.");
  try {
    const registered = listSessions();
    const direct = registered.some((session) => session.entrypoint === "claude-desktop" && session.alive && session.pid === parentPid);
    const ancestry = await readAncestry({ parentPid, maxDepth: direct ? 1 : MAX_ANCESTORS });
    if (!Array.isArray(ancestry) || !ancestry.length || ancestry.length > MAX_ANCESTORS) throw new Error("invalid ancestry");
    const seen = new Set();
    let expected = parentPid;
    for (const entry of ancestry) {
      if (!Number.isSafeInteger(entry.pid) || entry.pid !== expected || seen.has(entry.pid) ||
          !Number.isSafeInteger(entry.parentPid) || entry.parentPid < 0 || typeof entry.processStart !== "string" || !entry.processStart.trim()) throw new Error("invalid ancestry");
      seen.add(entry.pid);
      expected = entry.parentPid;
    }
    const sessions = registered.filter((session) => session.entrypoint === "claude-desktop" && session.alive && seen.has(session.pid));
    if (sessions.length > 1) return senderResult("ambiguous", "Multiple registered Claude Desktop sessions appear in this MCP process's ancestry.");
    if (!sessions.length) return senderResult("unavailable", "This MCP process has no registered Claude Desktop Code session in its parent ancestry. Reconnect the bridge inside the intended existing Code task.");
    const session = sessions[0];
    const process = ancestry.find((entry) => entry.pid === session.pid);
    if (session.processStart && session.processStart !== process.processStart) return senderResult("unavailable", "The calling Claude session's registered process identity changed.");
    const context = readContext(session, { account });
    if (context.status !== "matched") return senderResult("unavailable", "The calling Claude Code session is not confirmed in the currently signed-in account.");
    return senderResult("verified", "The calling MCP process belongs to a live Claude Desktop Code session in the selected account.", {
      pid: session.pid, sessionId: session.sessionId, taskId: context.taskId, cwd: context.cwd,
      processStart: process.processStart, accountFingerprint: account.fingerprint,
      lineage: ancestry.map((entry) => ({ ...entry })),
    });
  } catch {
    return senderResult("unavailable", "The calling Claude process ancestry or task identity could not be verified.");
  }
}

export function requireClaudeSenderContext(sender) {
  if (sender?.status !== "verified") {
    const error = new Error(sender?.reason ?? "The calling Claude Desktop Code session is unverified.");
    error.code = "CLAUDE_SENDER_CONTEXT_UNVERIFIED";
    throw error;
  }
  return sender;
}

export async function assertClaudeSenderContext(expected, options) {
  const current = requireClaudeSenderContext(await readClaudeSenderContext(options));
  if (["pid", "sessionId", "taskId", "cwd", "processStart", "accountFingerprint"].some((field) => current[field] !== expected?.[field])) {
    const error = new Error("The calling Claude Desktop session or account changed while this operation was pending.");
    error.code = "CLAUDE_SENDER_CONTEXT_CHANGED";
    throw error;
  }
  return current;
}
