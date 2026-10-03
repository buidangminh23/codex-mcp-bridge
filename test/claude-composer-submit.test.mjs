import test from "node:test";
import assert from "node:assert/strict";
import { assessClaudeCodeComposer, submitClaudeCodeComposer, trustClaudeCodeComposer } from "../src/claude-composer-submit.mjs";

test("native trust passes only the authorized directory and invokes the Trust action once", async () => {
  let calls = 0;
  const cwd = "C:\\Projects\\sếp ' $(text)";
  const result = await trustClaudeCodeComposer({ cwd }, { platform: "win32", run: async (_command, args, options) => {
    calls++;
    assert.equal(args[args.indexOf("-Action") + 1], "Trust");
    assert.deepEqual(JSON.parse(Buffer.from(args[args.indexOf("-PayloadBase64") + 1], "base64").toString("utf8")), { cwd });
    assert.match(args[args.indexOf("-File") + 1], /src[\\/]claude-composer-submit\.ps1$/);
    assert.equal(options.windowsHide, true);
    return { stdout: JSON.stringify({ status: "trusted", reason: "exact_native_workspace_trust_invoked" }) };
  } });
  assert.equal(result.status, "trusted");
  assert.equal(calls, 1);
});

test("native trust preserves blockers and never retries an unknown invocation", async () => {
  for (const status of ["blocked", "absent", "uncertain"]) {
    let calls = 0;
    const result = await trustClaudeCodeComposer({ cwd: "C:\\project" }, { platform: "win32", run: async () => { calls++; return { stdout: JSON.stringify({ status, reason: "fixture" }) }; } });
    assert.equal(result.status, status);
    assert.equal(calls, 1);
  }
  assert.equal((await trustClaudeCodeComposer({ cwd: "relative" }, { platform: "win32", run: () => assert.fail("must not run") })).status, "blocked");
});

const request = { prompt: "Exact expected prompt\n## Task\nReply OK", cwd: "C:\\Projects\\bridge" };
const snapshot = () => ({
  windows: [{ id: 314, installedDesktop: true }],
  dialogs: [],
  codeSelected: true,
  composers: [{ text: request.prompt }],
  folderCount: 1,
  localMode: true,
  worktreeEnabled: false,
  selectedFolderPaths: [request.cwd],
  sendButtons: [{ enabled: true, invokable: true }],
});

test("accepts exactly one verified native composer for the canonical project", () => {
  const view = snapshot();
  view.selectedFolderPaths = ["c:/PROJECTS/bridge/"];
  assert.equal(assessClaudeCodeComposer(view, request).status, "ready");
});

test("blocks unverified desktop, ambiguous windows, trust dialogs and non-Code mode", () => {
  for (const change of [
    { windows: [] },
    { windows: [{ id: 314, installedDesktop: true }, { id: 315, installedDesktop: true }] },
    { windows: [{ id: 314, installedDesktop: false }] },
    { dialogs: ["Trust this folder"] },
    { codeSelected: false },
  ]) {
    assert.equal(assessClaudeCodeComposer({ ...snapshot(), ...change }, request).status, "blocked");
  }
});

test("blocks wrong prompt, duplicate composers and altered nonempty text", () => {
  for (const composers of [[], [{ text: "Another task" }], [{ text: `${request.prompt} ` }],
    [{ text: request.prompt }, { text: request.prompt }]]) {
    assert.equal(assessClaudeCodeComposer({ ...snapshot(), composers }, request).status, "blocked");
  }
});

test("accepts Desktop collapsing empty paragraph nodes without changing prompt text", () => {
  assert.equal(assessClaudeCodeComposer({ ...snapshot(), composers: [{ text: request.prompt }] }, { ...request, prompt: request.prompt.replace("\n", "\n\n") }).status, "ready");
});

test("requires selected full path rather than basename, worktree or additional folder", () => {
  for (const change of [
    { selectedFolderPaths: ["bridge"] },
    { selectedFolderPaths: ["C:\\Other\\bridge"] },
    { selectedFolderPaths: [] },
    { selectedFolderPaths: [request.cwd, "C:\\Other"] },
    { selectedFolderPaths: [null] },
    { worktreeEnabled: true },
    { worktreeEnabled: undefined },
    { folderCount: 2 },
    { localMode: false },
  ]) {
    assert.equal(assessClaudeCodeComposer({ ...snapshot(), ...change }, request).status, "blocked");
  }
});

test("requires uniquely enabled invokable Send", () => {
  for (const sendButtons of [[], [{ enabled: false, invokable: true }],
    [{ enabled: true, invokable: false }], [{ enabled: true, invokable: true }, { enabled: true, invokable: true }]]) {
    assert.equal(assessClaudeCodeComposer({ ...snapshot(), sendButtons }, request).status, "blocked");
  }
});

test("unsupported platforms and relative project paths never run native UI", async () => {
  const run = () => assert.fail("Native UI must not run");
  for (const platform of ["darwin", "linux"]) {
    assert.equal((await submitClaudeCodeComposer(request, { platform, run })).reason, "native_composer_submission_unsupported");
  }
  assert.equal((await submitClaudeCodeComposer({ ...request, cwd: "bridge" }, { platform: "win32", run })).reason, "absolute_project_path_required");
});

