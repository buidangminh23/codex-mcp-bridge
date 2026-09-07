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
import { RelaySocketServer } from "../src/native-relay-companion.mjs";
import { randomUUID } from "node:crypto";
import { readProcessAncestry } from "../src/claude-sender-context.mjs";
import { readClaudeAccountContext } from "../src/desktop-account-context.mjs";
import { readCodexAccountContext } from "../src/codex-account-context.mjs";
import { assertAccountIdentity } from "../src/bridge-account-context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const CLAUDE_ACCOUNT_B = "22222222-2222-4222-8222-222222222222";

function claudeFixtureRoot(home) {
  return process.platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude")
    : process.platform === "win32" ? path.join(home, "AppData", "Roaming", "Claude") : path.join(home, ".config", "Claude");
}

function fixtureRelayServer({ home, socketPath, ...options }) {
  const assertAccount = (expected) => assertAccountIdentity(expected, {
    claude: readClaudeAccountContext({ root: claudeFixtureRoot(home) }),
    codex: readCodexAccountContext({ root: path.join(home, ".codex") }),
  });
  const servers = [socketPath, `${socketPath}-accounts-v2`].map((endpoint) => new RelaySocketServer({
    ...options, socketPath: endpoint, assertAccount,
  }));
  return { start: () => Promise.all(servers.map((server) => server.start())), stop: () => servers.forEach((server) => server.stop()) };
}

async function desktopCallerFixture(home, env) {
  const accountRoot = claudeFixtureRoot(home);
  Object.assign(env, { APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex") });
  fs.mkdirSync(accountRoot, { recursive: true });
  const setAccount = (accountId) => fs.writeFileSync(path.join(accountRoot, "config.json"), JSON.stringify({ lastKnownAccountUuid: accountId, windowSizeWasSignedIn: true }));
  setAccount(CLAUDE_ACCOUNT_A);
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const token = [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ sub: "fixture-user", "https://api.openai.com/auth": { chatgpt_account_id: "fixture-codex" } })).toString("base64url"), "fixture"].join(".");
  fs.writeFileSync(path.join(env.CODEX_HOME, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "fixture-codex", id_token: token } }));
  const registry = path.join(home, ".claude", "sessions");
  fs.mkdirSync(registry, { recursive: true });
  const endpoint = path.join(home, "unused-peer-endpoint");
  fs.writeFileSync(endpoint, "");
  const [parent] = await readProcessAncestry({ parentPid: process.pid, maxDepth: 1 });
  assert.ok(parent?.processStart);
  const registryFile = path.join(registry, `${process.pid}.json`);
  fs.writeFileSync(registryFile, JSON.stringify({ pid: process.pid, sessionId: "fixture-caller", cwd: home, entrypoint: "claude-desktop", messagingSocketPath: endpoint, [process.platform === "win32" ? "procStartFt" : "procStart"]: parent.processStart }));
  const tasks = path.join(accountRoot, "claude-code-sessions", CLAUDE_ACCOUNT_A, "33333333-3333-4333-8333-333333333333");
  fs.mkdirSync(tasks, { recursive: true });
  const taskId = "local_44444444-4444-4444-8444-444444444444";
  fs.writeFileSync(path.join(tasks, `${taskId}.json`), JSON.stringify({ sessionId: taskId, cliSessionId: "fixture-caller", cwd: home, title: "Fixture caller", isArchived: false }));
  return { setAccount, registryFile };
}

async function withBridge(onRequest, run, extraEnv = () => ({})) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-integration-"));
  const server = await startFakeAppServer({ onRequest: (message, reply) => onRequest(message, reply, home) });
  const env = {
    PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
    HOME: home, USERPROFILE: home, CODEX_APP_SERVER_URL: server.url,
    CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_ALLOWED_ROOTS: home,
    CODEX_BRIDGE_THREAD_POLICY: "roots", CODEX_BRIDGE_OPEN_IN_APP: "0",
    CODEX_BRIDGE_RELEASE_AFTER_TURN: "0",
    ...await extraEnv(home),
  };
  const desktopFixture = env.CODEX_BRIDGE_DESKTOP_TASKS === "1" ? await desktopCallerFixture(home, env) : null;
  const client = new Client({ name: "bridge-integration", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(root, "src", "index.mjs")],
    cwd: home, env, stderr: "ignore",
  });
  try {
    await client.connect(transport);
    await run({ client, home, env, server, desktopFixture });
  } finally {
    await client.close();
    await server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function additionalBridgeProcess({ home, env }) {
  const client = new Client({ name: "bridge-restart-integration", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "index.mjs")], cwd: home, env, stderr: "ignore" });
  await client.connect(transport);
  return { client, pid: transport.pid };
}

