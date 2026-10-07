import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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

it("isolates native authority ACL checks from inherited PowerShell modules", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const moduleDirectory = path.join(f.dir, "modules", "Microsoft.PowerShell.Security");
  fs.mkdirSync(moduleDirectory, { recursive: true });
  fs.writeFileSync(path.join(moduleDirectory, "Microsoft.PowerShell.Security.psd1"), "@{ RootModule = 'Microsoft.PowerShell.Security.psm1'; ModuleVersion = '99.0.0'; GUID = '56a44588-742a-41ef-9c35-1b2ecb1bb5b4'; FunctionsToExport = @('Get-Acl') }");
  fs.writeFileSync(path.join(moduleDirectory, "Microsoft.PowerShell.Security.psm1"), "throw 'Inherited PowerShell module must not load'; function Get-Acl { throw 'Unexpected inherited module' }");
  const inherited = Object.entries(process.env).filter(([key]) => key.toLowerCase() === "psmodulepath");
  for (const [key] of inherited) delete process.env[key];
  process.env.PSModulePath = path.dirname(moduleDirectory);
  try {
    const reply = await handleRelayRequest(f.create, f.deps);
    assert.equal(reply.ok, true, reply.error?.message);
    const restarted = new NativeCreationReceipts({ directory: f.store.directory });
    assert.equal(restarted.read(f.id, accounts, f.hash).result.threadId, "new-thread");
    assert.equal(f.calls(), 1);
  } finally {
    delete process.env.PSModulePath;
    for (const [key, value] of inherited) process.env[key] = value;
  }
});

it("initializes Windows authority with only the current user despite explicit default access", { skip: process.platform !== "win32" }, async t => {
  const f = fixture(t);
  const directory = path.join(f.dir, "bridge-native-creation-authority");
  const key = path.join(directory, "signing-key");
  const mkdir = fs.mkdirSync, open = fs.openSync;
  const injected = [];
  const grant = file => {
    execFileSync("icacls.exe", [file, "/grant", "*S-1-5-18:(F)", "*S-1-5-32-544:(F)"], { stdio: "pipe", windowsHide: true });
    injected.push(file);
  };
  fs.mkdirSync = (file, ...options) => {
    const result = mkdir(file, ...options);
    if (file === directory) grant(file);
    return result;
  };
  fs.openSync = (file, flags, ...options) => {
    const fd = open(file, flags, ...options);
    if (flags === "wx" && path.basename(file) === "signing-key" && fs.realpathSync.native(path.dirname(file)) === fs.realpathSync.native(directory)) {
      try { grant(file); } catch (error) { fs.closeSync(fd); throw error; }
    }
    return fd;
  };
  try {
    const created = await handleRelayRequest(f.create, f.deps);
    assert.equal(created.ok, true, created.error?.message);
    assert.deepEqual(injected.map(file => fs.realpathSync.native(file)), [directory, key].map(file => fs.realpathSync.native(file)));
    const restarted = new NativeCreationReceipts({ directory: f.store.directory });
    assert.equal(restarted.read(f.id, accounts, f.hash).result.threadId, "new-thread");
    assert.equal(f.calls(), 1);
  } finally { fs.mkdirSync = mkdir; fs.openSync = open; }
});

it("rejects Windows authority access granted to another principal", { skip: process.platform !== "win32" }, async t => {
  for (const target of ["directory", "key"]) {
    const f = fixture(t);
    const created = await handleRelayRequest(f.create, f.deps);
    assert.equal(created.ok, true, created.error?.message);
    const directory = path.join(f.dir, "bridge-native-creation-authority");
    const file = target === "directory" ? directory : path.join(directory, "signing-key");
    execFileSync("icacls.exe", [file, "/grant", "*S-1-1-0:(R)"], { stdio: "pipe", windowsHide: true });
    const restarted = new NativeCreationReceipts({ directory: f.store.directory });
    assert.throws(() => restarted.read(f.id, accounts, f.hash), /Unexpected native authority access/, target);
    assert.equal(f.calls(), 1);
  }
});

it("removes only its newly created signing key after initialization fails", async t => {
  const f = fixture(t);
  const original = fs.writeFileSync;
  const key = path.join(f.dir, "bridge-native-creation-authority", "signing-key");
  let failed = false;
  fs.writeFileSync = (...args) => {
    if (!failed && typeof args[0] === "number" && Buffer.isBuffer(args[1]) && args[1].length === 32) {
      failed = true;
      throw Object.assign(Error("Signing key initialization failed"), { code: "EIO" });
    }
    return original(...args);
  };
  try {
    const reply = await handleRelayRequest(f.create, f.deps);
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /Signing key initialization failed/);
    assert.equal(fs.existsSync(key), false);
    assert.equal(f.calls(), 0);
  } finally { fs.writeFileSync = original; }
  const reply = await handleRelayRequest(f.create, f.deps);
  assert.equal(reply.ok, true, reply.error?.message);
  assert.equal(fs.statSync(key).size, 32);
  assert.equal(f.calls(), 1);
  fs.writeFileSync(key, Buffer.alloc(0));
  const existing = new NativeCreationReceipts({ directory: f.store.directory });
  assert.throws(() => existing.reserve(randomUUID(), args, accounts, "executor"), /Unsafe native creation signing key/);
  assert.equal(fs.statSync(key).size, 0);
});

it("rejects same-inode receipt changes between inspection and opening", t => {
  const f = fixture(t);
  f.store.reserve(f.id, args, accounts, "executor");
  const file = f.store.file(f.id);
  const original = fs.openSync;
  let changed = false;
  fs.openSync = (candidate, ...options) => {
    if (candidate === file && !changed) { changed = true; fs.appendFileSync(file, " "); }
    return original(candidate, ...options);
  };
  try { assert.throws(() => f.store.read(f.id, accounts, f.hash), /receipt changed/); }
  finally { fs.openSync = original; }
});

it("rejects signing key hardlinks added between inspection and opening", t => {
  const f = fixture(t);
  f.store.reserve(f.id, args, accounts, "executor");
  const key = path.join(f.dir, "bridge-native-creation-authority", "signing-key");
  const original = fs.openSync;
  fs.openSync = (candidate, ...options) => {
    if (path.basename(candidate) === "signing-key") fs.linkSync(candidate, path.join(f.dir, "linked-key"));
    return original(candidate, ...options);
  };
  try { assert.throws(() => f.store.read(f.id, accounts, f.hash), /signing key changed/); }
  finally { fs.openSync = original; }
});

it("treats Unicode quotation marks in Windows authority paths as literal data", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t);
  const directory = path.join(f.dir, "owner\u2019s receipts");
  fs.mkdirSync(directory);
  const store = new NativeCreationReceipts({ directory: path.join(directory, "receipts") });
  store.reserve(f.id, args, accounts, "executor");
  assert.equal(store.read(f.id, accounts, f.hash).state, "pending");
});
