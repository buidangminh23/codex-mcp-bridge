import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { listClaudeSessions } from "./peer-protocol.mjs";
import { readClaudeDesktopContext } from "./claude-desktop-context.mjs";

const execute = promisify(execFile);
const MAX_ANCESTORS = 8;
const WINDOWS_ANCESTRY_SOURCE = `
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;

public static class ClaudeProcessAncestry {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ProcessEntry {
    public uint dwSize, cntUsage, th32ProcessID;
    public UIntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  public sealed class Row {
    public uint pid;
    public uint parentPid;
    public string processStart;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);

  public static Row[] Read(uint firstPid, int limit) {
    var capturedAt = DateTime.UtcNow.ToFileTimeUtc();
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    var parents = new Dictionary<uint, uint>();
    try {
      var entry = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
      if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception(Marshal.GetLastWin32Error());
      do {
        if (parents.Count >= 65536) throw new InvalidOperationException("Process snapshot exceeds its read limit.");
        parents.Add(entry.th32ProcessID, entry.th32ParentProcessID);
      } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      CloseHandle(snapshot);
    }
    var rows = new List<Row>();
    var seen = new HashSet<uint>();
    var next = firstPid;
    var childStart = capturedAt;
    while (next > 0 && rows.Count < limit && seen.Add(next)) {
      uint parent;
      if (!parents.TryGetValue(next, out parent)) break;
      var process = OpenProcess(0x1000, false, next);
      if (process == IntPtr.Zero) break;
      try {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)
            || creation <= 0 || creation > childStart || exit != 0) break;
        rows.Add(new Row { pid = next, parentPid = parent, processStart = creation.ToString(CultureInfo.InvariantCulture) });
        childStart = creation;
        next = parent;
      } finally {
        CloseHandle(process);
      }
    }
    return rows.ToArray();
  }
}`;

function parseWindowsAncestry(stdout, parentPid, limit) {
  const rows = JSON.parse(stdout.trim());
  if (!Array.isArray(rows) || rows.length > limit) throw new Error("Invalid process ancestry response");
  const seen = new Set();
  let next = parentPid;
  let childStart;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Object.keys(row).some((key) => !["pid", "parentPid", "processStart"].includes(key))
        || !Number.isSafeInteger(row.pid) || row.pid !== next || row.pid <= 0 || row.pid > 0xffffffff || seen.has(row.pid)
        || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || row.parentPid > 0xffffffff
        || typeof row.processStart !== "string" || !/^[1-9]\d{0,18}$/.test(row.processStart)) throw new Error("Invalid process ancestry response");
    const start = BigInt(row.processStart);
    if (childStart !== undefined && start > childStart) throw new Error("Process ancestry contains a replaced parent");
    childStart = start;
    seen.add(row.pid);
    next = row.parentPid;
  }
  return rows;
}

export async function readProcessAncestry({ parentPid = process.ppid, platform = process.platform, maxDepth = MAX_ANCESTORS, run = execute } = {}) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid > 0xffffffff) return [];
  const limit = Number.isInteger(maxDepth) && maxDepth > 0 ? Math.min(maxDepth, MAX_ANCESTORS) : MAX_ANCESTORS;
  const options = { timeout: 5000, maxBuffer: 16384, windowsHide: true };
  if (platform === "win32") {
    const shell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${WINDOWS_ANCESTRY_SOURCE}\n'@\nConvertTo-Json -InputObject @([ClaudeProcessAncestry]::Read(${parentPid},${limit})) -Compress`;
    const { stdout } = await run(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], options);
    return parseWindowsAncestry(stdout, parentPid, limit);
  }
  const rows = [];
  const seen = new Set();
  let next = parentPid;
  const deadline = Date.now() + 5000;
  while (next > 0 && !seen.has(next) && rows.length < limit) {
    seen.add(next);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("process inspection deadline elapsed");
    const { stdout } = await run("/bin/ps", ["-p", String(next), "-o", "pid=,ppid=,lstart="], {
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
