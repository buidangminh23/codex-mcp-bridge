import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { listAntigravityConversations, runAgentApi, sanitizeAntigravityMetadata } from "../src/antigravity-desktop.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-desktop-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = process.platform === "win32" ? fs.realpathSync.native(home).toLowerCase() : fs.realpathSync.native(home);
  const uri = pathToFileURL(home).href;
  const env = { ANTIGRAVITY_LS_ADDRESS: "fixture", ANTIGRAVITY_CSRF_TOKEN: "fixture", ANTIGRAVITY_AGENTAPI_EXE: path.join(home, "language_server.exe") };
  const row = { conversationId: ID, cwd, projectId: "project", title: "Test", status: "CASCADE_RUN_STATUS_IDLE", surface: "desktop" };
  return { home, cwd, uri, env, row };
}

test("inventory excludes mirrored records, killed conversations, and multiple workspaces", async (t) => {
  const f = fixture(t);
  for (const surface of ["antigravity", "antigravity-cli"]) {
    const directory = path.join(f.home, ".gemini", surface);
    fs.mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(path.join(directory, "conversation_summaries.db"));
    db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT, project_id TEXT, status TEXT, not_fully_idle INTEGER, killed INTEGER, app_data_dir TEXT, last_modified_time TEXT, source TEXT DEFAULT '')");
    const add = db.prepare("INSERT INTO conversation_summaries VALUES (?, 'Test', ?, 'project', 'CASCADE_RUN_STATUS_IDLE', 0, ?, ?, '2026-10-28', '')");
    add.run(ID, JSON.stringify([f.uri]), 0, "antigravity");
    add.run(OTHER_ID, JSON.stringify([f.uri, f.uri]), 0, surface);
    add.run("33333333-3333-4333-8333-333333333333", JSON.stringify([f.uri]), 1, surface);
    db.prepare("INSERT INTO conversation_summaries VALUES (?, 'CLI mirror', ?, 'project', 'CASCADE_RUN_STATUS_IDLE', 0, 0, 'antigravity', '2026-10-28', 'CORTEX_TRAJECTORY_SOURCE_CLI')").run("44444444-4444-4444-8444-444444444444", JSON.stringify([f.uri]));
    db.close();
  }
  const rows = await listAntigravityConversations({ home: f.home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conversationId, ID);
  assert.equal(rows[0].surface, "desktop");
  assert.equal(rows[0].cwd, f.cwd);
  assert.equal((await listAntigravityConversations({ home: f.home, surface: "cli" })).length, 0);
});

test("native send rechecks metadata and idle state and treats prompts as single arguments", async (t) => {
  const f = fixture(t);
  const calls = [];
  let inventories = 0;
  const prompt = "Literal $(whoami) & \"quote\"\nsecond line";
  const result = await runAgentApi({ command: "send", conversationId: ID, prompt, expectedCwd: f.cwd, env: f.env, list: async () => { inventories++; return [f.row]; }, run: async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: JSON.stringify(args[1] === "get-conversation-metadata" ? { metadata: { workspaceUris: [f.uri], projectId: "project" } } : { success: true }) };
  } });
  assert.equal(inventories, 2);
  assert.deepEqual(calls[1].args, ["agentapi", "send-message", ID, prompt]);
  assert.equal(calls[1].options.shell, false);
  assert.equal(calls[1].options.env, f.env);
  assert.equal(result.status, "accepted");
  assert.equal(result.completed, false);
});

test("native send refuses changed workspace or project metadata before mutation", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(runAgentApi({ command: "send", conversationId: ID, prompt: "test", expectedCwd: f.cwd, env: f.env, list: async () => [f.row], run: async () => { calls++; return { stdout: JSON.stringify({ metadata: { workspaceUris: [f.uri], projectId: "changed" } }) }; } }), { code: "ANTIGRAVITY_METADATA_MISMATCH" });
  assert.equal(calls, 1);
});

