import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { RelaySocketServer, createNativeRelayLifecycle } from "../src/native-relay-companion.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = process.platform !== "win32";

function shortDirectory(t) {
  const directory = fs.mkdtempSync(path.join(posix ? "/tmp" : os.tmpdir(), "nrl-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function socketLive(socketPath) {
  return new Promise((resolve) => {
    const probe = net.connect({ path: socketPath });
    const done = (answer) => { probe.destroy(); resolve(answer); };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

async function eventually(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`${label} did not settle within ${timeoutMs} ms`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
  }
}

const relayServer = (socketPath, options = {}) => new RelaySocketServer({
  socketPath, signalExit: false, resolveExecutor: () => ({ threadId: "executor" }), dispatch: async () => ({ success: true }), ...options,
});

describe("native relay lifecycle", { skip: !posix && "POSIX sockets only" }, () => {
  it("removes the linked public socket when startup is refused or cancelled", async (t) => {
    const directory = shortDirectory(t);
    const refusedPath = path.join(directory, "refused.sock");
    const refused = relayServer(refusedPath, { restrictSocket: () => { throw new Error("chmod denied"); } });
    await assert.rejects(refused.start(), /could not be restricted/);
    assert.equal(fs.existsSync(refusedPath), false);

    const cancelledPath = path.join(directory, "cancelled.sock");
    let cancel;
    const cancelled = relayServer(cancelledPath, { restrictSocket: () => cancel() });
    cancel = () => cancelled.stop();
    await assert.rejects(cancelled.start(), /could not be restricted/);
    assert.equal(fs.existsSync(cancelledPath), false);
  });

  it("refuses activation with a generic message once deliveries are refused", async (t) => {
    const directory = shortDirectory(t);
    const lifecycle = createNativeRelayLifecycle({ nativeTools: { pending: new Map(), connecting: null, close() {} }, relays: [relayServer(path.join(directory, "g.sock"))] });
    lifecycle.refuseNewDeliveries();
    await assert.rejects(lifecycle.activate(), /^Error: The native relay is shutting down$/);
  });

  it("drains through the client-close path on SIGTERM and exits at once on a second signal", { timeout: 60000 }, async (t) => {
    for (const second of [false, true]) {
      const directory = shortDirectory(t);
      const pipePath = path.join(directory, "p.sock");
      const desktop = net.createServer((socket) => socket.on("error", () => {}));
      await new Promise((resolve) => desktop.listen(pipePath, resolve));
      t.after(() => new Promise((resolve) => desktop.close(resolve)));
      fs.mkdirSync(path.join(directory, "h"));
      const relayPath = path.join(directory, "r.sock");
      const child = spawn(process.execPath, [path.join(repository, "src", "native-relay-companion.mjs")], {
        env: { ...process.env, HOME: directory, CODEX_HOME: path.join(directory, "h"), CODEX_NATIVE_RELAY_SOCKET: relayPath, CODEX_APP_TOOLS_PIPE_PATH: pipePath, CODEX_BRIDGE_DESKTOP_TASKS: "0", CODEX_BRIDGE_HARDENED: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
      await eventually(() => socketLive(relayPath), 15000, "companion socket");
      const busy = net.connect(relayPath);
      busy.on("error", () => {});
      await new Promise((resolve) => busy.once("connect", resolve));
      child.kill("SIGTERM");
      await eventually(() => stderr.includes("MCP client closed (SIGTERM)"), 10000, "SIGTERM drain");
      assert.equal(child.exitCode, null);
      if (second) child.kill("SIGTERM");
      else busy.destroy();
      await eventually(() => child.exitCode !== null, 45000, "companion exit");
      assert.equal(child.exitCode, second ? 1 : 0);
      busy.destroy();
      if (!second) assert.equal(fs.existsSync(relayPath), false);
    }
  });
});
