import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFrame } from "../src/peer-protocol.mjs";
import { createQueuedDeliveryDrain, createQueuedDeliveryStore, publicQueueReceipt, QUEUE_LIMITS, QUEUE_STATES, queuedDeliveryEnabled, queuedDeliveryText } from "../src/queued-claude-delivery.mjs";

const ACCOUNT = "a".repeat(64);
const CODEX_ACCOUNT = "b".repeat(64);
const TASK = "local_00000000-0000-4000-8000-000000000001";
const SESSION = "11111111-1111-4111-8111-111111111111";

function harness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "queued-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { now: 1_000_000 };
  const store = createQueuedDeliveryStore({ root: path.join(root, "queue"), now: () => clock.now });
  const state = { inbound: "accept", sends: [], stopped: 0, peers: 0, senderReads: 0, outcome: { status: "reply_received", reply: { text: "done" } }, codexAccount: CODEX_ACCOUNT, sendError: null, senderStatus: "verified", sessions: [{ pid: 42, sessionId: SESSION, alive: true, entrypoint: "claude-desktop", cwd: root, socket: "/tmp/peer.sock" }] };
  const drain = createQueuedDeliveryDrain({
    store,
    readAccounts: () => ({ claude: { status: "verified", fingerprint: ACCOUNT }, codex: { status: "verified", fingerprint: state.codexAccount } }),
    readOutcome: () => state.outcome,
    now: () => clock.now,
    readSender: async () => (state.senderReads += 1, { status: state.senderStatus, pid: 42, sessionId: SESSION, taskId: TASK, cwd: root, accountFingerprint: ACCOUNT }),
    listSessions: () => state.sessions,
    readInbound: () => ({ value: state.inbound, source: "user" }),
    assertCwd: (session, expected) => { if (session.cwd !== expected) throw new Error("cwd mismatch"); },
    createPeer: () => (state.peers += 1, {
      start: async () => {},
      stop: () => { state.stopped += 1; },
      send: async (socket, text, options) => {
        await options.beforeSend?.();
        if (state.sendError) throw state.sendError;
        state.sends.push({ socket, text, options });
        return options.msgId;
      },
    }),
    peerLingerMs: 0,
    ...overrides,
  });
  const enqueue = (message = "Queued brief", recipient = {}) => store.enqueue({
    message,
    sender: { threadId: "01a00000-0000-7000-8000-000000000001", turnId: "turn-1", cwd: root, accountFingerprint: CODEX_ACCOUNT },
    recipient: { taskId: TASK, title: "Target", cwd: root, accountFingerprint: ACCOUNT, ...recipient },
  });
  return { root, clock, store, state, drain, enqueue };
}

test("queued delivery is off in hardened mode and through its opt-out", () => {
  assert.equal(queuedDeliveryEnabled({}), true);
  assert.equal(queuedDeliveryEnabled({ CLAUDE_BRIDGE_QUEUED_DELIVERY: "0" }), false);
  assert.equal(queuedDeliveryEnabled({ CODEX_BRIDGE_HARDENED: "1" }), false);
});

test("a retried enqueue returns the same entry and never exposes the body in a receipt", (t) => {
  const { enqueue } = harness(t);
  const first = enqueue();
  const second = enqueue();
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.entry.id, first.entry.id);
  const receipt = publicQueueReceipt(first.entry);
  assert.equal(receipt.status, "queued");
  assert.equal(receipt.sent, false);
  assert.equal(receipt.message, undefined);
  assert.equal(receipt.dedupeKey, undefined);
});

test("enqueue enforces the size and per-recipient limits", (t) => {
  const { enqueue } = harness(t);
  assert.throws(() => enqueue("x".repeat(QUEUE_LIMITS.maxMessageBytes + 1)), { code: "CLAUDE_QUEUE_MESSAGE_TOO_LARGE", sent: false });
  for (let index = 0; index < QUEUE_LIMITS.maxActivePerRecipient; index += 1) enqueue(`brief ${index}`);
  assert.throws(() => enqueue("one too many"), { code: "CLAUDE_QUEUE_FULL", sent: false });
});

test("the queue directory and entries are private", { skip: process.platform === "win32" }, (t) => {
  const { store, enqueue } = harness(t);
  const { entry } = enqueue();
  assert.equal(fs.statSync(store.root).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(store.root, `${entry.id}.json`)).mode & 0o077, 0);
});

