import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  MAX_FRAME_BYTES,
  NATIVE_DISPATCH_METHOD,
  NativeToolsClient,
  NativeDesktopRelay,
  NativeRelayError,
  bootstrapRelayThread,
  nativeDispatchParams,
  nativeRelayStatus,
  nativeToolsPipeFromCommandLine,
  readRelayConfig,
  relayConfigPath,
  relaySocketPath,
  resolveRelayThreadId,
  resolveNativeToolsPipePath,
  writeRelayConfig,
} from "../src/native-relay.mjs";
import { RelaySocketServer, handleRelayRequest, startRelayWhenAvailable } from "../src/native-relay-companion.mjs";
import { APP_SERVER_BACKEND, NATIVE_BACKEND, createThreadDelivery } from "../src/thread-delivery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";
const temps = [];
const stubExecutor = () => ({ threadId: "relay-thread", source: "test" });

/**
 * A companion killed with SIGKILL never runs its cleanup, so the socket file
 * survives it. Node unlinks the path on an orderly `server.close()`, so the
 * leftover has to come from a process that really was killed - anything else
 * tests a situation that cannot happen.
 */
function killedListener(socketPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(socketPath)}, () => console.log("up"))`,
    ]);
    child.stdout.on("data", () => {
      child.on("exit", () => resolve());
      child.kill("SIGKILL");
    });
    child.on("error", reject);
  });
}

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-relay-"));
  temps.push(dir);
  return dir;
}

/**
 * A unix socket path is capped near 104 bytes on macOS, and the temp
 * directories this suite creates are long enough to reach it. Sockets get their
 * own short directory so a passing test is not a fact about how deep the
 * runner's TMPDIR happens to be.
 */
function tempSocket() {
  if (IS_WINDOWS) return tempNamedPipe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-"));
  temps.push(dir);
  return path.join(dir, "s.sock");
}

function tempNamedPipe() {
  return "\\\\.\\pipe\\LOCAL\\codex-native-relay-test-" + process.pid + "-" + Math.random().toString(16).slice(2);
}

function windowsCommandLine(args) {
  return args.map((arg) => `"${arg.replace(/(\\*)"/g, (_match, slashes) => `${slashes.repeat(2)}\\"`).replace(/(\\+)$/, "$1$1")}"`).join(" ");
}

after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

describe("relay executor thread resolution", () => {
  it("prefers an explicit CODEX_RELAY_ID over the persisted one", () => {
    const home = tempHome();
    writeRelayConfig({ relayThreadId: "persisted" }, { CODEX_HOME: home });
    const resolved = resolveRelayThreadId({ CODEX_HOME: home, CODEX_RELAY_ID: " from-env " });
    assert.equal(resolved.threadId, "from-env");
    assert.equal(resolved.source, "CODEX_RELAY_ID");
  });

  it("falls back to the thread bootstrapped into native-relay.json", () => {
    const home = tempHome();
    const file = writeRelayConfig({ relayThreadId: "persisted-thread" }, { CODEX_HOME: home });
    assert.equal(file, relayConfigPath({ CODEX_HOME: home }));
    assert.equal(fs.statSync(file).mode & 0o777, IS_WINDOWS ? fs.statSync(file).mode & 0o777 : 0o600);

    const resolved = resolveRelayThreadId({ CODEX_HOME: home });
    assert.equal(resolved.threadId, "persisted-thread");
    assert.equal(resolved.source, file);
  });

  /**
   * Codex validates the executor thread and answers NATIVE_DISPATCH_FAILED for
   * an id it does not know, which says nothing about the missing configuration
   * that produced it. Failing here instead keeps the cause attached to the
   * error, and never invents an id to find out.
   */
  it("fails with the fix rather than inventing an executor thread", () => {
    const home = tempHome();
    assert.throws(
      () => resolveRelayThreadId({ CODEX_HOME: home }),
      (err) => {
        assert.ok(err instanceof NativeRelayError);
        assert.equal(err.code, "RELAY_THREAD_UNCONFIGURED");
        assert.match(err.message, /CODEX_RELAY_ID/);
        assert.match(err.message, /install-native-relay/);
        return true;
      },
    );
  });

  it("ignores a corrupt or non-object config instead of throwing", () => {
    const home = tempHome();
    fs.writeFileSync(relayConfigPath({ CODEX_HOME: home }), "not json at all");
    assert.equal(readRelayConfig({ CODEX_HOME: home }), null);
    assert.throws(() => resolveRelayThreadId({ CODEX_HOME: home }), /RELAY_THREAD_UNCONFIGURED|No Codex relay thread/);
  });
});

