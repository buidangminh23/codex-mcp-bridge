import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { createHardenedRootPolicy } from "../src/hardened-root-policy.mjs";
import { createNativeScopeAuthorizer, handleRelayRequest, RelaySocketServer } from "../src/native-relay-companion.mjs";
import { IS_WINDOWS } from "../src/platform.mjs";
import { buildFrame, PeerEndpoint } from "../src/peer-protocol.mjs";
import { ReplyForwarder } from "../src/reply-forwarder.mjs";
import { protectCurrentUserPipe } from "../src/windows-pipe-acl.mjs";

const accounts = Object.freeze({ claude: "a".repeat(64), codex: "b".repeat(64) });
const otherAccounts = Object.freeze({ claude: "c".repeat(64), codex: "d".repeat(64) });
const native = (structuredContent) => ({ success: true, structuredContent });
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function strictEnv(root, extra = {}) {
  return { CODEX_BRIDGE_HARDENED: "1", CODEX_BRIDGE_ALLOWED_ROOTS: root,
    CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_THREAD_POLICY: "roots",
    CODEX_BRIDGE_REMAP: "0", CODEX_BRIDGE_AUTOSTART: "0", ...extra };
}

function replaceDirectory(directory) {
  const moved = `${directory}-original-${randomUUID()}`;
  fs.renameSync(directory, moved);
  fs.mkdirSync(directory);
  return moved;
}

async function sendLines(socketPath, lines) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    socket.setEncoding("utf8");
    let output = "";
    socket.once("connect", () => socket.end(lines));
    socket.on("data", (chunk) => { output += chunk; });
    socket.on("error", (error) => { if (!["ECONNRESET", "EPIPE"].includes(error.code)) reject(error); });
    socket.on("close", () => resolve(output));
  });
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

function createNativeHarness(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-native-"));
  const allowedRoot = path.join(sandbox, "allowed");
  const projectA = path.join(allowedRoot, "project-a");
  const projectB = path.join(allowedRoot, "project-b");
  const forbiddenRoot = path.join(sandbox, "forbidden");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB);
  fs.mkdirSync(forbiddenRoot);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const state = {
    env: strictEnv(allowedRoot), currentAccount: accounts, beforeActual: null, resultOverride: null, actualCalls: [],
    projects: [
      { projectId: "project-a", projectKind: "local", hostId: "local", path: projectA },
      { projectId: "project-b", projectKind: "local", hostId: "local", path: projectB },
      { projectId: "cloud", projectKind: "chatgpt", hostId: "cloud", path: forbiddenRoot },
    ],
    threads: new Map([
      ["executor", { id: "executor", kind: "codex", hostId: "local", cwd: projectA, projectId: "project-a", status: "idle" }],
      ["target", { id: "target", kind: "codex", hostId: "local", cwd: projectA, projectId: "project-a", status: "idle" }],
      ["other", { id: "other", kind: "codex", hostId: "local", cwd: projectB, projectId: "project-b", status: "idle" }],
      ["forbidden", { id: "forbidden", kind: "codex", hostId: "local", cwd: forbiddenRoot, projectId: "cloud", status: "idle" }],
    ]),
  };
  const assertAccount = (actual) => {
    if (JSON.stringify(actual) !== JSON.stringify(state.currentAccount)) throw Object.assign(new Error("Account identity changed"), { code: "ACCOUNT_IDENTITY_CHANGED", sent: false });
  };
  const contentFor = (operation, args, actual) => {
    if (state.resultOverride && actual) return state.resultOverride(operation, args);
    if (operation === "list_projects") return { projects: state.projects, total: state.projects.length };
    if (operation === "list_threads") return { pinnedThreads: [state.threads.get("executor")], threads: [state.threads.get("target"), state.threads.get("other"), state.threads.get("forbidden")], total: 4, customSections: [{ id: "private" }] };
    if (operation === "read_thread") return { thread: state.threads.get(args.threadId) };
    if (operation === "create_thread") {
      const created = { id: "created", kind: "codex", hostId: "local", cwd: projectB, projectId: "project-b", status: "idle" };
      state.threads.set(created.id, created);
      return { threadId: created.id, hostId: "local" };
    }
    if (operation === "wait_threads") return { timedOut: false,
      wake: { reason: "turn_completed", turnId: "turn", threadId: "target", hostId: "local" },
      polls: [
        { thread: { id: "target", hostId: "local", status: "idle" }, latestAssistantMessage: "allowed target" },
        { thread: { id: "other", hostId: "local", status: "idle" }, latestAssistantMessage: "allowed other" },
        { thread: { id: "forbidden", hostId: "local", status: "idle" }, latestAssistantMessage: "secret" },
      ], total: 3 };
    return { threadId: args.threadId ?? null, accepted: true };
  };
  const dispatchDesktop = async ({ operation, arguments: args }, options = {}) => {
    const actual = typeof options.beforeSend === "function";
    if (actual) {
      await state.beforeActual?.(operation, args);
      await options.beforeSend();
      assertAccount(options.accountContext);
      state.actualCalls.push(operation);
    }
    return native(contentFor(operation, args, actual));
  };
  const dispatch = async ({ targetThreadId }, options = {}) => {
    await state.beforeActual?.("send_message_to_thread", { threadId: targetThreadId });
    await options.beforeSend?.();
    assertAccount(options.accountContext);
    state.actualCalls.push("raw_send_message_to_thread");
    return { success: true };
  };
  const authorize = createNativeScopeAuthorizer({ dispatchDesktop, env: state.env });
  const options = { env: state.env, strict: true, resolveExecutor: () => ({ threadId: "executor" }), assertAccount, authorize, dispatch, dispatchDesktop };
  return {
    state, projectA, projectB,
    request: (operation, args) => handleRelayRequest({ v: 2, operation, arguments: args, accountContext: accounts }, options),
    rawSend: (targetThreadId = "target") => handleRelayRequest({ v: 2, targetThreadId, message: "hello", accountContext: accounts }, options),
  };
}

