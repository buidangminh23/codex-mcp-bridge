import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { AntigravityDeliveries } from "../src/antigravity-deliveries.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-deliveries-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new AntigravityDeliveries(directory);
  const request = { requestId: crypto.randomUUID(), cwd: directory, prompt: "hello", surface: "cli", sender: { provider: "codex", id: "sender" } };
  return { directory, store, request };
}

test("duplicate pending requests execute once and completed receipts survive restart", async (t) => {
  const { store, request, directory } = fixture(t);
  let calls = 0;
  let finish;
  const operation = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  assert.equal((await store.dispatch(request, operation)).status, "pending");
  assert.equal((await store.dispatch(request, operation)).status, "pending");
  assert.equal(calls, 1);
  finish({ conversation_id: crypto.randomUUID(), status: "SUCCESS", response: "done" });
  await delay(10);
  assert.equal(new AntigravityDeliveries(directory).read(request.requestId).status, "completed");
  assert.equal((await store.dispatch(request, operation)).status, "completed");
  assert.equal(calls, 1);
});

test("reused request identity cannot change prompt or sender", async (t) => {
  const { store, request } = fixture(t);
  await store.dispatch(request, async () => ({}));
  await delay(10);
  await assert.rejects(store.dispatch({ ...request, prompt: "different" }, async () => ({})), /different delivery/);
  await assert.rejects(store.dispatch({ ...request, sender: { provider: "claude", id: "other" } }, async () => ({})), /different delivery/);
});

test("restart with pending receipt stays unknown and never resends", async (t) => {
  const { store, request, directory } = fixture(t);
  let finish;
  await store.dispatch(request, () => new Promise((resolve) => { finish = resolve; }));
  const restarted = new AntigravityDeliveries(directory);
  let called = false;
  assert.equal((await restarted.dispatch(request, () => { called = true; })).status, "unknown");
  assert.equal(called, false);
  finish({});
  await delay(10);
});

test("native acceptance is distinct from completion and timeout remains unknown", async (t) => {
  const { store, request } = fixture(t);
  await store.dispatch(request, async () => ({ status: "accepted", completed: false }));
  await delay(10);
  assert.equal(store.read(request.requestId).status, "accepted");
  const next = { ...request, requestId: crypto.randomUUID() };
  await store.dispatch(next, async () => { throw Object.assign(new Error("timeout"), { deliveryState: "unknown" }); });
  await delay(10);
  assert.equal(store.read(next.requestId).status, "unknown");
});

test("path traversal never reaches receipt files", (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.read("../foreign"), /UUID/);
});

test("native identity survives uncertain startup delivery and preflight failure is definite", async (t) => {
  const { store, request, directory } = fixture(t);
  const conversationId = crypto.randomUUID();
  await store.dispatch(request, async () => {
    store.identify(request.requestId, conversationId);
    throw Object.assign(new Error("lost reply"), { deliveryState: "unknown" });
  });
  await delay(10);
  const receipt = new AntigravityDeliveries(directory).read(request.requestId);
  assert.equal(receipt.conversationId, conversationId);
  assert.equal(receipt.status, "unknown");
  const failed = { ...request, requestId: crypto.randomUUID() };
  await store.dispatch(failed, async () => { throw Object.assign(new Error("not initialized"), { deliveryState: "not-sent" }); });
  await delay(10);
  assert.equal(store.read(failed.requestId).status, "failed");
});

test("native permission failures remain failed results rather than success", async (t) => {
  const { store, request } = fixture(t);
  await store.dispatch(request, async () => ({ status: "PERMISSION_DENIED", response: "", error: "Review required" }));
  await delay(10);
  assert.equal(store.read(request.requestId).status, "failed");
  assert.equal(store.read(request.requestId).result.status, "PERMISSION_DENIED");
});

test("receipt reads reject hard-linked records", async (t) => {
  const { store, request, directory } = fixture(t);
  await store.dispatch(request, async () => ({ status: "SUCCESS", response: "done" }));
  await delay(10);
  const file = store.file(request.requestId);
  fs.linkSync(file, path.join(directory, "duplicate.json"));
  assert.throws(() => store.read(request.requestId), /Invalid delivery record/);
});

test("receipt reads reject a replacement between opening and inspection", async (t) => {
  const { store, request, directory } = fixture(t);
  await store.dispatch(request, async () => ({ status: "SUCCESS", response: "done" }));
  await delay(10);
  const file = store.file(request.requestId);
  const original = fs.lstatSync;
  let replaced = false;
  t.mock.method(fs, "lstatSync", (...args) => {
    if (args[0] === file && !replaced) {
      replaced = true;
      fs.renameSync(file, path.join(directory, "previous.json"));
      fs.writeFileSync(file, "{}");
    }
    return original(...args);
  });
  assert.throws(() => store.read(request.requestId), /changed before reading/);
});
