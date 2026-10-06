import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { NativeCreationReceipts, creationRequestHash } from "../src/native-creation-receipts.mjs";
import { handleRelayRequest, RelaySocketServer } from "../src/native-relay-companion.mjs";
import { NativeDesktopRelay } from "../src/native-relay.mjs";

const accounts = { claude: "a".repeat(64), codex: "b".repeat(64) };
const args = { prompt: "initial task", title: "one task", target: { type: "project", projectId: "project", environment: { type: "local" } } };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-creation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new NativeCreationReceipts({ directory: path.join(dir, "receipts") });
  const id = randomUUID(), hash = creationRequestHash(args);
  const create = { v: 2, operation: "create_thread", arguments: args, accountContext: accounts, creationReceiptId: id };
  const poll = { v: 2, operation: "get_creation_receipt", arguments: { receiptId: id, requestHash: hash }, accountContext: accounts };
  let calls = 0, revoked = false;
  const deps = { strict: true, creationReceipts: store, resolveExecutor: () => ({ threadId: "executor" }),
    assertAccount: async value => assert.deepEqual(value, accounts),
    authorize: async () => { if (revoked) throw Error("project revoked"); return {}; },
    dispatchDesktop: async () => { calls++; return { success: true, structuredContent: { threadId: "new-thread", hostId: "local", firstTurn: { status: "accepted" } } }; } };
  return { dir, store, id, hash, create, poll, deps, calls: () => calls, revoke: () => { revoked = true; } };
}
it("retains late native creation results after the caller's socket timeout and across store restart", async t => {
  const f = fixture(t);
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\creation-${randomUUID()}` : path.join(f.dir, "relay.sock");
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const server = new RelaySocketServer({ ...f.deps, socketPath, protectSocket: () => {}, restrictSocket: () => {},
    dispatchDesktop: async value => { await gate; return f.deps.dispatchDesktop(value); } });
  await server.start(); t.after(() => server.stop());
  const client = new NativeDesktopRelay({ socketPath, accountSocketPath: socketPath, env: {} });
  const pending = client.requestDesktop("create_thread", args, { timeoutMs: 100, accountContext: accounts, creationReceiptId: f.id });
  await assert.rejects(pending, e => e.code === "RELAY_TIMEOUT");
  const before = await handleRelayRequest(f.poll, f.deps);
  assert.equal(before.result.status, "pending");
  finish();
  for (let n = 0; n < 100 && f.store.read(f.id, accounts, f.hash).state !== "completed"; n++) await new Promise(r => setTimeout(r, 10));
  const restarted = { ...f.deps, creationReceipts: new NativeCreationReceipts({ directory: f.store.directory }) };
  const reply = await handleRelayRequest(f.poll, restarted);
  assert.equal(reply.result.status, "completed");
  assert.equal(reply.result.result.threadId, "new-thread");
  assert.equal(f.calls(), 1);
  const duplicate = await handleRelayRequest(f.create, restarted);
  assert.equal(duplicate.ok, false);
  assert.equal(f.calls(), 1);
});
it("polls missing receipts without dispatch, and rejects wrong accounts, hash and executor", async t => {
  const f = fixture(t);
  assert.equal((await handleRelayRequest(f.poll, f.deps)).result.status, "missing");
  assert.equal(f.calls(), 0);
  await handleRelayRequest(f.create, f.deps);
  const wrongAccount = { ...f.poll, accountContext: { ...accounts, codex: "c".repeat(64) } };
  assert.equal((await handleRelayRequest(wrongAccount, { ...f.deps, assertAccount: () => {} })).ok, false);
  const wrongHash = { ...f.poll, arguments: { ...f.poll.arguments, requestHash: "0".repeat(64) } };
  assert.equal((await handleRelayRequest(wrongHash, f.deps)).ok, false);
  assert.equal((await handleRelayRequest(f.poll, { ...f.deps, resolveExecutor: () => ({ threadId: "other" }) })).ok, false);
  f.revoke();
  assert.equal((await handleRelayRequest(f.poll, f.deps)).ok, false);
  assert.equal(f.calls(), 1);
});
it("rechecks the original creation scope before releasing a stored result", async t => {
  const f = fixture(t), seen = [];
  await handleRelayRequest(f.create, f.deps);
  const reply = await handleRelayRequest(f.poll, { ...f.deps, authorize: async request => { seen.push(request); return {}; } });
  assert.equal(reply.ok, true);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].operation, "create_thread");
  assert.deepEqual(seen[0].arguments, args);
  assert.equal(seen[1].phase, "return");
  assert.equal(seen[1].result.threadId, "new-thread");
});
it("never dispatches an unbound or malformed recovery request", async t => {
  const f = fixture(t);
  for (const payload of [{ ...f.create, creationReceiptId: "../escape" }, { ...f.create, v: 1, accountContext: undefined },
    { ...f.poll, arguments: { ...f.poll.arguments, requestHash: "bad" } }]) {
    assert.equal((await handleRelayRequest(payload, f.deps)).ok, false);
  }
  assert.equal(f.calls(), 0);
});
it("does not guess a result after native dispatch fails", async t => {
  const f = fixture(t);
  await handleRelayRequest(f.create, { ...f.deps, dispatchDesktop: async () => { throw Error("native outcome unknown"); } });
  const result = await handleRelayRequest(f.poll, f.deps);
  assert.equal(result.result.status, "failed");
  assert.equal(result.result.result, undefined);
});
it("rejects unsafe, corrupt, oversized and altered on-disk receipts", async t => {
  const f = fixture(t);
  f.store.reserve(f.id, args, accounts, "executor");
  const file = f.store.file(f.id), original = fs.readFileSync(file);
  fs.writeFileSync(file, "{"); assert.throws(() => f.store.read(f.id, accounts, f.hash));
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1)); assert.throws(() => f.store.read(f.id, accounts, f.hash), /Unsafe/);
  const row = JSON.parse(original); row.args.prompt = "changed"; fs.writeFileSync(file, JSON.stringify(row));
  assert.throws(() => f.store.read(f.id, accounts, f.hash), /binding mismatch/);
});


it("authenticates completed results and refuses unsigned legacy receipts", async t => {
  const f = fixture(t);
  await handleRelayRequest(f.create, f.deps);
  const file = f.store.file(f.id), original = fs.readFileSync(file, "utf8");
  for (const edit of [row => { row.result.threadId = "unowned-victim"; }, row => { row.state = "pending"; }, row => { delete row.signature; }]) {
    const row = JSON.parse(original); edit(row); fs.writeFileSync(file, JSON.stringify(row));
    const restarted = new NativeCreationReceipts({ directory: f.store.directory });
    const reply = await handleRelayRequest(f.poll, { ...f.deps, creationReceipts: restarted });
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /signature/);
    assert.equal(f.calls(), 1);
  }
  fs.writeFileSync(file, original);
  assert.equal((await handleRelayRequest(f.poll, f.deps)).result.result.threadId, "new-thread");
});

it("fails closed when the persisted signing key is missing or replaced", async t => {
  for (const change of ["missing", "replaced", "truncated", "hardlink"]) {
    const f = fixture(t);
    await handleRelayRequest(f.create, f.deps);
    const key = path.join(f.dir, "bridge-native-creation-authority", "signing-key");
    const saved = path.join(f.dir, "saved-key"); fs.renameSync(key, saved);
    if (change === "replaced") fs.writeFileSync(key, Buffer.alloc(32), { mode: 0o600 });
    if (change === "truncated") fs.writeFileSync(key, Buffer.alloc(31), { mode: 0o600 });
    if (change === "hardlink") fs.linkSync(saved, key);
    const reply = await handleRelayRequest(f.poll, f.deps);
    assert.equal(reply.ok, false, change);
    assert.equal(f.calls(), 1);
  }
});
