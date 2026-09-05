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
  readTranscript,
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
    const parsed = parseFrame(JSON.stringify({ message: { content: "plain text" }, from: null }));
    assert.equal(parsed.text, "plain text");
    assert.equal(parsed.fromSocket, null);
  });

  it("throws on a line that is not JSON", () => {
    assert.throws(() => parseFrame("not json at all"));
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
});

describe("Windows peer endpoint", { skip: isWindows ? false : "Windows named-pipe regression" }, () => {
  it("retries while a Claude named pipe is starting", async () => {
    const socketPath = namedPipePath();
    const server = net.createServer();
    const received = new Promise((resolve, reject) => {
      server.on("error", reject);
      server.on("connection", (socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const index = buffer.indexOf("\n");
          if (index < 0) return;
          resolve(parseFrame(buffer.slice(0, index)));
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

  after(() => endpoint.stop());

  function receiveMessage(fromSocket, text) {
    const frame = buildFrame({ text, fromSocket });
    return new Promise((resolve, reject) => {
      const unsubscribe = endpoint.onMessage((record) => {
        if (record.msgId !== frame.msg_id) return;
        unsubscribe();
        resolve(record);
      });
      const socket = net.connect({ path: endpoint.socketPath }, () => {
        socket.end(`${JSON.stringify(frame)}\n`);
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
    assert.ok(fs.existsSync(endpoint.socketPath));
    if (!isWindows) {
      assert.equal(fs.statSync(endpoint.socketPath).mode & 0o777, 0o600, "the socket mode is the entire access control");
    }
  });

  it("preserves multibyte text split between socket chunks", async () => {
    const text = "Chao sếp 🚀";
    const fromSocket = "fragmented-peer";
    const frame = Buffer.from(`${JSON.stringify(buildFrame({ text, fromSocket }))}\n`);
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
        client.write(`${JSON.stringify(frame)}\n`, () => {
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
        client.write(`{ broken\n${JSON.stringify(good)}\n`, () => {
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
      && /not sent/.test(err.message) && /read_claude_inbox/.test(err.message) && /waitSec to 0/.test(err.message));
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

  it("waits for every outstanding no-wait reply before accepting a waited send", async (t) => {
    const sent = [];
    t.mock.method(endpoint, "send", async (targetSocket, text) => {
      sent.push(text);
      return text;
    });
    await endpoint.sendAndWait("many-no-wait-peer", "first", { timeoutMs: 0 });
    await endpoint.sendAndWait("many-no-wait-peer", "second", { timeoutMs: 0 });
    assert.equal(endpoint.unconfirmedReplies.get("many-no-wait-peer"), 2);
    await receiveMessage("many-no-wait-peer", "first answer");
    assert.equal(endpoint.unconfirmedReplies.get("many-no-wait-peer"), 1);
    await assert.rejects(
      endpoint.sendAndWait("many-no-wait-peer", "refused", { timeoutMs: 1000 }),
      (err) => err.code === "PEER_REPLY_PENDING",
    );
    assert.deepEqual(sent, ["first", "second"]);
    await receiveMessage("many-no-wait-peer", "second answer");
    const waited = endpoint.sendAndWait("many-no-wait-peer", "third", { timeoutMs: 1000 });
    await yieldToEvents();
    await receiveMessage("many-no-wait-peer", "third answer");
    assert.equal((await waited).reply.text, "third answer");
    assert.deepEqual(sent, ["first", "second", "third"]);
  });

  it("preserves earlier outstanding ownership when a later no-wait send fails", async (t) => {
    t.mock.method(endpoint, "send", async (targetSocket, text) => {
      if (text === "fail") throw new Error("no-wait send failed");
      return text;
    });
    await endpoint.sendAndWait("failed-no-wait-peer", "first", { timeoutMs: 0 });
    await assert.rejects(
      endpoint.sendAndWait("failed-no-wait-peer", "fail", { timeoutMs: 0 }),
      /no-wait send failed/,
    );
    assert.equal(endpoint.unconfirmedReplies.get("failed-no-wait-peer"), 1);
    await assert.rejects(
      endpoint.sendAndWait("failed-no-wait-peer", "waited", { timeoutMs: 1000 }),
      (err) => err.code === "PEER_REPLY_PENDING",
    );
    await receiveMessage("failed-no-wait-peer", "first answer");
    assert.equal(endpoint.unconfirmedReplies.has("failed-no-wait-peer"), false);
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
