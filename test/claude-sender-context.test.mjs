import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertClaudeSenderContext, readClaudeSenderContext, requireClaudeSenderContext } from "../src/claude-sender-context.mjs";

const accountA = { status: "verified", accountId: "account-a", fingerprint: "a".repeat(64) };
const accountB = { status: "verified", accountId: "account-b", fingerprint: "b".repeat(64) };

function fixture() {
  const ancestry = [{ pid: 200, parentPid: 100, processStart: "caller-start" }, { pid: 100, parentPid: 0, processStart: "desktop-start" }];
  const session = { pid: 200, entrypoint: "claude-desktop", alive: true, sessionId: "session-a", cwd: "/project", processStart: "caller-start", ownerAccount: "account-a" };
  const sessions = [session];
  return {
    ancestry, session, sessions,
    options: {
      account: accountA, parentPid: 200, readAncestry: async () => ancestry, listSessions: () => sessions,
      readContext: (current, { account }) => current.ownerAccount === account.accountId
        ? { status: "matched", taskId: `task-${current.sessionId}`, cwd: current.cwd }
        : { status: "missing" },
    },
  };
}

describe("Claude Desktop caller account and process binding", () => {
  it("keeps an old live caller out of a switched account and permits the new account's caller", async () => {
    const f = fixture();
    const original = requireClaudeSenderContext(await readClaudeSenderContext(f.options));
    assert.equal(original.sessionId, "session-a");
    assert.equal((await readClaudeSenderContext({ ...f.options, account: accountB })).status, "unavailable");
    await assert.rejects(assertClaudeSenderContext(original, { ...f.options, account: accountB }), /currently signed-in account/);
    f.session.ownerAccount = "account-b";
    f.session.sessionId = "session-b";
    f.session.pid = 201;
    f.ancestry[0].pid = 201;
    const current = await readClaudeSenderContext({ ...f.options, account: accountB, parentPid: 201 });
    assert.equal(current.status, "verified");
    assert.equal(current.sessionId, "session-b");
    assert.equal(current.accountFingerprint, accountB.fingerprint);
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
  });

  it("requires a registered Code session and refuses generic Desktop or unrelated process callers", async () => {
    const f = fixture();
    f.sessions.length = 0;
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.sessions.push({ ...f.session, entrypoint: "cli" });
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.sessions[0] = { ...f.session, pid: 999 };
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
  });

  it("rejects ambiguous ancestors, broken lineage and ancestry beyond the read limit", async () => {
    const f = fixture();
    f.sessions.push({ ...f.session, pid: 100 });
    assert.equal((await readClaudeSenderContext(f.options)).status, "ambiguous");
    f.sessions.pop();
    f.ancestry[1].pid = 99;
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.ancestry[1].pid = 100;
    f.ancestry.push(...Array.from({ length: 7 }, () => ({ pid: 1, parentPid: 0, processStart: "x" })));
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
  });

  it("captures OS process identity when the registry omits it and catches later process replacement", async () => {
    const f = fixture();
    delete f.session.processStart;
    const original = requireClaudeSenderContext(await readClaudeSenderContext(f.options));
    assert.equal(original.processStart, "caller-start");
    f.ancestry[0].processStart = "replacement-start";
    await assert.rejects(assertClaudeSenderContext(original, f.options), /changed while this operation/);
  });

  it("rejects stale registered process identity, signout and process inspection errors", async () => {
    const f = fixture();
    f.session.processStart = "old-start";
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.session.processStart = "caller-start";
    assert.equal((await readClaudeSenderContext({ ...f.options, account: { status: "signed_out" } })).status, "unavailable");
    assert.equal((await readClaudeSenderContext({ ...f.options, readAncestry: async () => { throw new Error("OS unavailable"); } })).status, "unavailable");
  });

  it("rechecks the exact caller task and workspace before a later dispatch", async () => {
    const f = fixture();
    const original = requireClaudeSenderContext(await readClaudeSenderContext(f.options));
    f.session.cwd = "/another-project";
    await assert.rejects(assertClaudeSenderContext(original, f.options), /changed while this operation/);
    f.session.cwd = "/project";
    f.session.sessionId = "replacement-session";
    await assert.rejects(assertClaudeSenderContext(original, f.options), /changed while this operation/);
  });
});
