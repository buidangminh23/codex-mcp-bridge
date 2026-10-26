import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { handleRemoteRequest, validateRemoteRequest, remoteSshArguments, exchangeRemoteRequest, readRemoteProfile, repositoryIdentity, forwardRemoteRequest, remoteRequestResponse, remoteNativeAdapter } from "../src/remote-codex.mjs";
import { RelaySocketServer } from "../src/native-relay-companion.mjs";
import { registerRemoteCodexTools } from "../src/remote-codex-tools.mjs";
import { NativeCreationReceipts, creationRequestHash } from "../src/native-creation-receipts.mjs";

const ROOT = path.resolve(os.tmpdir(), "remote-codex-project");
const TARGET = randomUUID(), SENDER = randomUUID(), EXECUTOR = randomUUID();
const LOCAL_ACCOUNT = "a".repeat(64), REMOTE_ACCOUNT = "b".repeat(64);
const profile = { sshHost: "mac", node: "/runtime/node", receiver: "/bridge/src/remote-codex-receiver.mjs", localCwd: ROOT, remoteCwd: "/projects/bridge" };
const request = (action = "send") => ({ version: 1, action, cwd: ROOT, repository: "example.com/org/repo", account: LOCAL_ACCOUNT,
  sender: { threadId: SENDER, host: "sender-pc", mode: "bypass" },
  ...(action !== "list" ? { threadId: TARGET } : {}), ...(action === "send" ? { message: "Check the bridge only.", requestId: randomUUID() } : {}) });

function fixture(overrides = {}) {
  const calls = [], rows = new Map();
  const project = { projectId: "project", projectKind: "local", hostId: "local", path: ROOT };
  const thread = { id: TARGET, kind: "codex", hostId: "local", projectId: "project", cwd: ROOT, title: "Bridge task" };
  const accounts = { codex: REMOTE_ACCOUNT };
  const options = {
    readAccounts: () => accounts, assertAccounts: () => {}, repository: () => "example.com/org/repo", canonical: (value) => value,
    captureScope: () => ({}), recheckScope: () => {}, executor: () => EXECUTOR,
    receipts: {
      read(id, identity, hash) {
        const row = rows.get(id);
        if (row && (row.hash !== hash || row.accounts.codex !== identity.codex)) throw new Error("Receipt binding mismatch");
        return row ?? null;
      },
      reserve(id, args, identity, executorId) {
        if (rows.has(id)) throw Object.assign(new Error("Reserved"), { code: "EEXIST" });
        const row = { id, hash: creationRequestHash(args), accounts: identity, executorId, state: "pending" };
        rows.set(id, row); return row;
      },
      write(row) { rows.set(row.id, row); },
    },
    relay: { async requestDesktop(operation, args, { beforeSend }) {
      await beforeSend();
      calls.push({ operation, args });
      const result = operation === "list_projects" ? { projects: [project] }
        : operation === "list_threads" ? { pinnedThreads: [], threads: [thread, { ...thread, id: randomUUID(), projectId: "other" }] }
        : operation === "read_thread" ? { thread: { ...thread }, turns: [{ id: randomUUID(), status: "completed" }] }
        : { success: true, threadId: TARGET };
      return { result };
    } },
    ...overrides,
  };
  return { options, calls, rows, project, thread, accounts, sends: () => calls.filter((call) => call.operation === "send_message_to_thread") };
}

