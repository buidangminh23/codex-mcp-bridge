import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { runTurn } from "../src/turn.mjs";
import { startFakeAppServer } from "./helpers/fake-app-server.mjs";

const sleep = (ms) => new Promise((r) => globalThis.setTimeout(r, ms));

function respondToEverything(msg, { respond, notify }) {
  if (msg.method === "thread/resume") return respond({ thread: { id: msg.params?.threadId } });
  if (msg.method === "ping") return respond({ pong: true });
  if (msg.method === "turn/start") {
    respond({ turn: { id: "turn-1" } });
    globalThis.setTimeout(() => notify("item/started", { threadId: msg.params.threadId, turnId: "turn-1" }), 20);
    return;
  }
  respond({});
}

/**
 * The app-server does not survive a reboot or a sleep, so the first call after
 * one has to rebuild the connection. Everything here is a regression test for
 * "the bridge errors or hangs on the first call after the machine wakes up".
 */
describe("recovery from a dropped app-server connection", () => {
  it("reconnects on the next call after the server drops the socket", async () => {
    const server = await startFakeAppServer({ onRequest: respondToEverything });
    const client = new CodexAppServerClient({ url: server.url, autoStart: false, log: () => {} });
    try {
      await client.connect();
      assert.equal(server.connections, 1);

      await client.ensureThreadAttached("thread-a");
      assert.ok(client.attachedThreads.has("thread-a"));

      server.dropConnection();
      await sleep(150);

      const result = await client.call("ping", {});
      assert.deepEqual(result, { pong: true });
      assert.ok(server.connections > 1, "the call should have opened a fresh connection");
      assert.equal(client.pending.size, 0, "pending requests leaked across the reconnect");
    } finally {
      client.ws?.close();
      await server.close();
    }
  });

  /**
   * A turn waits on `turn/completed`, which can only arrive over a live socket.
   * Without an explicit disconnect signal the caller blocks until its own
   * timeout expires - four minutes by default.
   */
  it("ends an interrupted turn immediately instead of waiting out the timeout", async () => {
    const server = await startFakeAppServer({ onRequest: respondToEverything });
    const client = new CodexAppServerClient({ url: server.url, autoStart: false, log: () => {} });
    try {
      await client.connect();
      const startedAt = Date.now();
      const turn = runTurn(client, {
        threadId: "thread-b",
        input: [{ type: "text", text: "hello" }],
        timeoutMs: 20000,
      }).catch((err) => ({ status: "threw", error: err.message }));

      await sleep(300);
      server.dropConnection();

      const outcome = await turn;
      const elapsed = Date.now() - startedAt;
      assert.equal(outcome.status, "disconnected", "the turn must report the disconnect, not a clean finish");
      assert.ok(elapsed < 5000, `turn took ${elapsed}ms of its 20000ms budget to notice the drop`);
      assert.equal(client.threadListeners.size, 0, "thread listeners were not released");
    } finally {
      client.ws?.close();
      await server.close();
    }
  });

  it("retries a refused first handshake instead of failing the call", async () => {
    const server = await startFakeAppServer({ failFirstUpgrades: 1, onRequest: respondToEverything });
    const client = new CodexAppServerClient({ url: server.url, autoStart: false, log: () => {} });
    try {
      await client.connect();
      assert.equal(server.refused, 1, "the first handshake should have been refused");
      assert.equal(server.connections, 1, "the retry should have connected");
    } finally {
      client.ws?.close();
      await server.close();
    }
  });

  it("reports a clear error when nothing is listening and autostart is off", async () => {
    const client = new CodexAppServerClient({ url: "ws://127.0.0.1:9", autoStart: false, log: () => {} });
    await assert.rejects(() => client.connect(), /No Codex app-server reachable/);
  });
});
