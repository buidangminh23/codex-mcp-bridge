import assert from "node:assert/strict";
import { it } from "node:test";
import { accountIdentity, assertAccountIdentity, bindUnsolicitedClaudeMessageAccount, requireBridgeAccounts, sameAccountIdentity } from "../src/bridge-account-context.mjs";
import { ReplyForwarder } from "../src/reply-forwarder.mjs";
import { PeerEndpoint } from "../src/peer-protocol.mjs";

const signedIn = (claude = "claude-a", codex = "codex-a") => ({
  claude: { status: "verified", fingerprint: claude },
  codex: { status: "verified", fingerprint: codex },
});

it("rechecks both identities for every call across repeated account switches", () => {
  for (const accounts of [signedIn(), signedIn("claude-b"), signedIn("claude-b", "codex-b"), signedIn()]) {
    const identity = requireBridgeAccounts(accounts);
    assert.equal(sameAccountIdentity(identity, accounts), true);
    assert.doesNotThrow(() => assertAccountIdentity(identity, accounts));
  }
});

it("refuses signed-out and incomplete sign-in states without claiming a dispatch", () => {
  for (const provider of ["claude", "codex"]) {
    for (const status of ["signed_out", "unavailable", "ambiguous", "verified"]) {
      const accounts = { ...signedIn(), [provider]: { status } };
      assert.equal(accountIdentity(accounts), null);
      assert.throws(() => requireBridgeAccounts(accounts), (error) => error.preflight.sent === false && error.preflight.code === "BRIDGE_ACCOUNT_UNVERIFIED");
    }
  }
});

it("keeps a late reply attached to its original accounts and never forwards it to the new account", async () => {
  let current = signedIn();
  let run;
  let dispatched = 0;
  const forwarder = new ReplyForwarder({
    schedule(callback) { run = callback; return 1; },
    cancel() {},
    beforeForward(record) { assertAccountIdentity(record.accountContext, current); },
    async deliver() { dispatched += 1; },
  });
  forwarder.enqueue({ msgId: "original", text: "Old account reply", accountContext: accountIdentity(current) }, "original-task");
  current = signedIn("claude-b", "codex-b");
  run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched, 0);
  assert.equal(forwarder.read("original").reasonCode, "BRIDGE_ACCOUNT_CHANGED");
  assert.equal(forwarder.read("original").threadId, "original-task");
  assert.equal(forwarder.read("original").status, "failed");
  current = signedIn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched, 0);
  forwarder.close();
});

function unsolicitedFixture() {
  let current = signedIn();
  const record = { msgId: "unsolicited", fromSocket: "exact-peer-socket", text: "Claude initiated greeting" };
  const session = { pid: 101, sessionId: "exact-cli", entrypoint: "claude-desktop", alive: true, socket: record.fromSocket };
  const checked = [];
  const options = {
    readAccounts: () => current,
    listSessions: () => [session],
    assertProcess: (candidate) => { assert.equal(candidate, session); checked.push(candidate); },
    readContext: (candidate, account) => {
      assert.equal(candidate, session);
      assert.equal(account, current.claude);
      return { status: "matched", taskId: "native-task", accountFingerprint: account.fingerprint };
    },
  };
  return { record, session, options, checked, activate(accounts) { current = accounts; } };
}

it("attributes an unsolicited message once at receipt and exposes it only to its original accounts", () => {
  const f = unsolicitedFixture();
  assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, f.options), true);
  assert.equal(f.checked.length, 1);
  assert.deepEqual(f.record.accountContext, accountIdentity(signedIn()));
  assert.equal(Object.isFrozen(f.record.accountContext), true);
  assert.equal(f.record.replyThreadId, undefined);
  const peer = new PeerEndpoint();
  peer.inbox.push(f.record);
  f.activate(signedIn("claude-b", "codex-b"));
  assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, f.options), false);
  assert.deepEqual(peer.drainInbox(20, (message) => sameAccountIdentity(message.accountContext, signedIn("claude-b", "codex-b"))), []);
  assert.equal(peer.inbox.length, 1);
  f.activate(signedIn());
  assert.deepEqual(peer.drainInbox(20, (message) => sameAccountIdentity(message.accountContext, signedIn())), [f.record]);
});

