import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { runTurn } from "../src/turn.mjs";

const turnModule = new URL("../src/turn.mjs", import.meta.url).href;

/**
 * runTurn only needs three things from the app-server client, so the tests
 * drive it with a stub rather than a socket: it keeps the turn state machine
 * (buffering, terminal statuses, timeout, disconnect, cleanup) testable without
 * a Codex install or a network.
 */
function stubClient({ onRequest } = {}) {
  const threadListeners = new Map();
  const disconnectListeners = new Set();

  return {
    threadListeners,
    disconnectListeners,
    subscribe(threadId, listener) {
      if (!threadListeners.has(threadId)) threadListeners.set(threadId, new Set());
      threadListeners.get(threadId).add(listener);
      return () => {
        const set = threadListeners.get(threadId);
        set.delete(listener);
        if (!set.size) threadListeners.delete(threadId);
      };
    },
    subscribeDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    async request(method, params) {
      if (onRequest) return onRequest(method, params);
      return { turn: { id: "turn-1" } };
    },
    emit(threadId, method, params) {
      for (const listener of [...(threadListeners.get(threadId) ?? [])]) listener({ method, params });
    },
    drop() {
      for (const listener of [...disconnectListeners]) listener();
    },
  };
}

const completed = (threadId, status = "completed") => ({
  method: "turn/completed",
  params: { turn: { id: "turn-1", status, durationMs: 1234 } },
  threadId,
});

