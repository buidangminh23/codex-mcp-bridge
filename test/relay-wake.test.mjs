import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";

import { createRelayWake, endpointAnswers, recentDesktopTaskFor, relayWakeEnabled } from "../src/relay-wake.mjs";
import { DesktopTaskDelivery, RELAY_DOWN_GUIDANCE } from "../src/thread-delivery.mjs";
import { NativeRelayError } from "../src/native-relay.mjs";

const ids = {
  latest: "01a15746-88bc-7de0-a7ee-f8c2e9767fbf",
  older: "01a1572f-bdf0-7693-983d-678fe49c79ab",
  other: "01a1586b-21ea-7660-97fc-144e7bea8614",
  cli: "01a1338c-6c88-7931-b937-8928025b42e4",
  executor: "01a071bc-3739-7ce2-93e4-f59220245944",
  target: "01a15f09-cbc7-7792-a8a3-507750699337",
};

function sessionsFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "relay-wake-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const elsewhere = path.join(root, "elsewhere");
  fs.mkdirSync(project);
  fs.mkdirSync(elsewhere);
  const sessions = path.join(root, "sessions");
  let tick = 0;
  const write = (day, id, cwd, { originator = "Codex Desktop", compressed = false } = {}) => {
    const directory = path.join(sessions, "2026", "10", day);
    fs.mkdirSync(directory, { recursive: true });
    const body = `${JSON.stringify({ type: "session_meta", payload: { id, cwd, originator } })}\n${JSON.stringify({ type: "event_msg" })}\n`;
    const file = path.join(directory, `rollout-2026-10-${day}T10-00-00-${id}.jsonl${compressed ? ".zst" : ""}`);
    fs.writeFileSync(file, compressed ? zlib.zstdCompressSync(Buffer.from(body)) : body);
    const stamp = new Date(Date.UTC(2026, 9, 1) + (tick += 60000));
    fs.utimesSync(file, stamp, stamp);
  };
  return { root, project, elsewhere, sessions, write };
}