test("the recipient's own session delivers once, in order, with no sender class", async (t) => {
  const { store, state, drain, enqueue, clock } = harness(t);
  const first = enqueue("first").entry;
  clock.now += 1;
  const second = enqueue("second").entry;
  await drain.tick();
  assert.equal(state.sends.length, 1);
  assert.match(state.sends[0].text, /^first/);
  assert.equal(state.sends[0].options.permissionMode, null);
  assert.equal(buildFrame({ text: "x", fromSocket: "/tmp/a.sock", permissionMode: state.sends[0].options.permissionMode }).message.content.includes("from-mode"), false);
  const sent = store.read(first.id);
  assert.equal(sent.state, QUEUE_STATES.sentUnconfirmed);
  assert.equal(sent.message, undefined);
  assert.equal(sent.msgId, state.sends[0].options.msgId);
  await drain.tick();
  assert.deepEqual(state.sends.map((send) => send.text.split("\n")[0]), ["first", "second"]);
  assert.equal(store.read(second.id).state, QUEUE_STATES.sentUnconfirmed);
});

test("the delivered text says it is queued, stale-prone, from an agent, and how to answer", (t) => {
  const { enqueue } = harness(t);
  const text = queuedDeliveryText(enqueue("brief").entry);
  assert.match(text, /not the user/);
  assert.match(text, /may be stale/);
  assert.match(text, /send_to_codex_thread/);
});

test("a recipient that no longer accepts inbound messages gets nothing", async (t) => {
  for (const inbound of ["hold", "refuse", null]) {
    const { store, state, drain, enqueue } = harness(t);
    const { entry } = enqueue();
    state.inbound = inbound;
    await drain.tick();
    assert.equal(state.sends.length, 0);
    const refused = store.read(entry.id);
    assert.equal(refused.state, QUEUE_STATES.refused);
    assert.equal(refused.reasonCode, "CLAUDE_RECIPIENT_INBOUND_POLICY");
    assert.equal(refused.message, undefined);
  }
});

test("another session, account or unverified caller leaves the entry queued", async (t) => {
  const other = harness(t);
  const foreign = other.enqueue("other task", { taskId: "local_00000000-0000-4000-8000-000000000002" }).entry;
  await other.drain.tick();
  assert.equal(other.state.sends.length, 0);
  assert.equal(other.store.read(foreign.id).state, QUEUE_STATES.queued);

  const account = harness(t);
  const otherAccount = account.enqueue("other account", { accountFingerprint: "c".repeat(64) }).entry;
  await account.drain.tick();
  assert.equal(account.state.sends.length, 0);
  assert.equal(account.store.read(otherAccount.id).state, QUEUE_STATES.queued);

  const shared = harness(t);
  const { entry } = shared.enqueue();
  shared.state.senderStatus = "unavailable";
  await shared.drain.tick();
  assert.equal(shared.state.sends.length, 0);
  assert.equal(shared.store.read(entry.id).state, QUEUE_STATES.queued);
});

test("a task now running in another directory is refused, not redirected", async (t) => {
  const { store, state, drain, enqueue } = harness(t);
  const { entry } = enqueue("brief", { cwd: "/somewhere/else" });
  await drain.tick();
  assert.equal(state.sends.length, 0);
  assert.equal(store.read(entry.id).reasonCode, "CLAUDE_SESSION_CWD_MISMATCH");
});

test("a failure before the write stays queued; a failure during the write is never resent", async (t) => {
  const before = harness(t);
  const pending = before.enqueue().entry;
  before.state.sendError = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
  await before.drain.tick();
  assert.equal(before.store.read(pending.id).state, QUEUE_STATES.queued);
  before.state.sendError = null;
  await before.drain.tick();
  assert.equal(before.state.sends.length, 1);

  const during = harness(t);
  const uncertain = during.enqueue().entry;
  during.state.sendError = Object.assign(new Error("reset"), { code: "ECONNRESET", deliveryUncertain: true });
  await during.drain.tick();
  assert.equal(during.store.read(uncertain.id).state, QUEUE_STATES.unknown);
  during.state.sendError = null;
  await during.drain.tick();
  assert.equal(during.state.sends.length, 0);
});

test("a held claim blocks a second drainer and a dead dispatch becomes unknown", async (t) => {
  const { store, state, drain, enqueue, clock } = harness(t);
  const { entry } = enqueue();
  assert.equal(store.claim(entry.id), true);
  await drain.tick();
  assert.equal(state.sends.length, 0);
  store.update(store.read(entry.id), { state: QUEUE_STATES.dispatching });
  clock.now += 6 * 60 * 1000;
  store.sweep();
  assert.equal(store.read(entry.id).state, QUEUE_STATES.unknown);
  assert.equal(store.claim(entry.id), true);
});

