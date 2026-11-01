import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { inspectClaudeWorker, runClaudeWorker } from "../src/background-claude-worker.mjs";

const SESSION = "d524394d-8b2c-4d91-ab33-8e994a729dda";
const REQUEST = "9bd40525-6560-45e9-8079-c6e3054e83e2";
const OTHER = "703e6c1f-921f-4e83-a528-a54967ef5a64";
const TOKEN = "private-worker-token-fixture";

function fixture(t, options = {}) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "claude-worker-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.writes = [];
  child.kills = 0;
  child.stdin = new Writable({
    write(chunk, encoding, callback) { child.writes.push(chunk.toString()); callback(options.writeError); },
    final(callback) { callback(); if (options.exitOnEnd !== false) queueMicrotask(() => child.emit("close", options.exitCode ?? 0, null)); },
  });
  child.kill = () => { child.kills++; queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; };
  child.event = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.init = (overrides = {}) => child.event({ type: "system", subtype: "init", session_id: SESSION, cwd, ...overrides });
  child.replay = (overrides = {}) => child.event({ type: "user", isReplay: true, uuid: REQUEST, session_id: SESSION, parent_tool_use_id: null, ...overrides });
  child.result = (overrides = {}) => child.event({ type: "result", subtype: "success", is_error: false, session_id: SESSION, user_message_uuid: REQUEST, result: "completed", permission_denials: [], ...overrides });
  const events = [];
  const launches = [];
  const settings = {
    executable: process.execPath, cwd, prompt: 'literal ` $(echo unsafe) & "text"\nTiếng Việt', requestId: REQUEST, sessionId: SESSION,
    env: { KEEP_SETTING: "retained", CLAUDECODE: "native-parent", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_SESSION_ID: OTHER },
    relayMcp: { command: process.execPath, args: ["relay.mjs"], env: { WORKER_RELAY_TOKEN: TOKEN } },
    timeoutMs: 1000, onEvent: (value) => events.push(value),
    spawn(binary, args, launchOptions) {
      launches.push({ binary, args, options: launchOptions });
      if (options.spawnError) throw options.spawnError;
      if (options.autoSpawn !== false) queueMicrotask(() => {
        child.emit("spawn");
        if (options.init !== false) child.init(options.initOverrides);
        if (options.replay) child.replay();
      });
      return child;
    },
    ...options.settings,
  };
  return { cwd, child, settings, launches, events, run: () => runClaudeWorker(settings) };
}

function inspect(options = {}) {
  const calls = [];
  const promise = inspectClaudeWorker({ executable: process.execPath, env: {}, run: async (binary, args, settings) => {
    calls.push({ binary, args, settings });
    return args[0] === "--version" ? { stdout: "2.1.314 (Claude Code)\n" } : { stdout: JSON.stringify({ loggedIn: true, email: "private@example.invalid", token: TOKEN }) };
  }, ...options });
  return { promise, calls };
}

test("inspection verifies CLI identity and authentication without exposing account data", async () => {
  const { promise, calls } = inspect();
  const result = await promise;
  assert.equal(result.agent, "claude");
  assert.equal(result.available, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.ready, true);
  assert.equal(result.version, "2.1.314");
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["auth", "status", "--json"]]);
  assert.ok(calls.every((call) => call.settings.windowsHide === true && call.settings.shell === false));
  assert.doesNotMatch(JSON.stringify(result), /private@example|private-worker-token/);
});

test("inspection distinguishes missing login from unavailable or malformed CLI", async () => {
  const missing = await inspectClaudeWorker({ executable: path.join(os.tmpdir(), "missing-cli-fixture.exe"), env: {} });
  assert.equal(missing.code, "CLAUDE_CLI_UNAVAILABLE");
  assert.equal(missing.available, false);
  const loggedOut = await inspect({ run: async (binary, args) => {
    if (args[0] === "--version") return { stdout: "2.1.314 (Claude Code)" };
    throw Object.assign(new Error("private-token"), { code: 1, stdout: '{"loggedIn":false}' });
  } }).promise;
  assert.equal(loggedOut.available, true);
  assert.equal(loggedOut.authenticated, false);
  assert.equal(loggedOut.code, "CLAUDE_CLI_AUTH_REQUIRED");
  assert.equal(loggedOut.ready, false);
  const malformed = await inspect({ run: async (binary, args) => ({ stdout: args[0] === "--version" ? "2.1.314 (Claude Code)" : "private-token invalid JSON" }) }).promise;
  assert.equal(malformed.code, "CLAUDE_CLI_AUTH_CHECK_FAILED");
  assert.equal(malformed.authenticated, null);
  assert.doesNotMatch(JSON.stringify(malformed), /private-token/);
});