describe("runTurn", () => {
  it("returns the agent text and an activity trail", async () => {
    const client = stubClient();
    const turn = runTurn(client, { threadId: "t1", input: [{ type: "text", text: "hi" }] });

    await new Promise((r) => globalThis.setImmediate(r));
    client.emit("t1", "item/completed", {
      threadId: "t1",
      turnId: "turn-1",
      item: { type: "commandExecution", command: ["ls", "-la"], exitCode: 0 },
    });
    client.emit("t1", "item/completed", {
      threadId: "t1",
      turnId: "turn-1",
      item: { type: "fileChange", changes: [{ path: "src/index.mjs" }] },
    });
    client.emit("t1", "item/completed", {
      threadId: "t1",
      turnId: "turn-1",
      item: { type: "agentMessage", text: "done" },
    });
    client.emit("t1", "turn/completed", completed("t1").params);

    const result = await turn;
    assert.equal(result.status, "completed");
    assert.equal(result.turnId, "turn-1");
    assert.equal(result.text, "done");
    assert.equal(result.durationMs, 1234);
    assert.deepEqual(
      result.activity.map((a) => a.kind),
      ["command", "fileChange"],
    );
    assert.deepEqual(result.activity[1].files, ["src/index.mjs"]);
  });

  /**
   * Notifications can land before `turn/start` returns the turn id. They are
   * buffered until the id is known, and dropping that buffer loses the first
   * commands of every turn.
   */
  it("replays notifications that arrive before the turn id is known", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = stubClient({
      onRequest: async () => {
        await gate;
        return { turn: { id: "turn-1" } };
      },
    });

    const turn = runTurn(client, { threadId: "t1", input: [] });
    await new Promise((r) => globalThis.setImmediate(r));
    client.emit("t1", "item/completed", {
      threadId: "t1",
      item: { type: "agentMessage", text: "early" },
    });
    release();
    await new Promise((r) => globalThis.setImmediate(r));
    client.emit("t1", "turn/completed", completed("t1").params);

    const result = await turn;
    assert.equal(result.text, "early");
  });

  it("ignores notifications belonging to another turn", async () => {
    const client = stubClient();
    const turn = runTurn(client, { threadId: "t1", input: [] });
    await new Promise((r) => globalThis.setImmediate(r));

    client.emit("t1", "item/completed", {
      threadId: "t1",
      turnId: "turn-other",
      item: { type: "agentMessage", text: "not mine" },
    });
    client.emit("t1", "item/completed", {
      threadId: "t1",
      turnId: "turn-1",
      item: { type: "agentMessage", text: "mine" },
    });
    client.emit("t1", "turn/completed", completed("t1").params);

    const result = await turn;
    assert.equal(result.text, "mine");
  });

  it("reports a timeout without cancelling the turn", async () => {
    const client = stubClient();
    const startedAt = Date.now();
    const result = await runTurn(client, { threadId: "t1", input: [], timeoutMs: 120 });
    assert.equal(result.status, "timeout");
    assert.equal(result.turnId, "turn-1", "the turn id must survive so the caller can read or interrupt it");
    assert.ok(Date.now() - startedAt >= 100);
  });

  it("ends promptly when the connection drops mid-turn", async () => {
    const client = stubClient();
    const startedAt = Date.now();
    const turn = runTurn(client, { threadId: "t1", input: [], timeoutMs: 20000 });
    await new Promise((r) => globalThis.setImmediate(r));
    client.drop();

    const result = await turn;
    assert.equal(result.status, "disconnected");
    assert.ok(Date.now() - startedAt < 2000, "a dropped socket must not wait out the turn timeout");
  });

  it("fails the turn on a non-retryable error", async () => {
    const client = stubClient();
    const turn = runTurn(client, { threadId: "t1", input: [] });
    await new Promise((r) => globalThis.setImmediate(r));
    client.emit("t1", "error", { threadId: "t1", error: { message: "sandbox denied" }, willRetry: false });

    const result = await turn;
    assert.equal(result.status, "failed");
    assert.deepEqual(result.errors, [{ message: "sandbox denied" }]);
  });

  it("keeps waiting through a retryable error", async () => {
    const client = stubClient();
    const turn = runTurn(client, { threadId: "t1", input: [] });
    await new Promise((r) => globalThis.setImmediate(r));
    client.emit("t1", "error", { threadId: "t1", error: { message: "rate limited" }, willRetry: true });
    client.emit("t1", "item/completed", {
      threadId: "t1",
      turnId: "turn-1",
      item: { type: "agentMessage", text: "recovered" },
    });
    client.emit("t1", "turn/completed", completed("t1").params);

    const result = await turn;
    assert.equal(result.status, "completed");
    assert.equal(result.text, "recovered");
    assert.equal(result.errors.length, 1);
  });

  it("releases its listeners however the turn ends", async () => {
    const client = stubClient();
    for (const finish of ["completed", "interrupted", "failed"]) {
      const turn = runTurn(client, { threadId: "t1", input: [] });
      await new Promise((r) => globalThis.setImmediate(r));
      client.emit("t1", "turn/completed", { turn: { id: "turn-1", status: finish } });
      const result = await turn;
      assert.equal(result.status, finish);
      assert.equal(client.threadListeners.size, 0, `listener leaked after a ${finish} turn`);
      assert.equal(client.disconnectListeners.size, 0, `disconnect listener leaked after a ${finish} turn`);
    }
  });

  it("propagates a failure to start the turn", async () => {
    const client = stubClient({
      onRequest: () => {
        throw new Error("thread 01a0 already has an active writer");
      },
    });
    await assert.rejects(() => runTurn(client, { threadId: "t1", input: [] }), /active writer/);
    assert.equal(client.threadListeners.size, 0, "a failed start must not leak listeners");
  });

  /**
   * A rejected `turn/start` used to also reject the internal completion promise,
   * which nothing awaits on that path - an unhandled rejection, and therefore
   * process exit under Node's default. The tool handler returned a tidy error
   * to a client whose server had already died. Sending into a thread the Codex
   * desktop app holds open is the everyday way to hit it, so this runs in a
   * real child process: an in-process assertion cannot observe the exit.
   */
  it("does not take the process down when turn/start fails", async () => {
    const script = `
      import { runTurn } from ${JSON.stringify(turnModule)};
      const client = {
        subscribe: () => () => {},
        subscribeDisconnect: () => () => {},
        request: async () => { throw new Error("thread 01a0 already has an active writer"); },
      };
      try { await runTurn(client, { threadId: "t1", input: [] }); } catch {}
      await new Promise((r) => setTimeout(r, 200));
      process.stdout.write("survived");
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(child.status, 0, `the bridge process died: ${child.stderr}`);
    assert.equal(child.stdout, "survived");
  });
});
