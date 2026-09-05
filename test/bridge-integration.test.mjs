import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeAppServer } from "./helpers/fake-app-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withBridge(onRequest, run, extraEnv = () => ({})) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-integration-"));
  const server = await startFakeAppServer({ onRequest: (message, reply) => onRequest(message, reply, home) });
  const env = {
    PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
    HOME: home, USERPROFILE: home, CODEX_APP_SERVER_URL: server.url,
    CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_ALLOWED_ROOTS: home,
    CODEX_BRIDGE_THREAD_POLICY: "roots", CODEX_BRIDGE_OPEN_IN_APP: "0",
    CODEX_BRIDGE_RELEASE_AFTER_TURN: "0",
    ...extraEnv(home),
  };
  const client = new Client({ name: "bridge-integration", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "src", "index.mjs")],
    cwd: home, env, stderr: "ignore",
  });
  try {
    await client.connect(transport);
    await run({ client, home, env, server });
  } finally {
    await client.close();
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("bridge workspace and listing integration", () => {
  it("sends an absolute cwd to a server running in a different directory", async () => {
    let requestedCwd;
    await withBridge((msg, { respond }, home) => {
      if (msg.method === "thread/start") {
        requestedCwd = msg.params.cwd;
        respond({ thread: { id: "relative-thread", cwd: home } });
      }
    }, async ({ client, home }) => {
      const result = await client.callTool({ name: "start_codex_thread", arguments: { cwd: "." } });
      assert.equal(result.isError, undefined);
      assert.equal(requestedCwd, home);
    });
  });

  it("refuses a server-created thread outside the permitted workspace before sending a turn", async () => {
    const calls = [];
    await withBridge((msg, { respond, notify }) => {
      calls.push(msg.method);
      if (msg.method === "thread/start") respond({ thread: { id: "wrong-workspace", cwd: root } });
      if (msg.method === "thread/name/set") respond({});
      if (msg.method === "thread/unsubscribe") respond({ status: "notLoaded" });
      if (msg.method === "turn/start") {
        respond({ turn: { id: "turn" } });
        notify("turn/completed", { threadId: "wrong-workspace", turn: { id: "turn", status: "completed" } });
      }
    }, async ({ client, home }) => {
      const result = await client.callTool({ name: "delegate_to_codex", arguments: {
        cwd: home, prompt: "Do not execute outside this workspace.", openInApp: false, releaseAfterTurn: false,
      } });
      assert.equal(result.isError, true);
      assert.equal(calls.includes("turn/start"), false);
      assert.equal(calls.includes("thread/name/set"), false);
    });
  });

  it("hydrates loaded thread IDs and applies title and exact cwd filters", async () => {
    const readIds = [];
    await withBridge((msg, { respond }, home) => {
      if (msg.method === "thread/loaded/list") respond({ data: ["wanted", "other-title", "other-cwd", "outside"], nextCursor: null });
      if (msg.method === "thread/read") {
        const id = msg.params.threadId;
        readIds.push(id);
        fs.mkdirSync(path.join(home, "child"), { recursive: true });
        respond({ thread: {
          id, name: id === "other-title" ? "Unrelated" : "Target title",
          cwd: id === "outside" ? root : id === "other-cwd" ? path.join(home, "child") : home,
        } });
      }
    }, async ({ client, home }) => {
      const result = await client.callTool({ name: "list_codex_threads", arguments: {
        loadedOnly: true, cwd: home, searchTerm: "TARGET",
      } });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0].text, /1 Codex thread\(s\)/);
      assert.match(result.content[0].text, /wanted/);
      assert.doesNotMatch(result.content[0].text, /other-title|other-cwd|outside/);
      assert.equal(readIds.length, 4);
    });
  });

  it("does not authorize an unexpected created workspace through a path map", async () => {
    const calls = [];
    await withBridge((msg, { respond, notify }) => {
      calls.push(msg.method);
      if (msg.method === "thread/start") respond({ thread: { id: "mapped-outside", cwd: root } });
      if (msg.method === "thread/name/set") respond({});
      if (msg.method === "thread/unsubscribe") respond({ status: "notLoaded" });
      if (msg.method === "turn/start") {
        respond({ turn: { id: "turn" } });
        notify("turn/completed", { threadId: "mapped-outside", turn: { id: "turn", status: "completed" } });
      }
    }, async ({ client, home }) => {
      const result = await client.callTool({ name: "delegate_to_codex", arguments: {
        cwd: home, prompt: "Do not execute in an unexpected workspace.", openInApp: false, releaseAfterTurn: false,
      } });
      assert.equal(result.isError, true);
      assert.equal(calls.includes("turn/start"), false);
    }, home => ({ CODEX_BRIDGE_PATH_MAP: JSON.stringify({ [root]: home }) }));
  });

  it("searches subsequent loaded pages after filtering the first page", async () => {
    const cursors = [];
    await withBridge((msg, { respond }, home) => {
      if (msg.method === "thread/loaded/list") {
        cursors.push(msg.params.cursor ?? null);
        respond(msg.params.cursor ? { data: ["matching"], nextCursor: null } : { data: ["unrelated"], nextCursor: "page2" });
      }
      if (msg.method === "thread/read") respond({ thread: {
        id: msg.params.threadId, cwd: home, name: msg.params.threadId,
      } });
    }, async ({ client }) => {
      const result = await client.callTool({ name: "list_codex_threads", arguments: {
        loadedOnly: true, limit: 1, searchTerm: "matching",
      } });
      assert.match(result.content[0].text, /1 Codex thread\(s\)/);
      assert.deepEqual(cursors, [null, "page2"]);
    });
  });
});