test("hardened roots enforce the strict profile, canonical containment, and directory identity", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-root-"));
  const root = path.join(sandbox, "allowed");
  const child = path.join(root, "project");
  const sibling = path.join(sandbox, "allowed-sibling");
  const outside = path.join(sandbox, "outside");
  fs.mkdirSync(child, { recursive: true }); fs.mkdirSync(sibling); fs.mkdirSync(outside);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const valid = strictEnv(root);
  for (const [name, value] of [["CODEX_BRIDGE_DESKTOP_TASKS", "0"], ["CODEX_BRIDGE_THREAD_POLICY", "owned"], ["CODEX_BRIDGE_REMAP", "1"], ["CODEX_BRIDGE_AUTOSTART", "1"], ["CODEX_BRIDGE_PATH_MAP", "x"], ["CODEX_BRIDGE_ALLOWED_THREADS", "*"]]) {
    assert.throws(() => createHardenedRootPolicy({ ...valid, [name]: value }), name);
  }
  for (const roots of [undefined, "", "*", path.parse(root).root, path.join(root, "missing")]) {
    const env = { ...valid };
    if (roots === undefined) delete env.CODEX_BRIDGE_ALLOWED_ROOTS; else env.CODEX_BRIDGE_ALLOWED_ROOTS = roots;
    assert.throws(() => createHardenedRootPolicy(env));
  }
  const policy = createHardenedRootPolicy(valid);
  const binding = policy.capture(child);
  assert.equal(policy.allows(child), true); assert.equal(policy.allows(sibling), false);
  assert.throws(() => policy.assert(path.join(root, "missing")));
  const junction = path.join(root, "junction-out");
  fs.symlinkSync(outside, junction, IS_WINDOWS ? "junction" : "dir");
  assert.equal(policy.allows(junction), false);
  const moved = replaceDirectory(child);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  assert.equal(policy.allows(child), true);
  assert.throws(() => policy.recheck(binding), /replaced/);
});

test("hardened configured roots reject same-path replacement", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-configured-root-"));
  const root = path.join(sandbox, "allowed"); fs.mkdirSync(root);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const policy = createHardenedRootPolicy(strictEnv(root));
  assert.equal(policy.allows(root), true);
  const moved = replaceDirectory(root);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  assert.equal(policy.allows(root), false);
  assert.throws(() => policy.capture(root), /retargeted or replaced/);
});

test("hardened relay rejects raw, accountless, and unverified frames before dispatch", async () => {
  let calls = 0;
  const options = { strict: true, dispatch: async () => { calls += 1; }, dispatchDesktop: async () => { calls += 1; } };
  for (const payload of [{ v: 1, targetThreadId: "target", message: "x" }, { v: 2, targetThreadId: "target", message: "x" }, { v: 2, operation: "list_projects", arguments: {} }]) {
    const response = await handleRelayRequest(payload, options);
    assert.equal(response.ok, false); assert.equal(response.error.code, "RELAY_BAD_REQUEST");
  }
  const unverified = await handleRelayRequest({ v: 2, targetThreadId: "target", message: "x", accountContext: accounts }, options);
  assert.equal(unverified.error.code, "NATIVE_SCOPE_UNVERIFIED"); assert.equal(calls, 0);
});

