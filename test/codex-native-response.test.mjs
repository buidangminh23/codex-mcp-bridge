import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, it } from "node:test";

import { captureCodexRolloutWatermark, inspectCodexNativeTurn, readCodexNativeTurnResponse, readCodexNativeCreationResponse, resolveCodexNativeDispatchResponse } from "../src/codex-native-response.mjs";

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
  const resolve = (watermark, overrides = {}) => resolveCodexNativeDispatchResponse({ threadId: THREAD_ID, previousTurnId: PREVIOUS_TURN_ID,
    expectedCwd: cwd, executorThreadId: EXECUTOR_ID, prompt: PROMPT, watermark, ...overrides }, { env });
  return { home, cwd, directory, file, env, capture, read, turn, append, session, resolve };
}

describe("native Codex response observation", () => {
  for (const activeTurn of [false, true]) it(`reads a turn with a different causal root: active=${activeTurn}`, (t) => {
    const f = fixture(t);
    const records = f.turn();
    records[0].payload.root_turn_id = EXECUTOR_ID;
    // A payload root must not override the dispatch's explicit metadata turn.
    records[2].payload.root_turn_id = EXECUTOR_ID;
    records[3].payload.internal_chat_message_metadata_passthrough.root_turn_id = EXECUTOR_ID;
    if (activeTurn) f.append(records.slice(0, 2));
    const mark = f.capture();
    f.append(activeTurn ? records.slice(2) : records);
    const resolved = f.resolve(mark, { previousTurnId: activeTurn ? TURN_ID : PREVIOUS_TURN_ID });
    assert.equal(resolved.status, "completed", resolved.reason);
    assert.equal(resolved.turnId, TURN_ID);
    assert.equal(resolved.text, "Received safely");
    const read = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    assert.equal(read.status, "completed", read.reason);
    assert.equal(read.text, "Received safely");
  });

  it("does not include another turn merely because it shares the selected causal root", (t) => {
    const f = fixture(t);
    const mark = f.capture();
    f.append(f.turn());
    const other = f.turn({ turnId: EXECUTOR_ID, prompt: "unrelated" });
    for (const { payload } of other) payload.root_turn_id = TURN_ID;
    f.append(other);
    const result = f.read(mark);
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.text, "Received safely");
  });

  for (const variant of ["identical", "permission_changed", "workspace_changed", "identity_changed", "after_completion"]) {
    it(`validates refreshed turn contexts after compaction: ${variant}`, (t) => {
      const f = fixture(t);
      const records = f.turn();
      Object.assign(records[1].payload, { approval_policy: "never", sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } });
      f.append(records.slice(0, 2));
      const mark = f.capture();
      const refreshed = structuredClone(records[1]);
      if (variant === "permission_changed") refreshed.payload.permission_profile.type = "read-only";
      if (variant === "workspace_changed") refreshed.payload.cwd = f.home;
      if (variant === "identity_changed") refreshed.payload.internal_chat_message_metadata_passthrough = { turn_id: EXECUTOR_ID };
      f.append(variant === "after_completion" ? [...records.slice(2), refreshed] : [records[2], refreshed, ...records.slice(3)]);
      const result = f.resolve(mark, { previousTurnId: TURN_ID });
      assert.equal(result.status, variant === "identical" ? "completed" : "unavailable", result.reason);
      assert.equal(result.text, variant === "identical" ? "Received safely" : "");
    });
  }

  for (const sameTurn of [false, true]) it(`resolves the exact historical dispatch after later turns start: same turn ${sameTurn}`, (t) => {
    const f = fixture(t);
    const records = f.turn();
    if (sameTurn) f.append(records.slice(0, 2));
    const mark = f.capture();
    f.append(sameTurn ? records.slice(2) : records);
    f.append(f.turn({ turnId: EXECUTOR_ID, prompt: "An unrelated follow-up" }));
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID, prompt: "Current task" }).slice(0, 2));
    const result = f.resolve(mark, { previousTurnId: sameTurn ? TURN_ID : null });
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.turnId, TURN_ID);
    assert.equal(result.text, "Received safely");
  });

  for (const variant of ["single_write", "continuous_writes"]) it(`re-reads the whole rollout set when Codex appends during the set check: ${variant}`, (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const readdir = fs.readdirSync;
    let directoryReads = 0;
    t.mock.method(fs, "readdirSync", (directory, ...rest) => {
      if (fs.realpathSync.native(String(directory)) === fs.realpathSync.native(f.directory) && ++directoryReads % 2 === 0 &&
          (variant === "continuous_writes" || directoryReads === 2)) {
        f.append([{ type: "event_msg", payload: { type: "token_count", turn_id: PREVIOUS_TURN_ID } }]);
      }
      return readdir.call(fs, directory, ...rest);
    });
    const mark = f.capture();
    if (variant === "single_write") {
      assert.equal(mark.status, "available", mark.reason);
      assert.equal(mark.size, fs.statSync(f.file).size);
      assert.equal(directoryReads, 4);
    } else {
      assert.equal(mark.status, "unavailable");
      assert.match(mark.reason, /A rollout segment changed while reading/);
      assert.equal(directoryReads, 6);
    }
  });

  for (const reader of ["turn", "dispatch"]) it(`re-reads the rollout set when Codex appends while a reply is read: ${reader}`, (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const mark = f.capture();
    assert.equal(mark.status, "available", mark.reason);
    f.append(f.turn());
    const readdir = fs.readdirSync;
    let directoryReads = 0;
    t.mock.method(fs, "readdirSync", (directory, ...rest) => {
      if (fs.realpathSync.native(String(directory)) === fs.realpathSync.native(f.directory) && ++directoryReads === 2) {
        f.append([{ type: "event_msg", payload: { type: "token_count", turn_id: PREVIOUS_TURN_ID } }]);
      }
      return readdir.call(fs, directory, ...rest);
    });
    const result = reader === "turn" ? f.read(mark) : f.resolve(mark);
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.text, "Received safely");
    assert.ok(directoryReads >= 4);
  });

  it("keeps a matching active dispatch pending without promoting commentary", (t) => {
    const f = fixture(t);
    const mark = f.capture();
    assert.equal(f.resolve(mark).status, "pending");
    f.append(f.turn({ phase: "commentary" }).slice(0, 4));
    const result = f.resolve(mark);
    assert.equal(result.status, "pending", result.reason);
    assert.equal(result.turnId, TURN_ID);
    assert.equal(result.text, "");
  });

  for (const variant of ["duplicate", "duplicate_other_turn", "wrong_sender", "wrong_prompt", "old_dispatch", "prefix_changed", "superseding_turn", "contradictory_id", "aborted"]) {
    it(`rejects unsafe historical dispatch resolution: ${variant}`, (t) => {
      const f = fixture(t);
      if (variant === "old_dispatch") f.append(f.turn());
      const mark = f.capture();
      const records = f.turn();
      if (variant === "duplicate") records.splice(3, 0, structuredClone(records[2]));
      if (variant === "wrong_sender") records[2] = f.turn({ executorThreadId: PREVIOUS_TURN_ID })[2];
      if (variant === "wrong_prompt") records[2] = f.turn({ prompt: "Different prompt" })[2];
      if (variant === "superseding_turn") records.splice(3, 0, ...f.turn({ turnId: EXECUTOR_ID }).slice(0, 2));
      if (variant === "contradictory_id") records[2].payload.turn_id = EXECUTOR_ID;
      if (variant === "aborted") records.splice(3, 0, { type: "event_msg", payload: { type: "task_aborted", turn_id: TURN_ID } });
      if (variant !== "old_dispatch") f.append(records);
      if (variant === "duplicate_other_turn") f.append(f.turn({ turnId: EXECUTOR_ID }));
      if (variant === "prefix_changed") fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace("Codex Desktop", "codex_work_desktop"));
      const result = f.resolve(mark);
      assert.equal(result.status, ["wrong_sender", "wrong_prompt", "old_dispatch"].includes(variant) ? "pending" : "unavailable", result.reason);
      assert.equal(result.text, "");
      assert.equal(result.replySha256, null);
    });
  }

  it("verifies exact memory citation text with an empty rollout list", (t) => {
    const f = fixture(t);
    const mark = f.capture();
    const body = "Verified response.\n\n";
    const citation = "<oai-mem-citation>\n<citation_entries>\nnotes.md:2-4|note=[release guidance]\n</citation_entries>\n<rollout_ids>\n</rollout_ids>\n</oai-mem-citation>";
    const records = f.turn({ content: [{ type: "output_text", text: body + citation }] });
    records.splice(3, 0, { type: "event_msg", payload: { type: "item_completed", thread_id: THREAD_ID, turn_id: TURN_ID,
      item: { type: "AgentMessage", id: records[3].payload.id, phase: "final_answer", content: [{ type: "Text", text: body }],
        memory_citation: { entries: [{ path: "notes.md", lineStart: 2, lineEnd: 4, note: "release guidance" }], rolloutIds: [] } } } });
    f.append(records);
    const result = f.read(mark);
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.text, body + citation);
  });

  it("observes a same-turn final after the exact peer dispatch and preserves distinct peer messages", (t) => {
    const f = fixture(t);
    const records = f.turn();
    f.append(records.slice(0, 2));
    const mark = f.capture();
    const other = f.turn({ prompt: "Separate peer update" })[2];
    f.append([records[2], other, ...records.slice(3)]);
    const result = f.read(mark, { previousTurnId: TURN_ID });
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.responseScope, "same_turn_final");
    assert.equal(result.text, "Received safely");
    assert.equal(result.assistantItems[0].id, records[3].payload.id);
    assert.equal(result.replySha256, crypto.createHash("sha256").update("Received safely").digest("hex"));
  });

  for (const variant of ["duplicate", "wrong_sender", "wrong_prompt", "old_dispatch", "old_final", "commentary", "user_message", "user_event", "aborted", "prefix_changed"]) {
    it(`withholds an unsafe same-turn response: ${variant}`, (t) => {
      const f = fixture(t);
      const records = f.turn();
      const prefix = records.slice(0, 2);
      if (variant === "old_dispatch") prefix.push(records[2]);
      if (variant === "old_final") prefix.push(records[3]);
      f.append(prefix);
      const mark = f.capture();
      const suffix = records.slice(2);
      if (variant === "duplicate") suffix.splice(1, 0, structuredClone(records[2]));
      if (variant === "wrong_sender") suffix[0] = f.turn({ executorThreadId: PREVIOUS_TURN_ID })[2];
      if (variant === "wrong_prompt") suffix[0] = f.turn({ prompt: "Other request" })[2];
      if (variant === "old_dispatch") suffix.shift();
      if (variant === "old_final") suffix.splice(1, 1);
      if (variant === "commentary") suffix[1].payload.phase = "commentary";
      if (variant === "user_message") suffix.splice(1, 0, { type: "response_item", payload: { type: "message", role: "user", turn_id: TURN_ID, content: [{ type: "input_text", text: "Do something else" }] } });
      if (variant === "user_event") suffix.splice(1, 0, { type: "event_msg", payload: { type: "user_message", turn_id: TURN_ID, message: "Do something else" } });
      if (variant === "aborted") suffix.splice(1, 0, { type: "event_msg", payload: { type: "task_aborted", turn_id: TURN_ID } });
      f.append(suffix);
      if (variant === "prefix_changed") fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace("task_started", "turn_started"));
      const result = f.read(mark, { previousTurnId: TURN_ID });
      assert.equal(result.status, "unavailable");
      assert.equal(result.text, "");
      assert.equal(result.replySha256, null);
    });
  }

  for (const variant of ["matching", "changed_text", "changed_citation", "missing_metadata", "invalid_lines", "missing_response"]) {
    it(`verifies Desktop memory citation representations: ${variant}`, (t) => {
      const f = fixture(t);
      const mark = f.capture();
      const citation = `<oai-mem-citation>\n<citation_entries>\nnotes.md:2-4|note=[release guidance]\n</citation_entries>\n<rollout_ids>\n${PREVIOUS_TURN_ID}\n</rollout_ids>\n</oai-mem-citation>`;
      const body = "Verified response.\n\n";
      const records = f.turn({ content: [{ type: "output_text", text: body + citation }] });
      const event = { type: "event_msg", payload: { type: "item_completed", thread_id: THREAD_ID, turn_id: TURN_ID,
        item: { type: "AgentMessage", id: records[3].payload.id, phase: "final_answer", content: [{ type: "Text", text: body }],
          memory_citation: { entries: [{ path: "notes.md", lineStart: 2, lineEnd: 4, note: "release guidance" }], rolloutIds: [PREVIOUS_TURN_ID] } } } };
      if (variant === "changed_text") event.payload.item.content[0].text = "Different response.\n\n";
      if (variant === "changed_citation") event.payload.item.memory_citation.entries[0].note = "different guidance";
      if (variant === "missing_metadata") delete event.payload.item.memory_citation;
      if (variant === "invalid_lines") event.payload.item.memory_citation.entries[0].lineStart = -1;
      records.splice(3, variant === "missing_response" ? 1 : 0, event);
      f.append(records);
      const result = f.read(mark);
      assert.equal(result.status, variant === "matching" ? "completed" : "unavailable", result.reason);
      assert.equal(result.text, variant === "matching" ? body + citation : "");
      if (variant === "matching") assert.equal(result.replySha256, crypto.createHash("sha256").update(body + citation).digest("hex"));
    });
  }

  it("correlates a confirmed creation to create_thread only, with exact sender and prompt", (t) => {
    const f = fixture(t);
    const records = f.turn();
    records[2].payload.name = "create_thread";
    f.append(records);
    const binding = { threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd, executorThreadId: EXECUTOR_ID, prompt: PROMPT };
    const read = (overrides = {}) => readCodexNativeCreationResponse({ ...binding, ...overrides }, { env: f.env });
    assert.equal(read().text, "Received safely");
    for (const override of [{ executorThreadId: PREVIOUS_TURN_ID }, { prompt: "another brief" }, { expectedCwd: f.home }]) {
      assert.equal(read(override).status, "unavailable");
    }
    fs.writeFileSync(f.file, line(f.session) + f.turn().map(line).join(""));
    assert.match(read().reason, /exact native dispatch/);
  });

  it("follows a new continuation after dispatch and verifies every old segment prefix", (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const evidence = { thread: { id: THREAD_ID, kind: "codex", hostId: "local", cwd: f.cwd }, latestTurnId: PREVIOUS_TURN_ID };
    const first = f.capture();
    const continued = f.file.replace(".jsonl", `_${EXECUTOR_ID}.jsonl`);
    fs.writeFileSync(continued, line(f.session) + f.turn().map(line).join(""));
    assert.equal(f.read(first, { desktopEvidence: evidence }).status, "completed");
    const currentEvidence = { ...evidence, latestTurnId: TURN_ID };
    const second = captureCodexRolloutWatermark({ threadId: THREAD_ID, expectedCwd: f.cwd, desktopEvidence: currentEvidence }, { env: f.env });
    assert.equal(second.status, "available", second.reason);
    assert.equal(second.file, fs.realpathSync.native(continued));
    assert.equal(second.segments.length, 2);
    assert.equal(f.read(second).status, "unavailable", "A turn predating dispatch cannot be replayed");
    assert.equal(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd, desktopEvidence: currentEvidence }, { env: f.env }).status, "completed");
    fs.writeFileSync(f.file, fs.readFileSync(f.file, "utf8").replace("Received safely", "Replaced safely"));
    assert.match(f.read(first).reason, /history changed/);
  });

  it("accepts CLI-origin responses only with independently confirmed native task ownership", (t) => {
    const f = fixture(t);
    Object.assign(f.session.payload, { originator: "codex-tui", source: "cli" });
    fs.writeFileSync(f.file, line(f.session));
    assert.equal(f.capture().status, "unavailable");
    const evidence = { thread: { id: THREAD_ID, kind: "codex", hostId: "local", cwd: f.cwd }, latestTurnId: PREVIOUS_TURN_ID };
    const watermark = captureCodexRolloutWatermark({ threadId: THREAD_ID, expectedCwd: f.cwd, desktopEvidence: evidence }, { env: f.env });
    assert.equal(watermark.status, "available", watermark.reason);
    f.append(f.turn());
    assert.equal(f.read(watermark).status, "unavailable");
    assert.equal(f.read(watermark, { desktopEvidence: evidence }).status, "completed");
    for (const thread of [
      { ...evidence.thread, kind: "chatgpt" }, { ...evidence.thread, hostId: "remote" },
      { ...evidence.thread, id: EXECUTOR_ID }, { ...evidence.thread, cwd: f.home },
    ]) assert.equal(f.read(watermark, { desktopEvidence: { ...evidence, thread } }).status, "unavailable");
  });

  it("rejects copied or split turns across continuations and missing pre-send segments", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    const continued = f.file.replace(".jsonl", `_${EXECUTOR_ID}.jsonl`);
    const records = f.turn();
    f.append(records.slice(0, 3));
    fs.writeFileSync(continued, line(f.session) + records.slice(3).map(line).join(""));
    assert.match(f.read(watermark).reason, /multiple rollout segments/);
    fs.writeFileSync(continued, line(f.session) + records.map(line).join(""));
    f.append(records.slice(3));
    assert.match(f.read(watermark).reason, /multiple rollout segments/);
    fs.unlinkSync(f.file);
    assert.match(f.read(watermark).reason, /disappeared/);
  });

  it("streams histories above 16 MiB while retaining exact prefix and reply verification", (t) => {
    const f = fixture(t);
    const row = line({ type: "response_item", payload: { content: "x".repeat(1024 * 1024) } });
    for (let i = 0; i < 17; i++) fs.appendFileSync(f.file, row);
    const watermark = f.capture();
    assert.equal(watermark.status, "available", watermark.reason);
    assert.ok(watermark.size > 16 * 1024 * 1024);
    assert.equal(watermark.prefixSha256, crypto.createHash("sha256").update(fs.readFileSync(f.file)).digest("hex"));
    f.append(f.turn());
    assert.equal(f.read(watermark).text, "Received safely");
    assert.equal(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env }).text, "Received safely");
    const fd = fs.openSync(f.file, "r+");
    try { fs.writeSync(fd, Buffer.from("y"), 0, 1, 8 * 1024 * 1024); } finally { fs.closeSync(fd); }
    assert.match(f.read(watermark).reason, /history changed/);
  });

  it("reads migrated Desktop tasks only when the latest context matches the selected workspace", (t) => {
    const f = fixture(t);
    f.session.payload.cwd = path.join(f.home, "removed-original-workspace");
    fs.writeFileSync(f.file, line(f.session));
    assert.equal(f.capture().status, "unavailable");
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const watermark = f.capture();
    assert.equal(watermark.status, "available", watermark.reason);
    f.append(f.turn());
    assert.equal(f.read(watermark).status, "completed");
    f.append([{ type: "turn_context", payload: { turn_id: PREVIOUS_TURN_ID, cwd: f.home } }]);
    assert.equal(f.capture().status, "unavailable");
    assert.equal(f.read(watermark).status, "unavailable");
  });

  it("bounds retained records of the requested turn even when each record fits", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    const records = f.turn();
    for (let i = 0; i < 40; i++) records.splice(3, 0, { type: "event_msg", payload: { type: "progress", turn_id: TURN_ID, text: "x".repeat(100) } });
    f.append(records);
    assert.match(f.read(watermark, {}, { maxRolloutBytes: 2048 }).reason, /retained-record limit/);
  });

  it("captures and reads exact final replies from both native Desktop origins", (t) => {
    for (const originator of ["Codex Desktop", "codex_work_desktop"]) {
      const f = fixture(t);
      f.session.payload.originator = originator;
      fs.writeFileSync(f.file, line(f.session));
      const watermark = f.capture();
      assert.equal(watermark.status, "available", originator);
      f.append(f.turn());
      const observed = f.read(watermark);
      const inspected = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
      assert.equal(observed.status, "completed");
      assert.equal(observed.text, "Received safely");
      assert.equal(inspected.status, "completed");
      assert.deepEqual(observed.assistantItems, inspected.assistantItems);
      assert.equal(observed.replySha256, inspected.replySha256);
    }
  });

  it("does not extend response observation to web, CLI, extension or unknown origins", (t) => {
    for (const originator of ["codex_work_web", "codex_cli_rs", "codex_vscode", "codex_work_desktop_unknown", "Codex Desktop unknown", null]) {
      const f = fixture(t);
      f.session.payload.originator = originator;
      fs.writeFileSync(f.file, line(f.session));
      assert.equal(f.capture().status, "unavailable");
      f.append(f.turn());
      assert.equal(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env }).status, "unavailable");
    }
  });

  it("retains session, workspace and source checks for Work Desktop response observation", (t) => {
    for (const patch of [{ id: EXECUTOR_ID }, { source: "cli" }, { source: "web" }, { cwd: "relative-workspace" }]) {
      const f = fixture(t);
      Object.assign(f.session.payload, { originator: "codex_work_desktop" }, patch);
      fs.writeFileSync(f.file, line(f.session));
      assert.equal(f.capture().status, "unavailable");
      f.append(f.turn());
      assert.equal(inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env }).status, "unavailable");
    }
  });

  it("keeps Work Desktop final replies bound to their exact dispatch and new turn", (t) => {
    const f = fixture(t);
    f.session.payload.originator = "codex_work_desktop";
    fs.writeFileSync(f.file, line(f.session));
    const watermark = f.capture();
    f.append(f.turn());
    assert.equal(f.read(watermark, { prompt: "unrelated prompt" }).status, "unavailable");
    assert.equal(f.read(watermark, { executorThreadId: PREVIOUS_TURN_ID }).status, "unavailable");
    assert.equal(f.read(watermark, { previousTurnId: TURN_ID }).status, "unavailable");
    assert.equal(f.read(watermark).status, "completed");
  });

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

  it("matches the exact XML-escaped native dispatch without confusing literal entities", (t) => {
    const prompt = "Return <integer> & retain literal &lt;integer&gt;";
    const encoded = "Return &lt;integer&gt; &amp; retain literal &amp;lt;integer&amp;gt;";
    const f = fixture(t);
    const watermark = f.capture();
    f.append(f.turn({ prompt: encoded }));
    assert.equal(f.read(watermark, { prompt }).status, "completed");
    assert.equal(f.read(watermark, { prompt: "Return <integer> & retain literal <integer>" }).status, "unavailable");
    assert.equal(f.read(watermark, { prompt, executorThreadId: PREVIOUS_TURN_ID }).status, "unavailable");
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

  it("pinpoints failed lifecycle checks and record offsets without exposing record contents", (t) => {
    const cases = [
      { check: "lifecycle_start_count", mutate: (records) => records.shift(), detail: /count=0; recordBytes=none/ },
      { check: "lifecycle_context_count", mutate: (records) => records.splice(1, 1), detail: /count=0; recordBytes=none/ },
      { check: "lifecycle_context_changed", mutate: (records) => records.splice(1, 0, { ...records[1], payload: { ...records[1].payload, approval_policy: "different" } }), detail: /count=2; recordBytes=\d+,\d+/ },
      { check: "lifecycle_completion_count", mutate: (records) => records.pop(), detail: /count=0; recordBytes=none/ },
      { check: "lifecycle_failure", mutate: (records) => records.splice(4, 0, { type: "event_msg", payload: { type: "turn_failed", turn_id: TURN_ID, error: "private-error-text" } }), detail: /count=1; eventBytes=\d+/ },
      { check: "lifecycle_order", mutate: (records) => [records[0], records[1]] = [records[1], records[0]], detail: /startByte=\d+; contextByte=\d+; completionByte=\d+/ },
    ];
    for (const { check, mutate, detail } of cases) {
      const f = fixture(t);
      const watermark = f.capture();
      const records = f.turn();
      mutate(records);
      f.append(records);
      for (const result of [f.read(watermark), inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env })]) {
        assert.equal(result.status, "unavailable", check);
        assert.ok(result.reason.includes(`check=${check};`), result.reason);
        assert.match(result.reason, detail);
        for (const secret of [f.cwd, PROMPT, "private-error-text", "Received safely"]) assert.ok(!result.reason.includes(secret));
        assert.deepEqual(result.assistantItems, []);
        assert.equal(result.text, "");
      }
    }
  });

  it("locates both conflicting assistant representations using exact byte offsets", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    const records = f.turn({ content: [{ type: "output_text", text: "private-reply-\u00e9" }] });
    records[3].payload.id = "private-item-id-\n-do-not-disclose";
    records.splice(4, 0, { type: "event_msg", payload: {
      type: "item_completed", turn_id: TURN_ID,
      item: { type: "AgentMessage", id: records[3].payload.id, content: [{ type: "Text", text: "private-conflicting-text" }], phase: "final_answer" },
    } });
    const responseOffset = Buffer.byteLength(line(f.session) + records.slice(0, 3).map(line).join(""));
    const eventOffset = Buffer.byteLength(line(f.session) + records.slice(0, 4).map(line).join(""));
    f.append(records);
    const result = f.read(watermark);
    assert.equal(result.status, "unavailable");
    assert.ok(result.reason.includes(`check=assistant_representation_text; responseItemByte=${responseOffset}; completedEventByte=${eventOffset}`), result.reason);
    for (const secret of [f.cwd, "private-reply", "private-item-id", "private-conflicting-text", PROMPT]) assert.ok(!result.reason.includes(secret));
    assert.equal(result.text, "");
  });

  it("identifies unmatched authoritative items and malformed content without returning their contents", (t) => {
    for (const variant of ["unmatched", "event_content", "response_content", "phase", "duplicate"]) {
      const f = fixture(t);
      const watermark = f.capture();
      const records = f.turn();
      const event = { type: "event_msg", payload: {
        type: "item_completed", turn_id: TURN_ID,
        item: { type: "AgentMessage", id: records[3].payload.id, phase: "final_answer", content: [{ type: "Text", text: "Received safely" }] },
      } };
      let check;
      if (variant === "unmatched") {
        event.payload.item.id = "private-unmatched-id";
        check = "authoritative_response_missing";
      } else if (variant === "event_content") {
        event.payload.item.content.push({ type: "private-unsupported-type", text: "private-content" });
        check = "completed_content";
      } else if (variant === "response_content") {
        records[3].payload.content.push({ type: "private-unsupported-type", text: "private-content" });
        check = "response_content";
      } else if (variant === "phase") {
        event.payload.item.phase = "private-unsupported-phase";
        check = "assistant_representation_type_phase";
      } else {
        records.splice(4, 0, structuredClone(records[3]));
        check = "response_item_id_duplicate";
      }
      records.splice(-1, 0, event);
      f.append(records);
      const result = f.read(watermark);
      assert.equal(result.status, "unavailable", variant);
      assert.ok(result.reason.includes(`check=${check};`), result.reason);
      assert.match(result.reason, /(?:responseItemByte|completedEventByte)=\d+/);
      if (variant.endsWith("content")) assert.match(result.reason, /contentPart=1/);
      assert.ok(!result.reason.includes("private-"));
      assert.equal(result.text, "");
    }
  });

  it("bounds ambiguous lifecycle diagnostics even with many duplicate records", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    const records = f.turn();
    records.splice(0, 0, ...Array.from({ length: 100 }, () => structuredClone(records[0])));
    f.append(records);
    const result = f.read(watermark);
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /check=lifecycle_start_count; count=101; recordBytes=\d+,\d+,\d+\]/);
    assert.ok(result.reason.length < 256);
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

  it("persists exact rollout identities and honors only exactly representable legacy identities", (t) => {
    const f = fixture(t);
    const watermark = f.capture();
    assert.equal(watermark.status, "available", watermark.reason);
    const exact = fs.lstatSync(f.file, { bigint: true });
    assert.deepEqual(watermark.identity, { dev: String(exact.dev), ino: String(exact.ino) });
    const stored = JSON.parse(JSON.stringify(watermark));
    f.append(f.turn());
    assert.equal(f.read(stored).status, "completed");
    const legacy = (identity) => ({ ...stored, identity, segments: stored.segments.map((mark) => ({ ...mark, identity })) });
    const numeric = { dev: Number(exact.dev), ino: Number(exact.ino) };
    const representable = Number.isSafeInteger(numeric.dev) && Number.isSafeInteger(numeric.ino);
    assert.equal(f.read(legacy(numeric)).status, representable ? "completed" : "unavailable");
    assert.match(f.read(legacy({ ...stored.identity, ino: String(exact.ino + 1n) })).reason, /identity changed/);
    assert.match(f.read(legacy({ ...stored.identity, ino: undefined })).reason, /identity changed/);
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

describe("compressed cold Codex rollouts", () => {
  function compress(f) {
    const zst = `${f.file}.zst`;
    const bytes = fs.readFileSync(f.file);
    fs.writeFileSync(zst, zlib.zstdCompressSync(bytes));
    fs.unlinkSync(f.file);
    return { zst, bytes };
  }

  function materialize(f, zst, records = []) {
    fs.writeFileSync(f.file, Buffer.concat([zlib.zstdDecompressSync(fs.readFileSync(zst)), Buffer.from(records.map(line).join(""))]));
    fs.unlinkSync(zst);
  }

  it("captures a watermark over the decompressed history of a .jsonl.zst rollout", (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const { zst, bytes } = compress(f);
    const mark = f.capture();
    assert.equal(mark.status, "available", mark.reason);
    assert.equal(mark.file, fs.realpathSync.native(zst));
    assert.equal(mark.size, bytes.length);
    assert.equal(mark.prefixSha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  });

  for (const reader of ["turn", "dispatch"]) it(`observes the reply after Codex rematerializes the cold rollout on resume: ${reader}`, (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const { zst } = compress(f);
    const mark = f.capture();
    assert.equal(mark.status, "available", mark.reason);
    materialize(f, zst, f.turn());
    const result = reader === "turn" ? f.read(mark) : f.resolve(mark);
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.turnId, TURN_ID);
    assert.equal(result.text, "Received safely");
  });

  it("rejects a rematerialized rollout whose pre-send history differs", (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const { zst } = compress(f);
    const mark = f.capture();
    const original = zlib.zstdDecompressSync(fs.readFileSync(zst));
    fs.writeFileSync(zst, zlib.zstdCompressSync(Buffer.from(original.toString("utf8").replace("Received safely", "Received wrongly"))));
    materialize(f, zst, f.turn());
    const result = f.read(mark);
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /pre-send Codex rollout history changed/);
  });

  it("still requires the same file identity while the rollout stays plain", (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: PREVIOUS_TURN_ID }));
    const mark = f.capture();
    const bytes = fs.readFileSync(f.file);
    fs.renameSync(f.file, `${f.file}.replaced`);
    fs.writeFileSync(f.file, Buffer.concat([bytes, Buffer.from(f.turn().map(line).join(""))]));
    const result = f.read(mark);
    assert.equal(result.status, "unavailable");
    assert.match(result.reason, /rollout identity changed after dispatch/);
  });

  it("reads an exact turn from a compressed rollout", (t) => {
    const f = fixture(t);
    f.append(f.turn());
    compress(f);
    const inspected = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    assert.equal(inspected.status, "completed", inspected.reason);
    assert.equal(inspected.text, "Received safely");
  });

  for (const reader of ["inspect", "turn", "dispatch"]) for (const stage of ["listing", "decompress"]) it(`retries when Codex removes the .zst mid-read: ${reader}, ${stage}`, (t) => {
    const f = fixture(t);
    f.append(f.turn({ turnId: reader === "inspect" ? TURN_ID : PREVIOUS_TURN_ID }));
    const { zst } = compress(f);
    const mark = reader === "inspect" ? null : f.capture();
    if (mark) assert.equal(mark.status, "available", mark.reason);
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      materialize(f, zst, reader === "inspect" ? [] : f.turn());
    };
    if (stage === "listing") {
      const readdir = fs.readdirSync;
      t.mock.method(fs, "readdirSync", (directory, ...rest) => {
        const entries = readdir.call(fs, directory, ...rest);
        if (fs.realpathSync.native(String(directory)) === fs.realpathSync.native(f.directory)) swap();
        return entries;
      });
    } else {
      const decompress = zlib.zstdDecompressSync;
      t.mock.method(zlib, "zstdDecompressSync", (...args) => {
        const content = decompress.apply(zlib, args);
        swap();
        return content;
      });
    }
    const result = reader === "inspect"
      ? inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env })
      : reader === "turn" ? f.read(mark) : f.resolve(mark);
    assert.ok(swapped);
    assert.equal(result.status, "completed", result.reason);
    assert.equal(result.turnId, TURN_ID);
    assert.equal(result.text, "Received safely");
  });

  it("serves an unchanged compressed segment from the scan cache and rescans a new version", (t) => {
    const f = fixture(t);
    f.append(f.turn());
    const { zst } = compress(f);
    const decompress = zlib.zstdDecompressSync;
    let decompressions = 0;
    t.mock.method(zlib, "zstdDecompressSync", (...args) => { decompressions++; return decompress.apply(zlib, args); });
    const inspect = () => inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    for (let attempt = 0; attempt < 3; attempt++) assert.equal(inspect().status, "completed");
    assert.equal(decompressions, 1);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(zst, later, later);
    assert.equal(inspect().status, "completed");
    assert.equal(decompressions, 2);
  });

  it("retries a read that races the zst-to-plain rematerialization", (t) => {
    const f = fixture(t);
    f.append(f.turn());
    const { zst } = compress(f);
    const readdir = fs.readdirSync;
    let directoryReads = 0;
    t.mock.method(fs, "readdirSync", (directory, ...rest) => {
      if (fs.realpathSync.native(String(directory)) === fs.realpathSync.native(f.directory) && ++directoryReads === 2) materialize(f, zst);
      return readdir.call(fs, directory, ...rest);
    });
    const inspected = inspectCodexNativeTurn({ threadId: THREAD_ID, turnId: TURN_ID, expectedCwd: f.cwd }, { env: f.env });
    assert.equal(inspected.status, "completed", inspected.reason);
    assert.equal(directoryReads, 4);
  });
});
