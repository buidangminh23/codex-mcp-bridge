import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { resolveClaudeDesktopSession } from "../src/claude-session-router.mjs";

const project = fs.mkdtempSync(path.join(os.tmpdir(), "claude-router-"));
const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), "claude-router-other-"));
after(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(otherProject, { recursive: true, force: true });
});

function fixture() {
  const sessions = [
    { pid: 101, sessionId: "cli-a", name: "same-project", cwd: project, entrypoint: "claude-desktop", alive: true, socket: "pipe-a" },
    { pid: 102, sessionId: "cli-b", name: "same-project", cwd: project, entrypoint: "claude-desktop", alive: true, socket: "pipe-b" },
  ];
  const records = new Map([
    ["cli-a", { accountId: "account-a", taskId: "task-a", status: "matched", title: "Task A", cwd: project }],
    ["cli-b", { accountId: "account-b", taskId: "task-b", status: "matched", title: "Task B", cwd: project }],
  ]);
  const readContext = (session, account) => records.get(session.sessionId)?.accountId === account.accountId
    ? records.get(session.sessionId)
    : { status: "missing", reason: "No exact task in the current account." };
  const args = { target: "auto", expectedCwd: project, sessions, account: { status: "verified", accountId: "account-a" }, readContext };
  return { args, records, sessions };
}

function blocked(callback, code) {
  assert.throws(callback, (error) => {
    assert.equal(error.preflight?.code, code);
    assert.equal(error.preflight?.status, "blocked");
    assert.equal(error.preflight?.sent, false);
    return true;
  });
}

describe("Claude Desktop session rediscovery", () => {
  it("follows A to B to A without reusing the other account's lingering process", () => {
    const { args } = fixture();
    for (const accountId of ["account-a", "account-b", "account-a", "account-b", "account-a"]) {
      const session = resolveClaudeDesktopSession({ ...args, account: { status: "verified", accountId } });
      assert.equal(session.sessionId, accountId === "account-a" ? "cli-a" : "cli-b");
      assert.equal(session.desktop.accountId, accountId);
    }
  });

  it("does not redirect an explicit live target belonging to another account", () => {
    const { args } = fixture();
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "cli-b", expectedTaskId: "task-a" }), "CLAUDE_DESKTOP_TASK_UNVERIFIED");
  });

  it("does not redirect an explicit target whose native task changed", () => {
    const { args } = fixture();
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "cli-a", expectedTaskId: "task-b" }), "CLAUDE_DESKTOP_TASK_MISMATCH");
  });

  it("requires a native task ID for explicit selection", () => {
    const { args } = fixture();
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "cli-a" }), "CLAUDE_DESKTOP_TASK_MISMATCH");
  });

  it("rediscovers a restarted CLI only for the same native task and current account", () => {
    const { args, records, sessions } = fixture();
    sessions[0] = { ...sessions[0], pid: 201, sessionId: "cli-a-restarted", socket: "pipe-restarted" };
    records.set("cli-a-restarted", records.get("cli-a"));
    records.delete("cli-a");
    const session = resolveClaudeDesktopSession({ ...args, target: "cli-a", expectedTaskId: "task-a" });
    assert.equal(session.sessionId, "cli-a-restarted");
    assert.equal(session.desktop.taskId, "task-a");
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "cli-a", expectedTaskId: "task-b" }), "CLAUDE_SESSION_NOT_FOUND");
  });

  it("does not select a newest or similarly named task when auto is ambiguous", () => {
    const { args, sessions, records } = fixture();
    sessions.push({ ...sessions[0], pid: 103, sessionId: "cli-c", name: "newest", startedAt: Date.now() });
    records.set("cli-c", { ...records.get("cli-a"), taskId: "task-c" });
    blocked(() => resolveClaudeDesktopSession(args), "CLAUDE_SESSION_AMBIGUOUS");
    assert.equal(resolveClaudeDesktopSession({ ...args, expectedTaskId: "task-a" }).sessionId, "cli-a");
  });

  it("blocks duplicate live instances of one native task", () => {
    const { args, sessions, records } = fixture();
    sessions.push({ ...sessions[0], pid: 103, sessionId: "cli-c" });
    records.set("cli-c", records.get("cli-a"));
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "vanished-cli", expectedTaskId: "task-a" }), "CLAUDE_SESSION_AMBIGUOUS");
  });

  it("checks the canonical project directory and never redirects a wrong-cwd exact target", () => {
    const { args } = fixture();
    assert.equal(resolveClaudeDesktopSession({ ...args, expectedCwd: path.join(project, ".") }).sessionId, "cli-a");
    blocked(() => resolveClaudeDesktopSession({ ...args, expectedCwd: otherProject }), "CLAUDE_SESSION_NOT_FOUND");
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "cli-a", expectedCwd: otherProject, expectedTaskId: "task-a" }), "CLAUDE_SESSION_CWD_MISMATCH");
    for (const expectedCwd of [undefined, "relative", path.join(project, "missing")]) {
      blocked(() => resolveClaudeDesktopSession({ ...args, expectedCwd }), "CLAUDE_SESSION_CWD_MISMATCH");
    }
  });

  it("blocks signed-out, unavailable, ambiguous, and missing account state before context reads", () => {
    const { args } = fixture();
    for (const status of ["signed_out", "unavailable", "ambiguous", undefined]) {
      blocked(() => resolveClaudeDesktopSession({ ...args, account: { status }, readContext: () => assert.fail("must not inspect tasks") }), "CLAUDE_ACCOUNT_UNVERIFIED");
    }
  });

  it("ignores dead and CLI-only candidates but rejects an exact live CLI target", () => {
    const { args, sessions } = fixture();
    sessions[0].alive = false;
    sessions.push({ ...sessions[0], pid: 103, alive: true, entrypoint: "cli", sessionId: "standalone-cli" });
    blocked(() => resolveClaudeDesktopSession(args), "CLAUDE_SESSION_NOT_FOUND");
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "standalone-cli", expectedTaskId: "task-a" }), "CLAUDE_DESKTOP_TASK_UNVERIFIED");
  });

  it("retains exact PID/sessionId/name selection without fuzzy matches", () => {
    const { args, sessions } = fixture();
    sessions[0].name = "Unique task";
    for (const target of ["cli-a", "101", 101, "Unique task"]) {
      assert.equal(resolveClaudeDesktopSession({ ...args, target, expectedTaskId: "task-a" }).sessionId, "cli-a");
    }
    sessions[1].name = "Unique task";
    blocked(() => resolveClaudeDesktopSession({ ...args, target: "Unique task", expectedTaskId: "task-a" }), "CLAUDE_SESSION_AMBIGUOUS");
  });

  it("does not accumulate candidates or mutate session rows across repeated inspection", () => {
    const { args, sessions } = fixture();
    sessions.push({ ...sessions[0] });
    const before = structuredClone(sessions);
    for (let index = 0; index < 20; index++) {
      assert.equal(resolveClaudeDesktopSession(args).sessionId, "cli-a");
    }
    assert.deepEqual(sessions, before);
    assert.equal(sessions[0].desktop, undefined);
  });

  it("blocks unreadable Desktop context and malformed task selectors", () => {
    const { args } = fixture();
    blocked(() => resolveClaudeDesktopSession({ ...args, readContext: () => { throw new Error("changed metadata"); } }), "CLAUDE_DESKTOP_TASK_UNVERIFIED");
    for (const expectedTaskId of [null, "", " ", 101]) {
      blocked(() => resolveClaudeDesktopSession({ ...args, expectedTaskId }), "CLAUDE_DESKTOP_TASK_MISMATCH");
    }
  });
});
