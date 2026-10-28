import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAntigravityOutboundBridge } from "../src/antigravity-outbound-bridge.mjs";
import { AntigravityDeliveries } from "../src/antigravity-deliveries.mjs";

async function fixture(t, outcomes = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-outbound-")));
  const identity = { status: "verified", provider: "antigravity", id: crypto.randomUUID(), cwd: directory, mode: "bypass", permissionFingerprint: "initial" };
  let current = identity;
  const calls = [];
  let beforeDispatch;
  const targets = {
    list: async (request) => { await request.beforeSend(); calls.push(request); return [{ conversationId: "fixture-task" }]; },
    send: async (request) => { await beforeDispatch?.(); await request.beforeSend(); calls.push(request); return outcomes.send ? outcomes.send(request) : { status: "accepted", conversationId: request.conversationId }; },
    read: async (request) => { await request.beforeSend(); calls.push(request); return outcomes.read ? outcomes.read(request) : { status: "idle" }; },
    close: async () => {},
  };
  const bridge = createAntigravityOutboundBridge({ targets, resolveSender: async () => structuredClone(current), deliveries: new AntigravityDeliveries(path.join(directory, "receipts")), rootPolicy: { assert() {} } });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(a);
  await client.connect(b);
  t.after(async () => { await client.close(); await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { ...JSON.parse(response.content[0].text), isError: response.isError };
  };
  const request = { target: "codex", conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), cwd: directory, prompt: "Fixture only" };
  return { client, call, request, identity, directory, calls, change: (value) => { current = value; }, beforeDispatch: (value) => { beforeDispatch = value; } };
}

test("outbound MCP advertises native tools and rejects missing caller before target access", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.client.listTools()).tools.map((x) => x.name).sort(), ["agent_bridge_status", "list_agent_tasks", "send_to_agent_task", "read_agent_delivery", "read_agent_task"].sort());
  f.change({ status: "unverified", reason: "Missing native metadata" });
  for (const [name, args] of [["list_agent_tasks", { target: "codex" }], ["send_to_agent_task", f.request], ["read_agent_delivery", { requestId: f.request.requestId }], ["read_agent_task", { target: "codex", conversationId: f.request.conversationId }]]) {
    assert.equal((await f.call(name, args)).isError, true);
  }
  assert.deepEqual(f.calls, []);
});

test("outbound delivery is idempotent, preserves authorship, and scopes receipt ownership", async (t) => {
  const f = await fixture(t);
  await f.call("send_to_agent_task", f.request);
  await new Promise(setImmediate);
  const receipt = await f.call("read_agent_delivery", { requestId: f.request.requestId });
  assert.equal(receipt.status, "accepted");
  assert.match(f.calls[0].prompt, /^\[From Antigravity Desktop/);
  assert.equal(f.calls[0].threadId, f.request.conversationId);
  await f.call("send_to_agent_task", f.request);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.call("send_to_agent_task", { ...f.request, prompt: "Changed" })).isError, true);
  f.change({ ...f.identity, id: crypto.randomUUID() });
  assert.match((await f.call("read_agent_delivery", { requestId: f.request.requestId })).error, /does not belong/);
});

test("outbound rejects cross-project and changing native permissions before delivery", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("send_to_agent_task", { ...f.request, cwd: os.tmpdir() })).isError, true);
  assert.deepEqual(f.calls, []);
  f.beforeDispatch(() => f.change({ ...f.identity, permissionFingerprint: "changed" }));
  await f.call("send_to_agent_task", f.request);
  await new Promise(setImmediate);
  f.change(f.identity);
  const receipt = await f.call("read_agent_delivery", { requestId: f.request.requestId });
  assert.equal(receipt.status, "failed");
  assert.match(receipt.reason, /permissions changed/);
  assert.deepEqual(f.calls, []);
});

test("outbound receipt recovery preserves durable state only for an unavailable native receipt", async (t) => {
  const msgId = crypto.randomUUID();
  const f = await fixture(t, {
    send: () => ({ status: "sent_unconfirmed", msgId }),
    read: () => { throw Object.assign(new Error("The native receipt is unavailable in this bridge process"), { code: "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE" }); },
  });
  const request = { ...f.request, target: "claude" };
  await f.call("send_to_agent_task", request);
  await new Promise(setImmediate);
  const receipt = await f.call("read_agent_delivery", { requestId: request.requestId });
  assert.notEqual(receipt.isError, true);
  assert.equal(receipt.requestId, request.requestId);
  assert.equal(receipt.status, "sent_unconfirmed");
  assert.equal(receipt.result.msgId, msgId);
  assert.equal(receipt.result.completed, false);
  assert.equal(receipt.nativeReceipt, null);
  assert.match(receipt.recovery, /do not resend/);
  assert.match(receipt.receiptError, /unavailable/);
  assert.equal(f.calls[1].msgId, msgId);
  await f.call("send_to_agent_task", request);
  assert.equal(f.calls.filter((call) => call.prompt).length, 1);
});

test("outbound receipt reads propagate native ownership and account errors without recovery", async (t) => {
  for (const [message, code] of [
    ["Native receipt does not belong to this Antigravity conversation", "ANTIGRAVITY_RECEIPT_OWNER_MISMATCH"],
    ["Claude account identity changed", "BRIDGE_ACCOUNT_IDENTITY_CHANGED"],
    ["The native receipt is unavailable in this bridge process", undefined],
  ]) {
    await t.test(message + (code ? ` (${code})` : " (untyped)"), async (t) => {
      const f = await fixture(t, {
        send: () => ({ status: "sent_unconfirmed", msgId: crypto.randomUUID() }),
        read: () => { throw Object.assign(new Error(message), { code }); },
      });
      await f.call("send_to_agent_task", { ...f.request, target: "claude" });
      await new Promise(setImmediate);
      const receipt = await f.call("read_agent_delivery", { requestId: f.request.requestId });
      assert.equal(receipt.isError, true);
      assert.equal(receipt.error, message);
      assert.equal(receipt.recovery, undefined);
      assert.equal(receipt.nativeReceipt, undefined);
      assert.equal(receipt.result, undefined);
    });
  }
});