test("native send refuses busy and unavailable recipients", async (t) => {
  const f = fixture(t);
  let calls = 0;
  for (const records of [[], [{ ...f.row, status: "busy" }]]) {
    await assert.rejects(runAgentApi({ command: "send", conversationId: ID, prompt: "test", expectedCwd: f.cwd, env: f.env, list: async () => records, run: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});

test("native send detects a recipient becoming busy after metadata lookup", async (t) => {
  const f = fixture(t);
  let inventories = 0;
  let calls = 0;
  await assert.rejects(runAgentApi({ command: "send", conversationId: ID, prompt: "test", expectedCwd: f.cwd, env: f.env, list: async () => [{ ...f.row, status: ++inventories === 1 ? "CASCADE_RUN_STATUS_IDLE" : "busy" }], run: async () => { calls++; return { stdout: JSON.stringify({ metadata: { workspaceUris: [f.uri], projectId: "project" } }) }; } }), { code: "ANTIGRAVITY_RECIPIENT_BUSY" });
  assert.equal(calls, 1);
});

test("native API requires managed sidecar context and rejects shell shims", async (t) => {
  const f = fixture(t);
  await assert.rejects(runAgentApi({ command: "metadata", conversationId: ID, env: {} }), { code: "ANTIGRAVITY_SIDECAR_REQUIRED" });
  await assert.rejects(runAgentApi({ command: "metadata", conversationId: ID, env: f.env, executable: path.join(f.home, "agentapi.bat") }), { code: "ANTIGRAVITY_EXECUTABLE_INVALID" });
});

test("native errors redact child command output and never retry", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(runAgentApi({ command: "metadata", conversationId: ID, env: f.env, run: async () => { calls++; throw Object.assign(new Error("private prompt and token"), { killed: true }); } }), (error) => error.code === "ANTIGRAVITY_OUTCOME_UNKNOWN" && !error.message.includes("private"));
  assert.equal(calls, 1);
});

test("metadata sanitizer omits native private fields and supports event envelopes", (t) => {
  const f = fixture(t);
  const result = sanitizeAntigravityMetadata({ payload: { conversationMetadata: { metadata: { workspaceUris: [f.uri], projectId: "project", staticConfig: { private: "secret" } } } } }, ID);
  assert.deepEqual(result, { conversationId: ID, cwd: f.cwd, projectId: "project", surface: "desktop" });
  assert.deepEqual(sanitizeAntigravityMetadata({ response: { conversationMetadata: { metadata: { workspaceUris: [f.uri], projectId: "project" } } } }, ID), result);
  assert.throws(() => sanitizeAntigravityMetadata({}, ID), { code: "ANTIGRAVITY_METADATA_UNSUPPORTED" });
  assert.throws(() => sanitizeAntigravityMetadata({ conversationId: OTHER_ID, metadata: { workspaceUris: [f.uri] } }, ID), { code: "ANTIGRAVITY_METADATA_MISMATCH" });
});

test("metadata failure diagnostics redact context and preserve not-sent state", async (t) => {
  const f = fixture(t);
  f.env.ANTIGRAVITY_CSRF_TOKEN = "sensitive-csrf";
  await assert.rejects(runAgentApi({ command: "metadata", conversationId: ID, env: f.env, run: async () => {
    throw Object.assign(new Error("private command"), { code: 1, stdout: JSON.stringify({ error: `native rejection sensitive-csrf ${ID} https://localhost:1234/private` }) });
  } }), (error) => error.deliveryState === "not_sent" && error.message.includes("exit 1") && !error.message.includes("sensitive-csrf") && !error.message.includes(ID) && !error.message.includes("localhost"));
});

test("dispatch failures retain unknown outcome while preflight failures are not sent", async (t) => {
  const f = fixture(t);
  await assert.rejects(runAgentApi({ command: "send", conversationId: ID, prompt: "test", expectedCwd: "relative", env: f.env }), { deliveryState: "not_sent" });
  await assert.rejects(runAgentApi({ command: "send", conversationId: ID, prompt: "test", expectedCwd: f.cwd, env: f.env, list: async () => [f.row], run: async (_file, args) => {
    if (args[1] === "get-conversation-metadata") return { stdout: JSON.stringify({ metadata: { workspaceUris: [f.uri], projectId: "project" } }) };
    throw Object.assign(new Error("lost acknowledgement"), { killed: true });
  } }), { deliveryState: "unknown" });
});