test("remote delivery permits different Codex accounts and preserves the real sender", async () => {
  const f = fixture(), input = request();
  const result = await handleRemoteRequest(input, f.options);
  assert.equal(result.status, "submitted");
  assert.equal(f.sends().length, 1);
  assert.match(f.sends()[0].args.prompt, new RegExp(SENDER));
  assert.match(f.sends()[0].args.prompt, /^\[From Codex on sender-pc/);
  assert.deepEqual(Object.keys(f.sends()[0].args).sort(), ["prompt", "threadId"]);
});

test("list filters other projects and read validates the exact task", async () => {
  const f = fixture();
  const listed = await handleRemoteRequest(request("list"), f.options);
  assert.deepEqual(listed.threads.map((thread) => thread.id), [TARGET]);
  const read = await handleRemoteRequest(request("read"), f.options);
  assert.equal(read.thread.id, TARGET);
  assert.equal(f.sends().length, 0);
});

test("sequential and concurrent retries never dispatch a send twice", async () => {
  const f = fixture(), input = request();
  const results = await Promise.all([handleRemoteRequest(input, f.options), handleRemoteRequest(input, f.options)]);
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal((await handleRemoteRequest(input, f.options)).duplicate, true);
  assert.equal(f.sends().length, 1);
  await assert.rejects(handleRemoteRequest({ ...input, message: "Changed" }, f.options), /binding mismatch/);
  assert.equal(f.sends().length, 1);
});

test("a disconnected native send leaves a durable non-retryable outcome", async () => {
  const f = fixture(), input = request();
  const original = f.options.relay.requestDesktop;
  let attempts = 0;
  f.options.relay.requestDesktop = async (operation, ...args) => {
    if (operation === "send_message_to_thread") { attempts++; throw new Error("Disconnected after write"); }
    return original(operation, ...args);
  };
  await assert.rejects(handleRemoteRequest(input, f.options), { code: "REMOTE_DELIVERY_UNCONFIRMED" });
  const result = await handleRemoteRequest(input, f.options);
  assert.equal(result.status, "unconfirmed");
  assert.equal(attempts, 1);
});

for (const [name, change, code] of [
  ["prompting sender", (r) => { r.sender.mode = "prompting"; }, "REMOTE_SENDER_PERMISSION"],
  ["missing sender", (r) => { delete r.sender; }, "REMOTE_REQUEST_INVALID"],
  ["invalid request UUID", (r) => { r.requestId = "other"; }, "REMOTE_REQUEST_INVALID"],
  ["oversized prompt", (r) => { r.message = "x".repeat(50001); }, "REMOTE_REQUEST_INVALID"],
  ["unsupported operation", (r) => { r.action = "create"; }, "REMOTE_REQUEST_INVALID"],
  ["unexpected permission override", (r) => { r.approvalPolicy = "never"; }, "REMOTE_REQUEST_INVALID"],
]) test(`refuses ${name} before any native operation`, async () => {
  const f = fixture(), input = request(); change(input);
  await assert.rejects(handleRemoteRequest(input, f.options), { code });
  assert.equal(f.calls.length, 0);
});

for (const field of ["id", "kind", "hostId", "projectId", "cwd"]) test(`refuses a target with mismatched ${field}`, async () => {
  const f = fixture(); f.thread[field] = "other";
  await assert.rejects(handleRemoteRequest(request(), f.options), { code: "REMOTE_THREAD_MISMATCH" });
  assert.equal(f.sends().length, 0);
});

test("refuses a different repository or missing saved project", async () => {
  const f = fixture({ repository: () => "example.com/org/other" });
  await assert.rejects(handleRemoteRequest(request(), f.options), { code: "REMOTE_PROJECT_MISMATCH" });
  assert.equal(f.calls.length, 0);
  const missing = fixture(); missing.project.path = "other";
  await assert.rejects(handleRemoteRequest(request(), missing.options), { code: "REMOTE_PROJECT_UNVERIFIED" });
  assert.equal(missing.sends().length, 0);
});

test("refuses an account switch or project replacement during delivery", async () => {
  for (const guard of ["assertAccounts", "recheckScope"]) {
    const f = fixture(); let checks = 0;
    f.options[guard] = () => { if (++checks === 4) throw new Error("Identity changed"); };
    await assert.rejects(handleRemoteRequest(request(), f.options), /Identity changed/);
    assert.equal(f.sends().length, 0);
  }
});

test("refuses the internal relay executor as a target", async () => {
  const f = fixture({ executor: () => TARGET });
  await assert.rejects(handleRemoteRequest(request(), f.options), { code: "REMOTE_THREAD_MISMATCH" });
  assert.equal(f.sends().length, 0);
});

test("signed receipts survive receiver restart and bind both accounts and the request", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-codex-receipts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "receipts"), input = request();
  const f = fixture({ receipts: new NativeCreationReceipts({ directory, accountProviders: ["codex"] }) });
  await handleRemoteRequest(input, f.options);
  f.options.receipts = new NativeCreationReceipts({ directory, accountProviders: ["codex"] });
  assert.equal((await handleRemoteRequest(input, f.options)).duplicate, true);
  assert.equal(f.sends().length, 1);
  f.accounts.codex = "d".repeat(64);
  await assert.rejects(handleRemoteRequest(input, { ...f.options, relay: { async requestDesktop(operation) {
    return { result: operation === "list_projects" ? { projects: [f.project] } : { thread: f.thread } };
  } } }), /binding mismatch/);
  assert.equal(f.sends().length, 1);
});

test("remote profile rejects SSH option injection and insecure paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-codex-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "bridge-remote-hosts.json"), env = { CODEX_HOME: root };
  const write = (value) => fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: { mac: value } }), { mode: 0o600 });
  write(profile);
  assert.deepEqual(readRemoteProfile("mac", { env }), profile);
  for (const invalid of [{ ...profile, sshHost: "-oProxyCommand=bad" }, { ...profile, node: "node" }, { ...profile, receiver: "/path\ncommand" }]) {
    write(invalid);
    assert.throws(() => readRemoteProfile("mac", { env }), { code: "REMOTE_CONFIG_INVALID" });
  }
});

