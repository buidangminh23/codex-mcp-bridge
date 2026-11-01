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
  const directory = outcomes.directory ?? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-outbound-")));
  const identity = outcomes.identity ?? { status: "verified", provider: "antigravity", id: crypto.randomUUID(), cwd: directory, mode: "bypass", permissionFingerprint: "initial" };
  let current = identity;
  const calls = [];
  let beforeDispatch;
  const lifecycle = { activated: 0, quiesced: 0, restored: null };
  const targets = {
    list: async (request) => { await request.beforeSend(); calls.push(request); return [{ conversationId: "fixture-task" }]; },
    send: async (request) => { await beforeDispatch?.(); await request.beforeSend(); calls.push(request); return outcomes.send ? outcomes.send(request) : { status: "accepted", conversationId: request.conversationId }; },
    read: async (request) => { await request.beforeSend(); calls.push(request); return outcomes.read ? outcomes.read(request) : { status: "idle" }; },
    reloadReason: () => null,
    quiesce: async () => { lifecycle.quiesced++; },
    exportReloadState: () => ({ receiptIds: ["fixture"] }),
    restoreReloadState: (state) => { lifecycle.restored = state; },
    activate: async () => { lifecycle.activated++; },
    close: async () => {},
  };
  const bridge = createAntigravityOutboundBridge({ targets, resolveSender: async () => structuredClone(current), deliveries: new AntigravityDeliveries(path.join(directory, "receipts")), rootPolicy: { assert() {} }, env: { HOME: directory, USERPROFILE: directory, AGENT_RELAY_DIRECTORY: path.join(directory, "background-relay"), CODEX_BRIDGE_WORKER: "1", CODEX_BRIDGE_STAGED: outcomes.staged ? "1" : "0" }, channel: { send() {}, on() {} } });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(a);
  await client.connect(b);
  t.after(async () => { await client.close(); await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { ...JSON.parse(response.content[0].text), isError: response.isError, structuredContent: response.structuredContent, reports: response.content.slice(1).map((item) => item.text).join("\n") };
  };
  const request = { target: "codex", conversationId: crypto.randomUUID(), requestId: crypto.randomUUID(), cwd: directory, prompt: "Fixture only" };
  return { client, call, request, identity, directory, calls, bridge, lifecycle, change: (value) => { current = value; }, beforeDispatch: (value) => { beforeDispatch = value; } };
}

test("outbound MCP advertises native tools and rejects missing caller before target access", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.client.listTools()).tools.map((x) => x.name).sort(), ["agent_bridge_status", "list_agent_tasks", "send_to_agent_task", "read_agent_delivery", "read_agent_task", "worker_status", "list_workers", "send_to_worker", "read_worker_delivery"].sort());
  f.change({ status: "unverified", reason: "Missing native metadata" });
  const status = await f.call("agent_bridge_status");
  assert.equal(status.isError, true);
  assert.equal(status.structuredContent.diagnostic.code, "ANTIGRAVITY_SENDER_UNVERIFIED");
  assert.equal(status.structuredContent.diagnostic.deliveryState, "not_applicable");
  assert.match(f.client.getInstructions(), /Never use Computer Use, open an old chat/);
  assert.match(f.client.getInstructions(), /separate background CLI workers/);
  assert.match(f.client.getInstructions(), /Never replay an uncertain native send through a worker/);
  for (const [name, args] of [["list_agent_tasks", { target: "codex" }], ["send_to_agent_task", f.request], ["read_agent_delivery", { requestId: f.request.requestId }], ["read_agent_task", { target: "codex", conversationId: f.request.conversationId }]]) {
    assert.equal((await f.call(name, args)).isError, true);
  }
  assert.deepEqual(f.calls, []);
});

test("background tools use the fixture environment instead of the live service configuration", async (t) => {
  const f = await fixture(t);
  const result = await f.client.callTool({ name: "worker_status", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.diagnostic.code, "WORKER_RELAY_NOT_CONFIGURED");
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(path.join(f.directory, "background-relay")), false);
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
  assert.equal(receipt.isError, true);
  assert.equal(receipt.structuredContent.diagnostic.code, "ANTIGRAVITY_SENDER_CHANGED");
  assert.equal(receipt.structuredContent.diagnostic.deliveryState, "not_sent");
  assert.equal(receipt.structuredContent.diagnostic.sent, false);
  assert.deepEqual(receipt.structuredContent.diagnostic.causeCodes, receipt.diagnostic.causeCodes);
  assert.match(receipt.reports, /Bridge diagnostic/);
  assert.match(receipt.reason, /permissions changed/);
  const repeated = await f.call("send_to_agent_task", f.request);
  assert.equal(repeated.isError, true);
  assert.equal(repeated.structuredContent.diagnostic.reportId, receipt.structuredContent.diagnostic.reportId);
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
  assert.equal(receipt.isError, true);
  assert.equal(receipt.requestId, request.requestId);
  assert.equal(receipt.status, "sent_unconfirmed");
  assert.equal(receipt.result.msgId, msgId);
  assert.equal(receipt.result.completed, false);
  assert.equal(receipt.nativeReceipt, null);
  assert.match(receipt.recovery, /do not resend/);
  assert.match(receipt.receiptError, /unavailable/);
  assert.equal(receipt.structuredContent.diagnostic.code, "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE");
  assert.equal(receipt.structuredContent.diagnostic.deliveryState, "not_applicable");
  assert.equal(receipt.structuredContent.diagnostic.ids.msgId, msgId);
  assert.equal(f.calls[1].msgId, msgId);
  await f.call("send_to_agent_task", request);
  assert.equal(f.calls.filter((call) => call.prompt).length, 1);
});

