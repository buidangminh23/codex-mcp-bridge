import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { antigravityBridgeDirectory, antigravitySocket } from "../src/antigravity-ipc.mjs";

const entry = fileURLToPath(new URL("../src/antigravity-bridge.mjs", import.meta.url));
const TOOLS = [
  "antigravity_bridge_status", "list_antigravity_conversations", "send_to_antigravity_conversation",
  "start_antigravity_cli_session", "read_antigravity_delivery", "close_antigravity_cli_session",
];

function payload(response) {
  assert.ok(response.content?.[0]?.type === "text");
  return JSON.parse(response.content[0].text);
}

async function fixture(t, { caller, verified = false } = {}) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "antigravity-mcp-")));
  const cwd = path.join(home, "project");
  const otherCwd = path.join(home, "other-project");
  const bridgeDirectory = antigravityBridgeDirectory(home);
  const sessions = path.join(home, ".codex", "sessions", "2026", "10", "28");
  for (const directory of [cwd, otherCwd, bridgeDirectory, sessions]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const threadId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const metadata = { "x-codex-turn-metadata": { thread_id: threadId, turn_id: turnId, thread_source: "user", auto_review_enabled: false, node_repl_auto_review_required: false } };
  const rollout = path.join(sessions, `rollout-2026-10-28T00-00-00-${threadId}.jsonl`);
  const records = [
    { type: "session_meta", payload: { id: threadId, originator: "Codex Desktop", source: "vscode", cwd } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: { turn_id: turnId, cwd, approval_policy: "never", approvals_reviewer: "user", permission_profile: { type: "disabled" }, sandbox_policy: { type: "danger-full-access" } } },
  ];
  const writeRollout = () => fs.writeFileSync(rollout, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  if (verified) writeRollout();
  const sidecarRequests = [];
  const sockets = new Set();
  const sidecar = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      sidecarRequests.push(request);
      socket.end(`${JSON.stringify({ result: { available: true, transport: "native-agentapi", permissionPolicy: "native-unchanged" } })}\n`);
    });
  });
  await new Promise((resolve, reject) => { sidecar.once("error", reject); sidecar.listen(antigravitySocket(bridgeDirectory), resolve); });
  const env = Object.fromEntries(Object.entries(getDefaultEnvironment()).filter(([name]) => !/^(?:CODEX|CLAUDE|ANTHROPIC|MCP_|ANTIGRAVITY)/i.test(name)));
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
    CODEX_HOME: path.join(home, ".codex"), ANTIGRAVITY_CLI_BIN: path.join(home, process.platform === "win32" ? "never-launch.exe" : "never-launch"),
  });
  if (caller) env.ANTIGRAVITY_BRIDGE_CALLER = caller;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd, env, stderr: "pipe" });
  const client = new Client({ name: "antigravity-fixture", version: "1.0.0" });
  transport.stderr.resume();
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => sidecar.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = (name, args, meta) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: 10000 });
  const receipts = () => fs.readdirSync(path.join(bridgeDirectory, "cli-deliveries"));
  return { client, call, home, cwd, otherCwd, metadata, threadId, records, writeRollout, sidecarRequests, receipts, bridgeDirectory };
}

test("real stdio bridge advertises all tools and reads status without starting a CLI", { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const inventory = await f.client.listTools();
  assert.deepEqual(inventory.tools.map((tool) => tool.name).sort(), [...TOOLS].sort());
  for (const name of ["antigravity_bridge_status", "list_antigravity_conversations", "read_antigravity_delivery"]) {
    assert.equal(inventory.tools.find((tool) => tool.name === name).annotations.readOnlyHint, true);
  }
  const response = await f.call("antigravity_bridge_status", {});
  assert.equal(response.isError, undefined);
  const status = payload(response);
  assert.equal(status.caller, "unconfigured");
  assert.equal(status.desktop.available, true);
  assert.equal(status.cli.activeSessions, 0);
  assert.equal(status.cli.interactiveTerminalAttachment, false);
  assert.deepEqual(f.sidecarRequests, [{ operation: "status" }]);
  assert.deepEqual(f.receipts(), []);
});