describe("native relay availability", () => {
  it("stays off where the Codex Desktop native pipe does not exist", () => {
    const status = nativeRelayStatus({
      CODEX_HOME: tempHome(),
      CODEX_NATIVE_RELAY_SOCKET: IS_WINDOWS ? tempNamedPipe() : undefined,
      CODEX_BRIDGE_NATIVE_RELAY: "auto",
    });
    assert.equal(status.enabled, false);
    assert.ok(status.reason, "an unavailable backend must say why");
  });

  it("can be switched off explicitly even where it would work", () => {
    const socket = tempSocket();
    const status = nativeRelayStatus({ CODEX_NATIVE_RELAY_SOCKET: socket, CODEX_BRIDGE_NATIVE_RELAY: "0" });
    assert.equal(status.enabled, false);
    assert.match(status.reason, /disabled/);
  });

  it("reports a missing companion socket by path, not as a bare failure", () => {
    const socket = tempSocket();
    const status = nativeRelayStatus({ CODEX_NATIVE_RELAY_SOCKET: socket, CODEX_BRIDGE_NATIVE_RELAY: "1" });
    assert.equal(status.enabled, false);
    assert.match(status.reason, new RegExp(socket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("resolves the socket under the Codex home by default", () => {
    const home = tempHome();
    assert.equal(
      relaySocketPath({ CODEX_HOME: home }),
      IS_WINDOWS ? "\\\\.\\pipe\\LOCAL\\codex-native-relay" : path.join(home, "native-relay.sock"),
    );
  });
});

describe("native dispatch parameters", () => {
  /**
   * The one shape in this project with no published schema behind it. Pinned so
   * a change to it is a deliberate edit to a named function rather than a
   * silent drift inside a request nobody reads.
   */
  it("keeps the executor context distinct from the destination", () => {
    const first = nativeDispatchParams({ executorThreadId: "relay-1", targetThreadId: "open-in-desktop", message: "hello" });
    const second = nativeDispatchParams({ executorThreadId: "relay-1", targetThreadId: "open-in-desktop", message: "hello" });
    assert.equal(NATIVE_DISPATCH_METHOD, "tools/call");
    assert.deepEqual(first, {
      arguments: { threadId: "open-in-desktop", prompt: "hello" },
      callId: first.callId,
      namespace: "codex_app",
      threadId: "relay-1",
      tool: "send_message_to_thread",
      turnId: first.turnId,
    });
    assert.match(first.callId, /^codex-native-relay-[0-9a-f-]{36}$/);
    assert.match(first.turnId, /^codex-native-relay-turn-[0-9a-f-]{36}$/);
    assert.notEqual(first.callId, second.callId);
    assert.notEqual(first.turnId, second.turnId);
  });
});

describe("companion request handling", () => {
  const executor = () => ({ threadId: "relay-thread", source: "test" });

  it("dispatches a well-formed request through the executor thread", async () => {
    const calls = [];
    const response = await handleRelayRequest(
      { targetThreadId: "open-thread", message: "from Claude" },
      { dispatch: async (args) => (calls.push(args), { success: true }), resolveExecutor: executor },
    );
    assert.deepEqual(calls, [
      { executorThreadId: "relay-thread", targetThreadId: "open-thread", message: "from Claude" },
    ]);
    assert.equal(response.ok, true);
    assert.equal(response.targetThreadId, "open-thread");
    assert.deepEqual(response.result, { success: true });
  });

  it("refuses an incomplete request without dispatching it", async () => {
    let dispatched = 0;
    const dispatch = async () => {
      dispatched += 1;
    };
    for (const payload of [{}, { targetThreadId: "t" }, { message: "m" }, { targetThreadId: "  ", message: "m" }, { targetThreadId: "t", message: "   " }]) {
      const response = await handleRelayRequest(payload, { dispatch, resolveExecutor: executor });
      assert.equal(response.ok, false, `${JSON.stringify(payload)} must be refused`);
      assert.equal(response.error.code, "RELAY_BAD_REQUEST");
    }
    assert.equal(dispatched, 0, "a malformed request must never reach Codex");
  });

  /**
   * Codex accepts the relay thread as a destination like any other, so a
   * mistaken bind would deliver the message into the invisible relay thread
   * and report success. Nothing downstream could tell that apart from delivery.
   */
  it("refuses to deliver into its own executor thread", async () => {
    const response = await handleRelayRequest(
      { targetThreadId: "relay-thread", message: "hello" },
      { dispatch: async () => assert.fail("must not dispatch"), resolveExecutor: executor },
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "RELAY_BAD_REQUEST");
  });

  it("reports an unconfigured executor thread as configuration, not as a dispatch failure", async () => {
    const response = await handleRelayRequest(
      { targetThreadId: "open-thread", message: "hello" },
      {
        dispatch: async () => assert.fail("must not dispatch"),
        resolveExecutor: () => {
          throw new NativeRelayError("nothing configured", "RELAY_THREAD_UNCONFIGURED");
        },
      },
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "RELAY_THREAD_UNCONFIGURED");
  });

  /**
   * A JSON-RPC rejection arrives with a numeric code, and echoing it would put
   * -32601 in a field whose every other value is a string this project defines.
   */
  it("does not leak a numeric JSON-RPC code into the relay error code", async () => {
    const response = await handleRelayRequest(
      { targetThreadId: "open-thread", message: "hello" },
      {
        dispatch: async () => {
          const err = new Error("Method not found");
          err.code = -32601;
          throw err;
        },
        resolveExecutor: executor,
      },
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "NATIVE_DISPATCH_FAILED");
    assert.match(response.error.message, /Method not found/);
  });

  it("requires an explicit successful native result", async () => {
    for (const result of [undefined, null, {}, { success: false }, { success: "true" }, { success: true, isError: true }]) {
      const response = await handleRelayRequest(
        { targetThreadId: "open-thread", message: "hello" },
        { dispatch: async () => result, resolveExecutor: executor },
      );
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "NATIVE_DISPATCH_FAILED");
    }
  });

  it("refuses unsupported envelopes before dispatch", async () => {
    for (const payload of [[], null, "hello", { v: 2, targetThreadId: "t", message: "m" }, { targetThreadId: "t", message: "m", command: "extra" }]) {
      const response = await handleRelayRequest(payload, { dispatch: async () => assert.fail("must not dispatch"), resolveExecutor: executor });
      assert.equal(response.error.code, "RELAY_BAD_REQUEST");
    }
  });
});

describe("relay socket round trip", () => {
  it("carries one message to the companion and one acknowledgement back", async () => {
    const socketPath = tempSocket();
    const seen = [];
    const server = new RelaySocketServer({
      socketPath,
      dispatch: async (args) => (seen.push(args), { success: true }),
      resolveExecutor: () => ({ threadId: "relay-thread", source: "test" }),
    });
    await server.start();
    try {
      if (!IS_WINDOWS) assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, "the file mode is the whole security boundary");

      const relay = new NativeDesktopRelay({
        socketPath,
        env: { CODEX_RELAY_ID: "relay-thread", CODEX_BRIDGE_NATIVE_RELAY: "1" },
      });
      assert.equal(relay.available, true);
      const ack = await relay.sendMessage("open-thread", "hello from Claude");
      assert.equal(ack.ok, true);
      assert.equal(ack.targetThreadId, "open-thread");
      assert.deepEqual(seen, [
        { executorThreadId: "relay-thread", targetThreadId: "open-thread", message: "hello from Claude" },
      ]);
    } finally {
      server.stop();
    }
  });

  it("surfaces a refusal from Codex as an error that says the companion answered", async () => {
    const socketPath = tempSocket();
    const server = new RelaySocketServer({
      socketPath,
      dispatch: async () => {
        throw new NativeRelayError("thread not found", "NATIVE_DISPATCH_FAILED");
      },
      resolveExecutor: () => ({ threadId: "relay-thread", source: "test" }),
    });
    await server.start();
    try {
      const relay = new NativeDesktopRelay({ socketPath, env: { CODEX_RELAY_ID: "relay-thread" } });
      await assert.rejects(
        () => relay.sendMessage("synthetic-uuid", "hello"),
        (err) => {
          assert.equal(err.code, "NATIVE_DISPATCH_FAILED");
          assert.equal(err.reachedCompanion, true, "Codex has already answered; retrying elsewhere only adds a lock failure");
          return true;
        },
      );
    } finally {
      server.stop();
    }
  });

  it("reports an absent companion as unreachable rather than as a refusal", async () => {
    const relay = new NativeDesktopRelay({ socketPath: tempSocket(), env: {} });
    await assert.rejects(
      () => relay.sendMessage("open-thread", "hello"),
      (err) => {
        assert.equal(err.code, "RELAY_UNREACHABLE");
        assert.equal(err.reachedCompanion, false, "nothing was asked, so the app-server path still deserves its turn");
        return true;
      },
    );
  });

  it("refuses to send a frame larger than the companion will buffer", async () => {
    const relay = new NativeDesktopRelay({ socketPath: tempSocket(), env: {} });
    await assert.rejects(
      () => relay.sendMessage("open-thread", "x".repeat(MAX_FRAME_BYTES + 1)),
      (err) => {
        assert.equal(err.code, "RELAY_MESSAGE_TOO_LARGE");
        return true;
      },
    );
  });

  /**
   * A companion killed with SIGKILL leaves the socket file behind. Binding has
   * to reclaim that address, or the relay stays down until someone deletes a
   * file by hand.
   */
  it("reclaims the socket a killed companion left behind", { skip: IS_WINDOWS }, async () => {
    const socketPath = tempSocket();
    await killedListener(socketPath);
    assert.ok(fs.existsSync(socketPath), "the leftover file is the situation under test");

    const second = new RelaySocketServer({ socketPath, dispatch: async () => ({ success: true, second: true }), resolveExecutor: stubExecutor });
    await second.start();
    try {
      const relay = new NativeDesktopRelay({ socketPath, env: { CODEX_RELAY_ID: "relay-thread" } });
      const ack = await relay.sendMessage("open-thread", "hello");
      assert.deepEqual(ack.result, { success: true, second: true });
    } finally {
      second.stop();
    }
  });

  /**
   * Codex Desktop can launch more than one companion. Blindly unlinking the
   * socket would let the second one steal the address from a live first one,
   * and messages would then reach whichever process bound last.
   */
  it("refuses to take the socket away from a live companion", async () => {
    const socketPath = tempSocket();
    const live = new RelaySocketServer({ socketPath, dispatch: async () => ({ success: true }), resolveExecutor: stubExecutor });
    await live.start();
    try {
      const rival = new RelaySocketServer({ socketPath, dispatch: async () => ({ success: true }), resolveExecutor: stubExecutor });
      await assert.rejects(() => rival.start(), /already owns/);
      const relay = new NativeDesktopRelay({ socketPath, env: { CODEX_RELAY_ID: "relay-thread" } });
      assert.equal((await relay.sendMessage("open-thread", "still here")).ok, true);
    } finally {
      live.stop();
    }
  });

  it("reports a shared companion listening until its socket owner stops", async () => {
    const socketPath = tempSocket();
    const options = { socketPath, dispatch: async () => assert.fail("a status probe must not dispatch a user message"), resolveExecutor: stubExecutor };
    const owner = new RelaySocketServer(options);
    const observer = new RelaySocketServer(options);
    await owner.start();
    try {
      assert.equal(await owner.isListening(), true);
      assert.equal(observer.started, false);
      assert.equal(await observer.isListening(), true);
      assert.equal(observer.started, false);
      const stopped = new Promise((resolve) => owner.server.once("close", resolve));
      owner.stop();
      await stopped;
      assert.equal(await observer.isListening(), false);
      assert.equal(observer.started, false);
    } finally {
      owner.stop();
      observer.stop();
    }
  });

  /**
   * A relay socket whose mode could not be set is not a degraded relay, it is
   * an open one: anything on the machine could then put text into a Codex
   * thread. Refusing leaves claude-bridge on the app-server path, which is
   * where it was before this backend existed.
   */
  it("refuses to serve a socket it could not make private", async () => {
    const socketPath = tempSocket();
    const server = new RelaySocketServer({
      socketPath,
      dispatch: async () => ({ success: true }),
      resolveExecutor: stubExecutor,
      restrictSocket: () => {
        throw new Error("EPERM: operation not permitted");
      },
    });
    await assert.rejects(() => server.start(), /mode could not be restricted/);
    assert.equal(server.started, false);

    await assert.rejects(
      () => new NativeDesktopRelay({ socketPath, env: {} }).sendMessage("open-thread", "hello"),
      (err) => {
        assert.equal(err.code, "RELAY_UNREACHABLE", "a refused socket must not keep answering");
        return true;
      },
    );
  });

  it("answers malformed JSON without dropping the connection", async () => {
    const socketPath = tempSocket();
    const server = new RelaySocketServer({ socketPath, dispatch: async () => assert.fail("must not dispatch"), resolveExecutor: stubExecutor });
    await server.start();
    try {
      const response = await new Promise((resolve, reject) => {
        let buffer = "";
        const socket = net.connect({ path: socketPath }, () => socket.write("{not json\n"));
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          if (!buffer.includes("\n")) return;
          socket.destroy();
          resolve(JSON.parse(buffer.split("\n")[0]));
        });
        socket.on("error", reject);
      });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "RELAY_BAD_REQUEST");
    } finally {
      server.stop();
    }
  });

  it("preserves UTF-8 split across request chunks and handles only one request per connection", async () => {
    const seen = [];
    const server = new RelaySocketServer({
      socketPath: tempSocket(),
      dispatch: async (args) => (seen.push(args), { success: true }),
      resolveExecutor: stubExecutor,
    });
    await server.start();
    try {
      const line = Buffer.from(`${JSON.stringify({ v: 1, targetThreadId: "open-thread", message: "Chào sếp 👋" })}\n`);
      const split = line.indexOf(Buffer.from("ế")) + 1;
      const response = await relayRawRequest(server.socketPath, [line.subarray(0, split), Buffer.concat([line.subarray(split), line])]);
      assert.equal(response.ok, true);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].message, "Chào sếp 👋");
    } finally {
      server.stop();
    }
  });

  it("returns a size refusal for an oversized unfinished request", async () => {
    const server = new RelaySocketServer({ socketPath: tempSocket(), dispatch: async () => assert.fail("must not dispatch"), resolveExecutor: stubExecutor });
    await server.start();
    try {
      const response = await relayRawRequest(server.socketPath, [Buffer.alloc(MAX_FRAME_BYTES + 1, 120)]);
      assert.equal(response.error.code, "RELAY_MESSAGE_TOO_LARGE");
    } finally {
      server.stop();
    }
  });

  it("does not resend through the app-server when the acknowledgement is lost", async () => {
    const socketPath = tempSocket();
    let requests = 0;
    const server = net.createServer((socket) => socket.once("data", () => {
      requests += 1;
      socket.destroy();
    }));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const delivery = createThreadDelivery({
        codex: { ensureThreadAttached: () => assert.fail("delivery may already have occurred") },
        relay: new NativeDesktopRelay({ socketPath, env: { CODEX_BRIDGE_NATIVE_RELAY: "1" } }),
      });
      await assert.rejects(() => delivery.deliver("open-thread", "hello"), (err) => {
        assert.equal(err.code, "RELAY_DELIVERY_UNCONFIRMED");
        assert.equal(err.reachedCompanion, true);
        return true;
      });
      assert.equal(requests, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("preserves UTF-8 split across acknowledgement chunks", async () => {
    const socketPath = tempSocket();
    const line = Buffer.from(`${JSON.stringify({ ok: false, v: 1, error: { code: "NATIVE_DISPATCH_FAILED", message: "Chào sếp 👋" } })}\n`);
    const split = line.indexOf(Buffer.from("ế")) + 1;
    const server = net.createServer((socket) => socket.once("data", () => {
      socket.write(line.subarray(0, split));
      globalThis.setTimeout(() => socket.end(line.subarray(split)), 10);
    }));
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      await assert.rejects(() => new NativeDesktopRelay({ socketPath }).sendMessage("t", "m"), (err) => {
        assert.equal(err.message, "Chào sếp 👋");
        return true;
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("Windows named-pipe relay", { skip: IS_WINDOWS ? false : "Windows named-pipe regression" }, () => {
  it("carries a message through the Windows relay pipe", async () => {
    const socketPath = tempNamedPipe();
    const seen = [];
    const server = new RelaySocketServer({
      socketPath,
      dispatch: async (args) => (seen.push(args), { success: true }),
      resolveExecutor: stubExecutor,
    });
    await server.start();
    try {
      const relay = new NativeDesktopRelay({
        socketPath,
        env: { CODEX_RELAY_ID: "relay-thread", CODEX_BRIDGE_NATIVE_RELAY: "1" },
      });
      assert.equal(relay.available, true);
      const ack = await relay.sendMessage("open-thread", "hello from Claude");
      assert.equal(ack.ok, true);
      assert.deepEqual(seen, [
        { executorThreadId: "relay-thread", targetThreadId: "open-thread", message: "hello from Claude" },
      ]);
    } finally {
      server.stop();
    }
  });
});

describe("thread delivery backend", () => {
  const workingRelay = (calls) => ({
    status: () => ({ enabled: true, socketPath: "/relay.sock", reason: null }),
    sendMessage: async (threadId, text) => (calls.push({ threadId, text }), { ok: true }),
  });

  it("delivers through Codex Desktop without attaching the thread", async () => {
    const calls = [];
    const codex = {
      ensureThreadAttached: async () => assert.fail("the desktop owns the writer lock; nothing may attach"),
    };
    const delivery = createThreadDelivery({ codex, relay: workingRelay(calls) });
    const result = await delivery.deliver("open-thread", "hello");
    assert.equal(result.backend, NATIVE_BACKEND);
    assert.deepEqual(calls, [{ threadId: "open-thread", text: "hello" }]);
    assert.match(delivery.describe(), /codex-desktop-native/);
  });

  it("uses the app-server path when no companion is installed", async () => {
    const attached = [];
    const codex = {
      ensureThreadAttached: async (threadId) => attached.push(threadId),
      subscribe: () => () => {},
      subscribeDisconnect: () => () => {},
      request: async () => ({ turn: { id: "turn-1" } }),
    };
    const relay = {
      status: () => ({ enabled: false, socketPath: "/relay.sock", reason: "no companion socket" }),
      sendMessage: async () => assert.fail("an unavailable relay must not be called"),
    };
    const delivery = createThreadDelivery({ codex, relay, timeoutMs: 50 });
    const result = await delivery.deliver("lonely-thread", "hello");
    assert.equal(result.backend, APP_SERVER_BACKEND);
    assert.deepEqual(attached, ["lonely-thread"]);
    assert.match(delivery.describe(), /app-server/);
  });

  it("releases only the fallback thread after a terminal turn", async () => {
    let listener;
    const released = [];
    const codex = {
      ensureThreadAttached: async () => {},
      subscribe: (_threadId, callback) => {
        listener = callback;
        return () => {};
      },
      subscribeDisconnect: () => () => {},
      request: async (method) => {
        if (method === "turn/start") {
          globalThis.setTimeout(
            () => listener({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } }),
            0,
          );
          return { turn: { id: "turn-1" } };
        }
        return {};
      },
      releaseThread: async (threadId) => {
        released.push(threadId);
        return { released: true };
      },
      stopServer: async () => assert.fail("must not stop the shared app-server"),
    };
    const relay = {
      status: () => ({ enabled: false, socketPath: "/relay.sock", reason: "no companion socket" }),
      sendMessage: async () => assert.fail("an unavailable relay must not be called"),
    };
    const delivery = createThreadDelivery({ codex, relay, timeoutMs: 100, releaseAfterTurn: true });
    const result = await delivery.deliver("fallback-thread", "hello");
    assert.equal(result.turn.status, "completed");
    assert.deepEqual(released, ["fallback-thread"]);
  });

  it("falls back when the companion is gone, and only then", async () => {
    const attached = [];
    const codex = {
      ensureThreadAttached: async (threadId) => attached.push(threadId),
      subscribe: () => () => {},
      subscribeDisconnect: () => () => {},
      request: async () => ({ turn: { id: "turn-1" } }),
    };
    const unreachable = {
      status: () => ({ enabled: true, socketPath: "/relay.sock", reason: null }),
      sendMessage: async () => {
        throw new NativeRelayError("socket vanished", "RELAY_UNREACHABLE");
      },
    };
    const fellBack = await createThreadDelivery({ codex, relay: unreachable, timeoutMs: 50 }).deliver("t", "hello");
    assert.equal(fellBack.backend, APP_SERVER_BACKEND);
    assert.deepEqual(attached, ["t"]);

    /**
     * Once Codex itself has refused, a second app-server would contend for the
     * ~/.codex state and then fail on the very writer lock this backend exists
     * to avoid - a slower way to produce the same error.
     */
    const refused = {
      status: () => ({ enabled: true, socketPath: "/relay.sock", reason: null }),
      sendMessage: async () => {
        throw new NativeRelayError("no such thread", "NATIVE_DISPATCH_FAILED", { reachedCompanion: true });
      },
    };
    const noFallback = createThreadDelivery({
      codex: { ensureThreadAttached: async () => assert.fail("must not attach after Codex refused") },
      relay: refused,
    });
    await assert.rejects(() => noFallback.deliver("t", "hello"), /no such thread/);
  });

  it("does not bypass native message validation with an app-server fallback", async () => {
    const relay = {
      status: () => ({ enabled: true }),
      sendMessage: async () => { throw new NativeRelayError("too large", "RELAY_MESSAGE_TOO_LARGE"); },
    };
    const delivery = createThreadDelivery({ codex: { ensureThreadAttached: () => assert.fail("must not bypass validation") }, relay });
    await assert.rejects(() => delivery.deliver("t", "x"), { code: "RELAY_MESSAGE_TOO_LARGE" });
  });
});

describe("relay thread bootstrap", () => {
  it("records the created thread so the executor survives a restart", async () => {
    const home = tempHome();
    const calls = [];
    const client = {
      releaseThread: async (threadId) => (calls.push({ method: "thread/unsubscribe", params: { threadId } }), { released: true }),
      call: async (method, params) => {
        calls.push({ method, params });
        return method === "thread/start" ? { thread: { id: "bootstrapped-thread" } } : {};
      },
    };
    const { threadId, configPath } = await bootstrapRelayThread(client, { cwd: home, env: { CODEX_HOME: home } });

    assert.equal(threadId, "bootstrapped-thread");
    assert.equal(readRelayConfig({ CODEX_HOME: home }).relayThreadId, "bootstrapped-thread");
    assert.equal(configPath, relayConfigPath({ CODEX_HOME: home }));

    /**
     * The relay thread is an executor context and nothing else. Creating it
     * able to run commands would hand every relayed message a sandbox it has
     * no use for.
     */
    const start = calls.find((c) => c.method === "thread/start");
    assert.equal(start.params.approvalPolicy, "never");
    assert.equal(start.params.sandbox, "read-only");
    assert.deepEqual(calls.at(-1), { method: "thread/unsubscribe", params: { threadId: "bootstrapped-thread" } });
  });

  it("keeps the thread when naming it fails", async () => {
    const home = tempHome();
    const client = {
      releaseThread: async () => ({ released: true }),
      call: async (method) => {
        if (method === "thread/name/set") throw new Error("naming is not available");
        return { thread: { id: "unnamed-thread" } };
      },
    };
    const { threadId } = await bootstrapRelayThread(client, { cwd: home, env: { CODEX_HOME: home } });
    assert.equal(threadId, "unnamed-thread");
    assert.equal(readRelayConfig({ CODEX_HOME: home }).relayThreadId, "unnamed-thread");
  });

  it("releases the created thread even when saving its configuration fails", async () => {
    const file = path.join(tempHome(), "not-a-directory");
    fs.writeFileSync(file, "occupied");
    const released = [];
    const client = {
      call: async () => ({ thread: { id: "created-before-error" } }),
      releaseThread: async (threadId) => released.push(threadId),
    };
    await assert.rejects(() => bootstrapRelayThread(client, { env: { CODEX_HOME: file } }));
    assert.deepEqual(released, ["created-before-error"]);
  });
});

async function relayRawRequest(socketPath, chunks) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const socket = net.connect({ path: socketPath }, async () => {
      for (const chunk of chunks) {
        if (socket.destroyed) break;
        socket.write(chunk);
        await new Promise((done) => globalThis.setTimeout(done, 10));
      }
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(10);
      if (index < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.subarray(0, index).toString("utf8")));
    });
    socket.on("error", reject);
  });
}

function nativeFrame(response) {
  const payload = Buffer.from(JSON.stringify(response));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

async function nativePipe(onRequest, socketPath = tempSocket()) {
  const sockets = new Set();
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        assert.ok(size > 0 && size <= MAX_FRAME_BYTES);
        if (buffer.length < size + 4) return;
        const payload = JSON.parse(buffer.subarray(4, size + 4).toString("utf8"));
        buffer = buffer.subarray(size + 4);
        onRequest(payload, socket);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    get connectionCount() { return connectionCount; },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("native tools pipe discovery", () => {
  const windowsExecutable = String.raw`C:\Program Files\WindowsApps\OpenAI.Codex_26.904.1121.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`;
  const windowsPipe = String.raw`\\.\pipe\codex-app-tools-9d269c5c`;
  const config = (socketPath) => `mcp_servers.codex_app={command="codex-app-tools",env={CODEX_APP_TOOLS_PIPE_PATH='${socketPath}'}}`;
  const windowsParent = (...args) => windowsCommandLine([windowsExecutable, "app-server", "--analytics-default-enabled", ...args]);

  it("reads the Windows parent config after command-line and TOML decoding", () => {
    const basicStringConfig = `mcp_servers.codex_app={"command"="codex-app-tools","env"={"CODEX_APP_TOOLS_PIPE_PATH"=${JSON.stringify(windowsPipe)}}}`;
    assert.equal(nativeToolsPipeFromCommandLine(windowsParent("-c", basicStringConfig), { platform: "win32" }), windowsPipe);
  });

  it("supports literal TOML strings and both long config option forms on Windows", () => {
    for (const args of [["-c", config(windowsPipe)], ["--config", config(windowsPipe)], [`--config=${config(windowsPipe)}`]]) {
      assert.equal(nativeToolsPipeFromCommandLine(windowsParent(...args), { platform: "win32" }), windowsPipe);
    }
  });

  it("finds the Codex app config among unrelated parent settings", () => {
    const commandLine = windowsParent("-c", 'model="example-model"', "-c", config(windowsPipe), "-c", "features.enable_request_compression=true");
    assert.equal(nativeToolsPipeFromCommandLine(commandLine, { platform: "win32" }), windowsPipe);
  });

  it("reads the raw argv text returned by ps on macOS and Linux", () => {
    const socketPath = "/tmp/codex app/native-tools.sock";
    const assignment = `mcp_servers.codex_app={command = "codex-app-tools", args = ["serve", "--native"], env = {CODEX_APP_TOOLS_PIPE_PATH = '${socketPath}'}}`;
    for (const platform of ["darwin", "linux"]) {
      const commandLine = `/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled -c ${assignment}`;
      assert.equal(nativeToolsPipeFromCommandLine(commandLine, { platform }), socketPath);
    }
  });

  it("rejects a pipe embedded in another process or a non-app-server invocation", () => {
    const commands = [
      ["other.exe", "app-server", "-c", config(windowsPipe)],
      [`${windowsExecutable}.backup`, "app-server", "-c", config(windowsPipe)],
      ["powershell.exe", "-Command", windowsParent("-c", config(windowsPipe))],
      [windowsExecutable, "exec", "app-server", "-c", config(windowsPipe)],
      [windowsExecutable, "exec", "--prompt", windowsParent("-c", config(windowsPipe))],
    ];
    for (const args of commands) {
      assert.equal(nativeToolsPipeFromCommandLine(windowsCommandLine(args), { platform: "win32" }), null);
    }
    assert.equal(nativeToolsPipeFromCommandLine(`/usr/bin/node app-server -c ${config("/tmp/native.sock")}`, { platform: "linux" }), null);
  });

  it("ignores native pipe text outside the codex_app environment table", () => {
    const unrelatedAssignments = [
      config(windowsPipe).replace("mcp_servers.codex_app", "mcp_servers.other"),
      `instructions=${JSON.stringify(config(windowsPipe))}`,
      `mcp_servers.codex_app={env={},CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}'}`,
      `mcp_servers.codex_app={env={nested={CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}'}}}`,
      `mcp_servers.codex_app={env={OTHER=${JSON.stringify(`CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}'`)}}}`,
    ];
    for (const assignment of unrelatedAssignments) {
      assert.equal(nativeToolsPipeFromCommandLine(windowsParent("-c", assignment), { platform: "win32" }), null);
    }
    assert.equal(nativeToolsPipeFromCommandLine(windowsParent("--prompt", config(windowsPipe)), { platform: "win32" }), null);
  });

  it("rejects malformed and conflicting native pipe configurations", () => {
    const assignments = [
      config(windowsPipe).slice(0, -1),
      `${config(windowsPipe)}garbage`,
      `mcp_servers.codex_app={env={CODEX_APP_TOOLS_PIPE_PATH=${windowsPipe}}}`,
      `mcp_servers.codex_app={env={CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}"}}`,
      `mcp_servers.codex_app={env={CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}',CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}-other'}}`,
      `mcp_servers.codex_app={env={CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}'},env={CODEX_APP_TOOLS_PIPE_PATH='${windowsPipe}-other'}}`,
    ];
    for (const assignment of assignments) {
      assert.equal(nativeToolsPipeFromCommandLine(windowsParent("-c", assignment), { platform: "win32" }), null);
    }
    assert.equal(nativeToolsPipeFromCommandLine(windowsParent("-c", config(windowsPipe), "-c", config(`${windowsPipe}-other`)), { platform: "win32" }), null);
  });

  it("rejects remote Windows pipes and endpoints outside the local pipe namespace", () => {
    for (const socketPath of [String.raw`\\remote-host\pipe\native-tools`, String.raw`C:\Temp\native-tools.sock`, "native-tools", String.raw`\\.\pipe` + "\\"]) {
      assert.equal(nativeToolsPipeFromCommandLine(windowsParent("-c", config(socketPath)), { platform: "win32" }), null);
    }
  });

  it("rejects relative Unix socket paths", () => {
    for (const socketPath of ["native-tools.sock", "./native-tools.sock", "../native-tools.sock", "~/native-tools.sock", ""]) {
      assert.equal(nativeToolsPipeFromCommandLine(`/usr/local/bin/codex app-server -c ${config(socketPath)}`, { platform: "linux" }), null);
    }
  });

  it("prefers the inherited pipe without probing any process", async () => {
    const resolved = await resolveNativeToolsPipePath({
      env: { CODEX_APP_TOOLS_PIPE_PATH: windowsPipe },
      platform: "win32",
      parentPid: 1234,
      readParentCommandLine: async () => assert.fail("the inherited native pipe must not trigger discovery"),
    });
    assert.equal(resolved, windowsPipe);
  });

  it("reads only the requested direct parent when the environment lacks the pipe", async () => {
    const probed = [];
    const resolved = await resolveNativeToolsPipePath({
      env: {},
      platform: "win32",
      parentPid: 1234,
      readParentCommandLine: async (pid) => {
        probed.push(pid);
        return windowsParent("-c", config(windowsPipe));
      },
    });
    assert.equal(resolved, windowsPipe);
    assert.deepEqual(probed, [1234]);
  });

  it("leaves discovery unavailable when its parent is not Codex or cannot be read", async () => {
    for (const readParentCommandLine of [
      async () => windowsCommandLine(["node.exe", "app-server", "-c", config(windowsPipe)]),
      async () => null,
      async () => { throw new Error("parent exited"); },
    ]) {
      assert.equal(await resolveNativeToolsPipePath({ env: {}, platform: "win32", parentPid: 1234, readParentCommandLine }), null);
    }
  });
});

describe("native tools pipe protocol", () => {
  it("discovers a native socket and completes a dispatch without an inherited pipe", async () => {
    const requests = [];
    let discoveries = 0;
    const native = await nativePipe((request, socket) => {
      requests.push(request);
      socket.write(nativeFrame({ jsonrpc: "2.0", id: request.id, result: { success: true } }));
    });
    const client = new NativeToolsClient({
      env: {},
      resolveSocketPath: async () => {
        discoveries += 1;
        return native.socketPath;
      },
    });
    try {
      assert.deepEqual(await client.dispatch({ executorThreadId: "executor", targetThreadId: "target", message: "hello" }), { success: true });
      await client.connect();
      assert.equal(discoveries, 1);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].params.arguments.threadId, "target");
      assert.equal(client.pending.size, 0);
    } finally {
      client.close();
      await native.close();
    }
  });

  it("uses an explicit or inherited socket without invoking discovery", async () => {
    const native = await nativePipe(() => assert.fail("connecting must not dispatch a user message"));
    try {
      for (const options of [
        { socketPath: native.socketPath, env: { CODEX_APP_TOOLS_PIPE_PATH: tempSocket() } },
        { env: { CODEX_APP_TOOLS_PIPE_PATH: native.socketPath } },
      ]) {
        const client = new NativeToolsClient({ ...options, resolveSocketPath: async () => assert.fail("configured native sockets must take precedence") });
        try {
          await client.connect();
          assert.equal(client.socketPath, native.socketPath);
        } finally {
          client.close();
        }
      }
    } finally {
      await native.close();
    }
  });

  it("can discover the socket after an earlier discovery returned unavailable", async () => {
    const native = await nativePipe(() => assert.fail("connecting must not dispatch a user message"));
    let discoveries = 0;
    const client = new NativeToolsClient({ env: {}, resolveSocketPath: async () => (++discoveries === 1 ? null : native.socketPath) });
    try {
      await assert.rejects(() => client.connect(), { code: "NATIVE_PIPE_UNAVAILABLE" });
      await client.connect();
      assert.equal(discoveries, 2);
      assert.equal(client.socketPath, native.socketPath);
    } finally {
      client.close();
      await native.close();
    }
  });

  it("cancels pending discovery on close before opening a native connection or dispatching", async () => {
    for (const operation of ["connect", "dispatch"]) {
      let requests = 0;
      let resolveDiscovery;
      const discovery = new Promise((resolve) => { resolveDiscovery = resolve; });
      const native = await nativePipe((request, socket) => {
        requests += 1;
        socket.write(nativeFrame({ jsonrpc: "2.0", id: request.id, result: { success: true } }));
      });
      const client = new NativeToolsClient({ env: {}, resolveSocketPath: () => discovery });
      try {
        const pending = operation === "connect"
          ? client.connect()
          : client.dispatch({ executorThreadId: "executor", targetThreadId: "target", message: "cancelled" });
        const rejected = assert.rejects(pending, /closed|cancel/i);
        client.close();
        resolveDiscovery(native.socketPath);
        await rejected;
        assert.equal(native.connectionCount, 0);
        assert.equal(requests, 0);
        assert.equal(client.socket, null);
        assert.equal(client.pending.size, 0);
      } finally {
        client.close();
        await native.close();
      }
    }
  });

  it("shares one pending discovery and socket across concurrent connection requests", async () => {
    let discoveries = 0;
    let resolveDiscovery;
    const discovery = new Promise((resolve) => { resolveDiscovery = resolve; });
    const native = await nativePipe((request, socket) => socket.write(nativeFrame({ jsonrpc: "2.0", id: request.id, result: { success: true } })));
    const client = new NativeToolsClient({ env: {}, resolveSocketPath: () => { discoveries += 1; return discovery; } });
    try {
      const pending = Promise.all([client.connect(), client.connect(), client.connect()]);
      resolveDiscovery(native.socketPath);
      await pending;
      assert.deepEqual(await client.dispatch({ executorThreadId: "executor", targetThreadId: "target", message: "connected" }), { success: true });
      assert.equal(discoveries, 1);
      assert.equal(native.connectionCount, 1);
    } finally {
      client.close();
      await native.close();
    }
  });

  it("routes concurrent responses by id with byte framing and fragmented UTF-8", async () => {
    const requests = [];
    const native = await nativePipe((request, socket) => {
      requests.push(request);
      if (requests.length !== 2) return;
      const frames = Buffer.concat([...requests].reverse().map((item) => nativeFrame({
        jsonrpc: "2.0", id: item.id, result: { success: true, message: item.params.arguments.prompt },
      })));
      const split = frames.indexOf(Buffer.from("ế")) + 1;
      socket.write(frames.subarray(0, 2));
      globalThis.setTimeout(() => {
        socket.write(frames.subarray(2, split));
        globalThis.setTimeout(() => socket.write(frames.subarray(split)), 10);
      }, 10);
    });
    const client = new NativeToolsClient({ socketPath: native.socketPath, env: {} });
    try {
      const results = await Promise.all([
        client.dispatch({ executorThreadId: "executor", targetThreadId: "first", message: "First" }),
        client.dispatch({ executorThreadId: "executor", targetThreadId: "second", message: "Chào sếp 👋" }),
      ]);
      assert.deepEqual(results.map((result) => result.message), ["First", "Chào sếp 👋"]);
      assert.equal(new Set(requests.map((request) => request.id)).size, 2);
      assert.equal(new Set(requests.map((request) => request.params.callId)).size, 2);
      assert.equal(new Set(requests.map((request) => request.params.turnId)).size, 2);
      assert.equal(client.pending.size, 0);
    } finally {
      client.close();
      await native.close();
    }
  });

  it("rejects malformed native frames and clears every pending request", async () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(MAX_FRAME_BYTES + 1);
    const malformed = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from("{")]);
    for (const response of [oversized, Buffer.alloc(4), malformed, nativeFrame({ id: 1, result: {} })]) {
      const native = await nativePipe((_request, socket) => socket.write(response));
      const client = new NativeToolsClient({ socketPath: native.socketPath, timeoutMs: 500 });
      try {
        await assert.rejects(() => client.dispatch({ executorThreadId: "e", targetThreadId: "t", message: "m" }), { code: "NATIVE_BAD_RESPONSE" });
        assert.equal(client.pending.size, 0);
      } finally {
        client.close();
        await native.close();
      }
    }
  });

  it("does not retry a dispatch after the native pipe closes without an answer", async () => {
    let requests = 0;
    const native = await nativePipe((_request, socket) => {
      requests += 1;
      socket.destroy();
    });
    const client = new NativeToolsClient({ socketPath: native.socketPath, timeoutMs: 500 });
    try {
      await assert.rejects(() => client.dispatch({ executorThreadId: "e", targetThreadId: "t", message: "m" }), { code: "NATIVE_DELIVERY_UNCONFIRMED" });
      assert.equal(requests, 1);
      assert.equal(client.pending.size, 0);
    } finally {
      client.close();
      await native.close();
    }
  });

  it("times out an unconfirmed native dispatch without retaining a pending request", async () => {
    let requests = 0;
    const native = await nativePipe(() => { requests += 1; });
    const client = new NativeToolsClient({ socketPath: native.socketPath, timeoutMs: 40 });
    try {
      await assert.rejects(() => client.dispatch({ executorThreadId: "e", targetThreadId: "t", message: "m" }), { code: "NATIVE_DELIVERY_UNCONFIRMED" });
      assert.equal(requests, 1);
      assert.equal(client.pending.size, 0);
    } finally {
      client.close();
      await native.close();
    }
  });

  it("reports an unavailable native pipe when neither inheritance nor discovery provides one", async () => {
    const client = new NativeToolsClient({ env: {}, resolveSocketPath: async () => null });
    await assert.rejects(() => client.connect(), (err) => {
      assert.equal(err.code, "NATIVE_PIPE_UNAVAILABLE");
      assert.match(err.message, /CODEX_APP_TOOLS_PIPE_PATH|Codex Desktop/);
      return true;
    });
    assert.equal(client.pending.size, 0);
    client.close();
  });

  it("rejects a native payload that exceeds its byte limit before connecting", async () => {
    const client = new NativeToolsClient({ env: {}, resolveSocketPath: async () => assert.fail("oversized payloads must be rejected before discovery") });
    await assert.rejects(() => client.dispatch({ executorThreadId: "e", targetThreadId: "t", message: "ế".repeat(MAX_FRAME_BYTES) }), { code: "RELAY_MESSAGE_TOO_LARGE" });
    assert.equal(client.pending.size, 0);
  });
});

