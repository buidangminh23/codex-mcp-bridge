import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAntigravityOutboundTargets } from "../src/antigravity-outbound-targets.mjs";

function fixture(t) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-outbound-")));
  const other = path.join(cwd, "other");
  fs.mkdirSync(other);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const id = crypto.randomUUID();
  const sender = { provider: "antigravity", id, conversationId: id, cwd, mode: "prompting", permissionFingerprint: "f".repeat(64) };
  const accounts = { codex: { status: "verified", fingerprint: "a".repeat(64) }, claude: { status: "verified", fingerprint: "b".repeat(64) } };
  const project = { projectId: "fixture-project", projectKind: "local", hostId: "local", path: cwd };
  const thread = { id: crypto.randomUUID(), kind: "codex", hostId: "local", projectId: project.projectId, cwd, title: "Fixture Codex" };
  const session = { sessionId: crypto.randomUUID(), pid: 901, processStart: "fixture-start", socket: "fixture-socket", alive: true, entrypoint: "claude-desktop", cwd };
  const desktop = { status: "matched", taskId: crypto.randomUUID(), title: "Fixture Claude", cwd, accountFingerprint: accounts.claude.fingerprint, permissionClass: "prompting", permissionMode: "default" };
  const inbound = { value: null, source: null };
  const state = { projects: [project], threads: [thread], sessions: [session], readThread: null, beforeNative: null, afterNative: null, beforePeer: null, accountChanged: false, peerCalls: [], nativeCalls: [], peerStarted: 0, peerSettings: null, stopped: false };
  const peer = {
    async start() { state.peerStarted++; },
    async sendAndWait(socket, text, options) {
      await state.beforePeer?.();
      await options.beforeSend();
      state.peerCalls.push({ socket, text, options });
      if (state.peerError) throw state.peerError;
      await state.afterPeer?.();
      return { msgId: "fixture-message" };
    },
    readDelivery(msgId) { return { msgId, status: "reply_received", reply: "fixture reply" }; },
    stop() { state.stopped = true; },
    closed: Promise.resolve(),
  };
  const backend = createAntigravityOutboundTargets({
    env: {},
    readAccounts: () => accounts,
    assertAccounts(identity) {
      assert.deepEqual(identity, { codex: accounts.codex.fingerprint, claude: accounts.claude.fingerprint });
      if (state.accountChanged) throw new Error("Account changed");
    },
    listSessions: () => state.sessions,
    readContext: () => desktop,
    readInbound: () => inbound,
    assertProcess(candidate) { assert.equal(candidate.processStart, "fixture-start"); },
    peerFactory(settings) { state.peerSettings = settings; return peer; },
    relay: {
      async requestDesktop(name, args, options) {
        if (name === "send_message_to_thread") await state.beforeNative?.();
        await options.beforeSend();
        state.nativeCalls.push({ name, args, options });
        let result;
        if (name === "list_projects") result = { projects: state.projects };
        else if (name === "list_threads") result = { threads: state.threads, pinnedThreads: [] };
        else if (name === "read_thread") {
          const record = state.threads.find((row) => row.id === args.threadId);
          const native = record ? { ...record, status: { type: "idle", activeFlags: [] } } : null;
          if (native) delete native.projectId;
          result = { thread: state.readThread ? state.readThread(native) : native, turns: [{ text: "fixture turn" }] };
        }
        else if (name === "send_message_to_thread") { result = { success: true }; await state.afterNative?.(); }
        else assert.fail(`Unexpected operation ${name}`);
        return { result };
      },
    },
  });
  t.after(() => backend.close());
  const beforeSend = async () => sender;
  const codexSend = (overrides = {}) => backend.send({ target: "codex", threadId: thread.id, cwd, prompt: "Fixture work", sender, beforeSend, ...overrides });
  const claudeSend = (overrides = {}) => backend.send({ target: "claude", sessionId: session.sessionId, taskId: desktop.taskId, cwd, prompt: "Fixture work", sender, beforeSend, ...overrides });
  return { cwd, other, sender, accounts, project, thread, session, desktop, inbound, state, backend, beforeSend, codexSend, claudeSend };
}