for (const caller of [undefined, "codex", "claude"]) {
  test(`missing ${caller ?? "unconfigured"} sender identity blocks all scoped operations before dispatch`, { timeout: 20000 }, async (t) => {
    const f = await fixture(t, { caller });
    const shared = { requestId: crypto.randomUUID(), cwd: f.cwd, prompt: "Fixture only; must never reach a model" };
    const conversationId = crypto.randomUUID();
    const operations = [
      ["list_antigravity_conversations", { surface: "desktop" }],
      ["list_antigravity_conversations", { surface: "cli" }],
      ["start_antigravity_cli_session", shared],
      ["send_to_antigravity_conversation", { ...shared, surface: "desktop", conversationId }],
      ["send_to_antigravity_conversation", { ...shared, surface: "cli", conversationId }],
      ["read_antigravity_delivery", { surface: "desktop", requestId: shared.requestId }],
      ["read_antigravity_delivery", { surface: "cli", requestId: shared.requestId }],
      ["close_antigravity_cli_session", { conversationId }],
    ];
    for (const [name, args] of operations) {
      const response = await f.call(name, args);
      assert.equal(response.isError, true, name);
      assert.equal(payload(response).deliveryState, "not_sent", name);
      assert.match(payload(response).error, caller === "codex" ? /host-supplied Codex/ : caller === "claude" ? /account is not verified/ : /unknown callers/, name);
    }
    assert.deepEqual(f.sidecarRequests, []);
    assert.deepEqual(f.receipts(), []);
  });
}

test("verified fixture sender can list owned CLI sessions but cannot send outside its project", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { caller: "codex", verified: true });
  const response = await f.call("list_antigravity_conversations", { surface: "cli" }, f.metadata);
  assert.equal(response.isError, undefined, JSON.stringify(response));
  assert.deepEqual(payload(response), []);
  const request = { requestId: crypto.randomUUID(), cwd: f.otherCwd, prompt: "Fixture only; must never reach a model" };
  for (const [name, args] of [
    ["start_antigravity_cli_session", request],
    ["send_to_antigravity_conversation", { ...request, surface: "desktop", conversationId: crypto.randomUUID() }],
    ["send_to_antigravity_conversation", { ...request, surface: "cli", conversationId: crypto.randomUUID() }],
  ]) {
    const denied = await f.call(name, args, f.metadata);
    assert.equal(denied.isError, true, name);
    assert.match(payload(denied).error, /match the verified sender's project directory/);
    assert.equal(payload(denied).deliveryState, "not_sent");
  }
  assert.deepEqual(f.sidecarRequests, []);
  assert.deepEqual(f.receipts(), []);
});

test("completed caller turns cannot reuse old metadata for a native send", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { caller: "codex", verified: true });
  f.records[1].payload.type = "task_complete";
  f.writeRollout();
  const denied = await f.call("send_to_antigravity_conversation", {
    requestId: crypto.randomUUID(), cwd: f.cwd, prompt: "Fixture only", surface: "desktop", conversationId: crypto.randomUUID(),
  }, f.metadata);
  assert.equal(denied.isError, true);
  assert.match(payload(denied).error, /no longer the latest active Codex turn/);
  assert.deepEqual(f.sidecarRequests, []);
  assert.deepEqual(f.receipts(), []);
});

test("fixture receipts are scoped to exact sender identity and workspace", { timeout: 20000 }, async (t) => {
  const f = await fixture(t, { caller: "codex", verified: true });
  const requestId = crypto.randomUUID();
  const record = { requestId, status: "completed", cwd: f.cwd, sender: { provider: "codex", id: f.threadId }, result: { response: "fixture receipt" } };
  const file = path.join(f.bridgeDirectory, "cli-deliveries", `${requestId}.json`);
  const read = () => f.call("read_antigravity_delivery", { surface: "cli", requestId }, f.metadata);
  const write = () => fs.writeFileSync(file, JSON.stringify(record));
  write();
  assert.equal(payload(await read()).result.response, "fixture receipt");
  record.sender.id = crypto.randomUUID();
  write();
  assert.match(payload(await read()).error, /does not belong to this sending conversation/);
  record.sender.id = f.threadId;
  record.sender.provider = "claude";
  write();
  assert.match(payload(await read()).error, /does not belong to this sending conversation/);
  record.sender.provider = "codex";
  record.cwd = f.otherCwd;
  write();
  assert.match(payload(await read()).error, /match the verified sender's project directory/);
  assert.deepEqual(f.sidecarRequests, []);
});
