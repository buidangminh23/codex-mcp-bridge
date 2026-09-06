import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { homeDir, IS_WINDOWS } from "./platform.mjs";

const SOCKET_DIR = "/tmp/cc-socks";

/**
 * Windows has no /tmp, and path.join rewrites the unix default to "\tmp\cc-socks"
 * on the system drive, where listen() fails with EACCES. The endpoint then never
 * comes up, so Claude has no address to answer on and the bridge is silently
 * one-way: messages reach Claude, replies never come back.
 *
 * Claude Code advertises a named pipe on Windows for exactly this reason, so the
 * peer uses the same transport there. net.connect({ path }) and server.listen()
 * accept a pipe name unchanged, so only creation differs - a pipe has no
 * directory to create, no mode to chmod and no file to unlink beforehand.
 */
function peerSocketPath(pid) {
  return IS_WINDOWS ? `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString("hex")}` : path.join(SOCKET_DIR, `${pid}.sock`);
}
const PEER_PROTOCOL_VERSION = 1;
const CLAUDE_VERSION_HINT = "2.1.229";
const PS_BIN = "/bin/ps";

const sessionsDir = () => path.join(homeDir(), ".claude", "sessions");
const projectsDir = () => path.join(homeDir(), ".claude", "projects");

/**
 * A Claude Code session advertises itself in ~/.claude/sessions/<pid>.json and
 * listens for peer messages on a local socket or Windows named pipe. Messages are newline-delimited
 * JSON; the wrapper element is what Claude renders in its chat surface.
 */
export function buildFrame({ text, fromSocket, priority = "next", permissionMode }) {
  const msgId = crypto.randomUUID();
  const from = `uds:${fromSocket.replace(/[^A-Za-z0-9:_/.\-]/gu, (character) => Array.from(Buffer.from(character), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join(""))}`;
  const mode = ["bypass", "prompting"].includes(permissionMode) ? ` from-mode="${permissionMode}"` : "";
  return {
    msgV: PEER_PROTOCOL_VERSION,
    msg_id: msgId,
    uuid: msgId,
    type: "user",
    message: {
      role: "user",
      content: `<cross-session-message from="${from}"${mode}>\n${text}\n</cross-session-message>`,
    },
    priority,
    from,
  };
}