test("Codex list and read use current-account native saved-project metadata", async (t) => {
  const f = fixture(t);
  const listed = await f.backend.list({ target: "codex", sender: f.sender, beforeSend: f.beforeSend });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].threadId, f.thread.id);
  const read = await f.backend.read({ target: "codex", threadId: f.thread.id, cwd: f.cwd, sender: f.sender });
  assert.equal(read.result.turns[0].text, "fixture turn");
  assert.equal(read.result.thread.projectId, undefined);
  assert.deepEqual(read.result.thread.status, { type: "idle", activeFlags: [] });
  for (const call of f.state.nativeCalls) assert.deepEqual(call.options.accountContext, { codex: "a".repeat(64), claude: "b".repeat(64) });
  assert.equal(f.state.nativeCalls.some((call) => call.name === "send_message_to_thread"), false);
});

test("Codex native read omissions require matching inventory and reject contradictory metadata", async (t) => {
  for (const mutate of [
    (f) => { f.state.readThread = (thread) => ({ ...thread, projectId: "another-project" }); },
    (f) => { f.state.readThread = (thread) => ({ ...thread, cwd: f.other }); },
    (f) => { f.state.readThread = (thread) => ({ ...thread, hostId: "remote" }); },
    (f) => { f.state.threads = []; },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.codexSend());
    assert.equal(f.state.nativeCalls.some((call) => call.name === "send_message_to_thread"), false);
  }
});

test("Codex sends only to the exact existing task and retains native settings", async (t) => {
  const f = fixture(t);
  const receipt = await f.codexSend();
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.completed, false);
  assert.deepEqual(receipt.accountContext, { codex: f.accounts.codex.fingerprint, claude: f.accounts.claude.fingerprint });
  const sends = f.state.nativeCalls.filter((call) => call.name === "send_message_to_thread");
  assert.equal(sends.length, 1);
  assert.deepEqual(Object.keys(sends[0].args).sort(), ["prompt", "threadId"]);
  assert.match(sends[0].args.prompt, /Agent handoff from Antigravity conversation/);
  assert.equal(f.state.nativeCalls.some((call) => call.name === "create_thread"), false);
});

test("Codex rejects mismatched project, missing assignment, remote task and ambiguous saved projects", async (t) => {
  for (const mutate of [
    (f) => { f.thread.cwd = f.other; },
    (f) => { delete f.thread.projectId; },
    (f) => { f.thread.hostId = "remote"; },
    (f) => { f.state.projects.push({ ...f.project, projectId: "duplicate" }); },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.codexSend());
    assert.equal(f.state.nativeCalls.some((call) => call.name === "send_message_to_thread"), false);
  }
});

test("native final preflight detects moved Codex tasks and changed accounts", async (t) => {
  for (const mutate of [(f) => { f.thread.cwd = f.other; }, (f) => { f.state.accountChanged = true; }]) {
    const f = fixture(t);
    f.state.beforeNative = () => mutate(f);
    await assert.rejects(f.codexSend());
    assert.equal(f.state.nativeCalls.some((call) => call.name === "send_message_to_thread"), false);
  }
});

test("post-send account change leaves Codex delivery unknown", async (t) => {
  const f = fixture(t);
  f.state.afterNative = () => { f.state.accountChanged = true; };
  await assert.rejects(f.codexSend(), { deliveryState: "unknown", accountContext: { codex: f.accounts.codex.fingerprint, claude: f.accounts.claude.fingerprint } });
  assert.equal(f.state.nativeCalls.filter((call) => call.name === "send_message_to_thread").length, 1);
});

test("Claude list and read expose only exact native Desktop metadata", async (t) => {
  const f = fixture(t);
  const listed = await f.backend.list({ target: "claude", sender: f.sender });
  assert.equal(listed[0].sessionId, f.session.sessionId);
  assert.equal(listed[0].taskId, f.desktop.taskId);
  const read = await f.backend.read({ target: "claude", sessionId: f.session.sessionId, taskId: f.desktop.taskId, sender: f.sender });
  assert.equal(read.title, "Fixture Claude");
  assert.equal(read.socket, undefined);
  assert.equal(read.transcript, undefined);
  assert.equal(f.state.peerStarted, 0);
});

test("Claude uses Antigravity peer identity, native sender mode and no Codex reply forwarding", async (t) => {
  const f = fixture(t);
  const receipt = await f.claudeSend();
  assert.equal(receipt.status, "sent_unconfirmed");
  assert.equal(receipt.msgId, "fixture-message");
  assert.deepEqual(receipt.accountContext, { codex: f.accounts.codex.fingerprint, claude: f.accounts.claude.fingerprint });
  assert.match(f.state.peerSettings.name, /^antigravity-/);
  const call = f.state.peerCalls[0];
  assert.equal(call.options.permissionMode, "prompting");
  assert.equal(call.options.replyThreadId, undefined);
  assert.equal(call.options.timeoutMs, 0);
  assert.equal(call.options.transcriptSession.sessionId, f.session.sessionId);
  const read = await f.backend.read({ target: "claude", msgId: receipt.msgId, sender: f.sender });
  assert.equal(read.reply, "fixture reply");
});