test("uncertain outbound failures remain reportable and are never resent or disclosed to another sender", async (t) => {
  const f = await fixture(t, {
    send: () => { throw Object.assign(new Error("Native send failed; token=PRIVATE_TOKEN; https://private.example/path"), { code: "EPIPE", phase: "dispatch", deliveryState: "unknown", stdout: "PRIVATE_STDOUT" }); },
  });
  f.request.prompt = "PRIVATE_PROMPT";
  await f.call("send_to_agent_task", f.request);
  await new Promise(setImmediate);
  const receipt = await f.call("read_agent_delivery", { requestId: f.request.requestId });
  assert.equal(receipt.isError, true);
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.structuredContent.diagnostic.code, "EPIPE");
  assert.equal(receipt.structuredContent.diagnostic.deliveryState, "unknown");
  assert.equal(receipt.structuredContent.diagnostic.sent, null);
  assert.equal(receipt.structuredContent.diagnostic.retrySafe, false);
  assert.equal(receipt.structuredContent.diagnostic.ids.requestId, f.request.requestId);
  assert.equal(receipt.structuredContent.diagnostic.ids.conversationId, f.request.conversationId);
  assert.doesNotMatch(receipt.reports + JSON.stringify(receipt.structuredContent), /PRIVATE_|private\.example/);
  const repeated = await f.call("send_to_agent_task", f.request);
  assert.equal(repeated.isError, true);
  assert.equal(repeated.structuredContent.diagnostic.reportId, receipt.structuredContent.diagnostic.reportId);
  assert.equal(f.calls.length, 1);
  f.change({ ...f.identity, id: crypto.randomUUID() });
  const denied = await f.call("read_agent_delivery", { requestId: f.request.requestId });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.diagnostic.code, "ANTIGRAVITY_RECEIPT_OWNER_MISMATCH");
  assert.notEqual(denied.structuredContent.diagnostic.reportId, receipt.structuredContent.diagnostic.reportId);
  assert.equal(denied.diagnostic, undefined);
  assert.equal(denied.result, undefined);
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

test("outbound reload waits for dispatch, transfers state and reads durable receipts without replay", async (t) => {
  let finish;
  const previous = await fixture(t, { send: () => new Promise((resolve) => { finish = resolve; }) });
  await previous.call("send_to_agent_task", previous.request);
  await new Promise(setImmediate);
  assert.equal(previous.bridge.reload.inspect().reloadable, false);
  await assert.rejects(previous.bridge.reload.control("quiesce"), /deliveries are still active/);
  finish({ status: "accepted" });
  await new Promise(setImmediate);
  const { state } = await previous.bridge.reload.control("quiesce");
  assert.equal(previous.lifecycle.quiesced, 1);
  const blocked = await previous.call("send_to_agent_task", { ...previous.request, requestId: crypto.randomUUID() });
  assert.equal(blocked.isError, true);
  assert.match(blocked.error, /quiesced/);
  assert.equal(blocked.structuredContent.diagnostic.deliveryState, "not_sent");
  const background = await previous.client.callTool({ name: "worker_status", arguments: {} });
  assert.equal(background.isError, true);
  assert.match(background.content[0].text, /quiesced/);
  assert.equal(background.structuredContent.diagnostic.code, "MCP_WORKER_QUIESCED");
  const next = await fixture(t, { directory: previous.directory, identity: previous.identity, staged: true });
  assert.equal((await next.call("agent_bridge_status")).isError, true);
  await assert.rejects(next.bridge.reload.control("restore", { ...state, payload: { ...state.payload, directory: os.tmpdir() } }), /directory changed/);
  await next.bridge.reload.control("restore", state);
  assert.deepEqual(next.lifecycle.restored, { receiptIds: ["fixture"] });
  assert.equal(next.lifecycle.activated, 0);
  await next.bridge.reload.control("activate");
  assert.equal(next.lifecycle.activated, 1);
  const receipt = await next.call("read_agent_delivery", { requestId: previous.request.requestId });
  assert.equal(receipt.status, "accepted");
  assert.equal((await next.call("send_to_agent_task", previous.request)).status, "accepted");
  assert.equal(previous.calls.length, 1);
  assert.deepEqual(next.calls, []);
  await previous.bridge.reload.control("resume");
  assert.equal(previous.lifecycle.activated, 1);
});