function runCheck(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "check.mjs")], {
      env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("exit", code => resolve({ code, output }));
  });
}

describe("check command exit status", () => {
  it("fails when the app-server cannot be reached", async () => {
    const result = await runCheck({
      PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:1", CODEX_BRIDGE_AUTOSTART: "0",
    });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /No Codex app-server reachable/);
  });

  it("succeeds when the server returns an empty, valid thread list", async () => {
    await withBridge((msg, { respond }) => {
      if (msg.method === "thread/list") respond({ data: [] });
    }, async ({ env }) => {
      const result = await runCheck(env);
      assert.equal(result.code, 0, result.output);
    });
  });
});

describe("concurrent bridge handoffs", () => {
  it("serializes one thread while keeping different threads and the shared server alive", async () => {
    const active = new Set();
    const released = [];
    let nextTurn = 0;
    let peak = 0;
    let overlap = false;
    await withBridge((msg, { respond, notify }, home) => {
      const threadId = msg.params?.threadId;
      if (msg.method === "thread/read" || msg.method === "thread/resume") respond({ thread: { id: threadId, cwd: home } });
      if (msg.method === "turn/start") {
        overlap ||= active.has(threadId);
        active.add(threadId);
        peak = Math.max(peak, active.size);
        const id = `turn-${++nextTurn}`;
        respond({ turn: { id } });
        setTimeout(() => {
          active.delete(threadId);
          notify("turn/completed", { threadId, turn: { id, status: "completed" } });
        }, 75);
      }
      if (msg.method === "thread/unsubscribe") {
        assert.equal(active.has(threadId), false);
        released.push(threadId);
        respond({ status: "unsubscribed" });
        notify("thread/closed", { threadId });
      }
      if (msg.method === "thread/list") respond({ data: [] });
    }, async ({ client }) => {
      const results = await Promise.all(["one", "one", "two"].map(threadId => client.callTool({
        name: "send_to_codex_thread", arguments: { threadId, prompt: "Return a short reply.", openInApp: false, releaseAfterTurn: true },
      })));
      for (const result of results) {
        assert.equal(result.isError, undefined, result.content[0].text);
        assert.match(result.content[0].text, /released thread/);
      }
      assert.equal(overlap, false);
      assert.equal(peak, 2);
      assert.deepEqual(released.sort(), ["one", "one", "two"]);
      const listed = await client.callTool({ name: "list_codex_threads", arguments: {} });
      assert.equal(listed.isError, undefined);
    });
  });

  it("reports pending unload without claiming the writer lock is released", async () => {
    await withBridge((msg, { respond, notify }, home) => {
      const threadId = msg.params?.threadId;
      if (msg.method === "thread/read" || msg.method === "thread/resume") respond({ thread: { id: threadId, cwd: home } });
      if (msg.method === "turn/start") {
        respond({ turn: { id: "turn" } });
        notify("turn/completed", { threadId, turn: { id: "turn", status: "completed" } });
      }
      if (msg.method === "thread/unsubscribe") respond({ status: "unsubscribed" });
    }, async ({ client }) => {
      const result = await client.callTool({ name: "send_to_codex_thread", arguments: {
        threadId: "pending-unload", prompt: "Return a short reply.", openInApp: false, releaseAfterTurn: true,
      } });
      assert.equal(result.isError, undefined, result.content[0].text);
      assert.match(result.content[0].text, /unsubscribed from thread pending-unload/);
      assert.doesNotMatch(result.content[0].text, /released thread|Desktop can write/);
    });
  });
});
