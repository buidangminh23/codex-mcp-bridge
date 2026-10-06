import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { ClaudeSessionCreation } from "../src/claude-session-creation.mjs";
import { createProjectScope, editProjectGrant, updateProjectPolicy } from "../src/project-policy.mjs";

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

for (const phase of ["open", "trust", "submit", "composer"]) {
  for (const mutation of ["revoke", "directory", "repository", "account", "runtime", "unchanged"]) {
    it(`revalidates production creation guard after sender lookup: ${phase}/${mutation}`, async t => {
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "creation-final-gate-")));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const cwd = path.join(root, "project"); fs.mkdirSync(cwd);
      if (mutation === "repository") execFileSync("git", ["-C", cwd, "init", "-b", "main"], { stdio: "pipe" });
      const file = path.join(root, "policy.json");
      updateProjectPolicy(file, policy => editProjectGrant(policy, "allow-project", cwd));
      const rootPolicy = createProjectScope(file);
      const effects = [];
      let validAccount = true, validRuntime = true, lookups = 0;
      const lookup = { open: 2, trust: 3, submit: 4, composer: 6 }[phase];
      const f = fixture({
        listTasks: async () => [{ taskId: "old-task", cwd, isArchived: false }],
        realpath: async directory => fs.realpathSync.native(directory),
        open: async () => { effects.push("open"); },
        trust: async () => { effects.push("trust"); return { status: "trusted" }; },
        settle: async () => {},
        submit: async ({ beforeSubmit }) => {
          await beforeSubmit();
          effects.push("select");
          await beforeSubmit();
          effects.push("submit");
          return { status: "submitted" };
        },
      });
      const sender = { cwd, threadId: "sender-a", status: "verified" };
      const assertSender = async () => {
        await Promise.resolve();
        if (++lookups === lookup) {
          if (mutation === "revoke") updateProjectPolicy(file, policy => editProjectGrant(policy, "revoke", cwd));
          if (mutation === "directory") { fs.renameSync(cwd, path.join(root, "previous")); fs.mkdirSync(cwd); }
          if (mutation === "repository") { fs.renameSync(path.join(cwd, ".git"), path.join(root, "previous-git")); execFileSync("git", ["-C", cwd, "init", "-b", "main"], { stdio: "pipe" }); }
          if (mutation === "account") validAccount = false;
          if (mutation === "runtime") validRuntime = false;
        }
        return sender;
      };
      const source = fs.readFileSync(new URL("../src/claude-bridge.mjs", import.meta.url), "utf8");
      const start = source.slice(source.indexOf("async function startClaudeCreation("), source.indexOf("async function inspectClaudeCreation("));
      const names = ["runtime", "desktopOnly", "assertSender", "readBridgeAccounts", "requireBridgeAccounts", "rootPolicy", "creations", "creationRootBindings", "assertCreationRoots", "assertAccountIdentity", "recheckScopeBindings", "textResult"];
      const execute = new Function(...names, start + "\nreturn startClaudeCreation;")(
        { assertCurrent() { if (!validRuntime) throw Error("runtime changed"); } }, true, assertSender,
        () => ({ claude: account }), value => value, rootPolicy, f.creation, new Map(), () => {},
        () => { if (!validAccount) throw Error("account changed"); },
        bindings => { rootPolicy.recheck(bindings.sender); rootPolicy.recheck(bindings.recipient); },
        value => ({ content: [{ type: "text", text: value }] }),
      );
      const operation = execute({ requestId: id, cwd, prompt: args.prompt, autoSubmit: true, trustProject: true }, {});
      if (mutation === "unchanged") {
        await operation;
        assert.deepEqual(effects, ["open", "trust", "select", "submit"]);
      } else {
        await operation.catch(error => assert.match(error.message, /revoked|replaced|not authorized|account changed|runtime changed/));
        assert.ok(lookups >= lookup);
        assert.equal(effects.includes(phase === "composer" ? "submit" : phase), false);
      }
    });
  }
}