describe("relay wake", () => {
  it("picks the most recent Codex Desktop task of the sender's project and skips the executor, CLI and other projects", async (t) => {
    const { project, elsewhere, sessions, write } = sessionsFixture(t);
    write("13", ids.older, project, { compressed: true });
    write("20", ids.cli, project, { originator: "codex_cli_rs" });
    write("20", ids.latest, project);
    write("20", ids.other, elsewhere);
    write("21", ids.executor, project);
    assert.equal(await recentDesktopTaskFor(project, { sessions, exclude: [ids.executor] }), ids.latest);
    assert.equal(await recentDesktopTaskFor(project, { sessions, exclude: [ids.executor, ids.latest] }), ids.older);
    assert.equal(await recentDesktopTaskFor(path.join(project, "missing"), { sessions }), null);
    assert.equal(await recentDesktopTaskFor(null, { sessions }), null);
  });

  it("opens the destination task in the background and waits for the relay socket", async () => {
    const opened = [];
    let live = false;
    let time = 0;
    const wake = createRelayWake({
      enabled: true, desktopRunning: () => true, executorThreadId: () => ids.executor,
      findTask: async () => { throw new Error("the destination is known"); },
      open: async (threadId) => { opened.push(threadId); },
      answers: async () => { time += 1000; if (time > 3000) live = true; return live; },
      now: () => time, sleep: async () => {},
    });
    assert.deepEqual(await wake({ socketPath: "/tmp/relay.sock", threadId: ids.target }), { threadId: ids.target });
    assert.deepEqual(opened, [ids.target]);
  });

  it("falls back to the sender project's recent task, never wakes through the executor, and backs off after a failure", async () => {
    const opened = [];
    let time = 0;
    const findings = [];
    const wake = createRelayWake({
      enabled: true, desktopRunning: () => true, executorThreadId: () => ids.executor, senderCwd: () => "/project",
      findTask: async (cwd, exclude) => { findings.push([cwd, exclude]); return ids.latest; },
      open: async (threadId) => { opened.push(threadId); },
      answers: async () => false, waitMs: 5000, cooldownMs: 60000,
      now: () => time, sleep: async (ms) => { time += ms; },
    });
    assert.equal(await wake({ socketPath: "/tmp/relay.sock", threadId: ids.executor }), null);
    assert.deepEqual(opened, [ids.latest]);
    assert.deepEqual(findings, [["/project", [ids.executor]]]);
    assert.equal(await wake({ socketPath: "/tmp/relay.sock", threadId: ids.target }), null);
    assert.deepEqual(opened, [ids.latest]);
    time += 60000;
    assert.equal(await wake({ socketPath: "/tmp/relay.sock", threadId: ids.target }), null);
    assert.deepEqual(opened, [ids.latest, ids.target]);
  });

  it("does nothing when disabled, when Codex Desktop is not running or when no task is known", async () => {
    const opened = [];
    const base = { executorThreadId: () => null, open: async (threadId) => { opened.push(threadId); }, answers: async () => true, findTask: async () => null };
    assert.equal(await createRelayWake({ ...base, enabled: false, desktopRunning: () => true })({ socketPath: "/s", threadId: ids.target }), null);
    assert.equal(await createRelayWake({ ...base, enabled: true, desktopRunning: () => false })({ socketPath: "/s", threadId: ids.target }), null);
    assert.equal(await createRelayWake({ ...base, enabled: true, desktopRunning: () => true })({ socketPath: "/s", threadId: "not-a-task" }), null);
    assert.deepEqual(opened, []);
    assert.equal(relayWakeEnabled({}, "darwin"), true);
    assert.equal(relayWakeEnabled({ CODEX_BRIDGE_RELAY_WAKE: "0" }, "darwin"), false);
    assert.equal(relayWakeEnabled({}, "win32"), true);
    assert.equal(relayWakeEnabled({ CODEX_BRIDGE_RELAY_WAKE: "off" }, "win32"), false);
    assert.equal(relayWakeEnabled({}, "linux"), false);
  });

  it("waits for an asynchronous Codex Desktop check before opening anything", async () => {
    const opened = [];
    const wake = createRelayWake({
      enabled: true, desktopRunning: async () => false, executorThreadId: () => null,
      open: async (threadId) => { opened.push(threadId); }, answers: async () => true, findTask: async () => null,
    });
    assert.equal(await wake({ socketPath: "/s", threadId: ids.target }), null);
    assert.deepEqual(opened, []);
  });

  it("finds a Desktop task of the same repository when the sender works in a linked worktree", async (t) => {
    const { root, sessions, write } = sessionsFixture(t);
    const repo = path.join(root, "repo");
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(repo);
    git("init", "-q");
    git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const worktree = path.join(root, "worktree");
    git("worktree", "add", "-q", worktree);
    write("20", ids.latest, repo);
    assert.equal(await recentDesktopTaskFor(worktree, { sessions }), ids.latest);
  });

  it("coalesces concurrent wakes into one open", async () => {
    const opened = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const wake = createRelayWake({
      enabled: true, desktopRunning: () => true, executorThreadId: () => null,
      open: async (threadId) => { opened.push(threadId); await gate; }, answers: async () => true, sleep: async () => {},
    });
    const first = wake({ socketPath: "/s", threadId: ids.target });
    const second = wake({ socketPath: "/s", threadId: ids.latest });
    release();
    assert.deepEqual(await Promise.all([first, second]), [{ threadId: ids.target }, { threadId: ids.target }]);
    assert.deepEqual(opened, [ids.target]);
  });

  it("checks an endpoint by connecting to it", async (t) => {
    let socketPath;
    if (process.platform === "win32") socketPath = String.raw`\\.\pipe\LOCAL\relay-wake-test-${process.pid}-${Date.now()}`;
    else {
      const directory = fs.mkdtempSync(path.join("/tmp", "rw-"));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      socketPath = path.join(directory, "s.sock");
    }
    assert.equal(await endpointAnswers(socketPath), false);
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(socketPath, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    assert.equal(await endpointAnswers(socketPath), true);
  });
});

describe("Desktop delivery relay wake", () => {
  const unreachable = () => Object.assign(new NativeRelayError("Codex Desktop relay connection failed at /s: connect ENOENT /s", "RELAY_UNREACHABLE"), { sent: false });
  const delivery = (relay, wakeRelay) => new DesktopTaskDelivery({ relay, security: { assertCwd() {} }, wakeRelay });

  it("wakes the relay once and retries a request that never reached it", async () => {
    let attempts = 0;
    const wakes = [];
    const relay = { socketPath: "/legacy.sock", accountSocketPath: "/accounts.sock", async requestDesktop() { if (attempts++ === 0) throw unreachable(); return { result: { projects: [] } }; } };
    const result = await delivery(relay, async (request) => { wakes.push(request); return { threadId: ids.latest }; }).request("list_projects", {});
    assert.deepEqual(result, { projects: [] });
    assert.equal(attempts, 2);
    assert.deepEqual(wakes.map(({ operation, socketPath, threadId }) => ({ operation, socketPath, threadId })), [{ operation: "list_projects", socketPath: "/legacy.sock", threadId: undefined }]);
  });

  it("does not retry after a failed wake, a delivered request or a non-relay failure, and names the relay only when it is down", async () => {
    const wakes = [];
    const wakeRelay = async (request) => { wakes.push(request.operation); return null; };
    await assert.rejects(delivery({ async requestDesktop() { throw unreachable(); } }, wakeRelay).request("list_projects", {}), (error) => {
      assert.ok(error.message.includes(RELAY_DOWN_GUIDANCE));
      assert.doesNotMatch(error.message, /\.\. /);
      return true;
    });
    let sends = 0;
    const delivered = Object.assign(new NativeRelayError("The Codex Desktop relay at /s closed before answering", "RELAY_DELIVERY_UNCONFIRMED"), { reachedCompanion: true });
    await assert.rejects(delivery({ async requestDesktop() { sends++; throw delivered; } }, wakeRelay).request("list_projects", {}), (error) => {
      assert.doesNotMatch(error.message, /native relay is not listening/);
      return true;
    });
    assert.equal(sends, 1);
    await assert.rejects(delivery({ async requestDesktop() { throw new Error("Bridge source changed after this MCP process started."); } }, wakeRelay).request("list_projects", {}), (error) => {
      assert.match(error.message, /started\. Desktop-only mode/);
      assert.doesNotMatch(error.message, /native relay is not listening/);
      return true;
    });
    assert.deepEqual(wakes, ["list_projects"]);
  });
});