test("passes shell metacharacters and Unicode only inside base64 JSON with hidden bounded execution", async () => {
  const special = { prompt: "`$(touch bad) ' \" ; & | sếp\nExact", cwd: "C:\\Projects\\bridge" };
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    const encoded = args[args.indexOf("-PayloadBase64") + 1];
    assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), special);
    assert.equal(args.includes(special.prompt), false);
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout <= 20000);
    assert.equal(file, "powershell.exe");
    assert.equal(args.includes("-NoProfile"), true);
    const action = args[args.indexOf("-Action") + 1];
    if (action === "Inspect") {
      return { stdout: JSON.stringify({ status: "ready", snapshot: { ...snapshot(), composers: [{ text: special.prompt }] } }) };
    }
    assert.equal(args[args.indexOf("-ExpectedWindowId") + 1], "314");
    if (action === "SelectFolder") return { stdout: JSON.stringify({ status: "selected" }) };
    return { stdout: JSON.stringify({ status: "submitted", reason: "native_send_invoked_once" }) };
  };
  assert.equal((await submitClaudeCodeComposer(special, { platform: "win32", run })).status, "submitted");
  assert.deepEqual(calls.map(({ args }) => args[args.indexOf("-Action") + 1]), ["Inspect", "SelectFolder", "Submit"]);
});

test("wrong or ambiguous composer never reaches native Submit", async () => {
  for (const composers of [[{ text: "Other task" }], [{ text: request.prompt }, { text: request.prompt }]]) {
    let calls = 0;
    const run = async () => {
      calls++;
      return { stdout: JSON.stringify({ status: "ready", snapshot: { ...snapshot(), composers } }) };
    };
    const result = await submitClaudeCodeComposer(request, { platform: "win32", run });
    assert.equal(result.status, "blocked");
    assert.equal(calls, 1);
  }
});

test("native inspection blocker is returned without any Send attempt", async () => {
  let calls = 0;
  const result = await submitClaudeCodeComposer(request, { platform: "win32", run: async () => {
    calls++;
    return { stdout: JSON.stringify({ status: "blocked", reason: "desktop_dialog_requires_attention" }) };
  } });
  assert.equal(result.status, "blocked");
  assert.equal(calls, 1);
});

test("submission timeout or invalid response is uncertain and never retried", async () => {
  for (const failure of ["throw", "malformed", "unexpected"]) {
    let calls = 0;
    const run = async () => {
      calls++;
      if (calls === 1) return { stdout: JSON.stringify({ status: "ready", snapshot: snapshot() }) };
      if (calls === 2) return { stdout: JSON.stringify({ status: "selected" }) };
      if (failure === "throw") throw Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
      if (failure === "malformed") return { stdout: "Not JSON" };
      return { stdout: JSON.stringify({ status: "ready" }) };
    };
    const result = await submitClaudeCodeComposer(request, { platform: "win32", run });
    assert.equal(result.status, "uncertain");
    assert.equal(result.submissionAttempted, true);
    assert.equal(calls, 3);
  }
});

test("inspection failure does not claim a native submission attempt", async () => {
  const result = await submitClaudeCodeComposer(request, { platform: "win32", run: async () => { throw new Error("UIA unavailable"); } });
  assert.equal(result.status, "blocked");
  assert.equal(result.submissionAttempted, false);
});

test("native revalidation failure returns blocked and never invokes a second Submit", async () => {
  let calls = 0;
  const result = await submitClaudeCodeComposer(request, { platform: "win32", run: async () => {
    calls++;
    return { stdout: JSON.stringify(calls === 1 ? { status: "ready", snapshot: snapshot() } : { status: "blocked", reason: "desktop_window_changed" }) };
  } });
  assert.equal(result.status, "blocked");
  assert.equal(result.submissionAttempted, false);
  assert.equal(calls, 2);
});

test("sender or account changes after inspection prevent Send", async () => {
  let calls = 0;
  const result = await submitClaudeCodeComposer({ ...request, beforeSubmit: async () => { throw new Error("Sender or account changed"); } }, {
    platform: "win32", sleep: async () => {}, run: async () => {
      calls++;
      return { stdout: JSON.stringify({ status: "ready", snapshot: snapshot() }) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "blocked");
  assert.equal(result.submissionAttempted, false);
});

test("sender revalidation after explicit folder selection prevents Send", async () => {
  const actions = [];
  let checks = 0;
  const result = await submitClaudeCodeComposer({ ...request, beforeSubmit: async () => { if (++checks === 2) throw new Error("Sender changed after folder selection"); } }, {
    platform: "win32", sleep: async () => {}, run: async (_file, args) => {
      const action = args[args.indexOf("-Action") + 1];
      actions.push(action);
      return { stdout: JSON.stringify(action === "Inspect" ? { status: "ready", snapshot: snapshot() } : { status: "selected" }) };
    },
  });
  assert.deepEqual(actions, ["Inspect", "SelectFolder"]);
  assert.equal(result.status, "blocked");
  assert.equal(result.submissionAttempted, false);
});
