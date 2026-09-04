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
import { z } from "zod";

import {
  MAX_FRAME_BYTES,
  NativeDesktopRelay,
  NativeRelayError,
  bootstrapRelayThread,
  nativeDispatchParams,
  nativeRelayStatus,
  readRelayConfig,
  relayConfigPath,
  relaySocketPath,
  resolveRelayThreadId,
  writeRelayConfig,
} from "../src/native-relay.mjs";
import { RelaySocketServer, handleRelayRequest } from "../src/native-relay-companion.mjs";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-"));
  temps.push(dir);
  return path.join(dir, "s.sock");
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
    const status = nativeRelayStatus({ CODEX_HOME: tempHome(), CODEX_BRIDGE_NATIVE_RELAY: "auto" });
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
    assert.equal(relaySocketPath({ CODEX_HOME: home }), path.join(home, "native-relay.sock"));
  });
});

describe("native dispatch parameters", () => {
  /**
   * The one shape in this project with no published schema behind it. Pinned so
   * a change to it is a deliberate edit to a named function rather than a
   * silent drift inside a request nobody reads.
   */
  it("keeps the executor context distinct from the destination", () => {
    assert.deepEqual(
      nativeDispatchParams({ executorThreadId: "relay-1", targetThreadId: "open-in-desktop", message: "hello" }),
      { executorThreadId: "relay-1", threadId: "open-in-desktop", message: "hello" },
    );
  });
});

describe("companion request handling", () => {
  const executor = () => ({ threadId: "relay-thread", source: "test" });

  it("dispatches a well-formed request through the executor thread", async () => {
    const calls = [];
    const response = await handleRelayRequest(
      { targetThreadId: "open-thread", message: "from Claude" },
      { dispatch: async (args) => (calls.push(args), { delivered: true }), resolveExecutor: executor },
    );
    assert.deepEqual(calls, [
      { executorThreadId: "relay-thread", targetThreadId: "open-thread", message: "from Claude" },
    ]);
    assert.equal(response.ok, true);
    assert.equal(response.targetThreadId, "open-thread");
    assert.deepEqual(response.result, { delivered: true });
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
});

describe("relay socket round trip", { skip: IS_WINDOWS ? "unix sockets are not the Windows transport" : false }, () => {
  it("carries one message to the companion and one acknowledgement back", async () => {
    const socketPath = tempSocket();
    const seen = [];
    const server = new RelaySocketServer({
      socketPath,
      dispatch: async (args) => (seen.push(args), { ok: 1 }),
      resolveExecutor: () => ({ threadId: "relay-thread", source: "test" }),
    });
    await server.start();
    try {
      assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600, "the file mode is the whole security boundary");

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
  it("reclaims the socket a killed companion left behind", async () => {
    const socketPath = tempSocket();
    await killedListener(socketPath);
    assert.ok(fs.existsSync(socketPath), "the leftover file is the situation under test");

    const second = new RelaySocketServer({ socketPath, dispatch: async () => ({ second: true }), resolveExecutor: stubExecutor });
    await second.start();
    try {
      const relay = new NativeDesktopRelay({ socketPath, env: { CODEX_RELAY_ID: "relay-thread" } });
      const ack = await relay.sendMessage("open-thread", "hello");
      assert.deepEqual(ack.result, { second: true });
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
    const live = new RelaySocketServer({ socketPath, dispatch: async () => ({}), resolveExecutor: stubExecutor });
    await live.start();
    try {
      const rival = new RelaySocketServer({ socketPath, dispatch: async () => ({}), resolveExecutor: stubExecutor });
      await assert.rejects(() => rival.start(), /already owns/);
      const relay = new NativeDesktopRelay({ socketPath, env: { CODEX_RELAY_ID: "relay-thread" } });
      assert.equal((await relay.sendMessage("open-thread", "still here")).ok, true);
    } finally {
      live.stop();
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
      dispatch: async () => ({}),
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
});

describe("relay thread bootstrap", () => {
  it("records the created thread so the executor survives a restart", async () => {
    const home = tempHome();
    const calls = [];
    const client = {
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
  });

  it("keeps the thread when naming it fails", async () => {
    const home = tempHome();
    const client = {
      call: async (method) => {
        if (method === "thread/name/set") throw new Error("naming is not available");
        return { thread: { id: "unnamed-thread" } };
      },
    };
    const { threadId } = await bootstrapRelayThread(client, { cwd: home, env: { CODEX_HOME: home } });
    assert.equal(threadId, "unnamed-thread");
    assert.equal(readRelayConfig({ CODEX_HOME: home }).relayThreadId, "unnamed-thread");
  });
});

/**
 * The unit tests above stub the dispatch. This one does not: it launches the
 * companion the way Codex Desktop launches it - as an MCP server over stdio -
 * and answers `codex_app.send_message_to_thread` from the client side, which is
 * the seat the app's own app-server sits in. What it proves is the shape of the
 * hand-off: the message crosses a real MCP connection, carries an executor
 * thread distinct from the destination, and reaches its thread without anything
 * ever attaching or resuming it.
 */
describe("companion under a real MCP client", { skip: IS_WINDOWS ? "unix sockets are not the Windows transport" : false }, () => {
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
    };
    const client = new Client({ name: "fake-codex-desktop", version: "1.0.0" });
    const dispatched = [];
    client.setRequestHandler(
      z.object({
        method: z.literal("codex_app.send_message_to_thread"),
        params: z.object({ executorThreadId: z.string(), threadId: z.string(), message: z.string() }),
      }),
      (request) => {
        dispatched.push(request.params);
        if (request.params.threadId === "synthetic-uuid") throw new Error("no such thread");
        return { delivered: true };
      },
    );
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
        dispatched.map((d) => d.threadId),
        ["thread-open-in-desktop", "second-open-thread", "synthetic-uuid"],
      );
      assert.ok(
        dispatched.every((d) => d.executorThreadId === "relay-executor" && d.executorThreadId !== d.threadId),
        "the executor context is never the destination",
      );
    } finally {
      await client.close();
    }
  });
});
