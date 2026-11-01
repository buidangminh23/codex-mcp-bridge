import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerBackgroundTools } from "../src/background-relay-mcp.mjs";
import { relayFailure } from "../src/background-relay-config.mjs";
import { bridgeDiagnostic } from "../src/recipient-preflight.mjs";
import { hermeticTestEnv } from "../scripts/run-tests.mjs";

function tools(call) {
  const handlers = new Map();
  registerBackgroundTools((name, definition, handler) => handlers.set(name, handler), { env: {}, call });
  return handlers;
}

test("background MCP preserves the original request ID and returns a queued receipt", async () => {
  const requestId = randomUUID();
  const input = { agent: "claude", cwd: process.cwd(), prompt: "Authorized task", requestId };
  const handlers = tools(async (method, args) => {
    assert.equal(method, "send");
    assert.deepEqual(args, input);
    return { requestId, status: "queued", deliveryState: "not_sent", surface: "background-cli" };
  });
  const result = await handlers.get("send_to_worker")(input);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, "queued");
  assert.equal(result.structuredContent.requestId, requestId);
});

test("failed background reads display the durable report unchanged in the calling chat", async () => {
  const requestId = randomUUID();
  const diagnostic = bridgeDiagnostic(relayFailure("WORKER_INTERRUPTED", "Worker delivery is unconfirmed", "unknown"),
    { component: "background-relay", operation: "send_to_worker", requestId });
  const handlers = tools(async (method, args, options) => {
    assert.equal(method, "read");
    assert.equal(options.timeoutMs, 70000);
    return { requestId, status: "unknown", deliveryState: "unknown", diagnostic };
  });
  const result = await handlers.get("read_worker_delivery")({ requestId, waitSec: 60 });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.diagnostic.reportId, diagnostic.reportId);
  assert.equal(result.structuredContent.diagnostic.deliveryState, "unknown");
  assert.match(result.content.at(-1).text, /WORKER_INTERRUPTED/);
  assert.match(result.content.at(-1).text, new RegExp(requestId));
  assert.match(result.content.at(-1).text, /Do not resend automatically/);
});

test("background tool failures carry precise codes and sanitized screenshot reports", async () => {
  const handlers = tools(async () => { throw relayFailure("WORKER_RELAY_AUTH_FAILED", "Authorization failed token=do-not-display"); });
  const result = await handlers.get("send_to_worker")({ requestId: randomUUID() });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.diagnostic.code, "WORKER_RELAY_AUTH_FAILED");
  assert.equal(result.structuredContent.diagnostic.sent, false);
  assert.doesNotMatch(JSON.stringify(result), /do-not-display/);
});

for (const entry of ["index.mjs", "claude-bridge.mjs", "background-relay-mcp.mjs"]) {
  test(`${entry} exposes background diagnostics without native apps or account metadata`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const env = { ...hermeticTestEnv(), HOME: directory, USERPROFILE: directory, CODEX_HOME: path.join(directory, ".codex"),
      CLAUDE_CONFIG_DIR: directory, CODEX_BRIDGE_DESKTOP_TASKS: "1", CLAUDE_BRIDGE_DESKTOP_ONLY: "1",
      CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_OPEN_IN_APP: "0", CODEX_APP_SERVER_URL: "ws://127.0.0.1:9",
      AGENT_RELAY_DIRECTORY: path.join(directory, "missing-relay") };
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(import.meta.dirname, "../src", entry)], env, stderr: "ignore" });
    const client = new Client({ name: "independent-worker-contract", version: "1" });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "send_to_worker", arguments: {
        agent: "claude", cwd: directory, prompt: "No worker must start because relay is not configured", requestId: randomUUID(),
      } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.diagnostic.code, "WORKER_RELAY_NOT_CONFIGURED");
      assert.equal(result.structuredContent.diagnostic.sent, false);
    } finally { await client.close(); }
  });
}
