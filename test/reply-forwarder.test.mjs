import assert from "node:assert/strict";
import { it } from "node:test";

import { ReplyForwarder } from "../src/reply-forwarder.mjs";

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function fixture(options = {}) {
  let timestamp = 0;
  let nextId = 0;
  const timers = new Map();
  const calls = [];
  const forwarder = new ReplyForwarder({
    deliver: async (threadId, record) => {
      calls.push({ threadId, record, at: timestamp });
      return { backend: "native-desktop" };
    },
    now: () => timestamp,
    schedule: (callback, delay) => {
      const id = nextId++;
      timers.set(id, { callback, at: timestamp + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    ...options,
  });
  return {
    forwarder,
    calls,
    timers,
    async next() {
      const pending = [...timers].sort((left, right) => left[1].at - right[1].at)[0];
      assert.ok(pending, "A scheduled forward must exist");
      const [id, timer] = pending;
      timers.delete(id);
      timestamp = timer.at;
      timer.callback();
      await flush();
    },
  };
}

const reply = (id, threadId = "original-task") => ({
  inReplyTo: id,
  msgId: `answer-${id}`,
  replyThreadId: threadId,
  fromSocket: "claude-session",
  text: `Reply for ${id}`,
});

it("queues rapid replies without loss and returns each to its original task", async () => {
  const f = fixture();
  for (const [id, thread] of [["a", "task-a"], ["b", "task-b"], ["c", "task-a"]]) {
    assert.equal(f.forwarder.enqueue(reply(id, thread), thread).status, "queued");
  }
  assert.equal(f.forwarder.status().queued, 3);
  await f.next();
  await f.next();
  await f.next();
  assert.deepEqual(f.calls.map(({ threadId, at }) => ({ threadId, at })), [
    { threadId: "task-a", at: 0 },
    { threadId: "task-b", at: 5000 },
    { threadId: "task-a", at: 10000 },
  ]);
  assert.equal(f.forwarder.status().forwarded, 3);
  assert.equal(f.timers.size, 0);
  assert.equal(f.forwarder.read("b").backend, "native-desktop");
});

it("deduplicates the original request and freezes its route and response", async () => {
  const f = fixture();
  const record = reply("original");
  const receipt = f.forwarder.enqueue(record, "original-task");
  record.text = "Changed after enqueue";
  record.replyThreadId = "different-task";
  receipt.threadId = "different-task";
  assert.equal(f.forwarder.enqueue(reply("original"), "original-task").status, "queued");
  assert.throws(() => f.forwarder.enqueue(reply("original", "different-task"), "different-task"), /cannot be redirected/);
  await f.next();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].threadId, "original-task");
  assert.equal(f.calls[0].record.text, "Reply for original");
  assert.equal(Object.isFrozen(f.calls[0].record), true);
  assert.equal(f.forwarder.enqueue(reply("original"), "original-task").status, "forwarded");
  assert.equal(f.timers.size, 0);
});

it("keeps the per-session cap visible without discarding the blocked replies", async () => {
  const f = fixture({ maxPerSession: 2 });
  for (const id of ["a", "b", "c"]) f.forwarder.enqueue(reply(id), "original-task");
  await f.next();
  await f.next();
  assert.equal(f.calls.length, 2);
  assert.equal(f.forwarder.read("c").status, "blocked");
  assert.equal(f.forwarder.read("c").reasonCode, "SESSION_LIMIT_REACHED");
  assert.equal(f.forwarder.enqueue(reply("d"), "original-task").status, "blocked");
  assert.equal(f.forwarder.status().blocked, 2);
  assert.equal(f.forwarder.status().attempts, 2);
  assert.equal(f.timers.size, 0);
});

it("keeps uncertain outcomes inspectable and never retries them", async () => {
  const errors = [
    Object.assign(new Error("Acknowledgement lost"), { code: "RELAY_UNREACHABLE", reachedCompanion: true }),
    Object.assign(new Error("Write outcome unknown"), { deliveryUncertain: true }),
    Object.assign(new Error("Timed out"), { code: "RELAY_TIMEOUT", sent: false }),
    new Error("Unexpected native failure"),
  ];
  let attempts = 0;
  const f = fixture({ deliver: async () => { throw errors[attempts++]; } });
  for (const id of ["a", "b", "c", "d"]) f.forwarder.enqueue(reply(id), "original-task");
  for (let index = 0; index < 4; index += 1) await f.next();
  for (const id of ["a", "b", "c", "d"]) {
    assert.equal(f.forwarder.read(id).status, "unknown");
    assert.equal(f.forwarder.enqueue(reply(id), "original-task").status, "unknown");
  }
  assert.equal(attempts, 4);
  assert.equal(f.forwarder.status().unknown, 4);
  assert.equal(f.timers.size, 0);
});

it("marks known no-dispatch failures separately and continues with other replies", async () => {
  let attempts = 0;
  const f = fixture({ deliver: async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("No companion socket"), { code: "RELAY_UNREACHABLE" });
    return { backend: "native-desktop" };
  } });
  f.forwarder.enqueue(reply("a"), "original-task");
  f.forwarder.enqueue(reply("b"), "original-task");
  await f.next();
  await f.next();
  assert.equal(f.forwarder.read("a").status, "failed");
  assert.equal(f.forwarder.read("a").reasonCode, "RELAY_UNREACHABLE");
  assert.equal(f.forwarder.read("b").status, "forwarded");
  assert.equal(attempts, 2);
});