test("inspection rejects old CLI versions and native Desktop locations without running them", async () => {
  const old = await inspect({ run: async () => ({ stdout: "2.1.258 (Claude Code)" }) }).promise;
  assert.equal(old.code, "CLAUDE_CLI_UNSUPPORTED_VERSION");
  let called = false;
  const desktop = await inspectClaudeWorker({ executable: path.join(os.tmpdir(), "AnthropicClaude", "claude.exe"), run: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(desktop.code, "CLAUDE_CLI_UNAVAILABLE");
});

test("worker launches privately with ephemeral state and exact relay-only tool grants", async (t) => {
  const box = fixture(t);
  const result = box.run();
  await new Promise(setImmediate);
  const { binary, args, options } = box.launches[0];
  assert.equal(binary, fs.realpathSync.native(process.execPath));
  assert.equal(options.cwd, box.cwd);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.env.WORKER_RELAY_TOKEN, TOKEN);
  assert.equal(options.env.KEEP_SETTING, "retained");
  assert.equal(options.env.CLAUDECODE, undefined);
  assert.equal(options.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(options.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(options.env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS, "1");
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-chrome"));
  assert.equal(args[args.indexOf("--permission-prompts") + 1], "none");
  assert.equal(args.some((arg) => ["--desktop", "--bg", "--resume", "--continue", "--bare", "--permission-mode", "--dangerously-skip-permissions"].includes(arg)), false);
  assert.equal(args.join(" ").includes(TOKEN), false);
  assert.equal(args.join(" ").includes(box.settings.prompt), false);
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]), { mcpServers: { "worker-relay": { command: process.execPath, args: ["relay.mjs"] } } });
  assert.deepEqual(args[args.indexOf("--allowedTools") + 1].split(","), ["worker_status", "list_workers", "send_to_worker", "read_worker_delivery"].map((name) => `mcp__worker-relay__${name}`));
  assert.deepEqual(JSON.parse(box.child.writes[0]), { type: "user", uuid: REQUEST, session_id: SESSION, message: { role: "user", content: box.settings.prompt }, parent_tool_use_id: null, client_composed: true, priority: "later" });
  box.child.result();
  assert.equal((await result).output, "completed");
});

test("init reports the session but only correlated replay proves acceptance", async (t) => {
  const box = fixture(t);
  const result = box.run();
  await new Promise(setImmediate);
  assert.deepEqual(box.events, [{ type: "session", sessionId: SESSION }]);
  box.child.replay();
  box.child.result();
  await result;
  assert.deepEqual(box.events, [{ type: "session", sessionId: SESSION }, { type: "accepted", sessionId: SESSION }]);
});

test("correlated result proves acceptance even when replay was not emitted", async (t) => {
  const box = fixture(t);
  const pending = box.run();
  await new Promise(setImmediate);
  box.child.result({ user_message_uuid: undefined, user_message_uuids: [REQUEST] });
  const result = await pending;
  assert.equal(result.deliveryState, "sent");
  assert.equal(result.sent, true);
  assert.equal(result.requestId, REQUEST);
  assert.equal(box.events.filter((event) => event.type === "accepted").length, 1);
});

test("success waits for a clean exit after the correlated result", async (t) => {
  const box = fixture(t, { exitOnEnd: false });
  let completed = false;
  const pending = box.run().then((value) => { completed = true; return value; });
  await new Promise(setImmediate);
  box.child.result();
  await new Promise(setImmediate);
  assert.equal(completed, false);
  box.child.emit("close", 0, null);
  await pending;
  const failed = fixture(t, { exitCode: 1 });
  const failure = failed.run();
  await new Promise(setImmediate);
  failed.child.result();
  await assert.rejects(failure, { code: "CLAUDE_WORKER_EXIT_FAILED", deliveryState: "unknown", sent: null });
});

test("split UTF-8 and a final unterminated frame retain the exact reply", async (t) => {
  const box = fixture(t, { exitOnEnd: false });
  const pending = box.run();
  await new Promise(setImmediate);
  const frame = Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: SESSION, user_message_uuid: REQUEST, result: "Tiếng Việt 🛰️" }));
  for (const byte of frame) box.child.stdout.write(Buffer.from([byte]));
  box.child.emit("close", 0, null);
  assert.equal((await pending).output, "Tiếng Việt 🛰️");
});

