import fs from "node:fs";
import path from "node:path";
import { listAntigravityConversations } from "./antigravity-desktop.mjs";
import { assertAccountIdentity, readBridgeAccounts, requireBridgeAccounts } from "./bridge-account-context.mjs";
import { readClaudeDesktopContext } from "./claude-desktop-context.mjs";
import { readClaudeAccountContext } from "./desktop-account-context.mjs";
import { NativeDesktopRelay } from "./native-relay.mjs";
import { assertClaudeSessionProcess, listClaudeSessions } from "./peer-protocol.mjs";
import { RELAY_UUID } from "./background-relay-config.mjs";
import { captureProjectScope } from "./project-scope.mjs";

const liveStatus = new Map([
  ["active", "running"], ["running", "running"], ["working", "running"], ["busy", "running"],
  ["inprogress", "running"], ["cascade_run_status_running", "running"], ["idle", "idle"],
  ["waiting", "waiting"], ["waitingforinput", "waiting"], ["waitingforapproval", "waiting"],
  ["needsinput", "waiting"], ["blocked", "waiting"],
]);

function sameProject(row, cwd, authorize) {
  if (typeof row.cwd !== "string" || !path.isAbsolute(row.cwd)) return false;
  try {
    const nativeCwd = fs.realpathSync.native(row.cwd);
    if (path.relative(cwd, nativeCwd) === "") return true;
    if (!authorize) return false;
    captureProjectScope(cwd, nativeCwd);
    return path.relative(authorize(nativeCwd), nativeCwd) === "";
  }
  catch { return false; }
}

async function codexSnapshot() {
  const accountContext = requireBridgeAccounts(readBridgeAccounts());
  const { result } = await new NativeDesktopRelay().requestDesktop("list_threads", { limit: 50 }, {
    accountContext, beforeSend: () => assertAccountIdentity(accountContext), timeoutMs: 5000,
  });
  assertAccountIdentity(accountContext);
  if (!Array.isArray(result?.threads) || !Array.isArray(result.pinnedThreads)
    || result.unavailableHosts?.some(host => host === "local" || host?.hostId === "local")) throw new Error("Codex Desktop unavailable");
  return { rows: [...result.pinnedThreads, ...result.threads],
    note: "Codex Desktop cung cấp ảnh chụp các phiên gần đây và đã ghim. Phiên cũ hơn có thể chưa xuất hiện." };
}

function claudeSnapshot(cwd, authorize) {
  const rows = listClaudeSessions({ includeActivity: true }).filter(session => session.alive && RELAY_UUID.test(session.sessionId) && sameProject(session, cwd, authorize));
  if (!rows.length) return { rows: [] };
  const account = readClaudeAccountContext();
  const sessions = [];
  let incomplete = rows.length > 50;
  for (const session of rows.slice(0, 50)) {
    try { assertClaudeSessionProcess(session); }
    catch { incomplete = true; continue; }
    let title = session.name;
    if (session.entrypoint === "claude-desktop") {
      const native = readClaudeDesktopContext(session, { account });
      if (native.status !== "matched") { incomplete = true; continue; }
      title = native.title;
    }
    sessions.push({ id: session.sessionId, title, cwd: session.cwd, activity: session.activity });
  }
  if (rows.some(session => session.entrypoint === "claude-desktop") && account.fingerprint !== readClaudeAccountContext().fingerprint) {
    throw new Error("Claude Desktop account changed");
  }
  return { rows: sessions, ...(incomplete ? { note: "Một số phiên Claude chưa xác minh được trong lần kiểm tra này." } : {}) };
}

export async function listFleetSessions(project, { codex = codexSnapshot, claude = claudeSnapshot, antigravity = listAntigravityConversations, authorize } = {}) {
  const cwd = fs.realpathSync.native(project);
  const providers = ["Codex Desktop", "Claude Code", "Antigravity"];
  const snapshots = await Promise.allSettled([
    Promise.resolve().then(codex), Promise.resolve().then(() => claude(cwd, authorize)),
    Promise.resolve().then(async () => {
      const rows = await antigravity({ limit: 100 });
      return { rows, ...(rows.length >= 100 ? { note: "Antigravity chỉ hiển thị các phiên từ danh sách gần đây." } : {}) };
    }),
  ]);
  const sessions = [];
  const notes = [];
  const seen = new Set();
  function add(agent, id, title, status) {
    const key = agent + ":" + id;
    if (!RELAY_UUID.test(id) || !status || seen.has(key)) return;
    seen.add(key);
    sessions.push({ agent, id, title: String(title || id).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256), status });
  }
  for (const [index, result] of snapshots.entries()) {
    if (result.status !== "fulfilled") continue;
    if (result.value.note) notes.push(result.value.note);
    for (const row of result.value.rows) {
      if (!sameProject(row, cwd, authorize)) continue;
      if (index === 0 && row.kind === "codex" && row.hostId === "local") {
        const status = row.status?.type ?? row.status;
        const waiting = Array.isArray(row.status?.activeFlags) && row.status.activeFlags.some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag));
        add("codex", row.id, row.title, waiting ? "waiting" : liveStatus.get(String(status).toLowerCase()));
      } else if (index === 1) {
        add("claude", row.id, row.title, liveStatus.get(String(row.activity).toLowerCase()) || "connected");
      } else if (index === 2) {
        const status = liveStatus.get(String(row.status).toLowerCase());
        if (status === "running" || status === "waiting") add("antigravity", row.conversationId, row.title, status);
      }
    }
  }
  const rank = { running: 0, waiting: 1, connected: 2, idle: 3 };
  sessions.sort((a, b) => rank[a.status] - rank[b.status]);
  const missing = providers.filter((_, i) => snapshots[i].status === "rejected");
  if (missing.length) notes.unshift("Chưa đọc được trạng thái phiên từ " + missing.join(", ") + ".");
  if (sessions.length > 100) notes.push("Đã hiển thị 100 phiên đầu tiên.");
  return { sessions: sessions.slice(0, 100), ...(notes.length ? { note: notes.join(" ") } : {}) };
}