test("origin identity matches HTTPS and SSH without leaking credentials", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-codex-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", ["-C", root, ...args], { windowsHide: true, stdio: "pipe" });
  git(["init"]);
  for (const origin of ["https://example.com/org/repo.git", "git@example.com:org/repo.git", "ssh://git@example.com/org/repo.git"]) {
    git(["config", "remote.origin.url", origin]);
    assert.equal(repositoryIdentity(root), "example.com/org/repo");
  }
  git(["config", "remote.origin.url", "https://secret@example.com/org/repo"]);
  assert.throws(() => repositoryIdentity(root), { code: "REMOTE_PROJECT_UNVERIFIED" });
});

test("remote profile rejects replacement between inspection and opening", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-codex-config-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "bridge-remote-hosts.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: { mac: profile } }), { mode: 0o600 });
  const canonical = fs.realpathSync.native(file);
  const original = fs.openSync;
  fs.openSync = function (value, ...args) {
    if (value === canonical) {
      fs.openSync = original;
      fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: { mac: { ...profile, sshHost: "different-host" } } }));
    }
    return original.call(this, value, ...args);
  };
  try { assert.throws(() => readRemoteProfile("mac", { env: { CODEX_HOME: root } }), { code: "REMOTE_CONFIG_CHANGED" }); }
  finally { fs.openSync = original; }
});

test("remote profile refuses a hardlink and relative Codex home", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-codex-config-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "bridge-remote-hosts.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: { mac: profile } }), { mode: 0o600 });
  fs.linkSync(file, path.join(root, "alias.json"));
  assert.throws(() => readRemoteProfile("mac", { env: { CODEX_HOME: root } }), { code: "REMOTE_CONFIG_UNSAFE" });
  assert.throws(() => readRemoteProfile("mac", { env: { CODEX_HOME: "." } }), { code: "REMOTE_CONFIG_UNSAFE" });
});

function fakeSsh(answer) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => {};
  let input = "";
  child.stdin.on("data", (chunk) => { input += chunk; });
  child.stdin.on("finish", () => queueMicrotask(() => answer(child, input)));
  return child;
}

test("SSH receives prompt only on stdin and uses pinned host verification", async () => {
  const input = request(); input.message = "$(touch escaped); `command`; quote ' \" \n Tiếng Việt";
  const result = await exchangeRemoteRequest(profile, input, { spawnProcess(command, args, options) {
    assert.equal(command, "ssh"); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("PermitLocalCommand=no"));
    assert.ok(!args.join(" ").includes(input.message));
    return fakeSsh((child, payload) => {
      assert.deepEqual(JSON.parse(payload), input);
      child.stdout.write(JSON.stringify({ version: 1, ok: true, action: input.action, requestId: input.requestId, result: { status: "submitted" } }));
      child.emit("close", 0);
    });
  } });
  assert.equal(result.status, "submitted");
  const args = remoteSshArguments({ ...profile, receiver: "/path with spaces/quote'$(false).mjs" });
  assert.equal(args.at(-2), "mac");
  assert.match(args.at(-1), /^zsh -lc '/);
});

test("SSH timeout and oversized output are uncertain, with no retry", async () => {
  for (const oversized of [false, true]) {
    let attempts = 0;
    await assert.rejects(exchangeRemoteRequest(profile, request(), { timeoutMs: 10, spawnProcess() {
      attempts++;
      return fakeSsh((child) => { if (oversized) child.stdout.write("x".repeat(4 * 1024 * 1024 + 1)); });
    } }), { code: "REMOTE_DELIVERY_UNCONFIRMED" });
    assert.equal(attempts, 1);
  }
});

function toolFixture(overrides = {}) {
  let handler; const sent = [], metadata = [];
  const sender = { status: "verified", threadId: SENDER, turnId: randomUUID(), cwd: ROOT, mode: "bypass" };
  registerRemoteCodexTools({ registerTool(name, schema, callback) { assert.equal(name, "remote_codex"); handler = callback; } }, {
    runtime: { assertCurrent() {} }, reload: { run: (fn) => fn() },
    resolveSender: async (meta) => { metadata.push(meta); return { ...sender }; },
    readAccount: () => ({ status: "verified", fingerprint: LOCAL_ACCOUNT }), readProfile: () => profile,
    captureScope: () => ({}), recheckScope: () => {}, repositoryIdentityOf: () => "example.com/org/repo", hostname: () => "sender-pc",
    exchange: async (remote, value) => { sent.push(value); return { status: "submitted" }; }, ...overrides,
  });
  return { call: (args = {}) => handler({ host: "mac", action: "send", threadId: TARGET, message: "Authorized smoke check", requestId: randomUUID(), ...args }, { _meta: { "host-proof": true } }), sent, metadata, sender };
}

