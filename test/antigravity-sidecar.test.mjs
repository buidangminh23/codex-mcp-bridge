import assert from "node:assert/strict";
import fs from "node:fs";
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
