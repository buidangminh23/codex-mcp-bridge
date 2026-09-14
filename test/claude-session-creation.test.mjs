import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { ClaudeSessionCreation } from "../src/claude-session-creation.mjs";

const id = "c264a6f1-0945-47b1-b3c1-810bf4f33312";
const secondId = "c264a6f1-0945-47b1-b3c1-810bf4f33313";
const account = { status: "verified", fingerprint: "account-a", root: "/accounts/a" };
const args = { requestId: id, cwd: "/project", prompt: "Reply with the verification code.", account, senderThreadId: "sender-a" };

function fixture(overrides = {}) {
  const state = { account, tasks: [{ taskId: "old-task", cliSessionId: "old-cli", cwd: "/project", isArchived: false }], sessions: [], messages: [], opened: [], processValid: true };
  const dependencies = {
    open: async (url) => state.opened.push(url),
    listTasks: async () => state.tasks,
    listSessions: async () => state.sessions,
    readContext: async (session) => ({ status: "matched", taskId: session.taskId, cwd: session.cwd, title: "New native task", accountFingerprint: state.account.fingerprint }),
    readTranscript: async () => ({ messages: state.messages }),
    readAccount: async () => state.account,
    assertProcess: async () => { if (!state.processValid) throw new Error("Changed process"); },
    realpath: async (directory) => { if (directory === "/missing") throw new Error("Missing"); return path.posix.normalize(directory); },
    platform: "linux",
    ...overrides,
  };
  const creation = new ClaudeSessionCreation(dependencies);
  const connect = (taskId = "new-task", sessionId = "new-cli") => {
    state.sessions.push({ taskId, sessionId, alive: true, entrypoint: "claude-desktop", cwd: "/project" });
    state.messages = [{ role: "user", text: `${args.prompt}\n\n[Codex creation request: ${id}]` }];
  };
  return { creation, state, dependencies, connect };
}

async function blocked(promise, code) {
  await assert.rejects(promise, (error) => error.code === code);
}