test("hardened native authorization permits every operation and filters list and wait output", async (t) => {
  const h = createNativeHarness(t);
  const projects = await h.request("list_projects", {});
  assert.equal(projects.ok, true); assert.deepEqual(projects.result.projects.map((row) => row.projectId), ["project-a", "project-b"]); assert.deepEqual(Object.keys(projects.result), ["projects"]);
  const threads = await h.request("list_threads", { limit: 20 });
  assert.equal(threads.ok, true); assert.deepEqual(threads.result.pinnedThreads.map((row) => row.id), ["executor"]); assert.deepEqual(threads.result.threads.map((row) => row.id), ["target", "other"]); assert.deepEqual(Object.keys(threads.result).sort(), ["pinnedThreads", "threads"]);
  const cases = [
    ["create_thread", { prompt: "build", target: { type: "project", projectId: "project-b", environment: { type: "local" } } }, "created"],
    ["read_thread", { threadId: "target", hostId: "local", turnLimit: 1 }, "target"],
    ["send_message_to_thread", { threadId: "target", prompt: "continue" }, "target"],
    ["navigate_to_codex_page", { threadId: "target" }, "target"],
    ["set_thread_title", { threadId: "target", title: "Allowed title" }, "target"],
  ];
  for (const [operation, args, expected] of cases) {
    const response = await h.request(operation, args);
    assert.equal(response.ok, true, `${operation}: ${response.error?.message ?? ""}`);
    assert.equal(response.result.threadId ?? response.result.thread?.id, expected);
  }
  const waited = await h.request("wait_threads", { targets: [{ threadId: "target", hostId: "local" }, { threadId: "other" }], timeoutMs: 0 });
  assert.equal(waited.ok, true); assert.deepEqual(waited.result.polls.map((row) => row.thread.id), ["target", "other"]); assert.equal(waited.result.wake.threadId, "target"); assert.deepEqual(Object.keys(waited.result).sort(), ["polls", "timedOut", "wake"]);
  assert.equal((await h.rawSend()).ok, true);
  assert.deepEqual(h.state.actualCalls, ["list_projects", "list_threads", "create_thread", "read_thread", "send_message_to_thread", "navigate_to_codex_page", "set_thread_title", "wait_threads", "raw_send_message_to_thread"]);
});

test("hardened native authorization rejects stale targets, mixed batches, self wait, and duplicates before mutation", async (t) => {
  const h = createNativeHarness(t);
  const cases = [
    ["read_thread", { threadId: "stale" }], ["send_message_to_thread", { threadId: "stale", prompt: "x" }],
    ["navigate_to_codex_page", { threadId: "stale" }], ["set_thread_title", { threadId: "stale", title: "x" }],
    ["wait_threads", { targets: [{ threadId: "target" }, { threadId: "forbidden" }], timeoutMs: 0 }],
    ["wait_threads", { targets: [{ threadId: "executor" }], timeoutMs: 0 }],
    ["wait_threads", { targets: [{ threadId: "target" }, { threadId: "target" }], timeoutMs: 0 }],
  ];
  for (const [operation, args] of cases) {
    const response = await h.request(operation, args);
    assert.equal(response.ok, false, operation); assert.equal(response.error.code, "NATIVE_SCOPE_UNVERIFIED", operation); assert.equal(h.state.actualCalls.length, 0);
  }
  assert.equal((await h.rawSend("forbidden")).ok, false); assert.equal(h.state.actualCalls.length, 0);
  h.state.projects.push({ ...h.state.projects[0] });
  const duplicate = await h.request("list_projects", {});
  assert.equal(duplicate.ok, false); assert.equal(duplicate.error.code, "NATIVE_SCOPE_UNVERIFIED"); assert.equal(h.state.actualCalls.length, 0);
});

test("hardened creation rejects nonlocal execution surfaces before dispatch", async (t) => {
  const h = createNativeHarness(t);
  const response = await h.request("create_thread", { prompt: "x", target: { type: "project", projectId: "project-b", environment: { type: "worktree" } } });
  assert.equal(response.ok, false); assert.equal(response.error.code, "RELAY_BAD_REQUEST"); assert.equal(h.state.actualCalls.length, 0);
});