test("expired entries are never delivered and terminal entries are pruned", async (t) => {
  const { store, state, drain, enqueue, clock } = harness(t);
  const { entry } = enqueue();
  clock.now += QUEUE_LIMITS.ttlMs + 1;
  await drain.tick();
  assert.equal(state.sends.length, 0);
  const expired = store.read(entry.id);
  assert.equal(expired.state, QUEUE_STATES.expired);
  assert.equal(expired.message, undefined);
  clock.now += QUEUE_LIMITS.terminalRetentionMs + 1;
  store.sweep();
  assert.equal(store.read(entry.id), null);
});

test("malformed, foreign-named and symlinked files in the queue are ignored", { skip: process.platform === "win32" }, (t) => {
  const { store, enqueue, root } = harness(t);
  const { entry } = enqueue();
  fs.writeFileSync(path.join(store.root, "00000000-0000-4000-8000-000000000009.json"), "{not json", { mode: 0o600 });
  const outside = path.join(root, "outside.json");
  fs.writeFileSync(outside, JSON.stringify({ ...store.read(entry.id), id: "00000000-0000-4000-8000-00000000000a" }));
  fs.symlinkSync(outside, path.join(store.root, "00000000-0000-4000-8000-00000000000a.json"));
  fs.writeFileSync(path.join(store.root, "00000000-0000-4000-8000-00000000000b.json"), JSON.stringify({ ...store.read(entry.id), id: "other" }), { mode: 0o600 });
  assert.deepEqual(store.pending().map((candidate) => candidate.id), [entry.id]);
  assert.equal(store.read("../outside"), null);
});

test("a failed state write after the socket write is never sent again", async (t) => {
  const { store, state, drain, enqueue, clock } = harness(t);
  const { entry } = enqueue();
  const realTransition = store.transition;
  let failures = 1;
  store.transition = (target, from, patch) => {
    if (patch.state === QUEUE_STATES.sentUnconfirmed && failures-- > 0) throw Object.assign(new Error("rename failed"), { code: "EPERM" });
    return realTransition(target, from, patch);
  };
  await drain.tick();
  await drain.tick();
  assert.equal(state.sends.length, 1);
  assert.equal(store.read(entry.id).state, QUEUE_STATES.dispatching);
  clock.now += 6 * 60 * 1000;
  store.sweep();
  assert.equal(store.read(entry.id).state, QUEUE_STATES.unknown);
  await drain.tick();
  assert.equal(state.sends.length, 1);
});

test("a changed Codex account leaves the entry queued", async (t) => {
  const { store, state, drain, enqueue } = harness(t);
  const { entry } = enqueue();
  state.codexAccount = "d".repeat(64);
  await drain.tick();
  assert.equal(state.sends.length, 0);
  assert.equal(store.read(entry.id).state, QUEUE_STATES.queued);
});

test("the next entry waits for a reply to the previous one, then for the timeout", async (t) => {
  const { state, drain, enqueue, clock } = harness(t);
  enqueue("first");
  clock.now += 1;
  enqueue("second");
  state.outcome = null;
  await drain.tick();
  await drain.tick();
  assert.equal(state.sends.length, 1);
  clock.now += 31 * 60 * 1000;
  await drain.tick();
  assert.equal(state.sends.length, 2);
});

test("a worker that cannot verify itself backs off and a foreign entry costs no identity reads", async (t) => {
  const shared = harness(t);
  shared.enqueue();
  shared.state.senderStatus = "unavailable";
  await shared.drain.tick();
  await shared.drain.tick();
  assert.equal(shared.state.senderReads, 1);

  const other = harness(t);
  other.enqueue("other", { taskId: "local_00000000-0000-4000-8000-000000000002" });
  await other.drain.tick();
  const reads = other.state.senderReads;
  await other.drain.tick();
  await other.drain.tick();
  assert.equal(other.state.senderReads, reads);
});

test("repeated send failures end the entry and reuse one peer", async (t) => {
  const { store, state, drain, enqueue } = harness(t);
  const { entry } = enqueue();
  state.sendError = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
  for (let attempt = 0; attempt < 8; attempt += 1) await drain.tick();
  assert.equal(store.read(entry.id).state, QUEUE_STATES.refused);
  assert.equal(store.read(entry.id).reasonCode, "CLAUDE_QUEUE_SEND_FAILED");
  assert.equal(state.peers, 1);
});

