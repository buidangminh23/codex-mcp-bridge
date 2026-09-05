import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DesktopTaskDelivery, DESKTOP_TOOL_BUDGET_MS } from "../src/thread-delivery.mjs";
import { DesktopTaskReceipts } from "../src/desktop-task-receipts.mjs";
import { BridgeSecurityPolicy } from "../src/security-policy.mjs";

function fixture(t, { dispatch, now = Date.now, sleep } = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-receipt-delivery-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "project");
  fs.mkdirSync(cwd);
  const calls = [];
  const registered = [];
  let creates = 0;
  let status = "active";
  let turnStatus = "inProgress";
  const security = {
    assertCwd(value) { assert.equal(path.relative(cwd, value), "", "Unexpected workspace"); },
    assertThread() {},
    registerThread(id) { registered.push(id); },
  };
  const relay = { async requestDesktop(operation, args, options) {
    calls.push({ operation, args, options });
    const override = await dispatch?.({ operation, args, options, cwd, calls });
    if (override !== undefined) return { result: override };
    if (operation === "list_projects") return { result: { projects: [{ projectId: "project", projectKind: "local", hostId: "local", path: cwd, label: "Existing project" }] } };
    if (operation === "create_thread") return { result: { threadId: `task-${++creates}`, hostId: "local", firstTurn: { status: "accepted" } } };
    if (operation === "read_thread") return { result: { thread: { id: args.threadId, hostId: "local", cwd, status, title: "Stable task" }, turns: [{ id: "turn", status: turnStatus }] } };
    if (operation === "navigate_to_codex_page") return { result: { navigated: true } };
    throw new Error(`Unexpected operation ${operation}`);
  } };
  const receipts = new DesktopTaskReceipts({ directory: path.join(directory, "receipts") });
  const createDelivery = () => new DesktopTaskDelivery({ relay, security, now, sleep, receipts: new DesktopTaskReceipts({ directory: receipts.directory }) });
  return { directory, cwd, calls, registered, receipts, createDelivery, delivery: createDelivery(), setState(nextStatus, nextTurn) { status = nextStatus; turnStatus = nextTurn; } };
}