test("hardened native writes recheck account, task binding, and directory identity at I/O", async (t) => {
  {
    const h = createNativeHarness(t); h.state.beforeActual = () => { h.state.currentAccount = otherAccounts; };
    const response = await h.request("send_message_to_thread", { threadId: "target", prompt: "must not send" });
    assert.equal(response.ok, false); assert.equal(response.error.code, "ACCOUNT_IDENTITY_CHANGED"); assert.equal(h.state.actualCalls.length, 0);
  }
  {
    const h = createNativeHarness(t); h.state.beforeActual = () => { h.state.threads.get("target").cwd = h.projectB; h.state.threads.get("target").projectId = "project-b"; };
    const response = await h.request("navigate_to_codex_page", { threadId: "target" });
    assert.equal(response.ok, false); assert.equal(response.error.code, "NATIVE_SCOPE_UNVERIFIED"); assert.equal(h.state.actualCalls.length, 0);
  }
  {
    const h = createNativeHarness(t); let moved;
    h.state.beforeActual = () => { moved ??= replaceDirectory(h.projectA); };
    t.after(() => { if (moved) fs.rmSync(moved, { recursive: true, force: true }); });
    const response = await h.request("set_thread_title", { threadId: "target", title: "must not apply" });
    assert.equal(response.ok, false); assert.equal(response.error.code, "NATIVE_SCOPE_UNVERIFIED"); assert.equal(h.state.actualCalls.length, 0);
  }
});

test("hardened native return checks reject a read result outside the selected binding", async (t) => {
  const h = createNativeHarness(t);
  h.state.resultOverride = (operation, args) => operation === "read_thread" ? { thread: { ...h.state.threads.get(args.threadId), cwd: h.projectB, projectId: "project-b" } } : null;
  const response = await h.request("read_thread", { threadId: "target" });
  assert.equal(response.ok, false); assert.equal(response.error.code, "NATIVE_SCOPE_UNVERIFIED"); assert.deepEqual(h.state.actualCalls, ["read_thread"]);
});

test("hardened native wait rejects explicit return contradictions but accepts minimal native rows", async (t) => {
  for (const contradiction of [{ cwd: "forbidden" }, { projectId: "wrong" }, { kind: "chatgpt" }]) {
    const h = createNativeHarness(t);
    const fields = { ...contradiction, ...(contradiction.cwd ? { cwd: h.state.threads.get("forbidden").cwd } : {}) };
    h.state.resultOverride = () => ({ timedOut: false, wake: null, polls: [{ thread: { id: "target", hostId: "local", ...fields }, latestAssistantMessage: "must not escape" }] });
    const response = await h.request("wait_threads", { targets: [{ threadId: "target", hostId: "local" }], timeoutMs: 0 });
    assert.equal(response.ok, false); assert.equal(response.error.code, "NATIVE_SCOPE_UNVERIFIED");
    assert.equal(JSON.stringify(response).includes("must not escape"), false);
    assert.deepEqual(h.state.actualCalls, ["wait_threads"]);
  }
  const h = createNativeHarness(t);
  h.state.resultOverride = () => ({ timedOut: false, wake: { reason: "turn_completed", threadId: "target", hostId: "local" }, polls: [{ thread: { id: "target", hostId: "local", status: { type: "idle" } }, latestAssistantMessage: { text: "valid minimal row" } }] });
  const response = await h.request("wait_threads", { targets: [{ threadId: "target", hostId: "local" }], timeoutMs: 0 });
  assert.equal(response.ok, true); assert.equal(response.result.polls[0].latestAssistantMessage.text, "valid minimal row");
});

test("hardened creation requires a confirmed exact local task id without marking uncertain outcomes unsent", async (t) => {
  for (const result of [{ accepted: true }, { threadId: "" }, { threadId: " " }, { clientThreadId: "queued" }, { conversationId: "other" }, { threadId: "stale" }, { threadId: "target" }, { threadId: "other", hostId: "remote" }]) {
    const h = createNativeHarness(t); h.state.resultOverride = () => result;
    const response = await h.request("create_thread", { prompt: "fixture", target: { type: "project", projectId: "project-b", environment: { type: "local" } } });
    assert.equal(response.ok, false, JSON.stringify(result));
    assert.notEqual(response.error.sent, false, "a post-dispatch identity failure cannot prove the creation was unsent");
    assert.deepEqual(h.state.actualCalls, ["create_thread"], "must neither retry nor substitute another creation");
  }
});