describe("native relay startup recovery", () => {
  it("retries with capped backoff until the configured pipe is ready", async () => {
    let attempts = 0;
    let started = 0;
    const logs = [];
    const startup = startRelayWhenAvailable({
      nativeTools: {
        socketPath: "configured-pipe",
        connect: async () => { if (++attempts < 4) throw new Error("not ready"); },
        close() {},
      },
      relay: { start: async () => { started += 1; }, stop() {} },
      retryDelayMs: 5,
      maxRetryDelayMs: 10,
      log: (message) => logs.push(message),
    });
    try {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 70));
      assert.equal(await startup.ready, true);
      assert.equal(attempts, 4);
      assert.equal(started, 1);
      assert.deepEqual(logs.map((line) => Number(line.match(/retrying in (\d+)ms/)[1])), [5, 10, 10]);
    } finally {
      startup.stop();
    }
  });

  it("does not retry when no native pipe is configured", async () => {
    let attempts = 0;
    const startup = startRelayWhenAvailable({
      nativeTools: { connect: async () => { attempts += 1; throw new Error("not configured"); }, close() {} },
      relay: { start: async () => assert.fail("must not start"), stop() {} },
      retryDelayMs: 5,
    });
    assert.equal(await startup.ready, false);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    assert.equal(attempts, 1);
    startup.stop();
  });

  it("cancels a scheduled retry when the companion closes", async () => {
    let attempts = 0;
    const startup = startRelayWhenAvailable({
      nativeTools: { socketPath: "configured-pipe", connect: async () => { attempts += 1; throw new Error("not ready"); }, close() {} },
      relay: { start: async () => assert.fail("must not start"), stop() {} },
      retryDelayMs: 30,
    });
    await new Promise((resolve) => setImmediate(resolve));
    startup.stop();
    assert.equal(await startup.ready, false);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
    assert.equal(attempts, 1);
  });

  it("does not start the relay after a pending connection resolves during shutdown", async () => {
    let resolveConnect;
    let closed = 0;
    const startup = startRelayWhenAvailable({
      nativeTools: {
        socketPath: "configured-pipe",
        connect: () => new Promise((resolve) => { resolveConnect = resolve; }),
        close: () => { closed += 1; },
      },
      relay: { start: async () => assert.fail("must not start after shutdown"), stop() {} },
    });
    startup.stop();
    resolveConnect();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await startup.ready, false);
    assert.ok(closed >= 1);
  });
});