describe("Claude native new session lifecycle", () => {
  it("opens only a prefilled native URI and awaits a real user submission", async () => {
    const { creation, state } = fixture();
    const result = await creation.start(args);
    assert.equal(result.status, "awaiting_user");
    assert.equal(result.promptSubmitted, false);
    const url = new URL(state.opened[0]);
    assert.equal(url.protocol, "claude:");
    assert.equal(url.host, "code");
    assert.equal(url.pathname, "/new");
    assert.equal(url.searchParams.get("folder"), "/project");
    assert.equal(url.searchParams.get("q"), `${args.prompt}\n\n[Codex creation request: ${id}]`);
    assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
  });

  it("requires a new live native task with the exact first user message", async () => {
    const { creation, connect } = fixture();
    await creation.start(args);
    connect();
    const result = await creation.inspect(id, args);
    assert.equal(result.status, "created");
    assert.equal(result.promptSubmitted, true);
    assert.equal(result.sessionId, "new-cli");
    assert.equal(result.taskId, "new-task");
    assert.equal(result.title, "New native task");
  });

  it("rejects reopened old tasks including archived and previously disconnected tasks", async () => {
    const { creation, state, connect } = fixture();
    state.tasks.push({ taskId: "archived-task", cwd: "/other", isArchived: true });
    await creation.start(args);
    connect("old-task", "restarted-cli");
    connect("archived-task", "another-cli");
    assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
  });

  it("does not accept assistant echoes, substring matches, or a later user message", async () => {
    const { creation, state, connect } = fixture();
    await creation.start(args);
    connect();
    const exact = state.messages[0];
    for (const messages of [[{ ...exact, role: "assistant" }], [{ ...exact, text: `${exact.text} extra` }], [{ role: "user", text: "Unrelated first request" }, exact]]) {
      state.messages = messages;
      assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
    }
  });

  it("requires verified process, cwd, native entrypoint, and matching metadata", async () => {
    const { creation, state, connect } = fixture();
    await creation.start(args);
    connect();
    state.processValid = false;
    assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
    state.processValid = true;
    state.sessions[0].cwd = "/other";
    assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
    state.sessions[0].cwd = "/project";
    state.sessions[0].entrypoint = "cli";
    assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
  });

  it("refuses account and sender changes without launching or resolving", async () => {
    const { creation, state, connect } = fixture();
    await creation.start(args);
    connect();
    await blocked(creation.inspect(id, { ...args, senderThreadId: "other-sender" }), "CLAUDE_CREATION_SENDER_MISMATCH");
    state.account = { ...account, fingerprint: "account-b" };
    await blocked(creation.inspect(id, args), "CLAUDE_CREATION_ACCOUNT_CHANGED");
    await blocked(creation.start({ ...args, requestId: secondId }), "CLAUDE_CREATION_ACCOUNT_CHANGED");
    assert.equal(state.opened.length, 1);
  });

  it("reuses identical request receipts and serializes simultaneous calls", async () => {
    const { creation, state } = fixture();
    const [first, second] = await Promise.all([creation.start(args), creation.start({ ...args, cwd: "/project/." })]);
    assert.deepEqual(first, second);
    assert.equal(state.opened.length, 1);
    await blocked(creation.start({ ...args, prompt: "Changed" }), "CLAUDE_CREATION_REQUEST_CONFLICT");
    await blocked(creation.start({ ...args, senderThreadId: "other" }), "CLAUDE_CREATION_REQUEST_CONFLICT");
    await blocked(creation.start({ ...args, requestId: secondId }), "CLAUDE_CREATION_PENDING");
    state.tasks.push({ taskId: "other-project-task", cwd: "/other", isArchived: false });
    await blocked(creation.start({ ...args, requestId: secondId, cwd: "/other" }), "CLAUDE_CREATION_PENDING");
  });

  it("explicitly abandons a pending composer without reopening, deleting, or claiming it closed", async () => {
    const { creation, state, dependencies, connect } = fixture();
    await creation.start(args);
    const abandoned = await creation.abandon(id, args);
    assert.equal(abandoned.status, "abandoned");
    assert.equal(abandoned.promptSubmitted, false);
    assert.match(abandoned.reason, /may still be open/);
    assert.equal((await creation.start(args)).status, "abandoned");
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(creation.exportState());
    assert.equal((await restored.inspect(id, args)).status, "abandoned");
    state.tasks.push({ taskId: "other-project-task", cwd: "/other", isArchived: false });
    assert.equal((await restored.start({ ...args, requestId: secondId, cwd: "/other" })).status, "awaiting_user");
    assert.equal(state.opened.length, 2);
    connect();
    assert.equal((await restored.inspect(id, args)).status, "created");
    assert.equal((await restored.abandon(id, args)).status, "created");
  });

  it("requires the original sender and account to abandon a request", async () => {
    const { creation, state } = fixture();
    await creation.start(args);
    await blocked(creation.abandon(id, { ...args, senderThreadId: "other" }), "CLAUDE_CREATION_SENDER_MISMATCH");
    state.account = { ...account, fingerprint: "account-b" };
    await blocked(creation.abandon(id, args), "CLAUDE_CREATION_ACCOUNT_CHANGED");
    assert.equal(creation.exportState().requests[0].status, "awaiting_user");
  });

  it("retains prior ambiguity after abandonment and reload", async () => {
    const { creation, state, dependencies, connect } = fixture();
    await creation.start(args);
    connect();
    connect("another-task", "another-cli");
    assert.equal((await creation.inspect(id, args)).status, "ambiguous");
    await creation.abandon(id, args);
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(creation.exportState());
    state.sessions.pop();
    assert.equal((await restored.inspect(id, args)).status, "abandoned");
  });

  it("preserves completed untitled task receipts across reloads", async () => {
    for (const title of ["", "  \t  "]) {
      const { creation, dependencies, connect } = fixture({ readContext: async (session) => ({ status: "matched", taskId: session.taskId, cwd: session.cwd, title }) });
      await creation.start(args);
      connect();
      assert.equal((await creation.inspect(id, args)).title, null);
      const restored = new ClaudeSessionCreation(dependencies);
      restored.restoreState(creation.exportState());
      assert.equal((await restored.inspect(id, args)).title, null);
    }
  });

  it("does not open unknown, missing, relative, or archived-only projects", async () => {
    const { creation, state } = fixture();
    await blocked(creation.start({ ...args, cwd: "project" }), "CLAUDE_CREATION_CWD_INVALID");
    await blocked(creation.start({ ...args, cwd: "/missing" }), "CLAUDE_CREATION_CWD_INVALID");
    await blocked(creation.start({ ...args, cwd: "/other" }), "CLAUDE_CREATION_PROJECT_NOT_FOUND");
    state.tasks[0].isArchived = true;
    await blocked(creation.start(args), "CLAUDE_CREATION_PROJECT_NOT_FOUND");
    delete state.tasks[0].isArchived;
    await blocked(creation.start(args), "CLAUDE_CREATION_PROJECT_NOT_FOUND");
    assert.equal(state.opened.length, 0);
  });

  it("keeps ambiguous new matches unresolved even when one disappears", async () => {
    const { creation, state, connect } = fixture();
    await creation.start(args);
    connect();
    connect("another-task", "another-cli");
    assert.equal((await creation.inspect(id, args)).status, "ambiguous");
    state.sessions.pop();
    assert.equal((await creation.inspect(id, args)).status, "ambiguous");
  });

  it("bounds prompts, encoded URLs, and request identities", async () => {
    const { creation, state } = fixture();
    await blocked(creation.start({ ...args, prompt: "x".repeat(14000) }), "CLAUDE_CREATION_PROMPT_TOO_LONG");
    await blocked(creation.start({ ...args, prompt: "中".repeat(4000) }), "CLAUDE_CREATION_URL_TOO_LONG");
    await blocked(creation.start({ ...args, requestId: "not-an-id" }), "CLAUDE_CREATION_REQUEST_INVALID");
    assert.equal(state.opened.length, 0);
  });

  it("retains uncertain launch receipts and never reopens them across reloads", async () => {
    let attempts = 0;
    const { creation, dependencies, connect } = fixture({ open: async () => { attempts += 1; throw new Error("Launcher disconnected"); } });
    assert.equal((await creation.start(args)).status, "launch_uncertain");
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(creation.exportState());
    assert.equal((await restored.start(args)).status, "launch_uncertain");
    assert.equal(attempts, 1);
    connect();
    assert.equal((await restored.inspect(id, args)).status, "created");
  });

  it("restores pending receipts and baseline without sharing mutable state", async () => {
    const { creation, dependencies, state, connect } = fixture();
    await creation.start(args);
    const saved = creation.exportState();
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(saved);
    saved.requests[0].baseline.length = 0;
    connect("old-task", "reopened");
    assert.equal((await restored.inspect(id, args)).status, "awaiting_user");
    assert.equal(state.opened.length, 1);
  });

  it("rejects malformed restored receipts atomically", () => {
    const { creation } = fixture();
    for (const state of [{ version: 2, requests: [] }, { version: 1, requests: [{}] }, { version: 1, requests: Array(33).fill({}) }]) {
      assert.throws(() => creation.restoreState(state), (error) => error.code === "CLAUDE_CREATION_STATE_INVALID");
      assert.equal(creation.exportState().requests.length, 0);
    }
  });

  it("keeps completed receipts across reloads and limits requests without evicting idempotency", async () => {
    const { creation, dependencies, state, connect } = fixture();
    await creation.start({ ...args, prompt: `  ${args.prompt}  ` });
    connect();
    assert.equal((await creation.inspect(id, args)).status, "created");
    const saved = creation.exportState();
    const original = saved.requests[0];
    saved.requests = Array.from({ length: 32 }, (_, index) => {
      const requestId = index.toString(16).padStart(32, "0");
      return { ...original, requestId, initialMessage: `${args.prompt}\n\n[Codex creation request: ${requestId}]` };
    });
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(saved);
    assert.equal((await restored.inspect(saved.requests[0].requestId, args)).status, "created");
    await blocked(restored.start({ ...args, requestId: secondId }), "CLAUDE_CREATION_LIMIT");
    assert.equal(state.opened.length, 1);
  });

  it("revalidates the caller immediately before opening and aborts a failed preflight", async () => {
    const { creation, state } = fixture();
    await assert.rejects(creation.start({ ...args, beforeOpen: async () => { throw new Error("Sender changed"); } }), /Sender changed/);
    assert.equal(state.opened.length, 0);
    assert.equal(creation.exportState().requests.length, 0);
  });

  it("rejects metadata filename mismatch and incomplete transcript evidence", async () => {
    const { creation, state } = fixture();
    state.tasks[0].fileTaskId = "wrong-file";
    await blocked(creation.start(args), "CLAUDE_CREATION_TASKS_INVALID");
    const other = fixture({ readTranscript: async () => ({ truncated: true, messages: [{ role: "user", text: `${args.prompt}\n\n[Codex creation request: ${id}]` }] }) });
    await other.creation.start(args);
    other.connect();
    assert.equal((await other.creation.inspect(id, args)).status, "awaiting_user");
  });
});