test("Claude blocks native inbound hold/refuse and cross-class delivery without changing policy", async (t) => {
  for (const mutate of [
    (f) => { f.inbound.value = "hold"; },
    (f) => { f.inbound.value = "refuse"; },
    (f) => { f.desktop.permissionClass = "bypass"; },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.claudeSend());
    assert.equal(f.state.peerStarted, 0);
    assert.equal(f.state.peerCalls.length, 0);
  }
});

test("Claude rejects CLI sessions, wrong task IDs, foreign accounts and duplicate sessions", async (t) => {
  for (const mutate of [
    (f) => { f.session.entrypoint = "cli"; },
    (f) => { f.desktop.accountFingerprint = "c".repeat(64); },
    (f) => { f.state.sessions.push({ ...f.session }); },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.claudeSend());
    assert.equal(f.state.peerCalls.length, 0);
  }
  const f = fixture(t);
  await assert.rejects(f.claudeSend({ taskId: "wrong-task" }));
  assert.equal(f.state.peerCalls.length, 0);
});

test("Claude final preflight checks process, socket, sender permission and inbound changes", async (t) => {
  for (const mutate of [
    (f) => { f.state.sessions = [{ ...f.session, socket: "new-socket" }]; },
    (f) => { f.state.sessions = [{ ...f.session, processStart: "new-process" }]; },
    (f) => { f.sender.permissionFingerprint = "changed"; },
    (f) => { f.inbound.value = "hold"; },
  ]) {
    const f = fixture(t);
    f.state.beforePeer = () => mutate(f);
    await assert.rejects(f.claudeSend());
    assert.equal(f.state.peerCalls.length, 0);
  }
});

test("outbound mutations require live sender revalidation and exact caller directory", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.codexSend({ beforeSend: undefined }), /revalidation/);
  await assert.rejects(f.claudeSend({ cwd: f.other }), /must match/);
  await assert.rejects(f.codexSend({ sender: { ...f.sender, provider: "claude" } }), /Verified Antigravity/);
  await assert.rejects(f.codexSend({ sender: { ...f.sender, mode: "default" } }), /permission evidence/);
  assert.equal(f.state.nativeCalls.length, 0);
  assert.equal(f.state.peerCalls.length, 0);
});

test("Claude receipts cannot leak into another Antigravity conversation", async (t) => {
  const f = fixture(t);
  await f.claudeSend();
  const id = crypto.randomUUID();
  await assert.rejects(f.backend.read({ target: "claude", msgId: "fixture-message", sender: { ...f.sender, id, conversationId: id } }), (error) => {
    assert.match(error.message, /does not belong/);
    assert.notEqual(error.code, "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE");
    return true;
  });
  await f.backend.close();
  assert.equal(f.state.stopped, true);
  await assert.rejects(f.backend.list({ target: "claude", sender: f.sender }), /closed/);
});

test("only missing native receipts allow the persisted receipt fallback", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.backend.read({ target: "claude", msgId: "missing-message", sender: f.sender }), { code: "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE" });
  await f.claudeSend();
  f.state.accountChanged = true;
  for (const msgId of ["fixture-message", "missing-message"]) {
    await assert.rejects(f.backend.read({ target: "claude", msgId, sender: f.sender }), (error) => {
      assert.match(error.message, /Account changed/);
      assert.notEqual(error.code, "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE");
      return true;
    });
  }
});

test("uncertain Claude delivery retains original account binding and native message ID", async (t) => {
  for (const mutate of [
    (f) => { f.state.peerError = Object.assign(new Error("Native connection lost"), { deliveryUncertain: true, msgId: "fixture-message" }); },
    (f) => { f.state.afterPeer = () => { f.state.accountChanged = true; }; },
  ]) {
    const f = fixture(t);
    mutate(f);
    await assert.rejects(f.claudeSend(), {
      deliveryState: "unknown",
      msgId: "fixture-message",
      accountContext: { codex: f.accounts.codex.fingerprint, claude: f.accounts.claude.fingerprint },
    });
  }
});
