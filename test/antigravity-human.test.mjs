import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { startAntigravitySidecar } from "../src/antigravity-sidecar.mjs";
import { inspectHumanConversation, sendHumanMessage, readHumanReceipt, HUMAN_SENDER } from "../src/antigravity-human.mjs";

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-human-"));
  fs.chmodSync(directory, 0o700);
  let handler;
  const conversationId = randomUUID();
  const state = { sends: 0, busy: false, project: "project", alive: true, error: null, duplicate: false };
  const record = { conversationId, cwd: directory, surface: "desktop", projectId: "project", status: "CASCADE_RUN_STATUS_IDLE" };
  const sidecar = await startAntigravitySidecar({
    directory,
    env: { ANTIGRAVITY_AGENTAPI_EXE: "native", ANTIGRAVITY_LS_ADDRESS: "native", ANTIGRAVITY_CSRF_TOKEN: "private" },
    createParentGuard: async () => async () => { if (!state.alive) throw Object.assign(new Error("parent gone"), { deliveryState: "not_sent" }); },
    serve: async (fn) => { handler = fn; return { close: async () => {} }; },
    list: async () => state.duplicate ? [record, record] : [{ ...record, status: state.busy ? "busy" : record.status }],
    runNative: async ({ command, prompt, expectedCwd }) => {
      if (command === "metadata") return { metadata: { workspaceUris: [pathToFileURL(directory).href], projectId: state.project } };
      state.sends++;
      assert.equal(expectedCwd, process.platform === "win32" ? fs.realpathSync.native(directory).toLowerCase() : fs.realpathSync.native(directory));
      assert.equal(prompt, "Human dashboard fixture");
      if (state.error) throw state.error;
      return { conversationId, status: "accepted", completed: false, surface: "desktop" };
    },
  });
  t.after(async () => {
    await sidecar.close();
    const resolved = fs.realpathSync.native(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("antigravity-human-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const options = { call: request => handler(request) };
  const target = { conversationId, cwd: directory };
  return { state, target, options, handler: request => handler(request), submission: () => ({ ...target, requestId: randomUUID(), prompt: "Human dashboard fixture" }) };
}
async function settled(f, request) {
  for (let i = 0; i < 50; i++) {
    const receipt = await readHumanReceipt(request, f.options);
    if (receipt?.status !== "pending") return receipt;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("fixture did not settle");
}

test("human transport uses fixed identity, native workspace and durable idempotent receipt", async t => {
  const f = await fixture(t);
  assert.equal((await inspectHumanConversation(f.target, f.options)).available, true);
  const request = f.submission();
  assert.equal((await sendHumanMessage(request, f.options)).status, "pending");
  const receipt = await settled(f, request);
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
  assert.deepEqual(receipt.sender, HUMAN_SENDER);
  assert.equal(receipt.result.completed, false);
  f.state.busy = true;
  assert.equal((await sendHumanMessage(request, f.options)).status, "accepted");
  assert.equal(f.state.sends, 1);
  await assert.rejects(sendHumanMessage({ ...request, prompt: "Different content" }, f.options), /already used/);
  assert.equal(f.state.sends, 1);
});

test("human preflight rejects busy, changed project and ambiguous recipient without native send", async t => {
  const f = await fixture(t);
  for (const key of ["busy", "duplicate", "project"]) {
    f.state[key] = key === "project" ? "changed" : true;
    await assert.rejects(inspectHumanConversation(f.target, f.options));
    const request = f.submission();
    await sendHumanMessage(request, f.options);
    assert.equal((await settled(f, request)).status, "failed");
    f.state[key] = key === "project" ? "project" : false;
  }
  assert.equal(f.state.sends, 0);
});

test("human API rejects spoofed identity and unrelated receipt before exposing it", async t => {
  const f = await fixture(t);
  const request = f.submission();
  await assert.rejects(f.handler({ operation: "human-send", ...request, sender: { provider: "claude", id: "fake" } }), /fixed human sender/);
  await assert.rejects(f.handler({ operation: "send", ...request, sender: HUMAN_SENDER }), /Invalid Antigravity/);
  for (const patch of [{ requestId: "bad" }, { conversationId: "bad" }, { cwd: "relative" }, { prompt: "\0" }, { prompt: "x".repeat(30001) }]) await assert.rejects(sendHumanMessage({ ...request, ...patch }, f.options));
  await sendHumanMessage(request, f.options);
  await settled(f, request);
  await assert.rejects(readHumanReceipt({ ...request, conversationId: randomUUID() }, f.options), /does not belong/);
  assert.equal(await readHumanReceipt({ ...request, requestId: randomUUID() }, f.options), null);
});

test("unknown native delivery stays unknown and cannot be sent twice", async t => {
  const f = await fixture(t);
  f.state.error = Object.assign(new Error("native disconnected"), { deliveryState: "unknown" });
  const request = f.submission();
  await sendHumanMessage(request, f.options);
  assert.equal((await settled(f, request)).status, "unknown");
  assert.equal((await sendHumanMessage(request, f.options)).status, "unknown");
  assert.equal(f.state.sends, 1);
});

test("old sidecar never receives a human send and malformed post-send receipt stays unknown", async t => {
  const f = await fixture(t);
  let sends = 0;
  await assert.rejects(sendHumanMessage(f.submission(), { call: async request => { assert.equal(request.operation, "status"); return { available: true }; } }), { code: "ANTIGRAVITY_HUMAN_UNSUPPORTED", deliveryState: "not_sent" });
  await assert.rejects(sendHumanMessage(f.submission(), { call: async request => {
    if (request.operation === "status") return { available: true, humanDispatchVersion: 1 };
    sends++; return { requestId: randomUUID() };
  } }), error => error.deliveryState === "unknown");
  assert.equal(sends, 1);
  f.state.alive = false;
  await assert.rejects(sendHumanMessage(f.submission(), f.options), /parent gone/);
  assert.equal(f.state.sends, 0);
});

test("a read-only capability timeout is definitely unsent", async t => {
  const f = await fixture(t);
  const calls = [];
  await assert.rejects(sendHumanMessage(f.submission(), { call: async request => {
    calls.push(request.operation);
    throw Object.assign(new Error("status timeout"), { deliveryState: "unknown", phase: "dispatch" });
  } }), error => error.deliveryState === "not_sent" && error.phase === "preflight");
  assert.deepEqual(calls, ["status"]);
});


