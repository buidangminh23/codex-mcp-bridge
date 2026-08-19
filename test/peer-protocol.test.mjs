import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

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

describe("transcript reading", () => {
  /**
   * Claude Code slugifies the cwd into the project directory name and the
   * rewrite is lossy (/Volumes/Win_Dev becomes -Volumes-Win-Dev), so the
   * transcript is found by scanning rather than by rebuilding the slug.
   */
  it("finds a transcript whose project directory does not match the cwd slug", () => {
    const projectDir = path.join(projectsDir, "-Volumes-Win-Dev-codex-mcp-bridge");
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

    const { file, messages } = readTranscript("abc", "/Volumes/Win_Dev/codex-mcp-bridge", 10);
    assert.equal(file, path.join(projectDir, "abc.jsonl"));
    assert.deepEqual(
      messages.map((m) => m.text),
      ["first", "second", "third"],
    );
  });

  it("returns the last N messages only", () => {
    const { messages } = readTranscript("abc", "/Volumes/Win_Dev/codex-mcp-bridge", 2);
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

describe("peer endpoint", { skip: isWindows ? "unix sockets are POSIX-only" : false }, () => {
  const endpoint = new PeerEndpoint({ name: "test-peer", cwd: sandbox });

  after(() => endpoint.stop());

  it("advertises itself so Claude can list and answer it", async () => {
    await endpoint.start();

    const registry = JSON.parse(fs.readFileSync(endpoint.registryPath, "utf8"));
    assert.equal(registry.entrypoint, BRIDGE_ENTRYPOINT);
    assert.equal(registry.name, "test-peer");
    assert.equal(registry.messagingSocketPath, endpoint.socketPath);
    assert.ok(fs.existsSync(endpoint.socketPath));
    assert.equal(fs.statSync(endpoint.socketPath).mode & 0o777, 0o600, "the socket mode is the entire access control");
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