it("preserves correlated reply account identity without inspecting or rebinding it", () => {
  for (const values of [{ accountContext: accountIdentity(signedIn()) }, { inReplyTo: "original-message" }, { accountContext: null, inReplyTo: "unbound-original" }]) {
    const record = { fromSocket: "exact-peer-socket", ...values };
    const original = { ...record };
    assert.equal(bindUnsolicitedClaudeMessageAccount(record, { readAccounts: () => assert.fail("must preserve original correlation") }), false);
    assert.deepEqual(record, original);
  }
});

it("does not mislabel an uncorrelated peer frame from a pending Desktop request as unsolicited", () => {
  const f = unsolicitedFixture();
  assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, {
    ...f.options,
    hasPendingSource: (socket) => { assert.equal(socket, f.record.fromSocket); return true; },
    readAccounts: () => assert.fail("must not infer another account for a pending source"),
  }), false);
  assert.equal(f.record.accountContext, undefined);
  assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, f.options), false);
  assert.equal(f.record.accountContext, undefined);
});

it("does not bind unknown, dead, CLI, ambiguous, or merely similar sender sockets", () => {
  const fixtures = [
    (session) => [],
    (session) => [{ ...session, alive: false }],
    (session) => [{ ...session, entrypoint: "cli" }],
    (session) => [session, { ...session, pid: 102, sessionId: "second-cli" }],
    (session) => [session, { ...session, pid: 102, entrypoint: "cli" }],
    (session) => [{ ...session, socket: session.socket + "-other" }],
  ];
  for (const candidates of fixtures) {
    const f = unsolicitedFixture();
    assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, { ...f.options, listSessions: () => candidates(f.session) }), false);
    assert.equal(f.record.accountContext, undefined);
    assert.equal(f.checked.length, 0);
  }
});

it("does not attribute messages with stale process identity or another account's task metadata", () => {
  for (const override of [
    { assertProcess: () => { throw new Error("process identity changed"); } },
    { readContext: () => ({ status: "missing" }) },
    { readContext: () => ({ status: "ambiguous" }) },
    { readContext: () => ({ status: "matched", accountFingerprint: "claude-other" }) },
    { readContext: () => ({ status: "matched" }) },
    { readContext: () => { throw new Error("metadata changed"); } },
  ]) {
    const f = unsolicitedFixture();
    assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, { ...f.options, ...override }), false);
    assert.equal(f.record.accountContext, undefined);
  }
});

it("rechecks both accounts after metadata inspection and never retroactively rebinds a rejected message", () => {
  for (const provider of ["claude", "codex"]) {
    const f = unsolicitedFixture();
    const original = signedIn();
    const changed = { ...original, [provider]: { status: "verified", fingerprint: "changed" } };
    assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, { ...f.options, readContext: () => {
      f.activate(changed);
      return { status: "matched", accountFingerprint: original.claude.fingerprint };
    } }), false);
    assert.equal(f.record.accountContext, undefined);
    f.activate(original);
    assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, f.options), false);
    assert.equal(f.record.accountContext, undefined);
  }
});

it("refuses unverified receipt-time accounts and limits candidate inspection", () => {
  for (const status of ["signed_out", "unavailable", "ambiguous"]) {
    const f = unsolicitedFixture();
    f.activate({ ...signedIn(), claude: { status } });
    assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, { ...f.options, listSessions: () => assert.fail("must not inspect unbound accounts") }), false);
    f.activate(signedIn());
    assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, f.options), false);
    assert.equal(f.record.accountContext, undefined);
  }
  const f = unsolicitedFixture();
  assert.equal(bindUnsolicitedClaudeMessageAccount(f.record, { ...f.options, listSessions: () => Array(8193).fill(f.session) }), false);
  assert.equal(f.checked.length, 0);
});