it("blocks changed routing in preflight without consuming a dispatch or dropping later work", async () => {
  const f = fixture({ beforeForward: (record) => {
    if (record.inReplyTo === "a") throw Object.assign(new Error("Routing changed"), { code: "ROUTING_CHANGED" });
  } });
  f.forwarder.enqueue(reply("a"), "original-task");
  f.forwarder.enqueue(reply("b"), "original-task");
  await f.next();
  await f.next();
  assert.equal(f.forwarder.read("a").status, "failed");
  assert.equal(f.forwarder.read("a").reasonCode, "ROUTING_CHANGED");
  assert.equal(f.forwarder.read("a").attemptedAt, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.forwarder.status().attempts, 1);
});

it("rejects invalid identities before scheduling and supports legacy message IDs", async () => {
  const f = fixture();
  for (const [record, thread] of [
    [null, "original-task"],
    [{ text: "Reply" }, "original-task"],
    [reply(" a "), "original-task"],
    [reply("a\nb"), "original-task"],
    [reply("a"), ""],
    [reply("a"), " original-task"],
    [reply("a"), "different-task"],
    [{ ...reply("a"), text: " " }, "original-task"],
  ]) assert.throws(() => f.forwarder.enqueue(record, thread), { code: "INVALID_REPLY_IDENTITY" });
  assert.equal(f.forwarder.status().total, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.forwarder.read("missing"), null);
  f.forwarder.enqueue({ msgId: "legacy-answer", text: "Legacy response" }, "legacy-task");
  await f.next();
  assert.equal(f.forwarder.read("legacy-answer").status, "forwarded");
});

it("retains queued replies as blocked on close and does not accept new dispatches", async () => {
  const f = fixture();
  f.forwarder.enqueue(reply("a"), "original-task");
  assert.equal(f.timers.size, 1);
  assert.equal(f.forwarder.close().blocked, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.forwarder.read("a").reasonCode, "FORWARDER_CLOSED");
  assert.equal(f.forwarder.enqueue(reply("b"), "original-task").status, "blocked");
  assert.equal(f.forwarder.status().blocked, 2);
  assert.equal(f.forwarder.close().closed, true);
  await flush();
  assert.equal(f.calls.length, 0);
});

it("lets an in-flight native outcome settle on close and preserves the unsent queue", async () => {
  let accept;
  let attempts = 0;
  const f = fixture({ deliver: () => {
    attempts += 1;
    return new Promise((resolve) => { accept = resolve; });
  } });
  f.forwarder.enqueue(reply("a"), "original-task");
  f.forwarder.enqueue(reply("b"), "original-task");
  await f.next();
  assert.equal(f.forwarder.read("a").status, "sending");
  f.forwarder.close();
  assert.equal(f.forwarder.read("a").status, "sending");
  assert.equal(f.forwarder.read("b").status, "blocked");
  accept({ backend: "native-desktop" });
  await flush();
  assert.equal(f.forwarder.read("a").status, "forwarded");
  assert.equal(attempts, 1);
  assert.equal(f.timers.size, 0);
});

it("does not dispatch when closed during asynchronous preflight", async () => {
  let allow;
  const f = fixture({ beforeForward: () => new Promise((resolve) => { allow = resolve; }) });
  f.forwarder.enqueue(reply("a"), "original-task");
  await f.next();
  f.forwarder.close();
  allow();
  await flush();
  assert.equal(f.forwarder.read("a").status, "blocked");
  assert.equal(f.forwarder.read("a").reasonCode, "FORWARDER_CLOSED");
  assert.equal(f.calls.length, 0);
});