export function parseFrame(line) {
  const frame = JSON.parse(line);
  if (frame?.type !== "user" || typeof frame.message?.content !== "string") return null;
  const raw = frame?.message?.content ?? "";
  const inner = raw.match(/<cross-session-message[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/);
  return {
    msgId: frame.msg_id ?? null,
    from: frame.from ?? null,
    fromSocket: decodePeerAddress(frame.from),
    text: (inner ? inner[1] : raw).trim(),
  };
}

function decodePeerAddress(from) {
  if (typeof from !== "string" || !from.startsWith("uds:")) return null;
  try { return decodeURIComponent(from.slice(4)) || null; }
  catch { return null; }
}

export function peerKeyPath(pid, socket) {
  const pipe = /^[\\/]{2}[.?][\\/]pipe[\\/](?:(LOCAL)[\\/])?([^\\/]+)$/i.exec(socket);
  let canonical;
  if (pipe && !/[. ]$/.test(pipe[2]) && ![".", ".."].includes(pipe[2])) {
    canonical = `\\\\.\\pipe\\${pipe[1] ? "local\\" : ""}${pipe[2].replace(/[A-Z]/g, (letter) => letter.toLowerCase())}`;
  } else if (!IS_WINDOWS && path.isAbsolute(socket)) {
    canonical = path.resolve(socket);
  } else {
    throw new Error("Refusing a non-local or non-canonical peer socket");
  }
  return path.join(sessionsDir(), `${pid}.${crypto.createHash("sha256").update(canonical).digest("hex")}.key`);
}

function readPeerToken(socket) {
  peerKeyPath(process.pid, socket);
  const candidates = listClaudeSessions({ includeBridges: true }).filter((entry) => {
    try { return peerKeyPath(entry.pid, entry.socket) === peerKeyPath(entry.pid, socket); }
    catch { return false; }
  });
  if (candidates.length !== 1) {
    if (IS_WINDOWS) throw new Error("No unique live session owns the destination inbox; message was not sent");
    return null;
  }
  try {
    const key = JSON.parse(fs.readFileSync(peerKeyPath(candidates[0].pid, socket), "utf8"));
    if (typeof key.peerToken !== "string" || !/^[0-9a-f]{32}$/i.test(key.peerToken)) throw new Error("Invalid peer key");
    const identity = IS_WINDOWS ? key.procStartFt : key.procStart;
    if (identity && identity !== readProcessStart(candidates[0].pid)) throw new Error("Peer process identity changed");
    return key.peerToken;
  } catch {
    if (IS_WINDOWS) throw new Error("The destination inbox authentication key is missing or invalid; message was not sent");
    return null;
  }
}

/**
 * MCP servers are spawned with an empty PATH, so `ps` must be addressed by its
 * absolute path - a bare lookup throws ENOENT and takes the whole server down
 * before it can answer the client's initialize call. The timestamp only guards
 * against pid reuse, so an empty value is an acceptable fallback.
 */
function readProcessStart(pid) {
  try {
    if (IS_WINDOWS) {
      const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      return execFileSync(shell, ["-NoProfile", "-Command", `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`], { timeout: 3000, windowsHide: true }).toString().trim();
    }
    return execFileSync(PS_BIN, ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 3000 }).toString().trim();
  } catch {
    return "";
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const SESSION_READ_ATTEMPTS = 3;
const PEER_SEND_ATTEMPTS = 3;
const PEER_CONNECT_TIMEOUT_MS = 2000;
const PEER_RETRY_DELAY_MS = 75;
const RETRYABLE_PEER_ERRORS = new Set(["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE", "ENOTFOUND", "ETIMEDOUT"]);

function readSessionEntry(file) {
  for (let attempt = 0; attempt < SESSION_READ_ATTEMPTS; attempt += 1) {
    try {
      const first = fs.readFileSync(file, "utf8");
      const second = fs.readFileSync(file, "utf8");
      if (first !== second) continue;
      return JSON.parse(second);
    } catch {}
  }
  return null;
}

function hasMessagingEndpoint(entry) {
  const socket = entry?.messagingSocketPath;
  if (IS_WINDOWS && typeof socket === "string" && socket.toLowerCase().startsWith("\\\\.\\pipe\\")) return true;
  return Boolean(socket) && fs.existsSync(socket);
}

export const BRIDGE_ENTRYPOINT = "codex-bridge";

export function listClaudeSessions({ includeDead = false, includeBridges = false } = {}) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const entry = readSessionEntry(path.join(dir, file));
    if (!entry) continue;
    if (!entry?.pid || !entry?.messagingSocketPath) continue;
    if (entry.entrypoint === BRIDGE_ENTRYPOINT && !includeBridges) continue;
    const alive = isProcessAlive(entry.pid) && hasMessagingEndpoint(entry);
    if (!alive && !includeDead) continue;
    rows.push({
      pid: entry.pid,
      name: entry.name ?? null,
      sessionId: entry.sessionId ?? null,
      bridgeSessionId: entry.bridgeSessionId ?? null,
      cwd: entry.cwd ?? null,
      kind: entry.kind ?? null,
      entrypoint: entry.entrypoint ?? null,
      startedAt: entry.startedAt ?? null,
      processStart: (IS_WINDOWS ? entry.procStartFt : entry.procStart) ?? null,
      socket: entry.messagingSocketPath,
      alive,
    });
  }
  return rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function findClaudeSession(target, { desktopOnly = false, expectedCwd } = {}) {
  const sessions = listClaudeSessions();
  const needle = String(target).trim();
  if (desktopOnly) {
    const byId = sessions.filter((session) => String(session.pid) === needle || session.sessionId === needle);
    const matches = byId.length ? byId : sessions.filter((session) => session.name === needle);
    if (!needle || matches.length === 0) return null;
    if (matches.length !== 1) throw new Error(`Desktop-only mode requires an unambiguous sessionId or pid; "${needle}" matches multiple sessions. No message was sent.`);
    const session = matches[0];
    if (session.entrypoint !== "claude-desktop") {
      throw new Error(`Desktop-only mode refuses Claude session ${session.sessionId ?? session.pid} with entrypoint ${session.entrypoint ?? "unknown"}. Open or reconnect an existing Code session in Claude Desktop for the intended project. Do not launch a replacement CLI session. No message was sent.`);
    }
    if (expectedCwd !== undefined) assertClaudeSessionCwd(session, expectedCwd);
    return session;
  }
  return (
    sessions.find((s) => String(s.pid) === needle) ??
    sessions.find((s) => s.sessionId === needle) ??
    sessions.find((s) => s.name === needle) ??
    sessions.find((s) => (s.name ?? "").toLowerCase().includes(needle.toLowerCase())) ??
    null
  );
}

export function assertClaudeSessionCwd(session, expectedCwd) {
  if (typeof expectedCwd !== "string" || !path.isAbsolute(expectedCwd) || !session.cwd || !path.isAbsolute(session.cwd)) {
    throw new Error("Desktop delivery requires an explicit absolute expectedCwd and an absolute session cwd. No message was sent.");
  }
  let expected;
  let actual;
  try {
    expected = fs.realpathSync.native(expectedCwd);
    actual = fs.realpathSync.native(session.cwd);
  } catch {
    throw new Error("The intended project directory or the Claude session cwd no longer exists. No message was sent.");
  }
  const normalize = (value) => IS_WINDOWS ? value.toLowerCase() : value;
  if (normalize(expected) !== normalize(actual)) {
    throw new Error(`Claude session cwd ${actual} does not match expectedCwd ${expected}. No message was sent.`);
  }
}

export function assertClaudeSessionProcess(session) {
  if (!session.alive || typeof session.processStart !== "string" || !session.processStart ||
      readProcessStart(session.pid) !== session.processStart) {
    throw new Error("The live Claude process identity is missing or changed. No message was sent; reopen the existing Desktop task and inspect its session again.");
  }
}

/**
 * Claude Code stores a transcript at ~/.claude/projects/<slug>/<sessionId>.jsonl
 * where the slug rewrites more than just path separators (/mnt/dev_disk ->
 * -mnt-dev-disk, losing the underscore), so the file is located by scanning
 * rather than by reconstructing the slug.
 */
function findTranscriptFile(sessionId, cwd) {
  const dir = projectsDir();
  const guess = path.join(dir, String(cwd ?? "").replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  if (fs.existsSync(guess)) return guess;
  if (!fs.existsSync(dir)) return guess;
  for (const project of fs.readdirSync(dir)) {
    const candidate = path.join(dir, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return guess;
}

export function readTranscript(sessionId, cwd, limit = 10) {
  const file = findTranscriptFile(sessionId, cwd);
  if (!fs.existsSync(file)) return { file, messages: [] };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const messages = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const role = entry?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    if (entry.isMeta || entry.isSidechain) continue;
    const content = entry?.message?.content;
    const text = Array.isArray(content)
      ? content
          .filter((c) => c?.type === "text")
          .map((c) => c.text ?? "")
          .join("\n")
      : String(content ?? "");
    if (!text.trim()) continue;
    messages.push({ role, text: text.trim() });
  }
  return { file, messages: messages.slice(-limit) };
}

export function readTranscriptReply(sessionId, cwd, msgId) {
  const file = findTranscriptFile(sessionId, cwd);
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); }
  catch { return null; }
  const descendants = new Set();
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.isSidechain) continue;
    if (entry.uuid === msgId && entry.message?.role === "user") { descendants.add(msgId); continue; }
    if (!descendants.has(entry.parentUuid)) continue;
    const role = entry.message?.role;
    const content = entry.message?.content;
    if (role === "user" && !(Array.isArray(content) && content.every((part) => part.type === "tool_result"))) continue;
    if (typeof entry.uuid === "string") descendants.add(entry.uuid);
    if (role !== "assistant" || !["end_turn", "stop_sequence"].includes(entry.message.stop_reason)) continue;
    const text = Array.isArray(content) ? content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") : String(content ?? "");
    if (text.trim()) return { text: text.trim(), msgId: entry.uuid, source: "transcript", inReplyTo: msgId };
  }
  return null;
}