describe("Claude native new session lifecycle", () => {
  it("awaits sender revalidation before opening and before automatic trust or submission", async () => {
    let checked = 0;
    const { creation, state } = fixture({
      trust: async () => assert.fail("must not trust after sender changes"),
      submit: async () => assert.fail("must not submit after sender changes"),
    });
    const denied = async () => { await Promise.resolve(); throw new Error("sender changed before open"); };
    await assert.rejects(creation.start({ ...args, beforeOpen: denied }), /sender changed before open/);
    assert.equal(state.opened.length, 0);
    assert.equal(creation.requests.size, 0);
    await assert.rejects(creation.start({ ...args, autoSubmit: true, trustProject: true, beforeOpen: async () => {
      await Promise.resolve();
      if (++checked === 2) throw new Error("sender changed after open");
    } }), /sender changed after open/);
    assert.equal(state.opened.length, 1);
    assert.equal(checked, 2);
    assert.equal(creation.requests.get(id).submissionAttempted, undefined);
  });

  it("submits an authorized exact composer once, including concurrent and restored retries", async () => {
    let submitted = 0;
    let trusted = 0;
    const { creation, state, dependencies, connect } = fixture({ trust: async ({ cwd }) => { assert.equal(cwd, "/project"); trusted++; return { status: "trusted" }; }, submit: async ({ prompt, cwd }) => { submitted++; assert.equal(cwd, "/project"); assert.match(prompt, new RegExp(id)); connect(); return { status: "submitted" }; } });
    const [first, second] = await Promise.all([creation.start({ ...args, autoSubmit: true, trustProject: true }), creation.start({ ...args, autoSubmit: true, trustProject: true })]);
    assert.equal(first.status, "created");
    assert.deepEqual(second, first);
    assert.equal(trusted, 1);
    assert.equal(submitted, 1);
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(creation.exportState());
    assert.deepEqual(await restored.start({ ...args, autoSubmit: true }), first);
    assert.equal(submitted, 1);
    assert.equal(state.opened.length, 1);
  });

  it("retains uncertain submission without pressing Send again or claiming receipt", async () => {
    let attempts = 0;
    const { creation, dependencies } = fixture({ submit: async () => { attempts++; throw new Error("Lost UI acknowledgement"); } });
    const receipt = await creation.start({ ...args, autoSubmit: true });
    assert.equal(receipt.status, "submission_uncertain");
    assert.equal(receipt.promptSubmitted, false);
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(creation.exportState());
    assert.deepEqual(await restored.start({ ...args, autoSubmit: true }), receipt);
    assert.equal(attempts, 1);
  });

  it("never trusts or submits when project or account cannot be verified", async () => {
    const { creation, state } = fixture({ trust: async () => assert.fail("must not trust"), submit: async () => assert.fail("must not submit") });
    state.tasks = [];
    await blocked(creation.start({ ...args, autoSubmit: true, trustProject: true }), "CLAUDE_CREATION_PROJECT_NOT_FOUND");
    assert.equal(state.opened.length, 0);
  });

  it("retries an unsent trust blocker in the same composer without reopening or duplicating Send", async () => {
    let allowTrust = false;
    let submissions = 0;
    const { creation, state, connect } = fixture({ trust: async () => ({ status: allowTrust ? "trusted" : "blocked", reason: "exact_trust_not_ready" }), submit: async () => { submissions++; connect(); return { status: "submitted" }; } });
    assert.equal((await creation.start({ ...args, autoSubmit: true, trustProject: true })).status, "awaiting_user");
    assert.equal(submissions, 0);
    allowTrust = true;
    assert.equal((await creation.start({ ...args, autoSubmit: true, trustProject: true })).status, "created");
    assert.equal(submissions, 1);
    assert.equal(state.opened.length, 1);
  });
  it("opens only a prefilled native URI and awaits a real user submission", async () => {
    const { creation, state } = fixture();
    const result = await creation.start(args);
    assert.equal(result.status, "awaiting_user");
    assert.equal(result.promptSubmitted, false);
    assert.equal(result.submissionStatus, "not_observed");
    assert.equal(result.directoryVerification.expectedCwd, "/project");
    assert.equal(result.directoryVerification.verified, false);
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
    assert.equal(result.submissionStatus, "observed");
    assert.equal(result.directoryVerification, undefined);
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
    assert.equal((await creation.inspect(id, args)).status, "awaiting_project_confirmation");
    state.sessions[0].cwd = "/project";
    state.sessions[0].entrypoint = "cli";
    assert.equal((await creation.inspect(id, args)).status, "awaiting_project_confirmation");
  });

  it("records submission in a wrong folder and verifies a later native project change", async () => {
    const { creation, state, dependencies, connect } = fixture();
    await creation.start(args);
    connect();
    state.sessions[0].cwd = "/scratch/No folder";
    state.messages[0].text = `<system-reminder>\nThe user started this session without choosing a project folder, so select a project if needed.\nRecent projects: /project, /other\n</system-reminder>\n\n${state.messages[0].text}`;
    const pending = await creation.inspect(id, args);
    assert.equal(pending.status, "awaiting_project_confirmation");
    assert.equal(pending.promptSubmitted, true);
    assert.equal(pending.observedCwd, "/scratch/No folder");
    assert.equal(pending.cwd, "/project");
    assert.equal(pending.taskId, "new-task");
    state.tasks.push({ taskId: "new-task", cliSessionId: "new-cli", cwd: "/scratch/No folder", isArchived: false });
    assert.deepEqual(await creation.start({ ...args, autoSubmit: true, trustProject: true }), pending);
    const next = await creation.start({ ...args, requestId: secondId });
    assert.equal(next.status, "awaiting_user");
    assert.equal(state.opened.length, 2);
    assert.equal(creation.exportState().requests[1].baseline.includes("new-task"), true);
    assert.equal((await creation.inspect(secondId, args)).status, "awaiting_user");
    const restored = new ClaudeSessionCreation(dependencies);
    restored.restoreState(creation.exportState());
    assert.deepEqual(await restored.inspect(id, args), pending);
    state.sessions[0].cwd = "/project";
    const confirmed = await restored.inspect(id, args);
    assert.equal(confirmed.status, "created");
    assert.equal(confirmed.observedCwd, "/project");
    assert.equal(confirmed.promptSubmitted, true);
  });

  it("accepts only the anchored no-folder banner before the exact initial message", async () => {
    const { creation, state, connect } = fixture();
    await creation.start(args);
    connect();
    const exact = state.messages[0].text;
    const banner = "<system-reminder>\r\nThe user started this session without choosing a project folder, with recent folders available.\r\n</system-reminder>\r\n\r\n";
    for (const text of [`Leading text${banner}${exact}`, `${banner}Extra prompt\n${exact}`, `${banner}${exact}Trailing text`, `${banner.replace("The user started", "Another user started")}${exact}`, `${banner.replace("with recent folders available.", "<system-reminder>Nested</system-reminder>")}${exact}`]) {
      state.messages[0].text = text;
      assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
    }
    state.messages[0].text = banner + exact;
    assert.equal((await creation.inspect(id, args)).status, "created");
  });

  it("requires observed process cwd and native metadata cwd to agree", async () => {
    const { creation, state, connect } = fixture({ readContext: async (session) => ({ status: "matched", taskId: session.taskId, cwd: "/different-context", title: null }) });
    await creation.start(args);
    connect();
    state.sessions[0].cwd = "/scratch";
    assert.equal((await creation.inspect(id, args)).status, "awaiting_user");
  });

  it("rejects ambiguous correlated new tasks even when their directories differ", async () => {
    const { creation, state, connect } = fixture();
    await creation.start(args);
    connect();
    connect("another-task", "another-cli");
    state.sessions[1].cwd = "/scratch";
    const result = await creation.inspect(id, args);
    assert.equal(result.status, "ambiguous");
    assert.equal(result.promptSubmitted, true);
    assert.equal(result.taskId, undefined);
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