test("hardened correlated replies retain roots and accounts through receipts and reload while unsolicited input is dropped", async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-scope-")); const project = path.join(sandbox, "project"); fs.mkdirSync(project);
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const env = strictEnv(sandbox); const policy = createHardenedRootPolicy(env);
  const bindings = { sender: policy.capture(project), recipient: policy.capture(project) };
  const peer = new PeerEndpoint({ name: `hardened-${randomUUID()}`, cwd: project, env, protectSocket: async () => ({ protected: true }) });
  t.after(async () => { peer.stop(); await peer.closed; });
  await peer.start();
  const auth = JSON.stringify({ type: "auth", token: peer.peerToken }) + "\n";
  await sendLines(peer.socketPath, auth + JSON.stringify(buildFrame({ text: "unsolicited", fromSocket: "unbound-peer" })) + "\n");
  await delay(10); assert.equal(peer.inbox.length, 0);
  const msgId = randomUUID(); const fromSocket = "bound-peer";
  peer.pendingMessages.set(msgId, { targetSocket: fromSocket }); peer.unconfirmedReplies.set(fromSocket, 1);
  peer.sentMessages.set(msgId, { targetSocket: fromSocket, sentAt: Date.now(), replyThreadId: "codex-task", accountContext: accounts, scopeBindings: bindings });
  await sendLines(peer.socketPath, auth + JSON.stringify(buildFrame({ text: "correlated", fromSocket })) + "\n");
  await eventually(() => peer.inbox.length === 1, "correlated reply was not accepted");
  const receipt = peer.readDelivery(msgId);
  assert.equal(receipt.status, "reply_received"); assert.equal(receipt.reply, "correlated"); assert.deepEqual(receipt.accountContext, accounts); assert.deepEqual(receipt.scopeBindings, bindings); assert.equal(receipt.senderCwd, bindings.sender.path); assert.equal(peer.pendingMessages.size, 0);
  await peer.quiesce(); const state = peer.exportReloadState();
  const replacement = new PeerEndpoint({ name: "replacement", cwd: project, env, protectSocket: async () => ({ protected: true }) });
  t.after(async () => { replacement.stop(); await replacement.closed; });
  replacement.restoreReloadState(state);
  const restored = replacement.readDelivery(msgId);
  assert.equal(restored.reply, "correlated"); assert.deepEqual(restored.accountContext, accounts); assert.deepEqual(restored.scopeBindings, bindings); assert.equal(replacement.drainInbox(1)[0].inReplyTo, msgId);
});

test("hardened reply forwarding accepts current bindings and fails after recipient replacement", async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-forward-scope-")); const sender = path.join(sandbox, "sender"); const recipient = path.join(sandbox, "recipient");
  fs.mkdirSync(sender, { recursive: true }); fs.mkdirSync(recipient); t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const policy = createHardenedRootPolicy(strictEnv(sandbox)); let delivered = 0;
  const forwarder = new ReplyForwarder({ minIntervalMs: 0, schedule: (callback) => { queueMicrotask(callback); return 1; }, cancel: () => {},
    beforeForward: (record) => { policy.recheck(record.scopeBindings.sender); policy.recheck(record.scopeBindings.recipient); },
    deliver: async () => { delivered += 1; return { backend: "fixture" }; } });
  t.after(() => forwarder.close());
  const current = { sender: policy.capture(sender), recipient: policy.capture(recipient) };
  forwarder.enqueue({ msgId: "reply-one", text: "allowed", scopeBindings: current }, "thread-one");
  await eventually(() => forwarder.read("reply-one")?.status === "forwarded", "current reply was not forwarded"); assert.equal(delivered, 1);
  const stale = { sender: policy.capture(sender), recipient: policy.capture(recipient) }; const moved = replaceDirectory(recipient);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  forwarder.enqueue({ msgId: "reply-two", text: "blocked", scopeBindings: stale }, "thread-one");
  await eventually(() => forwarder.read("reply-two")?.status === "failed", "stale reply was not rejected"); assert.equal(delivered, 1); assert.match(forwarder.read("reply-two").reason, /replaced/);
});