/**
 * Registers this process as a peer that Claude sessions can see in their agent
 * list and reply to. Without a registered socket, Claude has no address to
 * answer on and the conversation stays one-way.
 */
export class PeerEndpoint {
  constructor({ name = `codex-${process.pid}`, cwd = process.cwd(), log = () => {} } = {}) {
    this.name = name;
    this.cwd = cwd;
    this.log = log;
    this.pid = process.pid;
    this.socketPath = peerSocketPath(this.pid);
    this.registryPath = path.join(sessionsDir(), `${this.pid}.json`);
    this.keyPath = null;
    this.server = null;
    this.inbox = [];
    this.listeners = new Set();
    this.messageSequence = 0;
    this.requestQueues = new Map();
    this.unconfirmedReplies = new Map();
    this.started = false;
    this.peerToken = null;
    this.permissionMode = process.env.CLAUDE_BRIDGE_PERMISSION_MODE;
    this.deliveryReceipts = new Map();
    this.sentMessages = new Map();
    this.pendingMessages = new Map();
    this.responsePoll = null;
  }

  /**
   * A bridge killed with SIGKILL leaves its registry entry and socket behind,
   * and Claude then lists a crowd of dead peers with the same name. Sweep the
   * leftovers of previous bridge runs before advertising this one.
   */
  #sweepDeadBridges() {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const registry = path.join(dir, file);
      const entry = readSessionEntry(registry);
      if (!entry) continue;
      if (entry?.entrypoint !== BRIDGE_ENTRYPOINT) continue;
      if (!entry.pid || entry.pid === this.pid || isProcessAlive(entry.pid)) continue;
      for (const stale of [registry, entry.messagingSocketPath, ...fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${entry.pid}.`) && f.endsWith(".key"))
        .map((f) => path.join(dir, f))]) {
        if (!stale) continue;
        try {
          fs.rmSync(stale, { force: true });
        } catch {}
      }
      this.log(`swept dead bridge peer pid ${entry.pid}`);
    }
  }

  async start() {
    if (this.started) return;
    this.#sweepDeadBridges();
    const procStart = readProcessStart(this.pid);
    const peerToken = crypto.randomBytes(16).toString("hex");
    this.peerToken = peerToken;
    this.keyPath = peerKeyPath(this.pid, this.socketPath);

    if (!IS_WINDOWS) fs.mkdirSync(SOCKET_DIR, { recursive: true });
    fs.mkdirSync(sessionsDir(), { recursive: true });
    if (!IS_WINDOWS && fs.existsSync(this.socketPath)) fs.rmSync(this.socketPath, { force: true });

    await new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.#handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    if (!IS_WINDOWS) fs.chmodSync(this.socketPath, 0o600);

    const processIdentity = procStart ? (IS_WINDOWS ? { procStartFt: procStart } : { procStart }) : {};
    this.registry = {
      pid: this.pid,
      sessionId: crypto.randomUUID(),
      cwd: this.cwd,
      startedAt: Date.now(),
      ...processIdentity,
      version: CLAUDE_VERSION_HINT,
      peerProtocol: PEER_PROTOCOL_VERSION,
      kind: "interactive",
      entrypoint: BRIDGE_ENTRYPOINT,
      messagingSocketPath: this.socketPath,
      name: this.name,
      nameSource: "derived",
    };
    fs.writeFileSync(this.registryPath, JSON.stringify(this.registry), { mode: 0o600 });
    fs.writeFileSync(this.keyPath, JSON.stringify({ peerToken, ...processIdentity }), { mode: 0o600 });

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => {
        this.stop();
        process.exit(0);
      });
    }
    process.on("exit", () => this.stop());

    this.started = true;
    this.log(`peer "${this.name}" listening on ${this.socketPath}`);
  }

  #handleConnection(socket) {
    let buffer = "";
    let authenticated = false;
    let firstLine = true;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1048576) { socket.destroy(); return; }
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) {
          if (IS_WINDOWS && !authenticated) { socket.destroy(); return; }
          continue;
        }
        let message;
        try {
          const frame = JSON.parse(line);
          if (firstLine && frame?.type === "auth") {
            firstLine = false;
            const supplied = typeof frame.token === "string" ? Buffer.from(frame.token) : Buffer.alloc(0);
            const expected = Buffer.from(this.peerToken ?? "");
            authenticated = expected.length > 0 && supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
            if (!authenticated) { socket.destroy(); return; }
            continue;
          }
          firstLine = false;
          if (IS_WINDOWS && !authenticated) { socket.destroy(); return; }
          if (frame?.type === "control" && frame.action === "peer_message_status") {
            if (typeof frame.orig_msg_id === "string" && typeof frame.from === "string") {
              const receipt = {
                status: frame.status_detail === "refused" ? "refused" : frame.status,
                reason: typeof frame.reason === "string" ? frame.reason : "",
                fromSocket: decodePeerAddress(frame.from),
              };
              const pending = this.pendingMessages.get(frame.orig_msg_id);
              if (pending?.targetSocket === receipt.fromSocket) {
                this.deliveryReceipts.set(frame.orig_msg_id, receipt);
                if (["refused", "denied", "expired", "dropped"].includes(receipt.status)) this.#removePendingReply(receipt.fromSocket, frame.orig_msg_id);
              }
            }
            continue;
          }
          message = parseFrame(line);
        } catch {
          if (IS_WINDOWS && !authenticated) { socket.destroy(); return; }
          this.log("ignored malformed peer frame");
          continue;
        }
        if (!message) continue;
        this.#receiveMessage(message);
      }
    });
    socket.on("error", (err) => this.log(`peer socket error: ${err.message}`));
  }

  #receiveMessage(message) {
    const record = { ...message, receivedAt: Date.now(), sequence: ++this.messageSequence };
    this.inbox.push(record);
    const key = record.inReplyTo ?? [...this.pendingMessages].find(([, entry]) => entry.targetSocket === record.fromSocket)?.[0];
    if (key && this.pendingMessages.get(key)?.targetSocket === record.fromSocket) {
      const sent = this.sentMessages.get(key);
      if (sent) {
        record.inReplyTo = key;
        record.replyThreadId = sent.replyThreadId ?? null;
        sent.reply = record;
      }
      this.#removePendingReply(record.fromSocket, key);
    }
    this.log(`inbox <- ${record.fromSocket ?? "?"}: ${record.text.slice(0, 120)}`);
    for (const listener of [...this.listeners]) {
      try { listener(record); }
      catch (err) { this.log(`peer listener error: ${err.message}`); }
    }
  }

  #refreshTranscriptReplies() {
    for (const [msgId, pending] of this.pendingMessages) {
      if (!pending.transcriptSession) continue;
      const { sessionId, cwd } = pending.transcriptSession;
      const file = findTranscriptFile(sessionId, cwd);
      let stamp;
      try { const stat = fs.statSync(file); stamp = `${stat.mtimeMs}:${stat.size}`; }
      catch { continue; }
      if (stamp === pending.transcriptStamp) continue;
      pending.transcriptStamp = stamp;
      const reply = readTranscriptReply(sessionId, cwd, msgId);
      if (reply) this.#receiveMessage({ ...reply, fromSocket: pending.targetSocket });
    }
    if (![...this.pendingMessages.values()].some((entry) => entry.transcriptSession)) {
      globalThis.clearInterval(this.responsePoll);
      this.responsePoll = null;
    }
  }

  /**
   * Codex starts one bridge per session, so several peers advertise at once.
   * Renaming to the bound thread is what lets a human tell them apart in
   * Claude's agent list.
   */
  rename(name) {
    if (!name || name === this.name) return this.name;
    this.name = name;
    if (this.started && this.registry) {
      this.registry.name = name;
      fs.writeFileSync(this.registryPath, JSON.stringify(this.registry), { mode: 0o600 });
      this.log(`peer renamed to "${name}"`);
    }
    return this.name;
  }

  onMessage(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(targetSocket, text, { priority = "next", msgId, permissionMode = this.permissionMode, beforeSend } = {}) {
    const frame = buildFrame({ text, fromSocket: this.socketPath, priority, permissionMode });
    if (msgId) frame.uuid = frame.msg_id = msgId;
    const token = readPeerToken(targetSocket);
    const line = (token ? JSON.stringify({ type: "auth", token }) + "\n" : "") + JSON.stringify(frame) + "\n";
    for (let attempt = 1; attempt <= PEER_SEND_ATTEMPTS; attempt += 1) {
      await beforeSend?.();
      try {
        await new Promise((resolve, reject) => {
          const client = net.connect({ path: targetSocket });
          let connected = false;
          let writeStarted = false;
          let settled = false;
          const timer = globalThis.setTimeout(() => {
            const error = new Error("timed out connecting to " + targetSocket);
            error.code = "ETIMEDOUT";
            finish(error);
            client.destroy();
          }, PEER_CONNECT_TIMEOUT_MS);
          const finish = (error) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timer);
            if (error) {
              if (writeStarted) error.deliveryUncertain = true;
              reject({ error, retryable: !connected && !writeStarted });
            } else {
              resolve();
            }
          };
          client.once("connect", async () => {
            connected = true;
            try {
              await beforeSend?.();
              if (settled) return;
              writeStarted = true;
              client.write(line, (error) => {
                if (error) {
                  finish(error);
                  return;
                }
                client.end();
                finish();
              });
            } catch (error) {
              finish(error);
              client.destroy();
            }
          });
          client.once("error", finish);
        });
        return frame.msg_id;
      } catch (failure) {
        const error = failure?.error ?? failure;
        if (!failure?.retryable || attempt === PEER_SEND_ATTEMPTS || !RETRYABLE_PEER_ERRORS.has(error?.code)) {
          throw error;
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, PEER_RETRY_DELAY_MS));
      }
    }
    return frame.msg_id;
  }

  async sendAndWait(targetSocket, text, { timeoutMs = 120000, priority = "next", transcriptSession, beforeSend, permissionMode = this.permissionMode, replyThreadId } = {}) {
    const previous = this.requestQueues.get(targetSocket) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      await beforeSend?.();
      const unconfirmed = this.unconfirmedReplies.get(targetSocket) ?? 0;
      if (unconfirmed > 0) {
        const error = new Error(
          `${unconfirmed} earlier message(s) to ${targetSocket} still await a reply; this message was not sent. `
          + "Inspect read_claude_delivery and wait for Claude's outstanding replies. Changing waitSec or starting another bridge must not be used to bypass a pending message.",
        );
        error.code = "PEER_REPLY_PENDING";
        throw error;
      }
      const since = Date.now();
      const afterSequence = this.messageSequence;
      this.unconfirmedReplies.set(targetSocket, unconfirmed + 1);
      let msgId = crypto.randomUUID();
      this.pendingMessages.set(msgId, { targetSocket, transcriptSession });
      this.sentMessages.set(msgId, { targetSocket, transcriptSession, sentAt: since, replyThreadId, permissionMode });
      if (transcriptSession && !this.responsePoll) {
        this.responsePoll = globalThis.setInterval(() => this.#refreshTranscriptReplies(), 250);
        this.responsePoll.unref();
      }
      try {
        const sentId = await this.send(targetSocket, text, { priority, msgId, permissionMode, beforeSend });
        if (sentId !== msgId) {
          const pendingMessage = this.pendingMessages.get(msgId);
          const earlyReply = this.sentMessages.get(msgId)?.reply;
          if (earlyReply?.inReplyTo === msgId) earlyReply.inReplyTo = sentId;
          this.pendingMessages.delete(msgId);
          this.sentMessages.set(sentId, this.sentMessages.get(msgId));
          this.sentMessages.delete(msgId);
          msgId = sentId;
          if (pendingMessage) this.pendingMessages.set(msgId, pendingMessage);
        }
      } catch (err) {
        const sent = this.sentMessages.get(msgId);
        if (sent) sent.error = err.message;
        if (!err.deliveryUncertain) {
          this.#removePendingReply(targetSocket, msgId);
          if (sent) sent.failed = true;
        }
        err.msgId = msgId;
        throw err;
      }
      const reply = timeoutMs > 0
        ? await this.waitForReply(targetSocket, { timeoutMs, since, afterSequence, msgId })
        : null;
      const delivery = this.deliveryReceipts.get(msgId);
      if (delivery?.fromSocket === targetSocket) return { msgId, reply, delivery };
      return { msgId, reply };
    });
    this.requestQueues.set(targetSocket, pending);
    try {
      return await pending;
    } finally {
      if (this.requestQueues.get(targetSocket) === pending) this.requestQueues.delete(targetSocket);
    }
  }

  #removePendingReply(fromSocket, msgId) {
    const key = msgId ?? [...this.pendingMessages].find(([, entry]) => entry.targetSocket === fromSocket)?.[0];
    if (!key || this.pendingMessages.get(key)?.targetSocket !== fromSocket) return;
    this.pendingMessages.delete(key);
    const pending = this.unconfirmedReplies.get(fromSocket) ?? 0;
    if (pending > 1) this.unconfirmedReplies.set(fromSocket, pending - 1);
    else this.unconfirmedReplies.delete(fromSocket);
  }

  /**
   * Claude answers with a fresh msg_id rather than an in-reply-to field, so a
   * reply is matched by origin socket and arrival time.
   */
  waitForReply(fromSocket, { timeoutMs = 120000, since = Date.now(), afterSequence = null, msgId } = {}) {
    const matches = (record) => record.fromSocket === fromSocket
      && (!record.inReplyTo || !msgId || record.inReplyTo === msgId)
      && (afterSequence === null ? record.receivedAt >= since : record.sequence > afterSequence);
    const existing = this.inbox.find(matches);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const finish = (reply) => {
        unsubscribe();
        globalThis.clearTimeout(timer);
        globalThis.clearInterval(poll);
        resolve(reply);
      };
      const timer = globalThis.setTimeout(() => finish(null), timeoutMs);
      const unsubscribe = this.onMessage((record) => {
        if (!matches(record)) return;
        finish(record);
      });
      const poll = msgId ? globalThis.setInterval(() => {
        const receipt = this.deliveryReceipts.get(msgId);
        if (receipt?.fromSocket === fromSocket && ["held", "refused", "denied", "expired", "dropped"].includes(receipt.status)) { finish(null); return; }
      }, 250) : null;
    });
  }

  drainInbox(limit = 20) {
    const messages = this.inbox.slice(-limit);
    this.inbox = [];
    return messages;
  }

  readDelivery(msgId) {
    const sent = this.sentMessages.get(msgId);
    if (!sent) return null;
    const delivery = this.deliveryReceipts.get(msgId);
    const session = sent.transcriptSession;
    return {
      msgId,
      status: sent.reply ? "reply_received" : sent.failed ? "send_failed" : delivery?.status ?? "sent_unconfirmed",
      reason: delivery?.reason ?? sent.error ?? null,
      sentAt: sent.sentAt,
      sessionId: session?.sessionId ?? null,
      cwd: session?.cwd ?? null,
      entrypoint: session?.entrypoint ?? null,
      taskId: session?.desktop?.taskId ?? null,
      title: session?.desktop?.title ?? null,
      senderMode: sent.permissionMode ?? null,
      replyThreadId: sent.replyThreadId ?? null,
      pending: this.pendingMessages.has(msgId),
      ...(sent.reply ? { reply: sent.reply.text, source: sent.reply.source ?? "peer" } : {}),
    };
  }

  stop() {
    globalThis.clearInterval(this.responsePoll);
    this.responsePoll = null;
    this.pendingMessages.clear();
    try {
      this.server?.close();
    } catch {}
    for (const file of [this.socketPath, this.registryPath, this.keyPath]) {
      if (!file) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
    this.started = false;
  }
}
