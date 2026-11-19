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

function authorizedProject(cwd) {
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
  if (input?.version !== 1 || !RELAY_UUID.test(input.nonce ?? "") || !["probe", "send", "read", "windows"].includes(input.action)
    || typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || input.cwd.length > 4096 || /[\0\r\n]/.test(input.cwd)
    || remote && (typeof input.repository !== "string" || !input.repository || input.repository.length > 4096)
    || ["send", "read"].includes(input.action) && (!RELAY_UUID.test(input.requestId ?? "") || !BACKGROUND_AGENTS.includes(input.agent))
    || input.expectedRevision != null && !revisionPattern.test(input.expectedRevision)
    || input.action === "send" && (typeof input.prompt !== "string" || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 256 * 1024)) {
    throw relayFailure("FLEET_REQUEST_INVALID", "Invalid fleet host request");
  }
}

export async function handleFleetHostRequest(input, { remote = true, relay = callBackgroundRelay, authorize = authorizedProject,
  identity = projectIdentity, checkout = checkoutState, windows = listFleetWindows, env = process.env } = {}) {
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
  if (input.action === "probe") {
    const metrics = { hostname: os.hostname(), platform: process.platform, freeBytes: os.freemem(), totalBytes: os.totalmem(), revision: null, clean: null };
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

export function fleetSshArgs(host) {
  const platform = host.platform ?? "linux";
  if (!commands.has(platform) || typeof host.sshHost !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(host.sshHost)) {
    throw relayFailure("FLEET_HOST_INVALID", "Choose a configured SSH alias and supported platform");
  }
  let command = commands.get(platform);
  if (host.runtime) {
    const paths = [host.runtime.node, host.runtime.cli];
    if (platform === "win32" || paths.some(value => typeof value !== "string" || !path.posix.isAbsolute(value) || /[\0\r\n]/.test(value))) {
      throw relayFailure("FLEET_HOST_INVALID", "The installed bridge profile needs absolute POSIX runtime paths");
    }
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const shell = platform === "darwin" ? "/bin/zsh" : "/bin/sh";
    command = shell + " -lc " + quote("exec " + paths.map(quote).join(" ") + " fleet-host");
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
  } else if (input.action === "windows") {
    if (!Array.isArray(body.result?.windows) || body.result.windows.length > 256
      || !body.result.windows.every(row => typeof row?.app === "string" && typeof row.title === "string")) throw uncertain();
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
    const sourceCwd = action === "send" ? authorize(cwd) : cwd;
    return remoteCall(host, { ...input, repository: identity(sourceCwd) });
  };
  return { probe: host => request(host, "probe"), windows: host => request(host, "windows"),
    send: (host, job) => request(host, "send", job), read: (host, job) => request(host, "read", job) };
}