test("Windows relay serializes start and destroys provisional connections before parsing", { skip: !IS_WINDOWS }, async (t) => {
  const socketPath = `\\\\.\\pipe\\LOCAL\\codex-native-relay-test-${randomUUID().replaceAll("-", "")}`; let release;
  const gate = new Promise((resolve) => { release = resolve; }); let protections = 0; let dispatches = 0;
  const relay = new RelaySocketServer({ socketPath, strict: true, protectSocket: async () => { protections += 1; await gate; }, dispatch: async () => { dispatches += 1; return { success: true }; } });
  t.after(async () => { relay.stop(); await relay.closed; });
  const first = relay.start(); const second = relay.start(); assert.equal(first, second); await delay(20);
  const early = sendLines(socketPath, `${JSON.stringify({ v: 2, targetThreadId: "target", message: "early", accountContext: accounts })}\n`); await delay(10); release(); await first;
  assert.equal(await early, ""); assert.equal(protections, 1); assert.equal(dispatches, 0); assert.equal(relay.provisionalSockets.size, 0);
});

test("Windows relay failure and stop during start leave no listener or provisional handle", { skip: !IS_WINDOWS }, async (t) => {
  const failed = new RelaySocketServer({ socketPath: `\\\\.\\pipe\\LOCAL\\codex-native-relay-test-${randomUUID().replaceAll("-", "")}`, strict: true, protectSocket: async () => { throw new Error("acl failure"); } });
  t.after(async () => { failed.stop(); await failed.closed; });
  await assert.rejects(failed.start(), /acl failure/); assert.equal(failed.server.listening, false); assert.equal(failed.provisionalSockets.size, 0);
  const socketPath = `\\\\.\\pipe\\LOCAL\\codex-native-relay-test-${randomUUID().replaceAll("-", "")}`; let release;
  const gate = new Promise((resolve) => { release = resolve; }); const stopped = new RelaySocketServer({ socketPath, strict: true, protectSocket: async () => gate });
  const starting = stopped.start(); await delay(20); const early = sendLines(socketPath, "{}\n"); await delay(10); stopped.stop(); release();
  await assert.rejects(starting, /cancelled/); await stopped.closed; await early;
  assert.equal(stopped.started, false); assert.equal(stopped.server.listening, false); assert.equal(stopped.provisionalSockets.size, 0); assert.equal(stopped.connections.size, 0);
});

test("Windows peer startup is shared and stop during ACL protection cannot resurrect it", { skip: !IS_WINDOWS }, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-peer-lifecycle-")); t.after(() => fs.rmSync(sandbox, { recursive: true, force: true })); let release;
  const gate = new Promise((resolve) => { release = resolve; }); let protections = 0;
  const peer = new PeerEndpoint({ cwd: sandbox, env: strictEnv(sandbox), protectSocket: async () => { protections += 1; await gate; } });
  const first = peer.start(); const second = peer.start(); assert.equal(first, second); await delay(20);
  const early = sendLines(peer.socketPath, `${JSON.stringify({ type: "auth", token: peer.peerToken })}\n${JSON.stringify(buildFrame({ text: "early", fromSocket: "attacker" }))}\n`); await delay(10); peer.stop(); release();
  await assert.rejects(first, /cancelled/); await peer.closed; await early;
  assert.equal(protections, 1); assert.equal(peer.started, false); assert.equal(peer.server.listening, false); assert.equal(peer.provisionalSockets.size, 0); assert.equal(peer.connections.size, 0); assert.equal(fs.existsSync(peer.registryPath), false);
});

test("Windows protected relay permits current user and proves anonymous read and duplex denial", { skip: !IS_WINDOWS }, async (t) => {
  const socketPath = `\\\\.\\pipe\\LOCAL\\codex-native-relay-test-${randomUUID().replaceAll("-", "")}`;
  const relay = new RelaySocketServer({ socketPath, strict: true }); t.after(async () => { relay.stop(); await relay.closed; });
  await relay.start(); const readback = await protectCurrentUserPipe(socketPath);
  assert.equal(readback.ownerMatches, true); assert.equal(readback.protected, true); assert.equal(readback.aceCount, 1); assert.equal(readback.anonymousDenied, true); assert.equal(readback.readError, 5); assert.equal(readback.duplexError, 5);
  const response = JSON.parse(await sendLines(socketPath, `${JSON.stringify({ v: 1, targetThreadId: "target", message: "same user" })}\n`));
  assert.equal(response.ok, false); assert.equal(response.error.code, "RELAY_BAD_REQUEST"); relay.stop(); await relay.closed; assert.equal(relay.server.listening, false); assert.equal(relay.connections.size, 0);
});