async function withDesktopReceiptBridge(dispatch, run) {
  let relay;
  const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dt-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\desktop-receipts-${randomUUID()}` : path.join(socketRoot, "d.sock");
  try {
    await withBridge(() => { throw new Error("Desktop receipt operations must not reach an external app-server"); }, run, async (home) => {
      relay = fixtureRelayServer({ home, socketPath, resolveExecutor: () => ({ threadId: "executor" }), dispatchDesktop: async (request) => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(await dispatch(request, home)) }] }) });
      await relay.start();
      return { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_NATIVE_RELAY_SOCKET: socketPath, CODEX_APP_SERVER_URL: "invalid-unused-legacy-endpoint" };
    });
  } finally {
    relay?.stop();
    fs.rmSync(socketRoot, { recursive: true, force: true });
  }
}

function creationReceipts(home) {
  const directory = path.join(home, ".codex", "bridge-task-receipts");
  return fs.readdirSync(directory).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
}

describe("Desktop task MCP integration", () => {
  it("withholds a delayed reply when the account changes after the explicit task was dispatched", async () => {
    const calls = [];
    let changeAccount;
    await withDesktopReceiptBridge(async ({ operation, arguments: args }, home) => {
      calls.push(operation);
      if (operation === "read_thread") return { thread: { id: args.threadId, hostId: "local", cwd: home }, turns: [] };
      if (operation === "send_message_to_thread") return { threadId: args.threadId, status: "accepted" };
      if (operation === "wait_threads") {
        changeAccount();
        return { polls: [{ thread: { id: "original-task", hostId: "local", status: { type: "idle" } }, latestTurn: { id: "original-turn", status: "completed" }, latestAssistantMessage: { turnId: "original-turn", phase: "final_answer", text: "PRIVATE_DELAYED_REPLY" } }] };
      }
      throw new Error(`Unexpected operation ${operation}`);
    }, async ({ client, desktopFixture }) => {
      changeAccount = () => desktopFixture.setAccount(CLAUDE_ACCOUNT_B);
      const reply = await client.callTool({ name: "send_to_codex_thread", arguments: { threadId: "original-task", prompt: "Original work", openInApp: false } });
      assert.equal(reply.isError, true);
      assert.equal(reply.structuredContent.operation.state, "dispatched_outcome_unverified");
      assert.equal(reply.structuredContent.operation.threadId, "original-task");
      assert.doesNotMatch(JSON.stringify(reply), /PRIVATE_DELAYED_REPLY|No message was sent/);
      assert.match(reply.content[0].text, /may already have been dispatched/);
      assert.deepEqual(calls, ["read_thread", "send_message_to_thread", "wait_threads"]);
      const later = await client.callTool({ name: "send_to_codex_thread", arguments: { threadId: "original-task", prompt: "Stale caller", openInApp: false } });
      assert.equal(later.isError, true);
      assert.match(later.content[0].text, /calling Claude Code session is not confirmed/);
      assert.equal(calls.length, 3);
    });
  });

  it("keeps status callable for a generic main-process MCP but refuses task mutations", async () => {
    const calls = [];
    await withDesktopReceiptBridge(async ({ operation }) => {
      calls.push(operation);
      if (operation === "list_projects") return { projects: [] };
      throw new Error(`Unexpected operation ${operation}`);
    }, async ({ client, home, desktopFixture }) => {
      fs.unlinkSync(desktopFixture.registryFile);
      const status = await client.callTool({ name: "codex_bridge_status", arguments: {} });
      assert.equal(status.isError, undefined);
      const mutation = await client.callTool({ name: "start_codex_thread", arguments: { cwd: home, prompt: "Blocked generic caller" } });
      assert.equal(mutation.isError, true);
      assert.match(mutation.content[0].text, /no registered Claude Desktop Code session/);
      assert.deepEqual(calls, ["list_projects"]);
    });
  });
  it("blocks concurrent named creation across MCP processes and reuses the completed task after restart with an edited prompt", async () => {
    const calls = [];
    let completed = false;
    let observeCreate;
    let releaseCreate;
    const creating = new Promise((resolve) => { observeCreate = resolve; });
    const gate = new Promise((resolve) => { releaseCreate = resolve; });
    await withDesktopReceiptBridge(async ({ operation }, home) => {
      calls.push(operation);
      if (operation === "list_projects") return { projects: [{ projectId: "receipt-project", projectKind: "local", hostId: "local", path: home, label: "Receipt test" }] };
      if (operation === "create_thread") {
        observeCreate();
        await gate;
        return { threadId: "shared-receipt-task", hostId: "local", firstTurn: { status: "accepted" } };
      }
      if (operation === "read_thread") return { thread: { id: "shared-receipt-task", hostId: "local", cwd: home, title: "Shared title", status: completed ? "idle" : "active" }, turns: [{ id: "receipt-turn", status: completed ? "completed" : "inProgress" }] };
      if (operation === "list_threads") return { pinnedThreads: [{ id: "shared-receipt-task", kind: "codex", hostId: "local", cwd: home, projectId: "receipt-project" }], threads: [] };
      throw new Error(`Unexpected operation ${operation}`);
    }, async ({ client, home, env, server }) => {
      const clients = [];
      const args = { cwd: home, name: "Shared title", prompt: "Original private brief", openInApp: false };
      try {
        const simultaneous = await additionalBridgeProcess({ home, env });
        clients.push(simultaneous.client);
        const first = client.callTool({ name: "start_codex_thread", arguments: args });
        first.catch(() => {});
        await creating;
        assert.deepEqual(creationReceipts(home).map((receipt) => receipt.state), ["pending"]);
        const duplicate = await simultaneous.client.callTool({ name: "start_codex_thread", arguments: { ...args, prompt: "Slightly edited private brief" } });
        assert.equal(duplicate.isError, true);
        assert.match(duplicate.content[0].text, /pending|already in progress/);
        assert.equal(calls.filter((operation) => operation === "create_thread").length, 1);
        releaseCreate();
        const accepted = await first;
        assert.equal(accepted.isError, undefined);
        assert.match(accepted.content[0].text, /threadId: shared-receipt-task/);
        assert.deepEqual(creationReceipts(home).map(({ state, threadId }) => ({ state, threadId })), [{ state: "known", threadId: "shared-receipt-task" }]);
        const activeRetry = await simultaneous.client.callTool({ name: "start_codex_thread", arguments: { ...args, prompt: "Slightly edited private brief" } });
        assert.equal(activeRetry.isError, undefined);
        assert.match(activeRetry.content[0].text, /Reused the existing Codex Desktop task; the prompt was not resent/);
        assert.match(activeRetry.content[0].text, /^project assignment: verified in Desktop's current listing$/m);
        completed = true;
        await client.close();
        await simultaneous.client.close();
        const restarted = await additionalBridgeProcess({ home, env });
        clients.push(restarted.client);
        assert.notEqual(restarted.pid, simultaneous.pid);
        const retry = await restarted.client.callTool({ name: "start_codex_thread", arguments: { ...args, prompt: "Slightly edited private brief" } });
        assert.equal(retry.isError, undefined);
        assert.match(retry.content[0].text, /Reused the existing Codex Desktop task; the prompt was not resent/);
        assert.match(retry.content[0].text, /threadId: shared-receipt-task/);
        assert.match(retry.content[0].text, /^projectId: receipt-project$/m);
        assert.match(retry.content[0].text, /^project assignment: verified in Desktop's current listing$/m);
        assert.deepEqual(calls, ["list_projects", "create_thread", "read_thread", "list_projects", "list_threads", "read_thread", "list_projects", "list_threads"]);
        assert.equal(server.connections, 0);
      } finally {
        releaseCreate();
        await Promise.all(clients.map((other) => other.close()));
      }
    });
  });

  it("retains an omitted task across MCP restart without claiming verified project assignment or resending the edited brief", async () => {
    const calls = [];
    await withDesktopReceiptBridge(async ({ operation }, home) => {
      calls.push(operation);
      if (operation === "list_projects") return { projects: [{ projectId: "receipt-project", projectKind: "local", hostId: "local", path: home, label: "Receipt test" }] };
      if (operation === "create_thread") return { threadId: "omitted-receipt-task", hostId: "local", firstTurn: { status: "accepted" } };
      if (operation === "read_thread") return { thread: { id: "omitted-receipt-task", hostId: "local", cwd: home, title: "Omitted title", status: "idle" }, turns: [] };
      if (operation === "list_threads") return { pinnedThreads: [], threads: [] };
      throw new Error(`Unexpected operation ${operation}`);
    }, async ({ client, home, env, server }) => {
      const args = { cwd: home, name: "Omitted title", prompt: "Original private brief", openInApp: false };
      const accepted = await client.callTool({ name: "start_codex_thread", arguments: args });
      assert.equal(accepted.isError, undefined);
      await client.close();
      const restarted = await additionalBridgeProcess({ home, env });
      try {
        const reused = await restarted.client.callTool({ name: "delegate_to_codex", arguments: { ...args, prompt: "Edited private brief" } });
        assert.equal(reused.isError, undefined);
        const text = reused.content[0].text;
        assert.match(text, /Reused the existing Codex Desktop task; the prompt was not resent/);
        assert.match(text, /^threadId: omitted-receipt-task$/m);
        assert.match(text, /^expected projectId: receipt-project$/m);
        assert.match(text, /^project assignment: unverified$/m);
        assert.match(text, /absent from Desktop's recent\/pinned listing/);
        assert.match(text, /^status: existing task retained; project assignment needs inspection$/m);
        assert.doesNotMatch(text, /^projectId:|^project:|project assignment: verified|status: completed/m);
        assert.deepEqual(calls, ["list_projects", "create_thread", "read_thread", "list_projects", "list_threads"]);
        assert.deepEqual(creationReceipts(home).map(({ state, threadId }) => ({ state, threadId })), [{ state: "known", threadId: "omitted-receipt-task" }]);
        assert.equal(server.connections, 0);
      } finally {
        await restarted.client.close();
      }
    });
  });

  it("persists an unknown creation after a lost native reply and blocks retries from a restarted MCP process", async () => {
    const calls = [];
    await withDesktopReceiptBridge(async ({ operation }, home) => {
      calls.push(operation);
      if (operation === "list_projects") return { projects: [{ projectId: "receipt-project", projectKind: "local", hostId: "local", path: home }] };
      if (operation === "create_thread") throw new Error("Native reply was lost after Desktop accepted creation");
      throw new Error(`Unexpected operation ${operation}`);
    }, async ({ client, home, env, server }) => {
      const args = { cwd: home, name: "Lost reply title", prompt: "Original brief", openInApp: false };
      const initial = await client.callTool({ name: "start_codex_thread", arguments: args });
      assert.equal(initial.isError, true);
      assert.match(initial.content[0].text, /Do not resend the prompt.*blocks duplicate tasks even after a bridge restart/);
      assert.deepEqual(creationReceipts(home).map((receipt) => receipt.state), ["unknown"]);
      await client.close();
      const restarted = await additionalBridgeProcess({ home, env });
      try {
        const retry = await restarted.client.callTool({ name: "start_codex_thread", arguments: { ...args, prompt: "Original brief with minor edits" } });
        assert.equal(retry.isError, true);
        assert.match(retry.content[0].text, /earlier Desktop creation is unknown.*Do not resend or create another task/);
        assert.deepEqual(calls, ["list_projects", "create_thread"]);
        assert.deepEqual(creationReceipts(home).map((receipt) => receipt.state), ["unknown"]);
        assert.equal(server.connections, 0);
      } finally {
        await restarted.client.close();
      }
    });
  });

  it("shares a ten-second budget between creation and observation while preserving its task for restart reuse", { timeout: 20000 }, async () => {
    const calls = [];
    let releaseWait;
    const gate = new Promise((resolve) => { releaseWait = resolve; });
    try {
      await withDesktopReceiptBridge(async ({ operation }, home) => {
        calls.push(operation);
        if (operation === "list_projects") return { projects: [{ projectId: "receipt-project", projectKind: "local", hostId: "local", path: home }] };
        if (operation === "create_thread") {
          await new Promise((resolve) => setTimeout(resolve, 1100));
          return { threadId: "timeout-receipt-task", hostId: "local", firstTurn: { status: "accepted" } };
        }
        if (operation === "read_thread") return { thread: { id: "timeout-receipt-task", hostId: "local", cwd: home, title: "Timeout title", status: "active" }, turns: [{ id: "timeout-turn", status: "inProgress" }] };
        if (operation === "list_threads") return { pinnedThreads: [], threads: [{ id: "timeout-receipt-task", kind: "codex", hostId: "local", cwd: home, projectId: "receipt-project" }] };
        if (operation === "wait_threads") {
          assert.deepEqual(creationReceipts(home).map(({ state, threadId }) => ({ state, threadId })), [{ state: "known", threadId: "timeout-receipt-task" }]);
          await gate;
          return { polls: [] };
        }
        throw new Error(`Unexpected operation ${operation}`);
      }, async ({ client, home, env, server }) => {
        const args = { cwd: home, name: "Timeout title", prompt: "Keep working after observation ends", openInApp: false };
        const started = Date.now();
        const result = await client.callTool({ name: "delegate_to_codex", arguments: { ...args, timeoutSec: 10 } });
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 9500 && elapsed < 11000, `Whole operation took ${elapsed}ms; expected the single 10s budget`);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /threadId: timeout-receipt-task/);
        assert.match(result.content[0].text, /status: timeout/);
        assert.deepEqual(creationReceipts(home).map(({ state, threadId }) => ({ state, threadId })), [{ state: "known", threadId: "timeout-receipt-task" }]);
        releaseWait();
        await client.close();
        const restarted = await additionalBridgeProcess({ home, env });
        try {
          const retry = await restarted.client.callTool({ name: "start_codex_thread", arguments: args });
          assert.equal(retry.isError, undefined);
          assert.match(retry.content[0].text, /Reused the existing Codex Desktop task/);
          assert.match(retry.content[0].text, /threadId: timeout-receipt-task/);
          assert.match(retry.content[0].text, /^project assignment: verified in Desktop's current listing$/m);
          assert.deepEqual(calls, ["list_projects", "create_thread", "wait_threads", "read_thread", "list_projects", "list_threads"]);
          assert.equal(server.connections, 0);
        } finally {
          await restarted.client.close();
        }
      });
    } finally {
      releaseWait();
    }
  });

  it("uses only Desktop for status, filtered listing, read, and open even when legacy autostart is requested", async () => {
    const calls = [];
    let relay;
    const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dt-"));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\desktop-diagnostics-${randomUUID()}` : path.join(socketRoot, "d.sock");
    try {
      await withBridge(() => { throw new Error("Desktop diagnostics must not contact an external app-server"); }, async ({ client, home, server }) => {
        const status = await client.callTool({ name: "codex_bridge_status", arguments: {} });
        assert.equal(status.isError, undefined);
        assert.match(status.content[0].text, /native relay:   available; verified/);
        assert.match(status.content[0].text, /autostart:      off/);
        assert.doesNotMatch(status.content[0].text, /Start one with/);
        const listed = await client.callTool({ name: "list_codex_threads", arguments: { cwd: home, searchTerm: "TARGET", limit: 5 } });
        assert.equal(listed.isError, undefined);
        assert.match(listed.content[0].text, /1 Codex thread\(s\) via Codex Desktop/);
        assert.match(listed.content[0].text, /title: Target task/);
        assert.match(listed.content[0].text, /updated: 2026-09-05/);
        assert.doesNotMatch(listed.content[0].text, /hidden-remote|hidden-chat|hidden-outside|misleading-summary/);
        const loaded = await client.callTool({ name: "list_codex_threads", arguments: { loadedOnly: true } });
        assert.equal(loaded.isError, true);
        assert.match(loaded.content[0].text, /does not expose a loaded-only/);
        const read = await client.callTool({ name: "read_codex_thread", arguments: { threadId: "target" } });
        assert.equal(read.isError, undefined);
        const opened = await client.callTool({ name: "open_codex_thread", arguments: { threadId: "target" } });
        assert.equal(opened.isError, undefined);
        const stopped = await client.callTool({ name: "stop_codex_app_server", arguments: {} });
        assert.equal(stopped.isError, undefined);
        assert.match(stopped.content[0].text, /left unchanged/);
        assert.deepEqual(calls, ["list_projects", "list_threads", "read_thread", "read_thread", "read_thread", "navigate_to_codex_page"]);
        assert.equal(server.connections, 0);
      }, async (home) => {
        relay = fixtureRelayServer({ home, socketPath, resolveExecutor: () => ({ threadId: "executor" }), dispatchDesktop: async ({ operation }) => {
          calls.push(operation);
          const target = { id: "target", kind: "codex", hostId: "local", cwd: home, title: "Target task", summary: "misleading-summary", status: "active", updatedAt: 1788597586 };
          let result;
          if (operation === "list_projects") result = { projects: [{ projectId: "project-id", projectKind: "local", hostId: "local", path: home }] };
          else if (operation === "list_threads") result = { pinnedThreads: [target], threads: [target, { ...target, id: "hidden-remote", hostId: "remote" }, { ...target, id: "hidden-chat", kind: "chatgpt" }, { ...target, id: "hidden-outside", cwd: root }] };
          else if (operation === "read_thread") result = { thread: target, turns: [] };
          else if (operation === "navigate_to_codex_page") result = { navigated: true };
          else throw new Error(`Unexpected operation ${operation}`);
          return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
        } });
        await relay.start();
        return { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_NATIVE_RELAY_SOCKET: socketPath, CODEX_BRIDGE_AUTOSTART: "1", CODEX_APP_SERVER_URL: "invalid-unused-legacy-endpoint" };
      });
    } finally {
      relay?.stop();
      fs.rmSync(socketRoot, { recursive: true, force: true });
    }
  });

  it("fails clearly when the Desktop relay is absent without falling back for any diagnostic or task operation", async () => {
    await withBridge(() => { throw new Error("Missing native relay must not trigger a legacy request"); }, async ({ client, home, server }) => {
      for (const [name, args] of [
        ["codex_bridge_status", {}], ["list_codex_threads", {}],
        ["read_codex_thread", { threadId: "task" }], ["open_codex_thread", { threadId: "task" }],
        ["interrupt_codex_turn", { threadId: "task", turnId: "turn" }],
        ["send_to_codex_thread", { threadId: "task", prompt: "Do not send externally" }],
        ["delegate_to_codex", { cwd: home, prompt: "Do not create externally" }],
        ["start_codex_thread", { cwd: home, prompt: "Do not create externally" }],
      ]) {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, name);
        assert.match(result.content[0].text, /Desktop-only mode will not start or use an external app-server/, name);
        assert.doesNotMatch(result.content[0].text, /Start one with/, name);
      }
      assert.equal(server.connections, 0);
    }, (home) => ({ CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_NATIVE_RELAY_SOCKET: process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\desktop-missing-${randomUUID()}` : path.join(home, "absent.sock"), CODEX_BRIDGE_AUTOSTART: "1", CODEX_APP_SERVER_URL: "invalid-unused-legacy-endpoint" }));
  });

  it("serializes overlapping Desktop sends to one thread while another thread can finish", async () => {
    const sends = [];
    const turns = new Map();
    let release;
    let observed;
    const firstWaiting = new Promise((resolve) => { observed = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    let relay;
    const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dt-"));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\desktop-concurrency-${randomUUID()}` : path.join(socketRoot, "d.sock");
    try {
      await withBridge(() => { throw new Error("Desktop sends must not reach the app-server"); }, async ({ client, server }) => {
        const send = (threadId) => client.callTool({ name: "send_to_codex_thread", arguments: { threadId, prompt: "Task", openInApp: false } });
        const first = send("same");
        await firstWaiting;
        const second = send("same");
        const other = await send("other");
        assert.equal(other.isError, undefined);
        assert.deepEqual(sends, ["same:1", "other:1"]);
        release();
        const results = await Promise.all([first, second]);
        assert.ok(results.every((result) => !result.isError));
        assert.deepEqual(sends, ["same:1", "other:1", "same:2"]);
        assert.equal(server.connections, 0);
      }, async (home) => {
        relay = fixtureRelayServer({ home, socketPath, resolveExecutor: () => ({ threadId: "executor" }), dispatchDesktop: async ({ operation, arguments: args }) => {
          const threadId = args.threadId ?? args.targets?.[0]?.threadId;
          let result;
          if (operation === "read_thread") result = { thread: { id: threadId, hostId: "local", cwd: home }, turns: [{ id: `${threadId}:${turns.get(threadId) ?? 0}` }] };
          else if (operation === "send_message_to_thread") {
            turns.set(threadId, (turns.get(threadId) ?? 0) + 1);
            sends.push(`${threadId}:${turns.get(threadId)}`);
            result = { threadId, status: "accepted" };
          } else if (operation === "wait_threads") {
            const turnId = `${threadId}:${turns.get(threadId)}`;
            if (turnId === "same:1") { observed(); await gate; }
            result = { polls: [{ thread: { id: threadId, hostId: "local", status: { type: "idle" } }, latestTurn: { id: turnId, status: "completed" }, latestAssistantMessage: { turnId, phase: "final_answer", text: "COMPLETE" } }] };
          } else throw new Error(`Unexpected operation ${operation}`);
          return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
        } });
        await relay.start();
        return { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_NATIVE_RELAY_SOCKET: socketPath, CODEX_BRIDGE_AUTOSTART: "1", CODEX_APP_SERVER_URL: "invalid-unused-legacy-endpoint" };
      });
    } finally {
      release();
      relay?.stop();
      fs.rmSync(socketRoot, { recursive: true, force: true });
    }
  });

  it("creates, assigns, opens, and waits without sending anything to a second app-server", async () => {
    const calls = [];
    let relay;
    const socketRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dt-"));
    const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\desktop-task-${randomUUID()}` : path.join(socketRoot, "d.sock");
    try {
      await withBridge(() => { throw new Error("Native delivery must not call the external app-server"); }, async ({ client, home }) => {
        const result = await client.callTool({ name: "delegate_to_codex", arguments: { cwd: home, prompt: "Task", name: "Visible task", openInApp: true } });
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /projectId: project-id/);
        assert.match(result.content[0].text, /opened in Codex Desktop while/);
        assert.match(result.content[0].text, /COMPLETE/);
        assert.deepEqual(calls.map(([op]) => op), ["list_projects", "create_thread", "navigate_to_codex_page", "wait_threads"]);
        const empty = await client.callTool({ name: "start_codex_thread", arguments: { cwd: home } });
        assert.equal(empty.isError, true);
        assert.match(empty.content[0].text, /No task was created/);
        assert.equal(calls.length, 4);
      }, async (home) => {
        relay = fixtureRelayServer({ home, socketPath, resolveExecutor: () => ({ threadId: "executor" }), dispatchDesktop: async ({ operation, arguments: args }) => {
          calls.push([operation, args]);
          let result;
          if (operation === "list_projects") result = { projects: [{ projectId: "project-id", projectKind: "local", hostId: "local", path: home, label: "Test" }] };
          else if (operation === "create_thread") result = { threadId: "new-task", hostId: "local" };
          else if (operation === "navigate_to_codex_page") result = { navigated: true };
          else if (operation === "wait_threads") result = { polls: [{ thread: { id: "new-task", hostId: "local", status: { type: "idle" } }, latestTurn: { id: "turn", status: "completed" }, latestAssistantMessage: { turnId: "turn", phase: "final_answer", text: "COMPLETE" } }] };
          else throw new Error(`Unexpected operation ${operation}`);
          return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
        } });
        await relay.start();
        return { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_NATIVE_RELAY_SOCKET: socketPath };
      });
    } finally {
      relay?.stop();
      fs.rmSync(socketRoot, { recursive: true, force: true });
    }
  });
});

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
      assert.equal(path.isAbsolute(requestedCwd), true);
      assert.equal(fs.realpathSync(requestedCwd), fs.realpathSync(home));
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
      CODEX_BRIDGE_DESKTOP_TASKS: "0",
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
