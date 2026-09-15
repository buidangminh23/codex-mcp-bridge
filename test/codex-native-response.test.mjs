import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { captureCodexRolloutWatermark, inspectCodexNativeTurn, readCodexNativeTurnResponse } from "../src/codex-native-response.mjs";

const THREAD_ID = "01a08745-d26e-7db2-aa9c-0758d52ea3e0";
const TURN_ID = "01a087df-8988-7433-b08b-d85692b1f41a";
const EXECUTOR_ID = "01a08793-b558-7800-b847-0f8ac1e26285";
const PREVIOUS_TURN_ID = "01a087dd-d587-76c3-93c3-60c16bc08542";
const PROMPT = "CODEX_RECEIVED_CLAUDE_RAW_TEST";

function line(record) {
  return `${JSON.stringify(record)}\n`;
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-response-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = fs.realpathSync.native(fs.mkdirSync(path.join(home, "project"), { recursive: true }));
  const directory = path.join(home, ".codex", "sessions", "2026", "09", "09");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-09-09T11-44-55-${THREAD_ID}.jsonl`);
  const session = { type: "session_meta", payload: { id: THREAD_ID, originator: "Codex Desktop", source: "vscode", cwd } };
  fs.writeFileSync(file, line(session));
  const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex") };
  const capture = () => captureCodexRolloutWatermark({ threadId: THREAD_ID, expectedCwd: cwd }, { env });
  const read = (watermark, overrides = {}, options = {}) => readCodexNativeTurnResponse({
    threadId: THREAD_ID,
    turnId: TURN_ID,
    previousTurnId: PREVIOUS_TURN_ID,
    expectedCwd: cwd,
    executorThreadId: EXECUTOR_ID,
    prompt: PROMPT,
    watermark,
    ...overrides,
  }, { env, ...options });
  const turn = ({ turnId = TURN_ID, executorThreadId = EXECUTOR_ID, prompt = PROMPT, phase = "final_answer", content = [{ type: "output_text", text: "Received safely" }] } = {}) => [
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: { turn_id: turnId, cwd } },
    { type: "response_item", payload: {
      type: "function_call_output", id: crypto.randomUUID(), name: "send_message_to_thread", namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${executorThreadId}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
    { type: "response_item", payload: {
      type: "message", id: crypto.randomUUID(), role: "assistant", content, phase,
      internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["unknown"] },
    } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  const append = (records) => fs.appendFileSync(file, records.map(line).join(""));
  return { home, cwd, directory, file, env, capture, read, turn, append, session };
}

describe("native Codex response observation", () => {
  it("inspects the authoritative assistant item for one exact completed turn", (t) => {
    const f = fixture(t);
    const records = f.turn();
    const assistantId = records[3].payload.id;
    records.splice(3, 0, { type: "event_msg", payload: {
      type: "item_completed", thread_id: THREAD_ID, turn_id: TURN_ID,
      item: { type: "AgentMessage", id: assistantId, content: [{ type: "Text", text: "Received safely" }], phase: "final_answer" },
    } });
    f.append(records);
    assert.deepEqual(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env }), {
      status: "completed",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      source: "codex_desktop_rollout",
      assistantItems: [{ id: assistantId, text: "Received safely" }],
      text: "Received safely",
      replySha256: crypto.createHash("sha256").update("Received safely").digest("hex"),
    });
  });

  it("preserves exact native reply text while hashing normalized line endings and Unicode", (t) => {
    const f = fixture(t);
    const exact = " leading\r\ne\u0301 trailing ";
    const records = f.turn({ content: [{ type: "output_text", text: exact }] });
    f.append(records);
    const result = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    assert.equal(result.text, exact);
    assert.equal(result.assistantItems[0].text, exact);
    assert.equal(result.replySha256, crypto.createHash("sha256").update(" leading\né trailing ".normalize("NFC")).digest("hex"));
  });

  it("reads the exact final answer correlated to the newly dispatched native turn", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    assert.equal(watermark.status, "available");
    const records = f.turn();
    const assistantId = records[3].payload.id;
    f.append(records);
    const observed = f.read(watermark);
    const authoritative = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    assert.equal(observed.status, "completed");
    assert.equal(observed.text, "Received safely");
    assert.equal(observed.turnId, TURN_ID);
    assert.deepEqual(observed.assistantItems, [{ id: assistantId, text: "Received safely" }]);
    assert.deepEqual(
      { assistantItems: observed.assistantItems, text: observed.text, replySha256: observed.replySha256 },
      { assistantItems: authoritative.assistantItems, text: authoritative.text, replySha256: authoritative.replySha256 },
    );
  });

  it("does not reuse an identical completed turn that existed before dispatch", (t) => {
    const f = fixture(t);
    f.append(f.turn());
    const watermark = f.capture();
    assert.equal(f.read(watermark).status, "unavailable");
  });

  it("reports an exact completed turn with zero final assistant items", (t) => {
    const f = fixture(t);
    const records = f.turn();
    records.splice(3, 1);
    f.append(records);
    const result = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    assert.equal(result.status, "completed_no_reply");
    assert.deepEqual(result.assistantItems, []);
    assert.equal(result.text, "");
    assert.equal(result.replySha256, crypto.createHash("sha256").update("").digest("hex"));
  });

  it("keeps two sequential turns in one task isolated by exact turn id", (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID, content: [{ type: "output_text", text: "old reply" }] }));
    f.append(f.turn({ content: [{ type: "output_text", text: "new reply" }] }));
    const previous = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: PREVIOUS_TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    const current = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    assert.equal(previous.text, "old reply");
    assert.equal(current.text, "new reply");
    assert.notEqual(previous.assistantItems[0].id, current.assistantItems[0].id);
  });

  it("rejects a conflicting completed-event representation of the same assistant item", (t) => {
    const f = fixture(t);
    const records = f.turn();
    records.splice(3, 0, { type: "event_msg", payload: {
      type: "item_completed", thread_id: THREAD_ID, turn_id: TURN_ID,
      item: { type: "AgentMessage", id: records[3].payload.id, content: [{ type: "Text", text: "different" }], phase: "final_answer" },
    } });
    f.append(records);
    assert.equal(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env }).status, "unavailable");
  });

  it("rejects matching assistant IDs with contradictory event phase or type", (t) => {
    for (const variant of [{ type: "AgentMessage", phase: "commentary" }, { type: "UserMessage", phase: "final_answer" }, { type: "AgentMessage" }]) {
      const f = fixture(t);
      const watermark = f.capture();
      const records = f.turn();
      records.splice(3, 0, { type: "event_msg", payload: {
        type: "item_completed", thread_id: THREAD_ID, turn_id: TURN_ID,
        item: { ...variant, id: records[3].payload.id, content: [{ type: "Text", text: "Received safely" }] },
      } });
      f.append(records);
      assert.equal(f.read(watermark).status, "unavailable");
      assert.equal(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env }).status, "unavailable");
    }
  });

  it("rejects a malformed exposed final assistant completion event", (t) => {
    const f = fixture(t);
    const records = f.turn();
    records.splice(3, 0, { type: "event_msg", payload: {
      type: "item_completed", thread_id: THREAD_ID, turn_id: TURN_ID,
      item: { type: "AgentMessage", id: records[3].payload.id, content: [{ type: "ToolCall", text: "unsupported" }], phase: "final_answer" },
    } });
    f.append(records);
    assert.equal(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env }).status, "unavailable");
  });

  it("rejects the previous or a different turn", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    assert.equal(f.read(watermark, { turnId: PREVIOUS_TURN_ID }).status, "unavailable");
    assert.equal(f.read(watermark).status, "unavailable");
  });

  it("rejects a wrong executor, prompt, or canonical cwd", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    f.append(f.turn({ executorThreadId: "01a08794-b558-7800-b847-0f8ac1e26285", prompt: "wrong" }));
    assert.equal(f.read(watermark).status, "unavailable");
    assert.equal(f.read(watermark, { executorThreadId: "01a08794-b558-7800-b847-0f8ac1e26285", prompt: "wrong", expectedCwd: f.home }).status, "unavailable");
  });

  it("rejects ambiguous dispatches and final answers", (t) => {
    for (const duplicate of [2, 3]) {
      const f = fixture(t);
      const watermark = f.capture();
      const records = f.turn();
      records.splice(duplicate, 0, structuredClone(records[duplicate]));
      f.append(records);
      assert.equal(f.read(watermark).status, "unavailable");
    }
  });

  it("does not promote commentary to a final reply", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    const records = f.turn();
    records[3].payload.phase = "commentary";
    f.append(records);
    assert.equal(f.read(watermark).status, "unavailable");
  });

  it("does not treat tool content or incomplete turns as a final reply", (t) => {
    for (const mutation of [
      (records) => { records[3].payload.content = [{ type: "tool_call", text: "not a reply" }]; },
      (records) => { records.pop(); },
    ]) {
      const f = fixture(t);
      const watermark = f.capture();
      const records = f.turn();
      mutation(records);
      f.append(records);
      assert.equal(f.read(watermark).status, "unavailable");
    }
  });

  it("rejects start or context records placed after the native dispatch", (t) => {
    for (const index of [0, 1]) {
      const f = fixture(t);
      const watermark = f.capture();
      const records = f.turn();
      const [record] = records.splice(index, 1);
      records.splice(2, 0, record);
      f.append(records);
      assert.equal(f.read(watermark).status, "unavailable");
    }
  });

  it("rejects an aborted lifecycle even when a final answer and completion also exist", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    const records = f.turn();
    records.splice(4, 0, { type: "event_msg", payload: { type: "turn_aborted", turn_id: TURN_ID } });
    f.append(records);
    assert.equal(f.read(watermark).status, "unavailable");
  });

  it("rejects contradictory explicit turn and task identities", (t) => {
    for (const mutate of [
      (records) => { records[2].payload.turn_id = PREVIOUS_TURN_ID; },
      (records) => { records[3].payload.internal_chat_message_metadata_passthrough.thread_id = "01a08744-d26e-7db2-aa9c-0758d52ea3e0"; },
    ]) {
      const f = fixture(t);
      const watermark = f.capture();
      const records = f.turn();
      mutate(records);
      f.append(records);
      assert.equal(f.read(watermark).status, "unavailable");
    }
  });

  it("rejects malformed, incomplete, and oversized rollout snapshots", (t) => {
    for (const tail of ["{bad json}\n", "{\"type\":\"event_msg\""]) {
      const f = fixture(t);
      const watermark = f.capture();
      fs.appendFileSync(f.file, tail);
      assert.equal(f.read(watermark).status, "unavailable");
    }
    const f = fixture(t);
    const watermark = f.capture();
    f.append(f.turn({ content: [{ type: "output_text", text: "x".repeat(4096) }] }));
    assert.equal(f.read(watermark, {}, { maxRolloutBytes: 1024 }).status, "unavailable");
  });

  it("rejects a rollout replaced after the pre-send watermark", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    fs.renameSync(f.file, `${f.file}.old`);
    fs.writeFileSync(f.file, line(f.session) + f.turn().map(line).join(""));
    assert.equal(f.read(watermark).status, "unavailable");
  });

  it("rejects multiple rollout files for one task", (t) => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.directory, `rollout-duplicate-${THREAD_ID}.jsonl`), line(f.session));
    assert.equal(f.capture().status, "unavailable");
  });

  it("rejects a linked rollout rather than following it", (t) => {
    const f = fixture(t);
    const target = `${f.file}.target`;
    fs.renameSync(f.file, target);
    if (process.platform === "win32") {
      const linkedDirectory = path.join(f.home, "linked-rollout-target");
      fs.mkdirSync(linkedDirectory);
      fs.symlinkSync(linkedDirectory, f.file, "junction");
    } else fs.symlinkSync(target, f.file, "file");
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
    assert.equal(f.capture().status, "unavailable");
  });

  it("rejects a date ancestor replaced by a junction after capture", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    const day = f.directory;
    const original = `${day}-original`;
    const redirected = path.join(f.home, "redirected-day");
    fs.mkdirSync(redirected);
    fs.renameSync(day, original);
    fs.writeFileSync(path.join(redirected, path.basename(f.file)), line(f.session) + f.turn().map(line).join(""));
    fs.symlinkSync(redirected, day, "junction");
    assert.equal(fs.lstatSync(day).isSymbolicLink(), true);
    assert.equal(f.read(watermark).status, "unavailable");
  });
});