describe("Desktop creation receipts and deadlines", () => {
  it("persists the accepted id before returning and reuses it after restart with an edited named brief", async (t) => {
    const f = fixture(t);
    const first = await f.delivery.create({ cwd: f.cwd, name: "Stable task", prompt: "Initial brief" });
    const identity = f.receipts.key({ cwd: f.cwd, name: "Stable task", prompt: "Initial brief" });
    assert.equal((await f.receipts.read(identity.key)).threadId, first.threadId);
    assert.equal((await f.receipts.read(identity.key)).state, "known");
    const retried = await f.createDelivery().create({ cwd: f.cwd, name: "Stable task", prompt: "Edited brief" });
    assert.equal(retried.threadId, first.threadId);
    assert.equal(retried.reused, true);
    assert.equal(retried.promptChanged, true);
    assert.deepEqual(f.calls.map((call) => call.operation), ["list_projects", "create_thread", "read_thread"]);
    assert.deepEqual(f.registered, [first.threadId]);
  });

  it("blocks edited retries after a lost acknowledgement and bridge restart", async (t) => {
    const f = fixture(t, { dispatch({ operation }) { if (operation === "create_thread") throw new Error("Reply was lost after Desktop accepted the task"); } });
    const args = { cwd: f.cwd, name: "Stable task", prompt: "Original brief" };
    await assert.rejects(f.delivery.create(args), /Do not resend the prompt/);
    const { key } = f.receipts.key(args);
    assert.equal((await f.receipts.read(key)).state, "unknown");
    await assert.rejects(f.createDelivery().create({ ...args, prompt: "Slightly edited brief" }), /earlier Desktop creation is unknown/);
    assert.deepEqual(f.calls.map((call) => call.operation), ["list_projects", "create_thread"]);
  });

  it("does not restore owned-policy authority from an editable receipt after restart", async (t) => {
    const f = fixture(t);
    const args = { cwd: f.cwd, name: "Stable task", prompt: "Original brief" };
    const initialPolicy = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: f.cwd, CODEX_BRIDGE_THREAD_POLICY: "owned" });
    f.delivery.security = initialPolicy;
    const created = await f.delivery.create(args);
    assert.equal(initialPolicy.isThreadAuthorized(created.threadId, f.cwd), true);
    const restarted = f.createDelivery();
    restarted.security = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: f.cwd, CODEX_BRIDGE_THREAD_POLICY: "owned" });
    await assert.rejects(restarted.create({ ...args, prompt: "Edited brief" }), (error) => {
      assert.match(error.message, /No authorized Codex threads/);
      assert.ok(error.message.includes(created.threadId));
      return true;
    });
    assert.equal(restarted.security.isThreadAuthorized(created.threadId, f.cwd), false);
    assert.deepEqual(f.calls.map((call) => call.operation), ["list_projects", "create_thread"]);
    restarted.security = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: f.cwd, CODEX_BRIDGE_THREAD_POLICY: "owned", CODEX_BRIDGE_ALLOWED_THREADS: created.threadId });
    assert.equal((await restarted.create(args)).threadId, created.threadId);
    assert.equal(restarted.security.ownedThreadIds.size, 0);
    assert.deepEqual(f.calls.map((call) => call.operation), ["list_projects", "create_thread", "read_thread"]);
  });

  it("keeps confirmed creation receipts when the first turn failed, needs attention, or has an unknown outcome", async (t) => {
    for (const firstTurnStatus of ["failed", "waitingOnApproval", "waitingOnUserInput", "outcome-unknown"]) {
      const f = fixture(t, { dispatch({ operation }) {
        if (operation === "create_thread") return { threadId: `confirmed-${firstTurnStatus}`, hostId: "local", firstTurn: { status: firstTurnStatus } };
      } });
      const args = { cwd: f.cwd, name: "Stable task", prompt: "Original brief" };
      await assert.rejects(f.delivery.create(args), new RegExp(`first turn reports ${firstTurnStatus}`));
      const receipt = await f.receipts.read(f.receipts.key(args).key);
      assert.equal(receipt.state, "known");
      assert.equal(receipt.threadId, `confirmed-${firstTurnStatus}`);
      const reused = await f.createDelivery().create({ ...args, prompt: "Edited brief" });
      assert.equal(reused.threadId, receipt.threadId);
      assert.equal(reused.reused, true);
      assert.deepEqual(f.calls.map((call) => call.operation), ["list_projects", "create_thread", "read_thread"]);
    }
  });

  it("does not retry pending creation left by a stopped provider", async (t) => {
    const f = fixture(t);
    const args = { cwd: f.cwd, name: "Stable task", prompt: "Original brief" };
    const identity = f.receipts.key(args);
    await f.receipts.write(identity.key, { version: 1, ...identity, cwd: f.cwd, name: args.name, state: "pending", startedAt: Date.now() });
    await assert.rejects(f.delivery.create({ ...args, prompt: "Edited brief" }), /earlier Desktop creation is pending/);
    assert.equal(f.calls.length, 0);
  });

  it("reuses the named task even when it completed before an edited retry", async (t) => {
    const f = fixture(t);
    const args = { cwd: f.cwd, name: "Stable task", prompt: "Original brief" };
    const first = await f.delivery.create(args);
    f.setState("waitingOnApproval", "inProgress");
    assert.equal((await f.delivery.create({ ...args, prompt: "Edited brief" })).threadId, first.threadId);
    f.setState({ type: "idle" }, "completed");
    assert.equal((await f.delivery.create(args)).threadId, first.threadId);
    const completedRetry = await f.delivery.create({ ...args, prompt: "Edited brief after completion" });
    assert.equal(completedRetry.threadId, first.threadId);
    assert.equal(completedRetry.promptChanged, true);
    assert.equal(f.calls.filter((call) => call.operation === "create_thread").length, 1);
    const second = await f.delivery.create({ ...args, name: "Separate task", prompt: "New task brief" });
    assert.notEqual(second.threadId, first.threadId);
    assert.equal(f.calls.filter((call) => call.operation === "create_thread").length, 2);
  });

  it("uses the exact prompt when the title was generated instead of explicitly supplied", async (t) => {
    const f = fixture(t);
    const args = { cwd: f.cwd, name: "Generated display title", dedupeName: "", prompt: "Original brief" };
    const first = await f.delivery.create(args);
    const retried = await f.delivery.create({ ...args, name: "Different generated display title" });
    assert.equal(retried.threadId, first.threadId);
    assert.equal((await f.receipts.read(f.receipts.key({ cwd: f.cwd, prompt: args.prompt }).key)).name, undefined);
    assert.notEqual((await f.delivery.create({ ...args, prompt: "Different brief" })).threadId, first.threadId);
  });

  it("rejects unauthorized paths before reading or writing receipts", async (t) => {
    const f = fixture(t);
    f.delivery.receipts = { key() { assert.fail("Unauthorized requests must not access receipts"); } };
    await assert.rejects(f.delivery.create({ cwd: f.directory, prompt: "Task" }), /Unexpected workspace/);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(f.receipts.directory), false);
  });

  it("does not substitute the parent project or journal a creation when the exact project is missing", async (t) => {
    const f = fixture(t, { dispatch({ operation, cwd }) {
      if (operation === "list_projects") return { projects: [{ projectId: "parent", projectKind: "local", hostId: "local", path: path.dirname(cwd) }] };
    } });
    await assert.rejects(f.delivery.create({ cwd: f.cwd, name: "Task", prompt: "Brief" }), /will not create a project or substitute/);
    assert.deepEqual(f.calls.map((call) => call.operation), ["list_projects"]);
    assert.equal(fs.existsSync(f.receipts.directory), false);
  });

  it("blocks a known receipt whose native task has moved to another workspace", async (t) => {
    const f = fixture(t, { dispatch({ operation, args, cwd }) {
      if (operation === "read_thread") return { thread: { id: args.threadId, hostId: "local", cwd: path.dirname(cwd), status: "idle" }, turns: [{ status: "completed" }] };
    } });
    const args = { cwd: f.cwd, name: "Task", prompt: "Brief" };
    await f.delivery.create(args);
    await assert.rejects(f.delivery.create({ ...args, prompt: "Changed brief" }), /did not confirm the requested local workspace/);
    assert.equal(f.calls.filter((call) => call.operation === "create_thread").length, 1);
  });

  it("spends one shared deadline across lookup, creation, opening, and observation", async (t) => {
    let time = 0;
    const f = fixture(t, { now: () => time, dispatch({ operation, options }) {
      if (operation === "list_projects") time += 7000;
      if (operation === "create_thread") time += 20000;
      if (operation === "navigate_to_codex_page") time += 5000;
      if (operation === "wait_threads") { time += options.timeoutMs; throw new Error("Native response timeout"); }
    } });
    const deadline = time + DESKTOP_TOOL_BUDGET_MS;
    const created = await f.delivery.create({ cwd: f.cwd, prompt: "Task", deadline });
    await f.delivery.open(created.threadId, { deadline });
    const result = await f.delivery.wait(created.threadId, { timeoutMs: deadline - time });
    assert.deepEqual(f.calls.map((call) => call.options.timeoutMs), [40000, 33000, 13000, 8000]);
    assert.equal(result.status, "timeout");
    assert.equal(result.threadId, created.threadId);
    assert.equal(time, 40000);
    assert.equal((await f.receipts.read(f.receipts.key({ cwd: f.cwd, prompt: "Task" }).key)).state, "known");
  });

  it("does not dispatch an expired request or observation", async (t) => {
    const f = fixture(t, { now: () => 50 });
    await assert.rejects(f.delivery.open("task", { deadline: 49 }), /operation was not sent/);
    assert.equal((await f.delivery.wait("task", { timeoutMs: 0 })).status, "timeout");
    assert.equal(f.calls.length, 0);
  });

  it("expires queued sends without running them later or releasing an active thread lock", async (t) => {
    const f = fixture(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const calls = [];
    const first = f.delivery.withThread("task", async () => { calls.push("first"); await gate; });
    await assert.rejects(f.delivery.withThread("task", () => calls.push("expired"), { deadline: Date.now() + 20 }), /response deadline elapsed/i);
    const third = f.delivery.withThread("task", () => calls.push("third"));
    assert.deepEqual(calls, ["first"]);
    release();
    await Promise.all([first, third]);
    assert.deepEqual(calls, ["first", "third"]);
  });
});
