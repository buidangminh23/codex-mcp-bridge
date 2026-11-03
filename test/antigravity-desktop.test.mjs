import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { captureAntigravityObservation, listAntigravityConversations, observeAntigravityDelivery, runAgentApi, sanitizeAntigravityMetadata } from "../src/antigravity-desktop.mjs";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-desktop-"));
  const cleanup = [];
  t.after(() => { for (const close of cleanup) close(); fs.rmSync(home, { recursive: true, force: true }); });
  const cwd = process.platform === "win32" ? fs.realpathSync.native(home).toLowerCase() : fs.realpathSync.native(home);
  const uri = pathToFileURL(home).href;
  const env = { ANTIGRAVITY_LS_ADDRESS: "fixture", ANTIGRAVITY_CSRF_TOKEN: "fixture", ANTIGRAVITY_AGENTAPI_EXE: path.join(home, "language_server.exe") };
  const row = { conversationId: ID, cwd, projectId: "project", title: "Test", status: "CASCADE_RUN_STATUS_IDLE", surface: "desktop" };
  return { home, cwd, uri, env, row, cleanup };
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

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}

function field(number, value) {
  if (typeof value === "number") return Buffer.concat([varint(number * 8), varint(value)]);
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function nativeStep({ index, type = 15, status = 3, executionId = OTHER_ID, time = 1793706600000, prompt = "fixture handoff", response = "native reply", tools = false, hidden = false, sender = "system", recipient = ID, messageId = crypto.randomUUID(), stopReason = 2 }) {
  const timestamp = Buffer.concat([field(1, Math.floor(time / 1000)), field(2, time % 1000 * 1000000)]);
  const metadata = Buffer.concat([field(1, timestamp), field(7, timestamp), field(8, timestamp), field(12, executionId)]);
  const payload = type === 101 ? field(114, field(4, Buffer.concat([field(1, messageId), field(2, recipient), field(3, sender), field(4, prompt), field(11, hidden ? 1 : 0)])))
    : type === 15 ? field(20, Buffer.concat([field(1, response), field(3, "PRIVATE_THINKING"), ...(tools ? [field(7, "PRIVATE_TOOL_CALL")] : []), field(12, stopReason)])) : type === 14 ? field(19, field(2, "another user message")) : Buffer.alloc(0);
  return { idx: index, step_type: type, status, step_format: 0, metadata, step_payload: Buffer.concat([field(1, type), field(4, status), field(5, metadata), payload]) };
}

function transcriptFixture(t) {
  const f = fixture(t);
  const directory = path.join(f.home, ".gemini", "antigravity", "conversations");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${ID}.db`);
  const db = new DatabaseSync(filename);
  db.exec("CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_format INTEGER, metadata BLOB, step_payload BLOB)");
  db.prepare("INSERT INTO trajectory_meta VALUES (?, ?)").run(OTHER_ID, ID);
  f.cleanup.push(() => db.close());
  const insert = (step) => db.prepare("INSERT OR REPLACE INTO steps VALUES (?, ?, ?, ?, ?, ?)").run(step.idx, step.step_type, step.status, step.step_format, step.metadata, step.step_payload);
  const prompt = "fixture handoff";
  const identity = { surface: "desktop", conversationId: ID, cwd: f.cwd, sender: { provider: "codex", id: OTHER_ID }, prompt };
  const digest = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const record = { ...identity, requestId: crypto.randomUUID(), digest, status: "accepted", createdAt: new Date(1793706599500).toISOString(), finishedAt: new Date(1793706600500).toISOString(), result: { status: "accepted", completed: false } };
  delete record.prompt;
  const observe = (receipt = record) => observeAntigravityDelivery(receipt, { home: f.home, list: async () => [f.row] });
  return { ...f, db, filename, prompt, insert, record, observe };
}

test("native reply observation recovers exact legacy dispatch and exposes only the public reply", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 0, response: "old unrelated reply", time: 1793706500000 }));
  f.insert(nativeStep({ index: 1, type: 101 }));
  f.insert(nativeStep({ index: 2, type: 101, hidden: true, prompt: "[Notice] All your subagents and background tasks have been stopped due to server restart. If you want a subagent to continue working, it needs to be revived by sending it a new message. If resuming work, please check on status and restart as needed." }));
  f.insert(nativeStep({ index: 3, tools: true, response: "still working" }));
  f.insert(nativeStep({ index: 4, response: "exact native reply", time: 1793706601000 }));
  const result = await f.observe();
  assert.equal(result.status, "reply_received");
  assert.equal(result.result.completed, true);
  assert.equal(result.result.response, "exact native reply");
  assert.equal(result.result.rootStepIndex, 1);
  assert.equal(result.result.replyStepIndex, 4);
  assert.equal(result.result.source, "native-transcript");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|old unrelated|still working/);
});

test("native acceptance and an idle conversation cannot confirm an unrelated or incomplete response", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 0, response: "unrelated reply" }));
  assert.equal((await f.observe()).status, "accepted");
  f.insert(nativeStep({ index: 1, type: 101 }));
  for (const change of [{ tools: true }, { status: 2 }, { stopReason: 3 }, { executionId: crypto.randomUUID() }, { response: "" }]) {
    f.insert(nativeStep({ index: 2, ...change }));
    const result = await f.observe();
    assert.equal(result.status, "accepted", JSON.stringify(change));
    assert.equal(result.result.response, undefined);
  }
  f.insert(nativeStep({ index: 2 }));
  let inspections = 0;
  const running = await observeAntigravityDelivery(f.record, { home: f.home, list: async () => [{ ...f.row, status: ++inspections === 1 ? f.row.status : "busy" }] });
  assert.equal(running.status, "accepted");
  assert.equal(running.replyObservation.code, "ANTIGRAVITY_REPLY_STILL_RUNNING");
});

test("native reply observation requires exact prompt, sender, timestamps and recipient", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 1, type: 101 }));
  f.insert(nativeStep({ index: 2 }));
  for (const change of [{ digest: "0".repeat(64) }, { sender: { provider: "codex", id: crypto.randomUUID() } }, { createdAt: "2026-11-04T00:00:00Z" }, { createdAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:00:01Z" }]) {
    assert.equal((await f.observe({ ...f.record, ...change })).status, "accepted");
  }
  f.insert(nativeStep({ index: 1, type: 101, recipient: OTHER_ID }));
  assert.equal((await f.observe()).status, "accepted");
});

test("legacy observations cannot claim an identical handoff immediately before the new receipt", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 1, type: 101, time: 1793706600000 }));
  f.insert(nativeStep({ index: 2, response: "previous identical handoff reply", time: 1793706600250 }));
  const record = { ...f.record, createdAt: new Date(1793706600500).toISOString(), finishedAt: new Date(1793706600700).toISOString() };
  for (const nativeObservation of [undefined, { version: 1, status: "unavailable", promptSha256: crypto.createHash("sha256").update(f.prompt).digest("hex"), projectId: f.row.projectId }]) {
    const result = await f.observe({ ...record, ...(nativeObservation ? { nativeObservation } : {}) });
    assert.equal(result.status, "accepted");
    assert.equal(result.replyObservation.code, "ANTIGRAVITY_MESSAGE_NOT_OBSERVED");
    assert.equal(result.result.response, undefined);
  }
});

test("duplicate roots and interleaved prompts cannot claim a later native reply", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 1, type: 101 }));
  f.insert(nativeStep({ index: 2, type: 101 }));
  f.insert(nativeStep({ index: 3 }));
  assert.equal((await f.observe()).replyObservation.code, "ANTIGRAVITY_REPLY_AMBIGUOUS");
  for (const change of [{ type: 14 }, { type: 101, prompt: "other handoff" }, { type: 101, hidden: true, prompt: "[Agent handoff from another sender]" }, { type: 101, hidden: true, prompt: "[Notice] A different native command" }]) {
    f.insert(nativeStep({ index: 2, ...change }));
    assert.equal((await f.observe()).status, "accepted");
  }
});

test("legacy observation searches exact roots across long history instead of selecting the latest match", async (t) => {
  const f = transcriptFixture(t);
  f.db.exec("BEGIN");
  for (let index = 0; index < 4100; index++) f.insert(nativeStep({ index, type: 132 }));
  f.insert(nativeStep({ index: 4100, type: 101 }));
  f.insert(nativeStep({ index: 4101, response: "new exact reply" }));
  f.db.exec("COMMIT");
  assert.equal((await f.observe()).result.response, "new exact reply");
  f.insert(nativeStep({ index: 0, type: 101 }));
  const duplicate = await f.observe();
  assert.equal(duplicate.status, "accepted");
  assert.equal(duplicate.replyObservation.code, "ANTIGRAVITY_REPLY_AMBIGUOUS");
});

test("legacy root selection and reply inspection share one SQLite snapshot during concurrent writes", async (t) => {
  const f = transcriptFixture(t);
  f.db.exec("PRAGMA journal_mode=WAL");
  f.insert(nativeStep({ index: 0, type: 101, prompt: "unrelated older handoff" }));
  f.insert(nativeStep({ index: 1, type: 101 }));
  f.insert(nativeStep({ index: 2, response: "original snapshot reply" }));
  const prepare = DatabaseSync.prototype.prepare;
  let changed = false;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql, ...args) {
    const statement = prepare.call(this, sql, ...args);
    if (sql.includes("metadata, step_payload FROM steps") && sql.includes("AND step_type = 101")) {
      const all = statement.all;
      t.mock.method(statement, "all", function (...parameters) {
        const rows = all.apply(this, parameters);
        if (!changed) {
          changed = true;
          f.insert(nativeStep({ index: 0, type: 101 }));
          f.insert(nativeStep({ index: 2, response: "different later reply" }));
        }
        return rows;
      });
    }
    return statement;
  });
  const result = await f.observe();
  assert.equal(changed, true);
  assert.equal(result.status, "reply_received");
  assert.equal(result.result.response, "original snapshot reply");
  const later = await f.observe();
  assert.equal(later.status, "accepted");
  assert.equal(later.replyObservation.code, "ANTIGRAVITY_REPLY_AMBIGUOUS");
});

test("native dispatch stops if its durable observation boundary cannot be saved", async (t) => {
  const f = transcriptFixture(t);
  let sends = 0;
  await assert.rejects(runAgentApi({ command: "send", conversationId: ID, prompt: f.prompt, expectedCwd: f.cwd, home: f.home, env: f.env, list: async () => [f.row],
    beforeDispatch: () => { throw new Error("Could not persist boundary"); },
    run: async (_file, args) => {
      if (args[1] === "send-message") sends++;
      return { stdout: JSON.stringify({ metadata: { workspaceUris: [f.uri], projectId: f.row.projectId } }) };
    } }), { deliveryState: "not_sent" });
  assert.equal(sends, 0);
});

test("new native sends capture and persist their boundary before dispatch", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 0, type: 101 }));
  f.insert(nativeStep({ index: 1, response: "old reply" }));
  let boundary;
  let sends = 0;
  const result = await runAgentApi({ command: "send", conversationId: ID, prompt: f.prompt, expectedCwd: f.cwd, home: f.home, env: f.env, list: async () => [f.row],
    beforeDispatch: (observation) => { assert.equal(sends, 0); boundary = observation; },
    run: async (_file, args) => {
      if (args[1] === "get-conversation-metadata") return { stdout: JSON.stringify({ metadata: { workspaceUris: [f.uri], projectId: f.row.projectId } }) };
      sends++;
      assert.equal(boundary.beforeStepIndex, 1);
      f.insert(nativeStep({ index: 2, type: 101 }));
      f.insert(nativeStep({ index: 3, response: "new reply" }));
      return { stdout: "{\"success\":true}" };
    } });
  assert.equal(result.status, "accepted");
  assert.equal(sends, 1);
  const observed = await f.observe({ ...f.record, nativeObservation: boundary });
  assert.equal(observed.result.response, "new reply");
  f.db.prepare("UPDATE trajectory_meta SET trajectory_id = ?").run(crypto.randomUUID());
  assert.equal((await f.observe({ ...f.record, nativeObservation: boundary })).replyObservation.code, "ANTIGRAVITY_TRANSCRIPT_REPLACED");
});

test("native observation refuses unknown schemas and malformed protobuf without exposing content", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 1, type: 101 }));
  f.insert({ ...nativeStep({ index: 2 }), step_payload: Buffer.from("PRIVATE_BROKEN_PAYLOAD") });
  let result = await f.observe();
  assert.equal(result.status, "accepted");
  assert.equal(result.replyObservation.status, "unavailable");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  f.db.exec("DROP TABLE steps");
  result = await f.observe();
  assert.equal(result.replyObservation.status, "unavailable");
  const boundary = await captureAntigravityObservation({ home: f.home, conversationId: ID, prompt: f.prompt, projectId: "project" });
  assert.equal(boundary.status, "unavailable");
});

test("native observation verifies current project and rejects oversized or linked transcript files", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 1, type: 101 }));
  f.insert(nativeStep({ index: 2 }));
  const boundary = await captureAntigravityObservation({ home: f.home, conversationId: ID, prompt: f.prompt, projectId: "foreign-project" });
  assert.equal((await f.observe({ ...f.record, nativeObservation: boundary })).replyObservation.status, "unavailable");
  f.db.prepare("UPDATE steps SET step_payload = zeroblob(?) WHERE idx=2").run(2 * 1024 * 1024 + 1);
  assert.equal((await f.observe()).replyObservation.code, "ANTIGRAVITY_TRANSCRIPT_LIMIT");
  fs.linkSync(f.filename, path.join(f.home, "linked.db"));
  assert.equal((await f.observe()).replyObservation.status, "unavailable");
});

test("native observation rejects symlinked conversation directories", async (t) => {
  const f = transcriptFixture(t);
  f.insert(nativeStep({ index: 1, type: 101 }));
  f.insert(nativeStep({ index: 2 }));
  const aliasHome = path.join(f.home, "alias-home");
  const aliasRoot = path.join(aliasHome, ".gemini", "antigravity");
  fs.mkdirSync(aliasRoot, { recursive: true });
  fs.symlinkSync(path.dirname(f.filename), path.join(aliasRoot, "conversations"), process.platform === "win32" ? "junction" : "dir");
  const result = await observeAntigravityDelivery(f.record, { home: aliasHome, list: async () => [f.row] });
  assert.equal(result.status, "accepted");
  assert.equal(result.replyObservation.status, "unavailable");
});
