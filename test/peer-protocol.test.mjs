import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { setImmediate as yieldToEvents } from "node:timers/promises";

import {
  BRIDGE_ENTRYPOINT,
  PeerEndpoint,
  buildFrame,
  findClaudeSession,
  listClaudeSessions,
  parseFrame,
  peerKeyPath,
  readTranscript,
  readTranscriptReply,
} from "../src/peer-protocol.mjs";

/**
 * The module reads ~/.claude at call time, so pointing HOME at a scratch
 * directory keeps the suite off the developer's real session registry - which
 * these tests would otherwise both read and litter.
 */
const realHome = process.env.HOME;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-"));
const sessionsDir = path.join(sandbox, ".claude", "sessions");
const projectsDir = path.join(sandbox, ".claude", "projects");

const isWindows = process.platform === "win32";

function namedPipePath() {
  return "\\\\.\\pipe\\LOCAL\\cc-peer-test-" + process.pid + "-" + Math.random().toString(16).slice(2);
}

function writeSession(name, entry) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${name}.json`), JSON.stringify(entry));
}

before(() => {
  process.env.HOME = sandbox;
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
});

after(() => {
  process.env.HOME = realHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("peer frames", () => {
  it("round-trips text through the cross-session wrapper", () => {
    const text = "line one\nline two with <angle> brackets & an ampersand";
    const frame = buildFrame({ text, fromSocket: "/tmp/cc-socks/42.sock" });

    assert.equal(frame.msgV, 1);
    assert.equal(frame.type, "user");
    assert.equal(frame.from, "uds:/tmp/cc-socks/42.sock");
    assert.match(frame.message.content, /^<cross-session-message /);

    const parsed = parseFrame(JSON.stringify(frame));
    assert.equal(parsed.text, text);
    assert.equal(parsed.fromSocket, "/tmp/cc-socks/42.sock");
    assert.equal(parsed.msgId, frame.msg_id);
  });

  it("gives every message its own id", () => {
    const a = buildFrame({ text: "x", fromSocket: "/tmp/a.sock" });
    const b = buildFrame({ text: "x", fromSocket: "/tmp/a.sock" });
    assert.notEqual(a.msg_id, b.msg_id);
  });

  it("falls back to the raw content when the wrapper is absent", () => {
    const parsed = parseFrame(JSON.stringify({ type: "user", message: { content: "plain text" }, from: null }));
    assert.equal(parsed.text, "plain text");
    assert.equal(parsed.fromSocket, null);
  });

  it("throws on a line that is not JSON", () => {
    assert.throws(() => parseFrame("not json at all"));
  });

  it("encodes Windows reply addresses and never invents the sender permission class", () => {
    const fromSocket = "\\\\.\\pipe\\LOCAL\\cc-msg-" + "a".repeat(32);
    const frame = buildFrame({ text: "hello", fromSocket });
    assert.match(frame.from, /^uds:%5C%5C/);
    assert.doesNotMatch(frame.message.content, /from-mode/);
    assert.equal(parseFrame(JSON.stringify(frame)).fromSocket, fromSocket);
    assert.match(buildFrame({ text: "x", fromSocket, permissionMode: "prompting" }).message.content, /from-mode="prompting"/);
    assert.equal(frame.uuid, frame.msg_id);
  });

  it("does not turn auth or control frames into empty replies", () => {
    assert.equal(parseFrame('{"type":"auth","token":"secret"}'), null);
    assert.equal(parseFrame('{"type":"control","action":"peer_message_status","status":"held"}'), null);
  });
});

describe("session registry", () => {
  it("lists a live session and skips a dead one", () => {
    const liveSocket = path.join(sandbox, "live.sock");
    fs.writeFileSync(liveSocket, "");
    writeSession("live", {
      pid: process.pid,
      sessionId: "session-live",
      name: "live-one",
      cwd: "/work",
      startedAt: 2,
      messagingSocketPath: liveSocket,
    });
    writeSession("dead", {
      pid: 999999,
      sessionId: "session-dead",
      name: "dead-one",
      startedAt: 1,
      messagingSocketPath: path.join(sandbox, "gone.sock"),
    });

    const live = listClaudeSessions();
    assert.deepEqual(
      live.map((s) => s.sessionId),
      ["session-live"],
    );
    assert.equal(listClaudeSessions({ includeDead: true }).length, 2);
  });

  it(
    "keeps a live Windows named-pipe session visible while the pipe is starting",
    { skip: isWindows ? false : "Windows named-pipe regression" },
    () => {
      writeSession("pipe-starting", {
        pid: process.pid,
        sessionId: "session-pipe-starting",
        name: "pipe-starting",
        startedAt: 0,
        messagingSocketPath: "\\\\.\\pipe\\LOCAL\\cc-msg-not-created-yet",
      });
      assert.equal(listClaudeSessions().find((s) => s.sessionId === "session-pipe-starting")?.alive, true);
    },
  );

  /**
   * Codex starts one bridge per session and each registers a peer, so without
   * this filter the bridge would list its own siblings as Claude sessions and
   * happily message them.
   */
  it("hides bridge peers unless asked for them", () => {
    writeSession("bridge", {
      pid: process.pid,
      sessionId: "session-bridge",
      name: "codex-1234",
      startedAt: 3,
      entrypoint: BRIDGE_ENTRYPOINT,
      messagingSocketPath: path.join(sandbox, "live.sock"),
    });

    assert.ok(!listClaudeSessions().some((s) => s.sessionId === "session-bridge"));
    assert.ok(listClaudeSessions({ includeBridges: true }).some((s) => s.sessionId === "session-bridge"));
  });

  it("ignores unreadable registry files instead of failing the listing", () => {
    fs.writeFileSync(path.join(sessionsDir, "broken.json"), "{ not json");
    assert.ok(listClaudeSessions().length >= 1);
  });

  it("finds a session by pid, sessionId, exact name and partial name", () => {
    assert.equal(findClaudeSession(String(process.pid))?.sessionId, "session-live");
    assert.equal(findClaudeSession("session-live")?.sessionId, "session-live");
    assert.equal(findClaudeSession("live-one")?.sessionId, "session-live");
    assert.equal(findClaudeSession("LIVE-")?.sessionId, "session-live");
    assert.equal(findClaudeSession("nothing-like-this"), null);
  });

  it("requires a unique exact Desktop target and refuses unknown entrypoints", () => {
    const desktop = { pid: process.pid, sessionId: "desktop-session", name: "desktop-target", messagingSocketPath: path.join(sandbox, "live.sock"), entrypoint: "claude-desktop" };
    writeSession("desktop-policy", desktop);
    try {
      assert.equal(findClaudeSession("desktop-session", { desktopOnly: true }).sessionId, "desktop-session");
      assert.equal(findClaudeSession("desktop-target", { desktopOnly: true }).sessionId, "desktop-session");
      assert.equal(findClaudeSession("desktop-targ", { desktopOnly: true }), null);
      assert.equal(findClaudeSession("", { desktopOnly: true }), null);
      assert.throws(() => findClaudeSession("session-live", { desktopOnly: true }), /Desktop-only mode refuses.*unknown/);
      writeSession("desktop-policy-duplicate", { ...desktop, sessionId: "another-desktop-session" });
      assert.throws(() => findClaudeSession("desktop-target", { desktopOnly: true }), /unambiguous.*multiple sessions/);
      assert.equal(findClaudeSession("desktop-session", { desktopOnly: true }).sessionId, "desktop-session");
    } finally {
      fs.rmSync(path.join(sessionsDir, "desktop-policy.json"), { force: true });
      fs.rmSync(path.join(sessionsDir, "desktop-policy-duplicate.json"), { force: true });
    }
  });
});

describe("Windows peer endpoint", { skip: isWindows ? false : "Windows named-pipe regression" }, () => {
  it("refuses missing authentication before opening a target connection", async () => {
    const endpoint = new PeerEndpoint();
    await assert.rejects(endpoint.send(namedPipePath(), "never sent"), /No unique live session/);
  });

  it("derives the same key for canonical Windows pipe aliases", () => {
    assert.equal(peerKeyPath(123, "\\\\.\\pipe\\LOCAL\\CC-MSG-abc"), peerKeyPath(123, "//./pipe/local/cc-msg-abc"));
    assert.throws(() => peerKeyPath(123, "\\\\remote\\pipe\\name"), /non-local/);
    assert.throws(() => peerKeyPath(123, "\\\\.\\pipe\\LOCAL\\nested\\name"), /non-local/);
  });
  it("retries while a Claude named pipe is starting", async () => {
    const socketPath = namedPipePath();
    const token = "a".repeat(32);
    writeSession("auth-target", { pid: process.pid, messagingSocketPath: socketPath });
    fs.writeFileSync(peerKeyPath(process.pid, socketPath), JSON.stringify({ peerToken: token }));
    const server = net.createServer();
    const received = new Promise((resolve, reject) => {
      server.on("error", reject);
      server.on("connection", (socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          if (lines.length < 3) return;
          assert.deepEqual(JSON.parse(lines[0]), { type: "auth", token });
          resolve(parseFrame(lines[1]));
          socket.destroy();
        });
        socket.on("error", reject);
      });
    });
    const listening = new Promise((resolve, reject) => {
      globalThis.setTimeout(() => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      }, 40);
    });
    const endpoint = new PeerEndpoint({ name: "sender", cwd: sandbox });
    try {
      await Promise.all([endpoint.send(socketPath, "hello"), listening]);
      const frame = await received;
      assert.equal(frame.text, "hello");
    } finally {
      server.close();
      fs.rmSync(path.join(sessionsDir, "auth-target.json"));
      fs.rmSync(peerKeyPath(process.pid, socketPath));
    }
  });
});

describe("transcript reading", () => {
  /**
   * Claude Code slugifies the cwd into the project directory name and the
   * rewrite is lossy (/mnt/dev_disk becomes -mnt-dev-disk), so the transcript
   * is found by scanning rather than by rebuilding the slug.
   */
  it("finds a transcript whose project directory does not match the cwd slug", () => {
    const projectDir = path.join(projectsDir, "-mnt-dev-disk-codex-mcp-bridge");
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [
      { message: { role: "user", content: [{ type: "text", text: "first" }] } },
      { message: { role: "assistant", content: [{ type: "text", text: "second" }] } },
      { isMeta: true, message: { role: "user", content: "ignored meta" } },
      { isSidechain: true, message: { role: "assistant", content: "ignored sidechain" } },
      { message: { role: "user", content: "   " } },
      "not json",
      { message: { role: "assistant", content: "third" } },
    ].map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
    fs.writeFileSync(path.join(projectDir, "abc.jsonl"), `${lines.join("\n")}\n`);

    const { file, messages } = readTranscript("abc", "/mnt/dev_disk/codex-mcp-bridge", 10);
    assert.equal(file, path.join(projectDir, "abc.jsonl"));
    assert.deepEqual(
      messages.map((m) => m.text),
      ["first", "second", "third"],
    );
  });

  it("returns the last N messages only", () => {
    const { messages } = readTranscript("abc", "/mnt/dev_disk/codex-mcp-bridge", 2);
    assert.deepEqual(
      messages.map((m) => m.text),
      ["second", "third"],
    );
  });

  it("reports an empty transcript rather than throwing when the file is missing", () => {
    const { messages } = readTranscript("no-such-session", "/nowhere", 5);
    assert.deepEqual(messages, []);
  });
});

describe("peer endpoint", () => {
  let endpoint;

  before(() => {
    endpoint = new PeerEndpoint({ name: "test-peer", cwd: sandbox });
  });

  it("matches only a completed assistant turn descended from the exact injected UUID", () => {
    const dir = path.join(projectsDir, "reply-fixture");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "reply.jsonl");
    const user = { uuid: "request", isMeta: true, message: { role: "user", content: "ping" } };
    const tool = { uuid: "tool", parentUuid: "request", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "working" }] } };
    const result = { uuid: "result", parentUuid: "tool", message: { role: "user", content: [{ type: "tool_result", content: "done" }] } };
    const answer = { uuid: "answer", parentUuid: "result", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "correct answer" }] } };
    const write = (rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    write([user, tool, result]);
    assert.equal(readTranscriptReply("reply", "unused", "request"), null);
    write([user, tool, result, answer]);
    assert.equal(readTranscriptReply("reply", "unused", "request")?.text, "correct answer");
    assert.equal(readTranscriptReply("reply", "unused", "other-request"), null);
    write([user, { uuid: "human", parentUuid: "request", message: { role: "user", content: "unrelated question" } }, { ...answer, parentUuid: "human" }]);
    assert.equal(readTranscriptReply("reply", "unused", "request"), null);
    write([user, { ...answer, parentUuid: "request", isSidechain: true }]);
    assert.equal(readTranscriptReply("reply", "unused", "request"), null);
  });

  /**
   * A message that arrives while the recipient is mid-turn is absorbed into
   * that turn: Claude Code records it as a queued_command attachment under a
   * fresh uuid whose source_uuid is the injected message id, and the turn's
   * closing text is the reply. Measured on Claude Code 2.1.260 in Claude
   * Desktop on 2026-09-06; an idle recipient instead records a user entry
   * whose uuid is the message id, which the test above covers.
   */
  it("matches a reply to a message absorbed mid-turn through its queued_command attachment", () => {
    const dir = path.join(projectsDir, "busy-fixture");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "busy.jsonl");
    const prompt = { uuid: "prompt", message: { role: "user", content: "keep working" } };
    const tool = { uuid: "tool", parentUuid: "prompt", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use" }] } };
    const result = { uuid: "result", parentUuid: "tool", message: { role: "user", content: [{ type: "tool_result", content: "done" }] } };
    const absorbed = { uuid: "absorbed", parentUuid: "result", type: "attachment", attachment: { type: "queued_command", source_uuid: "request", commandMode: "prompt", origin: { kind: "peer", msg_id: "request", fromMode: "bypass" }, isMeta: true } };
    const reminder = { uuid: "reminder", parentUuid: "absorbed", type: "attachment", attachment: { type: "silent_turn_reminder", text: "say something" } };
    const thinking = { uuid: "thinking", parentUuid: "reminder", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }] } };
    const answer = { uuid: "answer", parentUuid: "thinking", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "absorbed answer" }] } };
    const write = (rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    write([prompt, tool, result, absorbed, reminder, thinking]);
    assert.equal(readTranscriptReply("busy", "unused", "request"), null);
    write([prompt, tool, result, absorbed, reminder, thinking, answer]);
    assert.deepEqual(readTranscriptReply("busy", "unused", "request"), { text: "absorbed answer", msgId: "answer", source: "transcript", inReplyTo: "request", absorbed: true });
    assert.equal(readTranscriptReply("busy", "unused", "other"), null);
    write([prompt, tool, result, { ...absorbed, attachment: { type: "silent_turn_reminder", source_uuid: "request", origin: { kind: "peer", msg_id: "request" } } }, { ...answer, parentUuid: "absorbed" }]);
    assert.equal(readTranscriptReply("busy", "unused", "request"), null, "only a queued_command attachment records an injected message");
    write([prompt, tool, result, { ...absorbed, attachment: { type: "queued_command", origin: { kind: "peer", msg_id: "request" } } }, { ...answer, parentUuid: "absorbed" }]);
    assert.equal(readTranscriptReply("busy", "unused", "request")?.absorbed, true, "older Claude Code records only origin.msg_id");
    const idle = { uuid: "fresh", isMeta: true, origin: { kind: "peer", msg_id: "request" }, message: { role: "user", content: "ping" } };
    write([idle, { ...answer, parentUuid: "fresh" }]);
    assert.deepEqual(readTranscriptReply("busy", "unused", "request"), { text: "absorbed answer", msgId: "answer", source: "transcript", inReplyTo: "request", absorbed: false });
  });

  it("correlates legacy queued messages by peer origin instead of an unrelated source UUID", () => {
    const dir = path.join(projectsDir, "legacy-queued-replies");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "legacy.jsonl");
    for (const version of ["2.1.229", "2.1.237"]) {
      const root = { uuid: "queued-root", version, type: "attachment", attachment: { type: "queued_command", source_uuid: "unrelated-source", commandMode: "prompt", origin: { kind: "peer", msg_id: "request", fromMode: "bypass" }, isMeta: true } };
      const answer = { uuid: "answer", parentUuid: "queued-root", version, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "legacy answer" }] } };
      fs.writeFileSync(file, [root, answer].map((row) => JSON.stringify(row)).join("\n") + "\n");
      assert.deepEqual(readTranscriptReply("legacy", "unused", "request"), { text: "legacy answer", msgId: "answer", source: "transcript", inReplyTo: "request", absorbed: true }, version);
      assert.equal(readTranscriptReply("legacy", "unused", "unrelated-source"), null, "source_uuid must not claim the reply");
    }
  });

  it("rejects ambiguous roots and responses that cross another command", () => {
    const dir = path.join(projectsDir, "correlation-boundaries");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "boundaries.jsonl");
    const root = { uuid: "root", type: "attachment", attachment: { type: "queued_command", source_uuid: "request", origin: { kind: "peer", msg_id: "request" } } };
    const answer = { uuid: "answer", parentUuid: "root", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "answer" }] } };
    const cases = [
      ["conflicting origin ID", [{ ...root, attachment: { ...root.attachment, origin: { kind: "peer", msg_id: "other" } } }, answer]],
      ["non-peer attachment origin", [{ ...root, attachment: { ...root.attachment, origin: { kind: "user", msg_id: "request" } } }, answer]],
      ["missing attachment origin", [{ ...root, attachment: { type: "queued_command", source_uuid: "request" } }, answer]],
      ["non-peer idle origin", [{ uuid: "root", origin: { kind: "user", msg_id: "request" }, message: { role: "user", content: "prompt" } }, answer]],
      ["contradictory idle origin", [{ uuid: "request", origin: { kind: "peer", msg_id: "other" }, message: { role: "user", content: "prompt" } }, { ...answer, parentUuid: "request" }]],
      ["empty root UUID", [{ ...root, uuid: "" }, { ...answer, parentUuid: "" }]],
      ["multiple matching roots", [root, answer, { ...root, uuid: "second-root" }]],
      ["later queued peer command", [root, { ...root, uuid: "next", parentUuid: "root", attachment: { type: "queued_command", origin: { kind: "peer", msg_id: "other" } } }, { ...answer, parentUuid: "next" }]],
      ["later queued human command", [root, { uuid: "next", parentUuid: "root", type: "attachment", attachment: { type: "queued_command", prompt: "new question" } }, { ...answer, parentUuid: "next" }]],
      ["empty user input", [root, { uuid: "next", parentUuid: "root", message: { role: "user", content: [] } }, { ...answer, parentUuid: "next" }]],
    ];
    for (const [name, rows] of cases) {
      fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      assert.equal(readTranscriptReply("boundaries", "unused", "request"), null, name);
    }
    fs.writeFileSync(file, [root, { uuid: "other", parentUuid: "root", type: "attachment", attachment: { type: "queued_command", prompt: "new question" } }, answer].map((row) => JSON.stringify(row)).join("\n") + "\n");
    assert.equal(readTranscriptReply("boundaries", "unused", "request")?.text, "answer", "a separate command branch must not cut the original branch");
  });

  it("handles malformed transcript records and content without crashing", () => {
    const dir = path.join(projectsDir, "malformed-replies");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "malformed.jsonl");
    const root = { uuid: "request", message: { role: "user", content: "prompt" } };
    const answer = { uuid: "answer", parentUuid: "request", message: { role: "assistant", stop_reason: "end_turn", content: [null, 1, { type: "text", text: {} }, { type: "text", text: "valid answer" }] } };
    const write = (rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n{incomplete");
    write([null, [], 3, "text", root, answer]);
    assert.equal(readTranscriptReply("malformed", "unused", "request")?.text, "valid answer");
    write([root, { uuid: "result", parentUuid: "request", message: { role: "user", content: [null] } }, { ...answer, parentUuid: "result" }]);
    assert.equal(readTranscriptReply("malformed", "unused", "request"), null);
  });

  after(() => endpoint.stop());

  const authLine = () => JSON.stringify({ type: "auth", token: endpoint.peerToken }) + "\n";

  function receiveMessage(fromSocket, text) {
    const frame = buildFrame({ text, fromSocket });
    return new Promise((resolve, reject) => {
      const unsubscribe = endpoint.onMessage((record) => {
        if (record.msgId !== frame.msg_id) return;
        unsubscribe();
        resolve(record);
      });
      const socket = net.connect({ path: endpoint.socketPath }, () => {
        socket.end(`${authLine()}${JSON.stringify(frame)}\n`);
      });
      socket.once("error", (err) => {
        unsubscribe();
        reject(err);
      });
    });
  }

  it("advertises itself so Claude can list and answer it", async () => {
    await endpoint.start();

    const registry = JSON.parse(fs.readFileSync(endpoint.registryPath, "utf8"));
    assert.equal(registry.entrypoint, BRIDGE_ENTRYPOINT);
    assert.equal(registry.name, "test-peer");
    assert.equal(registry.messagingSocketPath, endpoint.socketPath);
    assert.equal(endpoint.keyPath, peerKeyPath(process.pid, endpoint.socketPath));
    if (isWindows) assert.match(endpoint.socketPath, /^\\\\\.\\pipe\\LOCAL\\cc-msg-[0-9a-f]{32}$/);
    assert.ok(fs.existsSync(endpoint.socketPath));
    if (!isWindows) {
      assert.equal(fs.statSync(endpoint.socketPath).mode & 0o777, 0o600, "the socket mode is the entire access control");
    }
  });

  it("rejects missing and incorrect Windows authentication without delivering a message", { skip: !isWindows }, async () => {
    const count = endpoint.messageSequence;
    const frame = JSON.stringify(buildFrame({ text: "rejected", fromSocket: "unauthenticated" })) + "\n";
    for (const payload of [frame, '{"type":"auth","token":"wrong"}\n' + frame]) {
      await new Promise((resolve, reject) => {
        const socket = net.connect(endpoint.socketPath, () => socket.end(payload));
        socket.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
        socket.on("close", resolve);
      });
    }
    assert.equal(endpoint.messageSequence, count);
  });

  it("keeps held receipts separate from replies and matches the original message id", async (t) => {
    t.mock.method(endpoint, "send", async () => "held-id");
    const waiting = endpoint.sendAndWait("held-peer", "hello", { timeoutMs: 1500 });
    await yieldToEvents();
    await new Promise((resolve, reject) => {
      const socket = net.connect(endpoint.socketPath, () => socket.end(authLine() + JSON.stringify({ type: "control", action: "peer_message_status", orig_msg_id: "held-id", from: "uds:held-peer", status: "held", reason: "Approval needed" }) + "\n"));
      socket.on("error", reject);
      socket.on("close", resolve);
    });
    const result = await waiting;
    assert.equal(result.reply, null);
    assert.equal(result.delivery.status, "held");
    assert.equal(endpoint.unconfirmedReplies.get("held-peer"), 1);
    assert.equal(endpoint.inbox.some((entry) => entry.msgId === "held-id"), false);
    assert.equal(endpoint.readDelivery("held-id").status, "held");
    await assert.rejects(endpoint.sendAndWait("held-peer", "retry", { timeoutMs: 0 }), /earlier message/);
    assert.equal(endpoint.send.mock.callCount(), 1);
    await new Promise((resolve, reject) => {
      const socket = net.connect(endpoint.socketPath, () => socket.end(authLine() + JSON.stringify({ type: "control", action: "peer_message_status", orig_msg_id: "held-id", from: "uds:held-peer", status: "expired", reason: "Recipient approval expired" }) + "\n"));
      socket.on("error", reject);
      socket.on("close", resolve);
    });
    assert.equal(endpoint.readDelivery("held-id").status, "expired");
    assert.equal(endpoint.readDelivery("held-id").pending, false);
  });

  it("preserves pending ownership when a transport error cannot prove non-delivery", async (t) => {
    t.mock.method(endpoint, "send", async () => { throw Object.assign(new Error("write completion unknown"), { deliveryUncertain: true }); });
    let msgId;
    await assert.rejects(endpoint.sendAndWait("uncertain-peer", "first", { timeoutMs: 0 }), (error) => {
      msgId = error.msgId;
      return error.deliveryUncertain;
    });
    assert.equal(endpoint.readDelivery(msgId).status, "sent_unconfirmed");
    assert.equal(endpoint.readDelivery(msgId).pending, true);
    await assert.rejects(endpoint.sendAndWait("uncertain-peer", "retry", { timeoutMs: 0 }), /earlier message/);
    assert.equal(endpoint.send.mock.callCount(), 1);
  });

  it("keeps a late Desktop transcript response after timeout and clears pending ownership", async (t) => {
    const dir = path.join(projectsDir, "late-reply");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "late-session.jsonl");
    let request;
    t.mock.method(endpoint, "send", async (target, text, options) => {
      request = options.msgId;
      fs.writeFileSync(file, JSON.stringify({ uuid: request, isMeta: true, message: { role: "user", content: text } }) + "\n");
      return request;
    });
    const response = await endpoint.sendAndWait("late-desktop", "hello", { timeoutMs: 20, transcriptSession: { sessionId: "late-session", cwd: "unused" } });
    assert.equal(response.reply, null);
    assert.equal(endpoint.unconfirmedReplies.get("late-desktop"), 1);
    const waiting = endpoint.waitForReply("late-desktop", { timeoutMs: 1500 });
    fs.appendFileSync(file, JSON.stringify({ uuid: "late-answer", parentUuid: request, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "late verified" }] } }) + "\n");
    const answer = await waiting;
    assert.equal(answer?.text, "late verified");
    assert.equal(answer?.source, "transcript");
    assert.equal(endpoint.unconfirmedReplies.has("late-desktop"), false);
    assert.ok(endpoint.drainInbox(100).some((entry) => entry.inReplyTo === request));
  });

  it("does not consume a Desktop request when its peer sends an unrelated notification", async (t) => {
    await endpoint.start();
    const dir = path.join(projectsDir, "correlated-desktop");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "correlated-session.jsonl");
    let request;
    t.mock.method(endpoint, "send", async (target, text, options) => {
      request = options.msgId;
      fs.writeFileSync(file, JSON.stringify({ uuid: request, isMeta: true, message: { role: "user", content: text } }) + "\n");
      await receiveMessage(target, "Unrelated peer notification");
      return request;
    });
    const response = await endpoint.sendAndWait("correlated-desktop", "hello", {
      timeoutMs: 20,
      transcriptSession: { sessionId: "correlated-session", cwd: "unused" },
      replyThreadId: "original-desktop-task",
    });
    assert.equal(response.reply, null);
    assert.equal(endpoint.readDelivery(request).pending, true);
    assert.equal(endpoint.readDelivery(request).status, "sent_unconfirmed");
    const waiting = endpoint.waitForReply("correlated-desktop", { msgId: request, timeoutMs: 1500 });
    fs.appendFileSync(file, JSON.stringify({ uuid: "correlated-answer", parentUuid: request, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Actual Desktop answer" }] } }) + "\n");
    const answer = await waiting;
    assert.equal(answer?.text, "Actual Desktop answer");
    assert.equal(answer?.replyThreadId, "original-desktop-task");
    assert.equal(endpoint.readDelivery(request).pending, false);
  });

  it("preserves multibyte text split between socket chunks", async () => {
    const text = "Chao sếp 🚀";
    const fromSocket = "fragmented-peer";
    const frame = Buffer.from(`${authLine()}${JSON.stringify(buildFrame({ text, fromSocket }))}\n`);
    const split = frame.indexOf(Buffer.from("ế")) + 1;
    const waiting = endpoint.waitForReply(fromSocket, { timeoutMs: 3000 });
    const socket = new PassThrough();
    endpoint.server.emit("connection", socket);
    try {
      socket.write(frame.subarray(0, split));
      socket.end(frame.subarray(split));
      assert.equal((await waiting)?.text, text);
    } finally {
      socket.destroy();
    }
  });

  it("receives a message and hands it to waitForReply", async () => {
    const from = "/tmp/cc-socks/claude-test.sock";
    const waiting = endpoint.waitForReply(from, { timeoutMs: 3000 });

    await new Promise((resolve, reject) => {
      const client = net.connect({ path: endpoint.socketPath }, () => {
        const frame = buildFrame({ text: "hello from Claude", fromSocket: from });
        client.write(`${authLine()}${JSON.stringify(frame)}\n`, () => {
          client.end();
          resolve();
        });
      });
      client.on("error", reject);
    });

    const reply = await waiting;
    assert.ok(reply, "the endpoint never received the frame");
    assert.equal(reply.text, "hello from Claude");
    assert.equal(reply.fromSocket, from);
  });

  it("drops malformed frames without dropping the connection", async () => {
    await new Promise((resolve, reject) => {
      const client = net.connect({ path: endpoint.socketPath }, () => {
        const good = buildFrame({ text: "still working", fromSocket: "/tmp/cc-socks/other.sock" });
        client.write(`${authLine()}{ broken\n${JSON.stringify(good)}\n`, () => {
          client.end();
          resolve();
        });
      });
      client.on("error", reject);
    });

    await new Promise((r) => globalThis.setTimeout(r, 100));
    const drained = endpoint.drainInbox(10);
    assert.ok(drained.some((m) => m.text === "still working"));
    assert.deepEqual(endpoint.drainInbox(10), [], "draining must empty the inbox");
  });

  it("renames itself in the registry so several bridges stay distinguishable", async () => {
    endpoint.rename("codex-01a0beef");
    const registry = JSON.parse(fs.readFileSync(endpoint.registryPath, "utf8"));
    assert.equal(registry.name, "codex-01a0beef");
  });

  it("drains inbox pages in arrival order without deleting unread messages", () => {
    const isolated = new PeerEndpoint({ name: "inbox-pagination" });
    const messages = Array.from({ length: 5 }, (_, index) => ({ msgId: `message-${index}`, text: `Reply ${index}` }));
    isolated.inbox.push(...messages);
    assert.deepEqual(isolated.drainInbox(2), messages.slice(0, 2));
    assert.deepEqual(isolated.drainInbox(2), messages.slice(2, 4));
    assert.deepEqual(isolated.drainInbox(2), messages.slice(4));
    assert.deepEqual(isolated.drainInbox(2), []);
  });

  it("preserves another account's unread replies while draining the active account", () => {
    const isolated = new PeerEndpoint({ name: "account-inbox" });
    const oldReply = { msgId: "old", text: "Old account", accountContext: { codex: "a" } };
    const currentReply = { msgId: "current", text: "Current account", accountContext: { codex: "b" } };
    isolated.inbox.push(oldReply, currentReply);
    assert.deepEqual(isolated.drainInbox(1, (record) => record.accountContext.codex === "b"), [currentReply]);
    assert.deepEqual(isolated.inbox, [oldReply]);
    assert.deepEqual(isolated.drainInbox(1, (record) => record.accountContext.codex === "a"), [oldReply]);
  });

  it("serializes requests to one peer without reusing same-millisecond replies", async (t) => {
    t.mock.method(Date, "now", () => 12345);
    const sent = [];
    t.mock.method(endpoint, "send", async (targetSocket, text) => {
      sent.push({ targetSocket, text });
      return text;
    });
    const first = endpoint.sendAndWait("queued-peer", "first", { timeoutMs: 1000 });
    const second = endpoint.sendAndWait("queued-peer", "second", { timeoutMs: 1000 });
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await yieldToEvents();
    assert.deepEqual(sent.map((entry) => entry.text), ["first"]);
    await receiveMessage("queued-peer", "first answer");
    assert.equal((await first).reply.text, "first answer");
    await yieldToEvents();
    assert.deepEqual(sent.map((entry) => entry.text), ["first", "second"]);
    assert.equal(secondSettled, false);
    await receiveMessage("queued-peer", "second answer");
    assert.equal((await second).reply.text, "second answer");
    assert.equal(endpoint.requestQueues.size, 0);
  });

  it("allows requests to different peers to wait independently", async (t) => {
    const sent = [];
    t.mock.method(endpoint, "send", async (targetSocket) => {
      sent.push(targetSocket);
      return targetSocket;
    });
    const first = endpoint.sendAndWait("parallel-first", "first", { timeoutMs: 1000 });
    const second = endpoint.sendAndWait("parallel-second", "second", { timeoutMs: 1000 });
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    await yieldToEvents();
    assert.deepEqual(sent, ["parallel-first", "parallel-second"]);
    await receiveMessage("parallel-second", "second answer");
    assert.equal((await second).reply.text, "second answer");
    assert.equal(firstSettled, false);
    await receiveMessage("parallel-first", "first answer");
    assert.equal((await first).reply.text, "first answer");
  });

  it("keeps a reply that arrives before sending finishes", async (t) => {
    t.mock.method(endpoint, "send", async (targetSocket) => {
      await receiveMessage(targetSocket, "fast answer");
      return "fast-message";
    });
    const result = await endpoint.sendAndWait("fast-peer", "hello", { timeoutMs: 1000 });
    assert.equal(result.msgId, "fast-message");
    assert.equal(result.reply.text, "fast answer");
  });

  it("keeps sender permissions and reply destinations local to concurrent requests", async (t) => {
    await endpoint.start();
    const originalMode = endpoint.permissionMode;
    t.after(() => { endpoint.permissionMode = originalMode; });
    const sent = [];
    t.mock.method(endpoint, "send", async (socket, text, options) => {
      sent.push({ socket, mode: options.permissionMode });
      return options.msgId;
    });
    const firstAccounts = { codex: "codex-a", claude: "claude-a" };
    const secondAccounts = { codex: "codex-b", claude: "claude-b" };
    const first = endpoint.sendAndWait("caller-first", "first", { timeoutMs: 1000, permissionMode: "bypass", replyThreadId: "task-first", accountContext: firstAccounts });
    const second = endpoint.sendAndWait("caller-second", "second", { timeoutMs: 1000, permissionMode: "prompting", replyThreadId: "task-second", accountContext: secondAccounts });
    await yieldToEvents();
    endpoint.permissionMode = "prompting";
    await receiveMessage("caller-second", "second reply");
    await receiveMessage("caller-first", "first reply");
    const results = await Promise.all([first, second]);
    assert.deepEqual(sent, [{ socket: "caller-first", mode: "bypass" }, { socket: "caller-second", mode: "prompting" }]);
    assert.equal(results[0].reply.replyThreadId, "task-first");
    assert.equal(results[1].reply.replyThreadId, "task-second");
    assert.deepEqual(results[0].reply.accountContext, firstAccounts);
    assert.deepEqual(results[1].reply.accountContext, secondAccounts);
    assert.equal(Object.isFrozen(results[0].reply.accountContext), true);
    assert.equal(endpoint.readDelivery(results[0].msgId).replyThreadId, "task-first");
    assert.equal(endpoint.readDelivery(results[0].msgId).senderMode, "bypass");
  });

  it("revalidates sender evidence after connecting and never writes a stale request", async () => {
    const destination = isWindows ? namedPipePath() : path.join(sandbox, "stale-sender.sock");
    let bytes = 0;
    let closed;
    const disconnected = new Promise((resolve) => { closed = resolve; });
    const receiver = net.createServer((socket) => {
      socket.on("data", (data) => { bytes += data.length; });
      socket.on("close", closed);
    });
    await new Promise((resolve) => receiver.listen(destination, resolve));
    writeSession("stale-sender", { pid: process.pid, messagingSocketPath: destination, cwd: sandbox });
    fs.writeFileSync(peerKeyPath(process.pid, destination), JSON.stringify({ peerToken: "c".repeat(32) }));
    let checks = 0;
    try {
      await assert.rejects(endpoint.sendAndWait(destination, "never write", {
        timeoutMs: 0,
        beforeSend: () => {
          if (++checks === 3) throw new Error("Sender turn ended");
        },
      }), /Sender turn ended/);
      await disconnected;
      assert.equal(bytes, 0);
      assert.equal(endpoint.unconfirmedReplies.has(destination), false);
    } finally {
      await new Promise((resolve) => receiver.close(resolve));
      fs.rmSync(path.join(sessionsDir, "stale-sender.json"));
      fs.rmSync(peerKeyPath(process.pid, destination));
    }
  });

  it("continues a peer queue after sending fails", async (t) => {
    t.mock.method(endpoint, "send", async (targetSocket, text) => {
      if (text === "fail") throw new Error("send failed");
      return text;
    });
    const failed = endpoint.sendAndWait("recovered-peer", "fail", { timeoutMs: 1000 });
    const next = endpoint.sendAndWait("recovered-peer", "next", { timeoutMs: 1000 });
    await assert.rejects(failed, /send failed/);
    await yieldToEvents();
    assert.equal(endpoint.unconfirmedReplies.get("recovered-peer"), 1);
    await receiveMessage("recovered-peer", "recovered answer");
    assert.equal((await next).reply.text, "recovered answer");
    assert.equal(endpoint.requestQueues.size, 0);
    assert.equal(endpoint.unconfirmedReplies.has("recovered-peer"), false);
  });

  it("refuses queued waited sends until a timed-out request receives its late reply", async (t) => {
    const sent = [];
    t.mock.method(endpoint, "send", async (targetSocket, text) => {
      sent.push(text);
      return text;
    });
    const expired = endpoint.sendAndWait("timeout-peer", "expire", { timeoutMs: 20 });
    const next = endpoint.sendAndWait("timeout-peer", "next", { timeoutMs: 1000 });
    const refused = assert.rejects(next, (err) => err.code === "PEER_REPLY_PENDING"
      && /not sent/.test(err.message) && /read_claude_delivery/.test(err.message) && /must not be used to bypass/.test(err.message));
    await yieldToEvents();
    assert.deepEqual(sent, ["expire"]);
    assert.equal((await expired).reply, null);
    await refused;
    assert.deepEqual(sent, ["expire"]);
    assert.equal(endpoint.unconfirmedReplies.get("timeout-peer"), 1);
    const late = await receiveMessage("timeout-peer", "late expired answer");
    assert.ok(endpoint.drainInbox(100).includes(late));
    assert.equal(endpoint.unconfirmedReplies.has("timeout-peer"), false);
    const retry = endpoint.sendAndWait("timeout-peer", "retry", { timeoutMs: 1000 });
    await yieldToEvents();
    assert.deepEqual(sent, ["expire", "retry"]);
    await receiveMessage("timeout-peer", "retry answer");
    assert.equal((await retry).reply.text, "retry answer");
  });

  it("sends without installing a reply waiter when timeout is zero", async (t) => {
    t.mock.method(endpoint, "send", async () => "fire-and-forget");
    const listenerCount = endpoint.listeners.size;
    const result = await endpoint.sendAndWait("no-wait-peer", "hello", { timeoutMs: 0 });
    assert.deepEqual(result, { msgId: "fire-and-forget", reply: null });
    assert.equal(endpoint.listeners.size, listenerCount);
    assert.equal(endpoint.requestQueues.size, 0);
    assert.equal(endpoint.unconfirmedReplies.get("no-wait-peer"), 1);
    await assert.rejects(
      endpoint.sendAndWait("no-wait-peer", "waited follow-up", { timeoutMs: 1000 }),
      (err) => err.code === "PEER_REPLY_PENDING",
    );
    assert.equal(endpoint.send.mock.callCount(), 1);
    await receiveMessage("no-wait-peer", "fire-and-forget answer");
    assert.equal(endpoint.unconfirmedReplies.has("no-wait-peer"), false);
  });

  it("refuses no-wait messages until the outstanding reply arrives", async (t) => {
    const sent = [];
    t.mock.method(endpoint, "send", async (targetSocket, text) => {
      sent.push(text);
      return text;
    });
    await endpoint.sendAndWait("many-no-wait-peer", "first", { timeoutMs: 0 });
    for (const timeoutMs of [0, 1000]) {
      await assert.rejects(endpoint.sendAndWait("many-no-wait-peer", "refused", { timeoutMs }),
        (err) => err.code === "PEER_REPLY_PENDING");
    }
    assert.equal(endpoint.unconfirmedReplies.get("many-no-wait-peer"), 1);
    assert.deepEqual(sent, ["first"]);
    await receiveMessage("many-no-wait-peer", "first answer");
    const waited = endpoint.sendAndWait("many-no-wait-peer", "second", { timeoutMs: 1000 });
    await yieldToEvents();
    await receiveMessage("many-no-wait-peer", "second answer");
    assert.equal((await waited).reply.text, "second answer");
    assert.deepEqual(sent, ["first", "second"]);
  });

  it("clears ownership when a no-wait reply arrives before sending finishes", async (t) => {
    t.mock.method(endpoint, "send", async (targetSocket, text) => {
      await receiveMessage(targetSocket, `${text} answer`);
      return text;
    });
    await endpoint.sendAndWait("fast-no-wait-peer", "first", { timeoutMs: 0 });
    assert.equal(endpoint.unconfirmedReplies.has("fast-no-wait-peer"), false);
    const next = await endpoint.sendAndWait("fast-no-wait-peer", "second", { timeoutMs: 1000 });
    assert.equal(next.reply.text, "second answer");
  });

  it("gives up waiting instead of hanging forever", async () => {
    const startedAt = Date.now();
    const reply = await endpoint.waitForReply("/tmp/cc-socks/never.sock", { timeoutMs: 150 });
    assert.equal(reply, null);
    assert.ok(Date.now() - startedAt >= 140);
  });

  it("removes its registry entry and socket on stop", () => {
    endpoint.stop();
    assert.ok(!fs.existsSync(endpoint.registryPath));
    assert.ok(!fs.existsSync(endpoint.socketPath));
  });
});