test("tool uses host metadata and never accepts a caller-supplied identity", async () => {
  const f = toolFixture();
  assert.equal((await f.call()).isError, undefined);
  assert.equal(f.sent.length, 1);
  assert.ok(f.metadata.every((meta) => meta["host-proof"]));
  assert.equal(f.sent[0].sender.threadId, SENDER);
});

test("tool refuses missing actual host metadata before opening SSH", async () => {
  const { resolveCodexSenderContext } = await import("../src/codex-sender-context.mjs");
  const f = toolFixture({ resolveSender: resolveCodexSenderContext });
  assert.equal((await f.call()).isError, true);
  assert.equal(f.sent.length, 0);
});

test("tool refuses prompting, stale sender, changed account and changed profile", async () => {
  const prompting = toolFixture(); prompting.sender.mode = "prompting";
  assert.match((await prompting.call()).content[0].text, /REMOTE_SENDER_PERMISSION/);
  assert.equal(prompting.sent.length, 0);
  let reads = 0;
  const stale = toolFixture({ resolveSender: async () => ++reads === 1 ? { status: "verified", threadId: SENDER, turnId: randomUUID(), cwd: ROOT, mode: "bypass" } : { status: "unavailable" } });
  assert.match((await stale.call()).content[0].text, /CODEX_SENDER_CHANGED/);
  assert.equal(stale.sent.length, 0);
  reads = 0;
  const changed = toolFixture({ readAccount: () => ({ status: "verified", fingerprint: ++reads === 1 ? LOCAL_ACCOUNT : REMOTE_ACCOUNT }) });
  assert.match((await changed.call()).content[0].text, /REMOTE_ACCOUNT_CHANGED/);
  assert.equal(changed.sent.length, 0);
  reads = 0;
  const config = toolFixture({ readProfile: () => ++reads === 1 ? profile : { ...profile, sshHost: "other" } });
  assert.match((await config.call()).content[0].text, /REMOTE_CONFIG_CHANGED/);
  assert.equal(config.sent.length, 0);
});

test("list cannot smuggle a send body", () => {
  assert.throws(() => validateRemoteRequest({ ...request("list"), message: "send me" }), { code: "REMOTE_REQUEST_INVALID" });
});

test("rechecks the original target binding immediately before the native write", async () => {
  const f = fixture();
  const original = f.options.relay.requestDesktop;
  let projectReads = 0;
  f.options.relay.requestDesktop = async (operation, ...args) => {
    const result = await original(operation, ...args);
    if (operation === "list_projects" && ++projectReads === 3) f.thread.projectId = "moved";
    return result;
  };
  await assert.rejects(handleRemoteRequest(request(), f.options));
  assert.equal(f.sends().length, 0);
});

test("a target move while the native connection opens cannot dispatch", async () => {
  const f = fixture();
  const original = f.options.relay.requestDesktop;
  f.options.relay.requestDesktop = async (operation, ...args) => {
    if (operation === "send_message_to_thread") f.thread.projectId = "moved";
    return original(operation, ...args);
  };
  await assert.rejects(handleRemoteRequest(request(), f.options));
  assert.equal(f.sends().length, 0);
});

test("the private companion socket forwards only verified remote operations", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "remote-codex-socket-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\codex-native-relay-remote-test-${randomUUID()}` : path.join(directory, "relay.sock");
  const f = fixture();
  const server = new RelaySocketServer({ socketPath, strict: true, signalExit: false, requestHandler: (value) => remoteRequestResponse(value, f.options) });
  t.after(async () => { server.stop(); await server.closed; fs.rmSync(directory, { recursive: true, force: true }); });
  await server.start();
  if (process.platform !== "win32") assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const input = request();
  assert.equal((await forwardRemoteRequest(input, { socketPath })).status, "submitted");
  assert.equal((await forwardRemoteRequest(input, { socketPath })).duplicate, true);
  assert.equal(f.sends().length, 1);
  assert.throws(() => forwardRemoteRequest({ ...input, sender: { ...input.sender, mode: "prompting" } }, { socketPath }), { code: "REMOTE_SENDER_PERMISSION" });
  assert.equal(f.sends().length, 1);
});

test("native adapter executes the destination guard before dispatch without Claude account options", async () => {
  let checked = false;
  const adapter = remoteNativeAdapter({ async dispatchDesktop(args, options) {
    assert.equal(args.executorThreadId, EXECUTOR);
    assert.deepEqual(Object.keys(options), ["beforeSend"]);
    await options.beforeSend();
    assert.equal(checked, true);
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ projects: [] }) }] };
  } }, { CODEX_RELAY_ID: EXECUTOR });
  assert.deepEqual(await adapter.requestDesktop("list_projects", {}, { beforeSend: () => { checked = true; } }), { result: { projects: [] } });
});
