import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { runTurn } from "../src/turn.mjs";
import { encodeFrame, startFakeAppServer } from "./helpers/fake-app-server.mjs";

const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
const clientModule = new URL("../src/app-server-client.mjs", import.meta.url).href;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(options, action) {
  const server = await startFakeAppServer(options);
  const client = new CodexAppServerClient({ url: server.url, autoStart: false });
  try {
    return await action(client, server);
  } finally {
    client.close();
    await server.close();
  }
}

describe("app-server request lifecycle", () => {
  it("cleans failed sends without an unhandled rejection or process exit", () => {
    const script = `
      import { CodexAppServerClient } from ${JSON.stringify(clientModule)};
      const client = new CodexAppServerClient({ autoStart: false });
      for (const mode of ["closed", "throwing"]) {
        if (mode === "throwing") client.ws = { readyState: WebSocket.OPEN, send() { throw new Error("send failed"); } };
        try { await client.request("ping", {}, { timeoutMs: 20 }); } catch {}
        if (client.pending.size !== 0) throw new Error("pending request leaked");
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      process.stdout.write("survived");
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "survived");
  });

  it("gates concurrent calls until initialize and initialized complete", async () => {
    const initializing = deferred();
    const methods = [];
    await fixture({
      autoInitialize: false,
      onRequest(msg, { respond }) {
        methods.push(msg.method);
        if (msg.method === "initialize") initializing.resolve(respond);
        if (msg.method === "ping") respond({ pong: true });
      },
    }, async (client) => {
      const connect = client.connect();
      const finishInitialize = await initializing.promise;
      const ping = client.call("ping", {});
      await sleep(30);
      assert.deepEqual(methods, ["initialize"]);
      finishInitialize({ codexHome: "/fake" });
      await connect;
      assert.deepEqual(await ping, { pong: true });
      assert.deepEqual(methods, ["initialize", "initialized", "ping"]);
    });
  });

  it("closes an unsuccessful initialize before retrying", async () => {
    let initializes = 0;
    let closeFrameObserved = false;
    await fixture({
      autoInitialize: false,
      onRequest(msg, { respond, socket }) {
        if (msg.method !== "initialize") return;
        initializes += 1;
        if (initializes === 1) {
          socket.once("data", (chunk) => { closeFrameObserved = (chunk[0] & 0x0f) === 0x08; });
          socket.write(encodeFrame(JSON.stringify({ id: msg.id, error: { code: -32000, message: "warming up" } })));
        } else respond({ codexHome: "/fake" });
      },
    }, async (client, server) => {
      await client.connect();
      assert.equal(initializes, 2);
      assert.equal(server.connections, 2);
      assert.equal(client.pending.size, 0);
      assert.equal(closeFrameObserved, true);
    });
  });

  it("rejects pending requests and notifies turns immediately on close", async () => {
    const requestArrived = deferred();
    await fixture({ onRequest(msg) { if (msg.method === "hang") requestArrived.resolve(); } }, async (client) => {
      await client.connect();
      client.markAttached("thread-a", { cwd: "/a" });
      let disconnects = 0;
      client.subscribeDisconnect(() => { disconnects += 1; });
      const pending = assert.rejects(client.request("hang", {}, { timeoutMs: 10000 }), /closed/);
      await requestArrived.promise;
      client.close();
      assert.equal(client.ws, null);
      assert.equal(client.pending.size, 0);
      assert.equal(client.attachedThreads.size, 0);
      assert.equal(client.threadCwds.size, 0);
      assert.equal(disconnects, 1);
      await pending;
      await sleep(20);
      assert.equal(disconnects, 1);
    });
  });

  it("cleans a stopped connection even if readiness has already gone away", async () => {
    const started = deferred();
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "turn/start") { respond({ turn: { id: "turn-a" } }); started.resolve(); }
    } }, async (client) => {
      await client.connect();
      const turn = runTurn(client, { threadId: "thread-a", input: [], timeoutMs: 10000 });
      await started.promise;
      client.isServerUp = async () => false;
      assert.equal((await client.stopServer()).stopped, false);
      assert.equal((await turn).status, "disconnected");
      assert.equal(client.pending.size, 0);
      assert.equal(client.threadListeners.size, 0);
    });
  });

  it("does not open a socket after a connection attempt is cancelled", async () => {
    const readiness = deferred();
    const client = new CodexAppServerClient({ autoStart: false });
    client.isServerUp = () => readiness.promise;
    const connection = assert.rejects(client.connect(), /cancelled/);
    client.close();
    readiness.resolve(true);
    await connection;
    assert.equal(client.ws, null);
    assert.equal(client.connecting, null);
  });

  it("does not autostart after a pending readiness check is cancelled", async () => {
    const readiness = deferred();
    const client = new CodexAppServerClient({ autoStart: true });
    client.isServerUp = () => readiness.promise;
    client.startServer = () => { throw new Error("must not spawn a server"); };
    const connection = assert.rejects(client.connect(), /cancelled/);
    client.close();
    readiness.resolve(false);
    await connection;
  });

  it("cancels a socket that is still waiting for its WebSocket handshake", async () => {
    const upgraded = deferred();
    const server = createServer((_, response) => response.writeHead(200).end("ok"));
    server.on("upgrade", (_, socket) => upgraded.resolve(socket));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new CodexAppServerClient({ url: `ws://127.0.0.1:${server.address().port}`, autoStart: false });
    let socket;
    try {
      const connection = assert.rejects(client.connect(), /cancelled/);
      socket = await upgraded.promise;
      client.close();
      await connection;
      assert.equal(client.ws, null);
      assert.equal(client.connecting, null);
    } finally {
      client.close();
      socket?.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("ignores malformed JSON-RPC values without breaking the connection", async () => {
    await fixture({ onRequest(msg, { respond }) { if (msg.method === "ping") respond({ pong: true }); } }, async (client, server) => {
      await client.connect();
      for (const value of [null, [], false, "text"]) server.send(value);
      assert.deepEqual(await client.call("ping", {}), { pong: true });
    });
  });

  it("does not let an obsolete socket close disconnect its replacement", async () => {
    await fixture({ onRequest(msg, { respond }) { if (msg.method === "ping") respond({ pong: true }); } }, async (client) => {
      await client.connect();
      const oldClose = client.ws.onclose;
      client.close();
      await client.connect();
      const replacement = client.ws;
      oldClose();
      assert.equal(client.ws, replacement);
      assert.deepEqual(await client.call("ping", {}), { pong: true });
    });
  });

  it("coalesces concurrent attachment of the same thread", async () => {
    let resumes = 0;
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "thread/resume") { resumes += 1; respond({ thread: { id: msg.params.threadId, cwd: "/a" } }); }
    } }, async (client) => {
      await Promise.all([client.ensureThreadAttached("thread-a"), client.ensureThreadAttached("thread-a")]);
      assert.equal(resumes, 1);
      assert.equal(client.attachingThreads.size, 0);
    });
  });

  it("refuses a new turn after reconnect when the previous turn is still running", async () => {
    let starts = 0;
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "turn/start") {
        starts += 1;
        respond({ turn: { id: "turn-a", status: "inProgress" } });
      }
      if (msg.method === "thread/resume") respond({ thread: {
        id: msg.params.threadId, turns: [{ id: "turn-a", status: "inProgress" }],
      } });
    } }, async (client, server) => {
      await client.call("turn/start", { threadId: "thread-a", input: [] });
      const disconnected = new Promise((resolve) => client.subscribeDisconnect(resolve));
      server.dropConnection();
      await disconnected;
      assert.equal(client.activeTurns.get("thread-a").needsReconcile, true);
      await client.ensureThreadAttached("thread-a");
      await assert.rejects(client.request("turn/start", { threadId: "thread-a", input: [] }), { code: "THREAD_BUSY" });
      assert.equal((await client.releaseThread("thread-a")).status, "busy");
      assert.equal(starts, 1);
    });
  });

  it("preserves an unacknowledged turn across socket loss until its state is confirmed", async () => {
    let starts = 0;
    await fixture({ onRequest(msg, { respond, socket }) {
      if (msg.method === "turn/start") {
        starts += 1;
        socket.destroy();
      }
      if (["thread/resume", "thread/read"].includes(msg.method)) respond({ thread: { id: msg.params.threadId } });
    } }, async (client) => {
      await assert.rejects(client.call("turn/start", { threadId: "thread-a", input: [] }), { code: "CONNECTION_CLOSED" });
      assert.equal(client.activeTurns.get("thread-a").turnId, null);
      assert.equal(client.activeTurns.get("thread-a").needsReconcile, true);
      await assert.rejects(client.ensureThreadAttached("thread-a"), { code: "THREAD_STATE_UNCONFIRMED" });
      await assert.rejects(client.request("turn/start", { threadId: "thread-a", input: [] }), { code: "THREAD_BUSY" });
      assert.equal(starts, 1);
    });
  });

  it("allows the next turn after reconnect confirms that the previous turn completed", async () => {
    let starts = 0;
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "turn/start") {
        starts += 1;
        respond({ turn: { id: starts === 1 ? "turn-a" : "turn-b", status: "inProgress" } });
      }
      if (msg.method === "thread/resume") respond({ thread: {
        id: msg.params.threadId, turns: [{ id: "turn-a", status: "completed" }],
      } });
    } }, async (client, server) => {
      await client.call("turn/start", { threadId: "thread-a", input: [] });
      const disconnected = new Promise((resolve) => client.subscribeDisconnect(resolve));
      server.dropConnection();
      await disconnected;
      await client.ensureThreadAttached("thread-a");
      assert.equal(client.activeTurns.has("thread-a"), false);
      assert.equal((await client.request("turn/start", { threadId: "thread-a", input: [] })).turn.id, "turn-b");
      assert.equal(starts, 2);
    });
  });

  it("reads explicit thread state when resume omits the unresolved turn", async () => {
    let starts = 0;
    let reads = 0;
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "turn/start") {
        starts += 1;
        respond({ turn: { id: `turn-${starts}`, status: "inProgress" } });
      }
      if (msg.method === "thread/resume") respond({ thread: { id: msg.params.threadId } });
      if (msg.method === "thread/read") {
        reads += 1;
        assert.equal(msg.params.includeTurns, true);
        respond({ thread: { id: msg.params.threadId, status: { type: "idle" } } });
      }
    } }, async (client, server) => {
      await client.call("turn/start", { threadId: "thread-a", input: [] });
      const disconnected = new Promise((resolve) => client.subscribeDisconnect(resolve));
      server.dropConnection();
      await disconnected;
      await client.ensureThreadAttached("thread-a");
      await client.request("turn/start", { threadId: "thread-a", input: [] });
      assert.equal(reads, 1);
      assert.equal(starts, 2);
    });
  });

  it("fails closed on missing resumed state and recovers when a later read confirms completion", async () => {
    let starts = 0;
    let reads = 0;
    let completed = false;
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "turn/start") {
        starts += 1;
        respond({ turn: { id: `turn-${starts}`, status: "inProgress" } });
      }
      if (msg.method === "thread/resume") respond({ thread: { id: msg.params.threadId } });
      if (msg.method === "thread/read") {
        reads += 1;
        respond({ thread: { id: msg.params.threadId, ...(completed ? { status: "idle" } : {}) } });
      }
    } }, async (client, server) => {
      await client.call("turn/start", { threadId: "thread-a", input: [] });
      const disconnected = new Promise((resolve) => client.subscribeDisconnect(resolve));
      server.dropConnection();
      await disconnected;
      await assert.rejects(client.ensureThreadAttached("thread-a"), { code: "THREAD_STATE_UNCONFIRMED" });
      await assert.rejects(client.request("turn/start", { threadId: "thread-a", input: [] }), { code: "THREAD_BUSY" });
      assert.equal(starts, 1);
      completed = true;
      await client.ensureThreadAttached("thread-a");
      await client.request("turn/start", { threadId: "thread-a", input: [] });
      assert.equal(starts, 2);
      assert.equal(reads, 2);
    });
  });

  it("blocks an active resumed thread even when this client did not start its turn", async () => {
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "thread/resume") respond({ thread: {
        id: msg.params.threadId, status: { type: "active" }, turns: [],
      } });
      if (msg.method === "turn/start") assert.fail("must not start another turn");
    } }, async (client, server) => {
      await client.ensureThreadAttached("thread-a");
      await assert.rejects(client.request("turn/start", { threadId: "thread-a", input: [] }), { code: "THREAD_BUSY" });
      server.send({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "previously-unknown", status: "completed" } } });
      await sleep(20);
      assert.equal(client.activeTurns.has("thread-a"), false);
    });
  });

  it("serializes a thread transaction while keeping other threads independent", async () => {
    const client = new CodexAppServerClient({ autoStart: false });
    const release = deferred();
    const order = [];
    const first = assert.rejects(client.withThread("a", async () => {
      order.push("a1");
      await release.promise;
      throw new Error("first failed");
    }), /first failed/);
    const second = client.withThread("a", () => { order.push("a2"); });
    await client.withThread("b", () => { order.push("b"); });
    assert.deepEqual(order, ["a1", "b"]);
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["a1", "b", "a2"]);
    assert.equal(client.threadOperations.size, 0);
  });
});