test("foreign request and session receipts cannot confirm delivery", async (t) => {
  for (const overrides of [{ user_message_uuid: OTHER }, { user_message_uuid: undefined }, { user_message_uuids: "invalid" }, { session_id: OTHER }]) {
    const box = fixture(t);
    const pending = box.run();
    await new Promise(setImmediate);
    box.child.result(overrides);
    await assert.rejects(pending, (error) => {
      assert.ok(["CLAUDE_WORKER_INVALID_PROTOCOL", "CLAUDE_WORKER_RESULT_UNCORRELATED"].includes(error.code));
      assert.equal(error.deliveryState, "unknown");
      return true;
    });
    assert.equal(box.events.some((event) => event.type === "accepted"), false);
    assert.equal(box.child.writes.length, 1);
  }
});

test("wrong init workspace or replay identity fails without pretending to receive work", async (t) => {
  for (const options of [{ initOverrides: { cwd: os.tmpdir() } }, { initOverrides: { session_id: OTHER } }]) {
    const box = fixture(t, options);
    await assert.rejects(box.run(), { code: "CLAUDE_WORKER_INVALID_PROTOCOL", deliveryState: "unknown" });
    assert.equal(box.events.length, 0);
  }
  const box = fixture(t);
  const pending = box.run();
  await new Promise(setImmediate);
  box.child.replay({ uuid: OTHER });
  await assert.rejects(pending, { code: "CLAUDE_WORKER_INVALID_PROTOCOL" });
});

test("permission denials remain typed failures even with a successful-looking result", async (t) => {
  const box = fixture(t);
  const pending = box.run();
  await new Promise(setImmediate);
  box.child.result({ permission_denials: [{ tool_name: "Edit", tool_input: { secret: TOKEN } }] });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "CLAUDE_WORKER_PERMISSION_DENIED");
    assert.equal(error.deliveryState, "sent");
    assert.equal(error.sent, true);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test("authentication and terminal execution errors preserve types without raw private details", async (t) => {
  for (const category of ["authentication_failed", "billing_error", "rate_limit", null]) {
    const box = fixture(t, { exitCode: 1 });
    const pending = box.run();
    await new Promise(setImmediate);
    if (category) box.child.event({ type: "assistant", session_id: SESSION, parent_tool_use_id: null, error: category });
    box.child.result({ subtype: "error_during_execution", is_error: true, result: undefined, errors: [TOKEN] });
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, category === "authentication_failed" ? "CLAUDE_CLI_AUTH_REQUIRED" : category ? `CLAUDE_CLI_${category.toUpperCase()}` : "CLAUDE_WORKER_EXECUTION_FAILED");
      assert.equal(error.reasonCode, "ERROR_DURING_EXECUTION");
      assert.equal(error.deliveryState, "sent");
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
    assert.equal(box.child.writes.length, 1);
  }
});

test("pre-spawn errors and cancellation remain not sent", async (t) => {
  const failed = fixture(t, { spawnError: new Error(TOKEN) });
  await assert.rejects(failed.run(), { code: "CLAUDE_WORKER_SPAWN_FAILED", deliveryState: "not_sent", sent: false });
  const controller = new AbortController();
  controller.abort();
  const cancelled = fixture(t, { settings: { signal: controller.signal } });
  await assert.rejects(cancelled.run(), { code: "CLAUDE_WORKER_ABORTED", deliveryState: "not_sent" });
  assert.equal(cancelled.launches.length, 0);
  const emitted = fixture(t, { autoSpawn: false });
  const pending = emitted.run();
  emitted.child.emit("error", new Error(TOKEN));
  await assert.rejects(pending, { code: "CLAUDE_WORKER_PROCESS_FAILED", deliveryState: "not_sent" });
  assert.equal(emitted.child.writes.length, 0);
});

test("startup policy refusals and blocked prompt hooks cannot masquerade as completed work", async (t) => {
  const startup = fixture(t, { exitCode: 1, init: false });
  const refused = startup.run();
  await new Promise(setImmediate);
  startup.child.result({ subtype: "error_during_execution", is_error: true, user_message_uuid: undefined, startup_failure_reason: "provider_not_allowed", errors: [TOKEN] });
  await assert.rejects(refused, { code: "CLAUDE_CLI_STARTUP_PROVIDER_NOT_ALLOWED", phase: "startup", deliveryState: "unknown", reasonCode: "PROVIDER_NOT_ALLOWED" });
  const hook = fixture(t);
  const blocked = hook.run();
  await new Promise(setImmediate);
  hook.child.result({ num_turns: 0, result: "A prompt hook blocked the request" });
  await assert.rejects(blocked, { code: "CLAUDE_WORKER_TURN_NOT_STARTED", deliveryState: "sent" });
});