describe("companion under a real MCP client", () => {
  it("initializes MCP and recovers when the native pipe appears after launch", async () => {
    const codexHome = tempHome();
    const nativeSocket = tempSocket();
    const relaySocket = tempSocket();
    const client = new Client({ name: "late-native-pipe", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "src", "native-relay-companion.mjs")],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: codexHome,
        USERPROFILE: codexHome,
        CODEX_HOME: codexHome,
        CODEX_RELAY_ID: "test-executor",
        CODEX_APP_TOOLS_PIPE_PATH: nativeSocket,
        CODEX_NATIVE_RELAY_SOCKET: relaySocket,
      },
      stderr: "ignore",
    });
    let native;
    let nativeRequests = 0;
    try {
      await client.connect(transport);
      const unavailable = await client.callTool({ name: "native_relay_status", arguments: {} });
      assert.match(unavailable.content[0].text, /not listening/);
      native = await nativePipe(() => { nativeRequests += 1; }, nativeSocket);
      let status;
      const deadline = Date.now() + 3000;
      do {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
        status = await client.callTool({ name: "native_relay_status", arguments: {} });
      } while (status.content[0].text.includes("not listening") && Date.now() < deadline);
      assert.doesNotMatch(status.content[0].text, /not listening/);
      assert.equal(nativeRequests, 0, "startup recovery must not dispatch a user message");
    } finally {
      await client.close();
      await native?.close();
    }
  });

  it("relays into an open thread through the connection Codex Desktop launched it on", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "nr-"));
    temps.push(codexHome);
    writeRelayConfig({ relayThreadId: "relay-executor" }, { CODEX_HOME: codexHome });

    const env = {
      PATH: process.env.PATH ?? "",
      HOME: codexHome,
      USERPROFILE: codexHome,
      CODEX_HOME: codexHome,
      CODEX_BRIDGE_NATIVE_RELAY: "1",
      CODEX_NATIVE_RELAY_SOCKET: tempSocket(),
    };
    const client = new Client({ name: "fake-codex-desktop", version: "1.0.0" });
    const dispatched = [];
    const native = await nativePipe((request, socket) => {
      assert.equal(request.jsonrpc, "2.0");
      assert.equal(request.method, "tools/call");
      dispatched.push(request.params);
      const reply = request.params.arguments.threadId === "synthetic-uuid"
        ? { error: { code: -32602, message: "no such thread" } }
        : { result: { success: true } };
      socket.write(nativeFrame({ jsonrpc: "2.0", id: request.id, ...reply }));
    });
    env.CODEX_APP_TOOLS_PIPE_PATH = native.socketPath;
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(root, "src", "native-relay-companion.mjs")],
        env,
        stderr: "ignore",
      }),
    );

    try {
      const delivery = createThreadDelivery({
        codex: {
          ensureThreadAttached: () => assert.fail("the desktop owns the writer lock; nothing may attach"),
        },
        relay: new NativeDesktopRelay({ env }),
      });

      const first = await delivery.deliver("thread-open-in-desktop", "hello");
      assert.equal(first.backend, NATIVE_BACKEND);
      assert.equal(first.ack.executorThreadId, "relay-executor");

      /**
       * Several Codex threads share one companion, so a second destination has
       * to arrive as a second destination rather than joining the first.
       */
      const second = await delivery.deliver("second-open-thread", "and again");
      assert.equal(second.ack.targetThreadId, "second-open-thread");

      await assert.rejects(() => delivery.deliver("synthetic-uuid", "nowhere"), /no such thread/);

      assert.deepEqual(
        dispatched.map((d) => d.arguments.threadId),
        ["thread-open-in-desktop", "second-open-thread", "synthetic-uuid"],
      );
      assert.ok(
        dispatched.every((d) => d.threadId === "relay-executor" && d.threadId !== d.arguments.threadId),
        "the executor context is never the destination",
      );
    } finally {
      await client.close();
      await native.close();
    }
  });
});