describe("per-thread subscription release", () => {
  it("unsubscribes one thread without stopping another running turn", async () => {
    const requests = [];
    await fixture({ onRequest(msg, { respond }) {
      requests.push(msg.method);
      if (msg.method === "turn/start") respond({ turn: { id: "turn-b" } });
      if (msg.method === "thread/unsubscribe") respond({ status: "unsubscribed" });
    } }, async (client, server) => {
      await client.connect();
      client.markAttached("thread-a");
      client.markAttached("thread-b");
      client.stopServer = () => { throw new Error("shared server must stay alive"); };
      await client.request("turn/start", { threadId: "thread-b", input: [] });
      const release = await client.releaseThread("thread-a", { timeoutMs: 10 });
      assert.equal(release.unsubscribed, true);
      assert.equal(release.released, false);
      assert.equal(client.holdsThread("thread-a"), true);
      assert.equal(client.attachedThreads.has("thread-a"), false);
      assert.equal(client.activeTurns.has("thread-b"), true);
      assert.equal(client.ws.readyState, WebSocket.OPEN);
      server.send({ method: "thread/closed", params: { threadId: "thread-a" } });
      await sleep(20);
      assert.equal(client.holdsThread("thread-a"), false);
      assert.equal(client.holdsThread("thread-b"), true);
      assert.equal(requests.filter((method) => method === "thread/unsubscribe").length, 1);
    });
  });

  for (const status of ["unsubscribed", "notSubscribed", "notLoaded"]) {
    it(`handles the official ${status} response without claiming an unconfirmed unload`, async () => {
      await fixture({ onRequest(msg, { respond }) { if (msg.method === "thread/unsubscribe") respond({ status }); } }, async (client) => {
        await client.connect();
        client.markAttached("thread-a");
        const result = await client.releaseThread("thread-a", { timeoutMs: 0 });
        assert.equal(result.status, status);
        assert.equal(result.unsubscribed, true);
        assert.equal(result.released, status === "notLoaded");
        assert.equal(client.holdsThread("thread-a"), status !== "notLoaded");
        assert.equal(client.threadListeners.size, 0);
        assert.equal(client.disconnectListeners.size, 0);
      });
    });
  }

  it("confirms unload when thread/closed arrives before the unsubscribe reply", async () => {
    await fixture({ onRequest(msg, { respond, notify }) {
      if (msg.method === "thread/unsubscribe") {
        notify("thread/closed", { threadId: msg.params.threadId });
        respond({ status: "unsubscribed" });
      }
    } }, async (client) => {
      await client.connect();
      client.markAttached("thread-a");
      assert.equal((await client.releaseThread("thread-a")).released, true);
      assert.equal(client.holdsThread("thread-a"), false);
    });
  });

  it("fails safely when thread/unsubscribe is unsupported", async () => {
    await fixture({ onRequest(msg, { socket }) {
      if (msg.method === "thread/unsubscribe") socket.write(encodeFrame(JSON.stringify({
        id: msg.id, error: { code: -32601, message: "Method not found" },
      })));
    } }, async (client) => {
      await client.connect();
      client.markAttached("thread-a");
      client.stopServer = () => { throw new Error("must not stop shared server"); };
      const result = await client.releaseThread("thread-a");
      assert.equal(result.status, "unsupported");
      assert.equal(result.unsubscribed, false);
      assert.equal(result.released, false);
      assert.equal(client.holdsThread("thread-a"), true);
    });
  });

  it("retains attachment when the server does not confirm unsubscription", async () => {
    await fixture({ onRequest(msg, { respond }) { if (msg.method === "thread/unsubscribe") respond({}); } }, async (client) => {
      await client.connect();
      client.markAttached("thread-a");
      assert.equal((await client.releaseThread("thread-a")).status, "invalidResponse");
      assert.equal(client.holdsThread("thread-a"), true);
    });
  });

  it("protects a timed-out turn until a matching completion arrives", async () => {
    await fixture({ onRequest(msg, { respond }) {
      if (msg.method === "turn/start") respond({ turn: { id: "turn-a" } });
      if (msg.method === "thread/unsubscribe") respond({ status: "notLoaded" });
    } }, async (client, server) => {
      await client.connect();
      client.markAttached("thread-a");
      assert.equal((await runTurn(client, { threadId: "thread-a", input: [], timeoutMs: 30 })).status, "timeout");
      assert.equal((await client.releaseThread("thread-a")).status, "busy");
      await assert.rejects(client.request("turn/start", { threadId: "thread-a", input: [] }), /running or unconfirmed/);
      server.send({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "other", status: "completed" } } });
      await sleep(20);
      assert.equal(client.activeTurns.has("thread-a"), true);
      server.send({ method: "turn/completed", params: { threadId: "thread-a", turn: { id: "turn-a", status: "completed" } } });
      await sleep(20);
      assert.equal((await client.releaseThread("thread-a")).released, true);
    });
  });

  it("keeps a turn/start acknowledgement timeout ambiguous instead of resending", async () => {
    await fixture({}, async (client) => {
      await client.connect();
      await assert.rejects(client.request("turn/start", { threadId: "thread-a", input: [] }, { timeoutMs: 20 }), /timed out/);
      assert.equal(client.activeTurns.has("thread-a"), true);
      assert.equal((await client.releaseThread("thread-a")).status, "busy");
      await assert.rejects(client.request("turn/start", { threadId: "thread-a", input: [] }), /unconfirmed/);
    });
  });

  it("does not retain an already completed turn when notifications precede its response", async () => {
    await fixture({ onRequest(msg, { respond, notify }) {
      if (msg.method === "turn/start") {
        notify("turn/completed", { threadId: msg.params.threadId, turn: { id: "turn-a", status: "completed" } });
        respond({ turn: { id: "turn-a" } });
      }
    } }, async (client) => {
      await client.connect();
      await client.request("turn/start", { threadId: "thread-a", input: [] });
      assert.equal(client.activeTurns.has("thread-a"), false);
    });
  });
});
