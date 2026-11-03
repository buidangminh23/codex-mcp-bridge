import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAntigravityParentGuard, startAntigravitySidecar } from "../src/antigravity-sidecar.mjs";

test("parent guard binds process creation identity and rejects orphan startup", async () => {
  for (const parentPid of [0, 1, -1, NaN, 0x100000000]) {
    await assert.rejects(createAntigravityParentGuard({ parentPid, inspect: async () => { assert.fail("Invalid parent must not be inspected"); } }), /parent is unavailable/);
  }
  for (const rows of [[], [{ pid: 99, processStart: "1" }], [{ pid: 100, processStart: "" }]]) {
    await assert.rejects(createAntigravityParentGuard({ parentPid: 100, inspect: async () => rows }), /parent is unavailable/);
  }
  let row = { pid: 100, processStart: "one" };
  const guard = await createAntigravityParentGuard({ parentPid: 100, inspect: async (args) => {
    assert.deepEqual(args, { parentPid: 100, maxDepth: 1 });
    return row ? [row] : [];
  } });
  await guard();
  row = { pid: 100, processStart: "two" };
  await assert.rejects(guard(), (error) => error.deliveryState === "not_sent");
  row = { pid: 100, processStart: "one" };
  await assert.rejects(guard(), /parent exited or changed/);
});

test("parent guard fails closed on process death or inspection error", async () => {
  for (const failure of ["gone", "error"]) {
    let calls = 0;
    const guard = await createAntigravityParentGuard({ parentPid: 100, inspect: async () => {
      if (++calls === 1) return [{ pid: 100, processStart: "one" }];
      if (failure === "error") throw new Error("Private inspection details");
      return [];
    } });
    await assert.rejects(guard(), (error) => error.deliveryState === "not_sent" && !error.message.includes("Private"));
  }
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-sidecar-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => {
    const resolved = fs.realpathSync.native(directory);
    assert.equal(path.dirname(resolved), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("antigravity-sidecar-"));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const state = { alive: true, closed: 0, lost: 0, checks: 0 };
  const options = {
    directory,
    env: { ANTIGRAVITY_AGENTAPI_EXE: "native", ANTIGRAVITY_LS_ADDRESS: "native-address" },
    createParentGuard: async () => async () => { state.checks++; if (!state.alive) throw Object.assign(new Error("Parent unavailable"), { deliveryState: "not_sent" }); },
    serve: async (handler) => { state.handler = handler; return { close: async () => { state.closed++; } }; },
    onParentLost: () => { state.lost++; },
    parentCheckIntervalMs: 10,
  };
  return { state, options };
}

test("sidecar rejects stale requests and releases socket once without retargeting native environment", async (t) => {
  const { state, options } = fixture(t);
  const sidecar = await startAntigravitySidecar(options);
  t.after(() => sidecar.close());
  assert.equal((await state.handler({ operation: "status" })).available, true);
  state.alive = false;
  await assert.rejects(state.handler({ operation: "status" }), /Parent unavailable/);
  await assert.rejects(state.handler({ operation: "send" }), (error) => error.deliveryState === "not_sent");
  await sidecar.close();
  assert.equal(state.closed, 1);
  assert.equal(state.lost, 1);
  assert.equal(options.env.ANTIGRAVITY_LS_ADDRESS, "native-address");
});

test("sidecar closes on parent death while idle and stops monitoring after close", async (t) => {
  const { state, options } = fixture(t);
  let lost;
  const parentLost = new Promise((resolve) => { lost = resolve; });
  options.onParentLost = lost;
  const sidecar = await startAntigravitySidecar(options);
  t.after(() => sidecar.close());
  state.alive = false;
  const timeout = setTimeout(() => assert.fail("Orphan sidecar remained open"), 1000);
  try { await parentLost; } finally { clearTimeout(timeout); }
  assert.equal(state.closed, 1);
  const checks = state.checks;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(state.checks, checks);
});

test("sidecar persists the pre-send boundary and refreshes native replies without resending", async (t) => {
  const { state, options } = fixture(t);
  const requestId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  let sends = 0;
  let observations = 0;
  options.runNative = async (args) => {
    sends++;
    await args.beforeDispatch({ version: 1, status: "ready", trajectoryId: crypto.randomUUID(), beforeStepIndex: 12, promptSha256: "b".repeat(64), projectId: "project" });
    const persisted = JSON.parse(fs.readFileSync(path.join(options.directory, "desktop-deliveries", `${requestId}.json`), "utf8"));
    assert.equal(persisted.nativeObservation.beforeStepIndex, 12);
    assert.equal(persisted.status, "pending");
    return { status: "accepted", completed: false, conversationId };
  };
  options.observeDelivery = async (record) => {
    observations++;
    assert.equal(record.nativeObservation.beforeStepIndex, 12);
    return { ...record, status: "reply_received", result: { status: "reply_received", completed: true, response: "native exact reply" } };
  };
  const sidecar = await startAntigravitySidecar(options);
  t.after(() => sidecar.close());
  const request = { operation: "send", requestId, conversationId, cwd: options.directory, sender: { provider: "codex", id: crypto.randomUUID() }, prompt: "Fixture message" };
  assert.equal((await state.handler(request)).status, "pending");
  await new Promise((resolve) => setImmediate(resolve));
  const receipt = await state.handler({ operation: "receipt", requestId });
  assert.equal(receipt.status, "reply_received");
  assert.equal(receipt.result.response, "native exact reply");
  assert.equal((await state.handler(request)).status, "reply_received");
  assert.equal(sends, 1);
  assert.equal(observations, 1);
});

test("sidecar keeps unknown reply observations unconfirmed", async (t) => {
  const { state, options } = fixture(t);
  options.runNative = async () => ({ status: "accepted", completed: false });
  options.observeDelivery = async (record) => ({ ...record, replyObservation: { status: "unavailable", code: "ANTIGRAVITY_TRANSCRIPT_UNSUPPORTED" } });
  const sidecar = await startAntigravitySidecar(options);
  t.after(() => sidecar.close());
  const requestId = crypto.randomUUID();
  await state.handler({ operation: "send", requestId, conversationId: crypto.randomUUID(), cwd: options.directory, sender: { provider: "codex", id: crypto.randomUUID() }, prompt: "Fixture message" });
  await new Promise((resolve) => setImmediate(resolve));
  const receipt = await state.handler({ operation: "receipt", requestId });
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.result.completed, false);
  assert.equal(receipt.replyObservation.status, "unavailable");
});
