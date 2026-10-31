import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createRelayWake, endpointAnswers, relayWakeEnabled } from "../src/relay-wake.mjs";
import { DesktopTaskDelivery, RELAY_DOWN_GUIDANCE } from "../src/thread-delivery.mjs";
import { NativeRelayError } from "../src/native-relay.mjs";

const ids = { latest: "01a15746-88bc-7de0-a7ee-f8c2e9767fbf" };

describe("silent relay recovery", () => {
  it("waits for recovery without opening a task even when legacy wake flags are enabled", async () => {
    let time = 0;
    const messages = [];
    const wake = createRelayWake({
      enabled: true, env: { CODEX_BRIDGE_RELAY_KEEPER: "1", CODEX_BRIDGE_RELAY_WAKE: "1" },
      open: () => assert.fail("recovery must never open a task"),
      findTask: () => assert.fail("recovery must not select a task"),
      findAnyTask: () => assert.fail("recovery must not navigate another project"),
      answers: async () => time >= 500, now: () => time, sleep: async ms => { time += ms; },
      log: message => messages.push(message),
    });
    assert.deepEqual(await wake({ socketPath: "/s", threadId: ids.latest }), { threadId: null });
    assert.equal(time, 500);
    assert.match(messages[0], /original operation will verify native dispatch/);
  });

  it("bounds probes and sleeps by the caller's remaining deadline", async () => {
    let time = 0;
    const timeouts = [];
    const wake = createRelayWake({
      enabled: true, waitMs: 20000, now: () => time,
      answers: async (_path, options) => { timeouts.push(options.timeoutMs); return false; },
      sleep: async ms => { time += ms; },
    });
    assert.equal(await wake({ socketPath: "/s", deadline: 400 }), null);
    assert.equal(time, 400);
    assert.deepEqual(timeouts, [400, 150]);
    assert.equal(await wake({ socketPath: "/s", deadline: 399 }), null);
    assert.equal(timeouts.length, 2);
  });

  it("does not suppress recovery after a previous timeout", async () => {
    let time = 0;
    let ready = false;
    const wake = createRelayWake({ enabled: true, waitMs: 100, now: () => time,
      answers: async () => ready, sleep: async ms => { time += ms; } });
    assert.equal(await wake({ socketPath: "/s" }), null);
    ready = true;
    assert.deepEqual(await wake({ socketPath: "/s" }), { threadId: null });
  });

  it("never accepts a transport answer that arrived after the deadline", async () => {
    let time = 0;
    const wake = createRelayWake({ enabled: true, now: () => time,
      answers: async () => { time = 501; return true; } });
    assert.equal(await wake({ socketPath: "/s", deadline: 500 }), null);
  });

  it("respects explicit opt-outs and invalid endpoints without probing", async () => {
    const answers = async () => assert.fail("must not probe");
    assert.equal(await createRelayWake({ enabled: false, answers })({ socketPath: "/s" }), null);
    assert.equal(await createRelayWake({ enabled: true, answers })({ socketPath: "" }), null);
    assert.equal(relayWakeEnabled({ CODEX_BRIDGE_RELAY_WAKE: "0" }, "win32"), false);
    assert.equal(relayWakeEnabled({}, "win32"), true);
    assert.equal(relayWakeEnabled({}, "darwin"), true);
    assert.equal(relayWakeEnabled({}, "linux"), false);
  });

  it("recovers when a real relay socket appears and keeps concurrent deadlines separate", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-recover-"));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\relay-recover-${process.pid}-${Date.now()}` : path.join(root, "s");
    const server = net.createServer(socket => socket.destroy());
    let timer;
    t.after(async () => {
      clearTimeout(timer);
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    });
    assert.equal(await endpointAnswers(socketPath), false);
    const wake = createRelayWake({ enabled: true, waitMs: 3000, pollMs: 10 });
    const short = wake({ socketPath, deadline: Date.now() - 1 });
    const long = wake({ socketPath });
    timer = setTimeout(() => server.listen(socketPath), 30);
    assert.equal(await short, null);
    assert.deepEqual(await long, { threadId: null });
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

it("recomputes the operation budget after recovery and refuses an expired retry", async () => {
  let time = 0;
  const budgets = [];
  const relay = { socketPath: "/s", async requestDesktop(_op, _args, options) {
    budgets.push(options.timeoutMs);
    if (budgets.length === 1) throw Object.assign(new NativeRelayError("offline", "RELAY_UNREACHABLE"), { sent: false });
    return { result: { projects: [] } };
  } };
  const delivery = new DesktopTaskDelivery({ relay, security: { assertCwd() {} }, now: () => time,
    wakeRelay: async () => { time = 700; return { threadId: null }; } });
  assert.deepEqual(await delivery.request("list_projects", {}, { deadline: 1000 }), { projects: [] });
  assert.deepEqual(budgets, [1000, 300]);
  budgets.length = 0;
  time = 0;
  await assert.rejects(delivery.request("list_projects", {}, { deadline: 600 }), /deadline has elapsed/);
  assert.deepEqual(budgets, [600]);
});

it("does not report a successful operation merely because the relay socket recovered", async () => {
  let attempts = 0;
  const relay = { socketPath: "/s", async requestDesktop() {
    if (++attempts === 1) throw Object.assign(new NativeRelayError("offline", "RELAY_UNREACHABLE"), { sent: false });
    throw new NativeRelayError("native dispatch rejected", "NATIVE_DISPATCH_FAILED");
  } };
  const delivery = new DesktopTaskDelivery({ relay, security: { assertCwd() {} }, wakeRelay: async () => ({ threadId: null }) });
  await assert.rejects(delivery.request("list_projects", {}), /native dispatch rejected/);
  assert.equal(attempts, 2);
});
