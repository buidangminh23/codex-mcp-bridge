import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VSCodeIpc } from "./vscode-ipc.mjs";
import { findRollout, readState, readCodexSenderContext } from "./codex-sender-context.mjs";
import { readProcessAncestry } from "./claude-sender-context.mjs";
import { listClaudeSessions, assertClaudeSessionCwd, assertClaudeSessionProcess, PeerEndpoint } from "./peer-protocol.mjs";
import { readClaudeInboundPolicy } from "./claude-inbound-policy.mjs";

const host = process.argv[2];
if (!["claude", "codex"].includes(host)) throw new Error("Specify the calling extension: claude or codex");
if (process.platform !== "win32") throw new Error("VS Code bridge preview currently supports Windows only");
const roots = (process.env.VSCODE_BRIDGE_ALLOWED_ROOTS ?? "").split(path.delimiter).filter(Boolean).map((root) => fs.realpathSync.native(root));
if (!roots.length || roots.some((root) => path.parse(root).root === root)) throw new Error("Configure explicit project roots in VSCODE_BRIDGE_ALLOWED_ROOTS");
const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const peer = new PeerEndpoint({ name: "codex-vscode-bridge" });
const unresolved = new Map();
const deliveryOwners = new Map();
const result = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
const samePath = (left, right) => path.relative(fs.realpathSync.native(left), fs.realpathSync.native(right)) === "";

function assertRoot(cwd) {
  const resolved = fs.realpathSync.native(cwd);
  if (!roots.some((root) => {
    const relative = path.relative(root, resolved);
    return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  })) throw new Error("The session is outside the configured project roots");
  return resolved;
}

async function caller(meta) {
  if (host === "codex") {
    const sender = readCodexSenderContext(meta, { originator: "codex_vscode" });
    if (sender.status !== "verified") throw new Error(sender.reason);
    assertRoot(sender.cwd);
    return sender;
  }
  const ancestry = await readProcessAncestry();
  const matches = listClaudeSessions().filter((session) => session.entrypoint === "claude-vscode" && ancestry.some((row) => row.pid === session.pid && row.processStart === session.processStart));
  if (matches.length !== 1) throw new Error("This MCP server must be launched by one live Claude Code VS Code session");
  assertClaudeSessionProcess(matches[0]);
  assertRoot(matches[0].cwd);
  return matches[0];
}

function codexTask(threadId, cwd) {
  if (!/^[0-9a-f-]{36}$/.test(threadId)) throw new Error("Invalid task ID");
  const file = findRollout(sessions, threadId);
  const state = readState(file, 64 * 1024 * 1024);
  if (state.session?.id !== threadId || state.session.originator !== "codex_vscode" || state.session.source !== "vscode") throw new Error("The target is not a Codex VS Code task");
  assertRoot(state.session.cwd);
  if (!samePath(state.session.cwd, cwd) || !samePath(state.context.cwd, cwd)) throw new Error("Target and caller must use the same project directory");
  return { ...state, file };
}

function taskCandidates(cwd) {
  const queue = [{ directory: sessions, depth: 0 }];
  const rows = [];
  let count = 0;
  while (queue.length) {
    const { directory, depth } = queue.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++count > 100000) throw new Error("Session scan limit exceeded");
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (depth < 3 && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) queue.push({ directory: file, depth: depth + 1 });
      if (depth !== 3 || !entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const fd = fs.openSync(file, "r");
      let first;
      try { const data = Buffer.alloc(65536); const size = fs.readSync(fd, data); first = JSON.parse(data.subarray(0, size).toString("utf8").split("\n")[0]); }
      catch { continue; }
      finally { fs.closeSync(fd); }
      const session = first.payload;
      if (first.type === "session_meta" && session?.originator === "codex_vscode" && session.source === "vscode" && samePath(session.cwd, cwd)) rows.push({ threadId: session.id, cwd: session.cwd });
    }
  }
  return rows.slice(-50);
}

const server = new McpServer({ name: `vscode-${host}-bridge`, version: "0.1.0" });
function tool(name, description, inputSchema, action) {
  server.registerTool(name, { description, inputSchema }, async (args, extra) => {
    try { return result(await action(args, await caller(extra?._meta), extra?._meta)); }
    catch (error) { return result({ error: error.message, ...(error.msgId ? { msgId: error.msgId } : {}) }, true); }
  });
}

tool("vscode_bridge_status", "Verify this extension caller and list same-project counterparts in VS Code. Desktop sessions are excluded.", {}, async (_, sender) => {
  if (host === "codex") return { host, cwd: sender.cwd, sessions: listClaudeSessions().filter((session) => session.entrypoint === "claude-vscode" && samePath(session.cwd, sender.cwd)).map(({ sessionId, cwd }) => ({ sessionId, cwd })) };
  const ipc = await new VSCodeIpc().connect();
  try {
    const tasks = [];
    for (const candidate of taskCandidates(sender.cwd)) {
      try { await ipc.owner(candidate.threadId); tasks.push(candidate); } catch {}
    }
    return { host, cwd: sender.cwd, tasks };
  } finally { ipc.close(); }
});

