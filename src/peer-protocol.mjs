import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCKET_DIR = "/tmp/cc-socks";
const PEER_PROTOCOL_VERSION = 1;
const CLAUDE_VERSION_HINT = "2.1.229";
const PS_BIN = "/bin/ps";

const sessionsDir = () => path.join(os.homedir(), ".claude", "sessions");
const projectsDir = () => path.join(os.homedir(), ".claude", "projects");

/**
 * A Claude Code session advertises itself in ~/.claude/sessions/<pid>.json and
 * listens for peer messages on a unix socket. Messages are newline-delimited
 * JSON; the wrapper element is what Claude renders in its chat surface.
 */
export function buildFrame({ text, fromSocket, priority = "next" }) {
  return {
    msgV: PEER_PROTOCOL_VERSION,
    msg_id: crypto.randomUUID(),
    type: "user",
    message: {
      role: "user",
      content: `<cross-session-message from="uds:${fromSocket}" from-mode="bypass">\n${text}\n</cross-session-message>`,
    },
    priority,
    from: `uds:${fromSocket}`,
  };
}

export function parseFrame(line) {
  const frame = JSON.parse(line);
  const raw = frame?.message?.content ?? "";
  const inner = raw.match(/<cross-session-message[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/);
  return {
    msgId: frame.msg_id ?? null,
    from: frame.from ?? null,
    fromSocket: (frame.from ?? "").replace(/^uds:/, "") || null,
    text: (inner ? inner[1] : raw).trim(),
  };
}

/**
 * MCP servers are spawned with an empty PATH, so `ps` must be addressed by its
 * absolute path - a bare lookup throws ENOENT and takes the whole server down
 * before it can answer the client's initialize call. The timestamp only guards
 * against pid reuse, so an empty value is an acceptable fallback.
 */
function readProcessStart(pid) {
  try {
    return execFileSync(PS_BIN, ["-o", "lstart=", "-p", String(pid)]).toString().trim();
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

export const BRIDGE_ENTRYPOINT = "codex-bridge";

export function listClaudeSessions({ includeDead = false, includeBridges = false } = {}) {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (!entry?.pid || !entry?.messagingSocketPath) continue;
    if (entry.entrypoint === BRIDGE_ENTRYPOINT && !includeBridges) continue;
    const alive = isProcessAlive(entry.pid) && fs.existsSync(entry.messagingSocketPath);
    if (!alive && !includeDead) continue;
    rows.push({
      pid: entry.pid,
      name: entry.name ?? null,
      sessionId: entry.sessionId ?? null,
      cwd: entry.cwd ?? null,
      kind: entry.kind ?? null,
      entrypoint: entry.entrypoint ?? null,
      startedAt: entry.startedAt ?? null,
      socket: entry.messagingSocketPath,
      alive,
    });
  }
  return rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function findClaudeSession(target) {
  const sessions = listClaudeSessions();
  const needle = String(target).trim();
  return (
    sessions.find((s) => String(s.pid) === needle) ??
    sessions.find((s) => s.sessionId === needle) ??
    sessions.find((s) => s.name === needle) ??
    sessions.find((s) => (s.name ?? "").toLowerCase().includes(needle.toLowerCase())) ??
    null
  );
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
    this.socketPath = path.join(SOCKET_DIR, `${this.pid}.sock`);
    this.registryPath = path.join(sessionsDir(), `${this.pid}.json`);
    this.keyPath = null;
    this.server = null;
    this.inbox = [];
    this.listeners = new Set();
    this.started = false;
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
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(registry, "utf8"));
      } catch {
        continue;
      }
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
    const keyHash = crypto.createHash("sha256").update(`${peerToken}${procStart}`).digest("hex");
    this.keyPath = path.join(sessionsDir(), `${this.pid}.${keyHash}.key`);

    fs.mkdirSync(SOCKET_DIR, { recursive: true });
    fs.mkdirSync(sessionsDir(), { recursive: true });
    if (fs.existsSync(this.socketPath)) fs.rmSync(this.socketPath, { force: true });

    await new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.#handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);

    this.registry = {
      pid: this.pid,
      sessionId: crypto.randomUUID(),
      cwd: this.cwd,
      startedAt: Date.now(),
      procStart,
      version: CLAUDE_VERSION_HINT,
      peerProtocol: PEER_PROTOCOL_VERSION,
      kind: "interactive",
      entrypoint: BRIDGE_ENTRYPOINT,
      messagingSocketPath: this.socketPath,
      name: this.name,
      nameSource: "derived",
    };
    fs.writeFileSync(this.registryPath, JSON.stringify(this.registry), { mode: 0o600 });
    fs.writeFileSync(this.keyPath, JSON.stringify({ peerToken, procStart }), { mode: 0o600 });

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
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = parseFrame(line);
        } catch {
          this.log(`ignored malformed peer frame (${line.slice(0, 80)})`);
          continue;
        }
        const record = { ...message, receivedAt: Date.now() };
        this.inbox.push(record);
        this.log(`inbox <- ${record.fromSocket ?? "?"}: ${record.text.slice(0, 120)}`);
        for (const listener of [...this.listeners]) {
          try {
            listener(record);
          } catch (err) {
            this.log(`peer listener error: ${err.message}`);
          }
        }
      }
    });
    socket.on("error", (err) => this.log(`peer socket error: ${err.message}`));
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

  async send(targetSocket, text, { priority = "next" } = {}) {
    const frame = buildFrame({ text, fromSocket: this.socketPath, priority });
    await new Promise((resolve, reject) => {
      const client = net.connect({ path: targetSocket }, () => {
        client.write(`${JSON.stringify(frame)}\n`, () => {
          client.end();
          resolve();
        });
      });
      client.on("error", reject);
    });
    return frame.msg_id;
  }

  /**
   * Claude answers with a fresh msg_id rather than an in-reply-to field, so a
   * reply is matched by origin socket and arrival time.
   */
  waitForReply(fromSocket, { timeoutMs = 120000, since = Date.now() } = {}) {
    const existing = this.inbox.find((m) => m.fromSocket === fromSocket && m.receivedAt >= since);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, timeoutMs);
      const unsubscribe = this.onMessage((record) => {
        if (record.fromSocket !== fromSocket) return;
        globalThis.clearTimeout(timer);
        unsubscribe();
        resolve(record);
      });
    });
  }

  drainInbox(limit = 20) {
    const messages = this.inbox.slice(-limit);
    this.inbox = [];
    return messages;
  }

  stop() {
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