test("post-write pipe failure crash cancellation and timeout remain uncertain and never replay", async (t) => {
  const broken = fixture(t, { writeError: new Error(TOKEN) });
  await assert.rejects(broken.run(), { code: "CLAUDE_WORKER_STDIN_FAILED", deliveryState: "unknown" });
  const exited = fixture(t);
  const crashed = exited.run();
  await new Promise(setImmediate);
  exited.child.emit("close", 1, null);
  await assert.rejects(crashed, { code: "CLAUDE_WORKER_EXIT_FAILED", deliveryState: "unknown" });
  const controller = new AbortController();
  const stopped = fixture(t, { settings: { signal: controller.signal } });
  const cancelled = stopped.run();
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(cancelled, { code: "CLAUDE_WORKER_ABORTED", deliveryState: "unknown" });
  const timeout = fixture(t, { settings: { timeoutMs: 15 } });
  await assert.rejects(timeout.run(), { code: "CLAUDE_WORKER_TIMEOUT", deliveryState: "unknown" });
  for (const box of [broken, exited, stopped, timeout]) assert.equal(box.child.writes.length, 1);
});

test("missing results and invalid protocol never become successful empty replies", async (t) => {
  const missing = fixture(t);
  const pending = missing.run();
  await new Promise(setImmediate);
  missing.child.emit("close", 0, null);
  await assert.rejects(pending, { code: "CLAUDE_WORKER_RESULT_MISSING", deliveryState: "unknown" });
  const malformed = fixture(t);
  const invalid = malformed.run();
  await new Promise(setImmediate);
  malformed.child.stdout.write(`invalid ${TOKEN}\n`);
  await assert.rejects(invalid, (error) => error.code === "CLAUDE_WORKER_INVALID_PROTOCOL" && !error.message.includes(TOKEN));
});

test("bounds output and diagnostics without retaining oversized or sensitive content", async (t) => {
  for (const stream of ["stdout", "stderr"]) {
    const box = fixture(t);
    const pending = box.run();
    await new Promise(setImmediate);
    box.child[stream].write("x".repeat(stream === "stdout" ? 2 * 1024 * 1024 + 1 : 256 * 1024 + 1));
    await assert.rejects(pending, { code: "CLAUDE_WORKER_OUTPUT_LIMIT", deliveryState: "unknown" });
    assert.equal(box.child.kills, 1);
  }
  const total = fixture(t);
  const exceeded = total.run();
  await new Promise(setImmediate);
  const event = `${JSON.stringify({ type: "system", subtype: "progress", text: "x".repeat(100000) })}\n`;
  for (let index = 0; index < 170; index++) total.child.stdout.write(event);
  await assert.rejects(exceeded, { code: "CLAUDE_WORKER_OUTPUT_LIMIT", deliveryState: "unknown" });
});

test("waits for receipt persistence callbacks and reports callback failure", async (t) => {
  let finish;
  const persisted = new Promise((resolve) => { finish = resolve; });
  const box = fixture(t, { settings: { onEvent: () => persisted } });
  let completed = false;
  const pending = box.run().then(() => { completed = true; });
  await new Promise(setImmediate);
  box.child.result();
  await new Promise(setImmediate);
  assert.equal(completed, false);
  finish();
  await pending;
  const failed = fixture(t, { settings: { onEvent: async () => { throw new Error(TOKEN); } } });
  await assert.rejects(failed.run(), { code: "CLAUDE_WORKER_EVENT_FAILED", deliveryState: "unknown" });
});

test("invalid identifiers options and MCP input fail before spawning", async (t) => {
  for (const overrides of [{ requestId: "native-desktop-task" }, { sessionId: "old-chat" }, { prompt: " " }, { cwd: "relative" }, { timeoutMs: 0 }, { relayMcp: { command: "node", args: [], env: {} } }]) {
    const box = fixture(t, { settings: overrides });
    await assert.rejects(box.run(), (error) => error.deliveryState === "not_sent" && error.sent === false);
    assert.equal(box.launches.length, 0);
  }
});