test("a stale claim on a waiting entry and old temp files are cleaned", (t) => {
  const { store, enqueue, clock } = harness(t);
  clock.now = Date.now();
  const { entry } = enqueue();
  assert.equal(store.claim(entry.id), true);
  const stale = path.join(store.root, `${entry.id}.json.1.abcd.tmp`);
  fs.writeFileSync(stale, "body");
  clock.now = Date.now() + 2 * 60 * 60 * 1000;
  store.sweep();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(store.claim(entry.id), true);
});

test("a dispatcher whose entry was already settled does not restore it", (t) => {
  const { store, enqueue, clock } = harness(t);
  const { entry } = enqueue();
  const dispatching = store.update(entry, { state: QUEUE_STATES.dispatching });
  clock.now += 6 * 60 * 1000;
  store.sweep();
  assert.equal(store.transition(dispatching, QUEUE_STATES.dispatching, { state: QUEUE_STATES.sentUnconfirmed }), null);
  assert.equal(store.read(entry.id).state, QUEUE_STATES.unknown);
  assert.equal(store.read(entry.id).message, undefined);
});

test("peek reports settled states without changing the file", (t) => {
  const { store, enqueue, clock } = harness(t);
  const { entry } = enqueue();
  clock.now += QUEUE_LIMITS.ttlMs + 1;
  const seen = store.peek(entry.id);
  assert.equal(seen.state, QUEUE_STATES.expired);
  assert.equal(seen.message, undefined);
  assert.equal(store.read(entry.id).state, QUEUE_STATES.queued);
});

test("a message that only exceeds the entry limit once encoded is refused up front", (t) => {
  const { enqueue } = harness(t);
  assert.throws(() => enqueue("\u0001".repeat(QUEUE_LIMITS.maxMessageBytes)), { code: "CLAUDE_QUEUE_MESSAGE_TOO_LARGE" });
});

test("a retried text after dispatch stays deduped; a refused one can be queued again", async (t) => {
  const { state, drain, enqueue } = harness(t);
  const first = enqueue("same").entry;
  await drain.tick();
  assert.equal(enqueue("same").entry.id, first.id);
  const other = harness(t);
  const refused = other.enqueue("same").entry;
  other.state.inbound = "refuse";
  await other.drain.tick();
  assert.notEqual(other.enqueue("same").entry.id, refused.id);
  assert.equal(state.sends.length, 1);
});

test("a symlinked queue root is ignored", { skip: process.platform === "win32" }, (t) => {
  const { store, enqueue, root } = harness(t);
  enqueue();
  const moved = path.join(root, "moved");
  fs.renameSync(store.root, moved);
  fs.symlinkSync(moved, store.root);
  assert.deepEqual(store.pending(), []);
  assert.throws(() => enqueue("new"), /private directory/);
});

test("project policy changes during the wait refuse the message instead of delivering it", async (t) => {
  let allowed = true;
  const h = harness(t, { assertScope: () => { if (!allowed) throw new Error("revoked"); } });
  const first = h.enqueue("Authorized brief").entry;
  await h.drain.tick();
  assert.equal(h.state.sends.length, 1);
  assert.equal(h.store.peek(first.id).state, QUEUE_STATES.sentUnconfirmed);
  allowed = false;
  h.state.outcome = { status: "interrupted" };
  const second = h.enqueue("Revoked brief").entry;
  await h.drain.tick();
  assert.equal(h.state.sends.length, 1);
  const settled = h.store.peek(second.id);
  assert.equal(settled.state, QUEUE_STATES.refused);
  assert.equal(settled.reasonCode, "CLAUDE_QUEUE_SCOPE_REVOKED");
});

test("a grant revoked between the claim and the socket write is not sent", async (t) => {
  let checks = 0;
  const h = harness(t, { assertScope: () => { if (++checks > 1) throw new Error("revoked"); } });
  const { entry } = h.enqueue("Racing brief");
  await h.drain.tick();
  assert.equal(h.state.sends.length, 0);
  assert.equal(h.store.peek(entry.id).state, QUEUE_STATES.refused);
  assert.equal(h.store.peek(entry.id).reasonCode, "CLAUDE_QUEUE_SCOPE_REVOKED");
});