if (host === "claude") {
  tool("send_to_codex_vscode", "Send to an existing Codex extension task in this project, preserving its selected permissions. Never retries or opens another app. Use read_codex_vscode_reply after submission.", { threadId: z.string(), message: z.string().min(1).max(50000) }, async ({ threadId, message }, sender, meta) => {
    if (unresolved.has(threadId)) throw new Error("An earlier send is unresolved. Read its reply before sending again.");
    const inspect = () => {
      const state = codexTask(threadId, sender.cwd);
      if (!["task_complete", "task_completed", "turn_complete", "turn_completed", "turn_aborted", "task_aborted"].includes(state.lifecycle?.type)) throw new Error("The target is busy or its lifecycle is unknown; wait for it to finish");
    };
    inspect();
    const ipc = await new VSCodeIpc().connect();
    try {
      return await ipc.send(threadId, message, { beforeSend: async () => {
        const current = await caller(meta);
        if (current.sessionId !== sender.sessionId || current.processStart !== sender.processStart) throw new Error("Caller session changed");
        inspect();
        if (unresolved.has(threadId)) throw new Error("Another send is already pending for this task");
        unresolved.set(threadId, "submission outcome unknown");
      } }).then((receipt) => { unresolved.set(threadId, receipt.turnId); return receipt; });
    } finally { ipc.close(); }
  });
  tool("read_codex_vscode_reply", "Read completion of the exact returned turn ID. A submission receipt alone does not prove completion.", { threadId: z.string(), turnId: z.string() }, async ({ threadId, turnId }, sender) => {
    const state = codexTask(threadId, sender.cwd);
    if (state.lifecycle?.turn_id !== turnId || !["task_complete", "task_completed", "turn_complete", "turn_completed"].includes(state.lifecycle.type)) return { status: "pending_or_unavailable", threadId, turnId };
    if (unresolved.get(threadId) === turnId) unresolved.delete(threadId);
    return { status: "completed", threadId, turnId, text: state.lifecycle.last_agent_message ?? null };
  });
} else {
  tool("send_to_claude_vscode", "Send to the exact Claude Code VS Code session in this project. Never changes recipient permissions. Do not ask the recipient to call back while this synchronous request waits.", { sessionId: z.string(), message: z.string().min(1).max(50000), waitSec: z.number().int().min(0).max(45).default(30) }, async ({ sessionId, message, waitSec }, sender, meta) => {
    const inspect = () => {
      const matches = listClaudeSessions().filter((session) => session.entrypoint === "claude-vscode" && session.sessionId === sessionId);
      if (matches.length !== 1) throw new Error("No unique live Claude Code VS Code session matches");
      const session = matches[0];
      assertClaudeSessionCwd(session, sender.cwd);
      assertClaudeSessionProcess(session);
      const policy = readClaudeInboundPolicy(session.cwd);
      if (["hold", "refuse"].includes(policy.value)) throw new Error(`Recipient crossSessionInbound is ${policy.value}; no message sent`);
      return session;
    };
    const recipient = inspect();
    await peer.start();
    const receipt = await peer.sendAndWait(recipient.socket, message, { timeoutMs: waitSec * 1000, permissionMode: sender.mode, transcriptSession: { sessionId, cwd: recipient.cwd }, beforeSend: async () => {
      const current = await caller(meta);
      if (current.turnId !== sender.turnId || current.mode !== sender.mode) throw new Error("Caller turn or permissions changed");
      const target = inspect();
      if (target.pid !== recipient.pid || target.socket !== recipient.socket || target.processStart !== recipient.processStart) throw new Error("Recipient session changed");
    } }).catch((error) => {
      if (error.msgId) deliveryOwners.set(error.msgId, sender.threadId);
      throw error;
    });
    deliveryOwners.set(receipt.msgId, sender.threadId);
    return { ...receipt, status: receipt.reply ? "reply_received" : receipt.delivery?.status ?? "sent_unconfirmed" };
  });
  tool("read_claude_vscode_delivery", "Inspect an earlier send without resending it.", { msgId: z.string() }, async ({ msgId }, sender) => {
    if (deliveryOwners.get(msgId) !== sender.threadId) throw new Error("This receipt does not belong to the calling task");
    return peer.readDelivery(msgId) ?? { status: "unknown" };
  });
}

process.on("exit", () => peer.stop());
await server.connect(new StdioServerTransport());
