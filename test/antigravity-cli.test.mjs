import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { AntigravityCliSession, resolveAntigravityCliBinary } from "../src/antigravity-cli.mjs";

const ID = "d524394d-8b2c-4d91-ab33-8e994a729dda";
const OTHER_ID = "9bd40525-6560-45e9-8079-c6e3054e83e2";

function fixture(t, options = {}) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-cli-")));
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.writes = [];
  child.stdin = new Writable({
    write(chunk, encoding, callback) { child.writes.push(chunk.toString()); callback(options.writeError); },
    final(callback) { callback(); if (options.exitOnEnd !== false) queueMicrotask(() => child.emit("close", 0, null)); },
  });
  child.kills = 0;
  child.kill = () => { child.kills++; if (options.exitOnKill !== false) queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  child.event = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
  child.init = (overrides = {}) => child.event({ event: "init", conversation_id: ID, init: { cwd, permission_mode: "request-review" }, ...overrides });
  child.result = (overrides = {}) => child.event({ event: "result", result: { conversation_id: ID, status: "SUCCESS", response: "ready", ...overrides } });
  let launch;
  const session = new AntigravityCliSession({
    cwd, binary: process.execPath, startupTimeoutMs: 1000, turnTimeoutMs: 1000, closeTimeoutMs: 10,
    spawn(binary, args, settings) { launch = { binary, args, settings }; if (options.init !== false) queueMicrotask(() => child.init(options.initOverrides)); return child; },
    ...options.session,
  });
  t.after(async () => { await session.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { session, child, cwd, launch: () => launch };
}

test("launches the native stream without changing permissions or invoking a shell", async (t) => {
  const { session, launch, cwd } = fixture(t);
  const state = await session.start();
  assert.equal(state.conversationId, ID);
  assert.equal(state.permissionMode, "request-review");
  assert.equal(state.cwd, cwd);
  assert.deepEqual(launch().args, ["--input-format", "stream-json", "--output-format", "stream-json"]);
  assert.equal(launch().settings.shell, false);
  assert.equal(launch().settings.windowsHide, true);
  assert.equal(launch().settings.cwd, cwd);
  assert.equal(launch().binary, fs.realpathSync.native(process.execPath));
});

test("sends literal NDJSON text and keeps one native conversation across turns", async (t) => {
  const { session, child } = fixture(t);
  await session.start();
  const prompt = 'literal ` $(echo unsafe) & "quoted"\nTiếng Việt';
  const first = session.send(prompt);
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(child.writes[0]), { event: "user", message: { content: prompt } });
  child.result();
  assert.equal((await first).response, "ready");
  const second = session.send("Second turn");
  await new Promise(setImmediate);
  child.result({ response: "second" });
  assert.equal((await second).response, "second");
  assert.equal(session.read().conversationId, ID);
  assert.equal(session.read().deliveryState, "completed");
});

test("waits for verified init before writing any prompt", async (t) => {
  const { session, child } = fixture(t, { init: false });
  const result = session.send("hello");
  await new Promise(setImmediate);
  assert.equal(child.writes.length, 0);
  child.init();
  await new Promise(setImmediate);
  assert.equal(child.writes.length, 1);
  child.result();
  await result;
});

test("explicit resume must match the native conversation identity", async (t) => {
  const { session, launch } = fixture(t, { session: { conversationId: ID } });
  await session.start();
  assert.deepEqual(launch().args.slice(-2), ["--conversation", ID]);
  const other = fixture(t, { session: { conversationId: OTHER_ID } });
  await assert.rejects(other.session.start(), { code: "INVALID_PROTOCOL", deliveryState: "not-sent" });
  assert.equal(other.child.writes.length, 0);
});

test("rejects a different native workspace before any send", async (t) => {
  const { session, child } = fixture(t, { initOverrides: { init: { cwd: os.tmpdir(), permission_mode: "request-review" } } });
  await assert.rejects(session.send("hello"), { code: "INVALID_PROTOCOL", deliveryState: "not-sent" });
  assert.equal(child.writes.length, 0);
});

test("rejects missing permission evidence and malformed conversation IDs", async (t) => {
  for (const overrides of [{ conversation_id: "guess" }, { init: { cwd: os.tmpdir() } }]) {
    const { session } = fixture(t, { initOverrides: overrides });
    await assert.rejects(session.start(), { code: "INVALID_PROTOCOL" });
  }
});

test("rejects concurrent sends without adding a second native message", async (t) => {
  const { session, child } = fixture(t);
  await session.start();
  const result = session.send("first");
  await new Promise(setImmediate);
  await assert.rejects(session.send("second"), { code: "SESSION_UNAVAILABLE" });
  assert.equal(child.writes.length, 1);
  child.result();
  await result;
});

test("handles split UTF-8 frames without losing characters", async (t) => {
  const { session, child } = fixture(t);
  await session.start();
  const result = session.send("hello");
  await new Promise(setImmediate);
  const frame = Buffer.from(`${JSON.stringify({ event: "result", result: { conversation_id: ID, status: "SUCCESS", response: "Tiếng Việt 🛰️" } })}\n`);
  for (const byte of frame) child.stdout.write(Buffer.from([byte]));
  assert.equal((await result).response, "Tiếng Việt 🛰️");
});

test("returns native permission failures without retrying or enabling bypass", async (t) => {
  const { session, child, launch } = fixture(t);
  await session.start();
  const result = session.send("Edit a file");
  await new Promise(setImmediate);
  child.result({ status: "ERROR", response: "", error: "Permission required" });
  assert.equal((await result).error, "Permission required");
  assert.equal(child.writes.length, 1);
  assert.equal(launch().args.some((arg) => /permissions|mode|continue/.test(arg)), false);
});

test("unknown delivery on timeout cannot be resent and a late result remains readable", async (t) => {
  const { session, child } = fixture(t, { session: { turnTimeoutMs: 10 } });
  await assert.rejects(session.send("hello"), { code: "TURN_TIMEOUT", deliveryState: "unknown" });
  assert.equal(session.read().status, "unknown");
  await assert.rejects(session.send("retry"), { code: "SESSION_UNAVAILABLE" });
  child.result({ response: "late answer" });
  assert.equal(session.read().result.response, "late answer");
  assert.equal(session.read().deliveryState, "completed");
  assert.equal(session.read().status, "unknown");
  assert.equal(child.writes.length, 1);
});

test("rejects mismatched result identities with unknown delivery", async (t) => {
  const { session, child } = fixture(t);
  await session.start();
  const result = session.send("hello");
  await new Promise(setImmediate);
  child.result({ conversation_id: OTHER_ID });
  await assert.rejects(result, { code: "INVALID_PROTOCOL", deliveryState: "unknown" });
  assert.equal(session.read().result, null);
});

test("bounds incomplete frames and total per-turn output", async (t) => {
  const frames = fixture(t, { session: { maxFrameBytes: 512 } });
  await frames.session.start();
  const first = frames.session.send("hello");
  await new Promise(setImmediate);
  frames.child.stdout.write("x".repeat(513));
  await assert.rejects(first, { code: "FRAME_LIMIT", deliveryState: "unknown" });
  const output = fixture(t, { session: { maxTurnBytes: 512 } });
  await output.session.start();
  const second = output.session.send("hello");
  await new Promise(setImmediate);
  output.child.stdout.write(`${JSON.stringify({ event: "step_update", text: "x".repeat(500) })}\n`);
  await assert.rejects(second, { code: "OUTPUT_LIMIT", deliveryState: "unknown" });
});

test("invalid JSON and duplicate init fail closed", async (t) => {
  for (const write of [(child) => child.stdout.write("{invalid}\n"), (child) => child.init()]) {
    const { session, child } = fixture(t);
    await session.start();
    const result = session.send("hello");
    await new Promise(setImmediate);
    write(child);
    await assert.rejects(result, { code: "INVALID_PROTOCOL", deliveryState: "unknown" });
  }
});

test("process exit before result preserves unknown delivery", async (t) => {
  const { session, child } = fixture(t);
  await session.start();
  const result = session.send("hello");
  await new Promise(setImmediate);
  child.emit("close", 1, null);
  await assert.rejects(result, { code: "PROCESS_EXIT", deliveryState: "unknown" });
});

test("stdin failure does not trigger a resend", async (t) => {
  const { session, child } = fixture(t, { writeError: new Error("broken pipe") });
  await assert.rejects(session.send("hello"), { code: "STDIN_ERROR", deliveryState: "unknown" });
  assert.equal(child.writes.length, 1);
});

test("startup failures are bounded and never send a prompt", async (t) => {
  const { session, child } = fixture(t, { init: false, session: { startupTimeoutMs: 10 } });
  await assert.rejects(session.send("hello"), { code: "STARTUP_TIMEOUT", deliveryState: "not-sent" });
  assert.equal(child.writes.length, 0);
  assert.ok(child.kills > 0);
});

test("spawn errors reject startup without sending or retaining a timer", async (t) => {
  const synchronous = fixture(t, { session: { spawn() { throw new Error("missing executable"); } } });
  await assert.rejects(synchronous.session.start(), { code: "SPAWN_FAILED", deliveryState: "not-sent" });
  const asynchronous = fixture(t, { init: false });
  const started = asynchronous.session.start();
  asynchronous.child.emit("error", new Error("could not launch"));
  await assert.rejects(started, { code: "PROCESS_ERROR", deliveryState: "not-sent" });
});

test("closing an incomplete turn preserves unknown delivery", async (t) => {
  const { session } = fixture(t, { exitOnEnd: false });
  await session.start();
  const sendResult = assert.rejects(session.send("hello"), { code: "SESSION_CLOSED", deliveryState: "unknown" });
  await new Promise(setImmediate);
  const closed = await session.close();
  await sendResult;
  assert.equal(closed.deliveryState, "unknown");
  assert.equal(closed.status, "closed");
});

test("close ends stdin first and kills only when graceful close expires", async (t) => {
  const graceful = fixture(t);
  await graceful.session.start();
  assert.equal((await graceful.session.close()).status, "closed");
  assert.equal(graceful.child.kills, 0);
  const forced = fixture(t, { exitOnEnd: false });
  await forced.session.start();
  assert.equal((await forced.session.close()).status, "closed");
  assert.equal(forced.child.kills, 1);
  const stubborn = fixture(t, { exitOnEnd: false, exitOnKill: false });
  await stubborn.session.start();
  assert.equal((await stubborn.session.close()).status, "closing");
});

test("rejects relative binaries, relative workspaces, invalid resume IDs and empty prompts", async (t) => {
  assert.throws(() => resolveAntigravityCliBinary({ binary: "agy" }), /absolute/);
  assert.throws(() => new AntigravityCliSession({ cwd: ".", binary: process.execPath }), /absolute/);
  const { session, cwd } = fixture(t);
  assert.throws(() => new AntigravityCliSession({ cwd, binary: process.execPath, conversationId: "latest" }), /conversation ID/);
  await assert.rejects(session.send(" "), { code: "INVALID_PROMPT" });
  assert.equal(session.read().status, "new");
});
