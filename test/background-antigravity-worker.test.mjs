import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { inspectAntigravityWorker, runAntigravityWorker } from "../src/background-antigravity-worker.mjs";

const SESSION_ID = "d524394d-8b2c-4d91-ab33-8e994a729dda";
const OTHER_ID = "9bd40525-6560-45e9-8079-c6e3054e83e2";
const REQUEST_ID = "36390ec9-c17c-48e9-9c4e-88c6aa44aab4";
const TOOL_NAMES = ["worker_status", "list_workers", "send_to_worker", "read_worker_delivery"];
const RELAY = {
  command: process.execPath,
  args: ["worker-relay.mjs"],
  env: {
    AGENT_RELAY_ENDPOINT: "http://127.0.0.1:5199",
    AGENT_RELAY_TOKEN: "private-worker-capability",
    AGENT_RELAY_WORKER_ID: "antigravity-worker-fixture",
    AGENT_RELAY_REQUEST_ID: REQUEST_ID,
  },
};

function fixture(t, options = {}) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "background-agy-")));
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.writes = [];
  child.kills = 0;
  child.exited = false;
  child.exit = (code = 0, signal = null) => {
    if (child.exited) return;
    child.exited = true;
    child.emit("close", code, signal);
  };
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      child.writes.push(chunk.toString());
      callback(options.writeError);
      options.onWrite?.(child);
    },
    final(callback) { callback(); queueMicrotask(() => { options.onEnd?.(child); child.exit(); }); },
  });
  child.kill = () => { child.kills++; queueMicrotask(() => child.exit(null, "SIGTERM")); return true; };
  child.event = (event) => child.stdout.write(`${JSON.stringify(event)}\n`);
  child.init = (overrides = {}) => child.event({
    event: "init", conversation_id: SESSION_ID,
    init: { cwd, permission_mode: "request-review", tools: TOOL_NAMES.map((name) => `mcp__worker-relay__${name}`) },
    ...overrides,
  });
  child.accept = (overrides = {}) => child.event({
    event: "step_update", step_update: { conversation_id: SESSION_ID, state: "DONE", step_type: "user_input", ...overrides },
  });
  child.result = (overrides = {}) => child.event({ event: "result", result: { conversation_id: SESSION_ID, status: "SUCCESS", response: "worker answer", ...overrides } });
  const launches = [];
  const events = [];
  const args = {
    executable: process.execPath, cwd, prompt: "private job prompt", requestId: REQUEST_ID,
    env: { PATH: process.env.PATH, NATIVE_CONTEXT: "preserved", CODEX_THREAD_ID: "native-thread", CLAUDE_SESSION_ID: "native-session", AGENT_RELAY_TOKEN: "stale-capability" },
    relayMcp: RELAY, timeoutMs: 1000,
    onEvent: (event) => events.push(event),
    spawn(executable, argv, settings) {
      launches.push({ executable, argv, settings });
      if (options.init !== false) queueMicrotask(() => child.init(options.initOverrides));
      options.onSpawn?.(child);
      return child;
    },
    ...options.args,
  };
  t.after(() => { child.exit(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { args, child, events, launches, cwd, run: (overrides = {}) => runAntigravityWorker({ ...args, ...overrides }) };
}

test("inspection checks only version and leaves unsupported auth probing unverified", async () => {
  const calls = [];
  const result = await inspectAntigravityWorker({ executable: process.execPath, env: {}, run: async (...args) => { calls.push(args); return { stdout: "1.4.9\n", stderr: "" }; } });
  assert.equal(result.agent, "antigravity");
  assert.equal(result.available, true);
  assert.equal(result.authenticated, null);
  assert.equal(result.ready, false);
  assert.equal(result.version, "1.4.9");
  assert.equal(result.code, "ANTIGRAVITY_AUTH_UNVERIFIED");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ["--version"]);
  assert.equal(calls[0][2].windowsHide, true);
  assert.equal(calls[0][2].shell, false);
});

test("inspection never exposes missing paths or failed command diagnostics", async () => {
  let called = false;
  const missing = await inspectAntigravityWorker({ executable: path.join(os.tmpdir(), "missing-private-provider.exe"), env: {}, run: async () => { called = true; } });
  assert.equal(missing.available, false);
  assert.equal(missing.authenticated, null);
  assert.equal(called, false);
  assert.doesNotMatch(JSON.stringify(missing), /missing-private-provider/);
  const failed = await inspectAntigravityWorker({ executable: process.execPath, env: {}, run: async () => { throw Object.assign(new Error("secret-account@example.test bearer-token"), { stdout: "private", stderr: "token=hidden" }); } });
  assert.equal(failed.available, false);
  assert.equal(failed.authenticated, null);
  assert.doesNotMatch(JSON.stringify(failed), /secret-account|bearer-token|hidden|private/);
});

test("inspection rejects invalid version output and explicit nonzero status", async () => {
  for (const output of [{ stdout: "arbitrary private output" }, { stdout: "1.4.9", exitCode: 2 }]) {
    const result = await inspectAntigravityWorker({ executable: process.execPath, env: {}, run: async () => output });
    assert.equal(result.available, false);
    assert.equal(result.ready, false);
    assert.equal(result.authenticated, null);
  }
});

test("runs a fresh hidden CLI with literal input and isolated relay identity", async (t) => {
  const f = fixture(t);
  const prompt = "literal ` $(echo unsafe) & \"quoted\"\nTiếng Việt";
  const pending = f.run({ prompt, sessionId: OTHER_ID });
  await new Promise(setImmediate);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0].argv, ["--input-format", "stream-json", "--output-format", "stream-json"]);
  assert.equal(f.launches[0].settings.windowsHide, true);
  assert.equal(f.launches[0].settings.shell, false);
  assert.equal(f.launches[0].settings.cwd, f.cwd);
  assert.equal(f.launches[0].settings.env.CODEX_THREAD_ID, undefined);
  assert.equal(f.launches[0].settings.env.CLAUDE_SESSION_ID, undefined);
  assert.equal(f.launches[0].settings.env.NATIVE_CONTEXT, "preserved");
  assert.equal(f.launches[0].settings.env.AGENT_RELAY_TOKEN, RELAY.env.AGENT_RELAY_TOKEN);
  assert.deepEqual(JSON.parse(f.child.writes[0]), { event: "user", message: { content: prompt } });
  assert.deepEqual(f.events, [{ type: "session", sessionId: SESSION_ID }]);
  f.child.accept();
  f.child.result();
  const result = await pending;
  assert.equal(result.output, "worker answer");
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.workerSessionId, OTHER_ID);
  assert.equal(result.deliveryState, "sent");
  assert.equal(result.sent, true);
  assert.equal(result.relayToolsVerified, true);
  assert.equal(result.relayToolDiscovery, "explicit-tools");
  assert.equal(f.events.filter((event) => event.type === "accepted").length, 1);
  assert.equal(f.child.exited, true);
  assert.equal(f.child.kills, 0);
});

test("a terminal correlated result proves acceptance when user-input events are absent", async (t) => {
  const f = fixture(t);
  const pending = f.run();
  await new Promise(setImmediate);
  f.child.result();
  await pending;
  assert.deepEqual(f.events, [{ type: "session", sessionId: SESSION_ID }, { type: "accepted", sessionId: SESSION_ID }]);
});

test("waits for init and verifies all advertised relay tools before writing", async (t) => {
  const f = fixture(t, { init: false });
  const pending = assert.rejects(f.run(), { code: "ANTIGRAVITY_RELAY_TOOLS_MISSING", phase: "relay", deliveryState: "not_sent", sent: false });
  await new Promise(setImmediate);
  assert.equal(f.child.writes.length, 0);
  f.child.init({ init: { cwd: f.cwd, permission_mode: "request-review", tools: ["mcp__worker-relay__worker_status", "mcp__other-relay__send_to_worker"] } });
  await pending;
  assert.equal(f.child.writes.length, 0);
  assert.equal(f.events.some((event) => event.type === "accepted"), false);
});

test("AGY 1.4.9 native MCP dispatcher catalog permits work without claiming individual relay tools", async (t) => {
  const f = fixture(t, { init: false });
  const pending = f.run();
  assert.equal(f.child.writes.length, 0);
  f.child.init({ init: { cwd: f.cwd, permission_mode: "request-review", tools: ["ask_permission", "call_mcp_tool", "run_command", "view_file", "write_to_file"] } });
  await new Promise(setImmediate);
  assert.equal(f.child.writes.length, 1);
  assert.deepEqual(f.events, [{ type: "session", sessionId: SESSION_ID }]);
  f.child.accept();
  f.child.result();
  const result = await pending;
  assert.equal(result.relayToolsVerified, false);
  assert.equal(result.relayToolDiscovery, "mcp-dispatcher");
  assert.equal(result.deliveryState, "sent");
  assert.equal(f.child.exited, true);
});

test("advertised catalogs without the native dispatcher or every relay tool remain blocked", async (t) => {
  for (const tools of [[], ["run_command"], ["mcp__other__call_mcp_tool"], ["call-mcp-tool"], ["mcp__worker-relay__worker_status", "run_command"]]) {
    const f = fixture(t, { init: false });
    const pending = assert.rejects(f.run(), { code: "ANTIGRAVITY_RELAY_TOOLS_MISSING", phase: "relay", deliveryState: "not_sent", sent: false });
    f.child.init({ init: { cwd: f.cwd, permission_mode: "request-review", tools } });
    await pending;
    assert.equal(f.child.writes.length, 0);
    assert.equal(f.events.some((event) => event.type === "accepted"), false);
  }
});

test("older init without tool advertisement does not claim verified relay tools", async (t) => {
  const f = fixture(t, { init: false });
  const pending = f.run();
  f.child.init({ init: { cwd: f.cwd, permission_mode: "request-review" } });
  await new Promise(setImmediate);
  f.child.result();
  const result = await pending;
  assert.equal(result.relayToolsVerified, false);
  assert.equal(result.relayToolDiscovery, "unadvertised");
});

test("rejects resume and invalid relay grants before starting a process", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run({ conversationId: SESSION_ID }), { code: "ANTIGRAVITY_WORKER_RESUME_UNSUPPORTED", deliveryState: "not_sent", sent: false });
  await assert.rejects(f.run({ resume: true }), { code: "ANTIGRAVITY_WORKER_RESUME_UNSUPPORTED", deliveryState: "not_sent", sent: false });
  await assert.rejects(f.run({ relayMcp: { ...RELAY, env: {} } }), { code: "ANTIGRAVITY_RELAY_GRANT_INVALID", deliveryState: "not_sent" });
  await assert.rejects(f.run({ relayMcp: { ...RELAY, env: { ...RELAY.env, AGENT_RELAY_REQUEST_ID: OTHER_ID } } }), { code: "ANTIGRAVITY_RELAY_GRANT_INVALID", deliveryState: "not_sent" });
  await assert.rejects(f.run({ prompt: " " }), { code: "ANTIGRAVITY_WORKER_INPUT_INVALID", deliveryState: "not_sent" });
  assert.equal(f.launches.length, 0);
});

test("startup authentication failures are typed and contain no stderr contents", async (t) => {
  const f = fixture(t, { init: false });
  const pending = assert.rejects(f.run(), (error) => {
    assert.equal(error.code, "ANTIGRAVITY_AUTH_REQUIRED");
    assert.equal(error.phase, "authentication");
    assert.equal(error.deliveryState, "not_sent");
    assert.equal(error.sent, false);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-account|secret-url|private-worker-capability/);
    return true;
  });
  f.child.stderr.write("authentication req");
  f.child.stderr.write("uired: private-account@example.test https://secret-url/?token=private-worker-capability\n");
  f.child.exit(1);
  await pending;
  assert.equal(f.child.writes.length, 0);
});

test("post-write authentication failure remains uncertain without acceptance proof", async (t) => {
  const f = fixture(t);
  const pending = assert.rejects(f.run(), { code: "ANTIGRAVITY_AUTH_REQUIRED", deliveryState: "unknown", sent: null });
  await new Promise(setImmediate);
  f.child.stderr.write("authentication required\n");
  f.child.exit(1);
  await pending;
  assert.equal(f.child.writes.length, 1);
  assert.equal(f.events.some((event) => event.type === "accepted"), false);
});

test("soft-denied stderr rejects an otherwise successful turn without leaking prompt or response", async (t) => {
  const f = fixture(t);
  const pending = assert.rejects(f.run(), (error) => {
    assert.equal(error.code, "ANTIGRAVITY_PERMISSION_DENIED");
    assert.equal(error.deliveryState, "sent");
    assert.equal(error.sent, true);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private job prompt|private response|private-command|private-worker-capability/);
    return true;
  });
  await new Promise(setImmediate);
  f.child.stderr.write("Tool mcp__worker-relay__send_to_worker requires appro");
  f.child.stderr.write("val and was soft-denied: private-command token=private-worker-capability\n");
  f.child.result({ response: "private response" });
  await pending;
  assert.equal(f.child.writes.length, 1);
});

test("waits for shutdown diagnostics before declaring a successful turn", async (t) => {
  const f = fixture(t, { onEnd(child) { child.stderr.write("Tool worker-relay/send_to_worker requires approval\n"); } });
  const pending = assert.rejects(f.run(), { code: "ANTIGRAVITY_PERMISSION_DENIED", deliveryState: "sent", sent: true });
  await new Promise(setImmediate);
  f.child.result();
  await pending;
});

test("excessive diagnostics fail with a bounded safe report instead of hiding later denial", async (t) => {
  const f = fixture(t);
  const pending = assert.rejects(f.run(), (error) => {
    assert.equal(error.code, "ANTIGRAVITY_WORKER_DIAGNOSTIC_LIMIT");
    assert.equal(error.deliveryState, "sent");
    assert.equal(error.sent, true);
    assert.ok(JSON.stringify(error).length < 1000);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private-output/);
    return true;
  });
  await new Promise(setImmediate);
  f.child.stderr.write("private-output".repeat(6000));
  f.child.result();
  await pending;
});

test("permission tool events reject success while unrelated tool errors remain recoverable", async (t) => {
  for (const denied of [true, false]) {
    const f = fixture(t);
    const promise = f.run();
    const pending = denied ? assert.rejects(promise, { code: "ANTIGRAVITY_PERMISSION_DENIED", deliveryState: "sent", sent: true }) : promise;
    await new Promise(setImmediate);
    f.child.event({ event: "step_update", step_update: { conversation_id: SESSION_ID, step_type: "tool", state: "DONE", tool_info: { error: { type: denied ? "PERMISSION_DENIED" : "NOT_FOUND", message: "private native error" } } } });
    f.child.result();
    await pending;
  }
});

test("native error results prove delivery and never expose native response or error text", async (t) => {
  const f = fixture(t);
  const pending = assert.rejects(f.run(), (error) => {
    assert.equal(error.code, "ANTIGRAVITY_WORKER_TURN_FAILED");
    assert.equal(error.deliveryState, "sent");
    assert.equal(error.sent, true);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private response|private failure/);
    return true;
  });
  await new Promise(setImmediate);
  f.child.result({ status: "ERROR", response: "private response", error: "private failure" });
  await pending;
});

test("mismatched step identities cannot prove acceptance", async (t) => {
  const f = fixture(t);
  const pending = assert.rejects(f.run(), { code: "ANTIGRAVITY_WORKER_PROTOCOL_ERROR", deliveryState: "unknown", sent: null });
  await new Promise(setImmediate);
  f.child.accept({ conversation_id: OTHER_ID });
  await pending;
  assert.equal(f.events.some((event) => event.type === "accepted"), false);
});

test("process loss and write failures after dispatch remain unknown and never retry", async (t) => {
  for (const writeError of [undefined, new Error("private broken pipe")]) {
    const f = fixture(t, { writeError });
    const pending = assert.rejects(f.run(), { deliveryState: "unknown", sent: null });
    await new Promise(setImmediate);
    if (!writeError) f.child.exit(1);
    await pending;
    assert.equal(f.child.writes.length, 1);
    assert.equal(f.launches.length, 1);
  }
});

test("cancellation before startup sends nothing", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("private cancellation"));
  await assert.rejects(f.run({ signal: controller.signal }), { code: "ANTIGRAVITY_WORKER_ABORTED", phase: "cancellation", deliveryState: "not_sent", sent: false });
  assert.equal(f.launches.length, 0);
});

test("cancellation after write preserves uncertain or proven delivery", async (t) => {
  for (const accepted of [false, true]) {
    const f = fixture(t);
    const controller = new AbortController();
    const pending = assert.rejects(f.run({ signal: controller.signal }), { code: "ANTIGRAVITY_WORKER_ABORTED", deliveryState: accepted ? "sent" : "unknown", sent: accepted ? true : null });
    await new Promise(setImmediate);
    if (accepted) f.child.accept();
    controller.abort();
    await pending;
    assert.equal(f.child.writes.length, 1);
    assert.ok(f.child.kills > 0);
  }
});

test("startup and turn timeouts retain their correct dispatch certainty", async (t) => {
  for (const init of [false, true]) {
    const f = fixture(t, { init, args: { timeoutMs: 20 } });
    await assert.rejects(f.run(), { code: "ANTIGRAVITY_WORKER_TIMEOUT", phase: "observation", deliveryState: init ? "unknown" : "not_sent", sent: init ? null : false });
    assert.equal(f.child.writes.length, init ? 1 : 0);
    assert.equal(f.launches.length, 1);
  }
});

test("observer failures are sanitized and cannot downgrade proven acceptance", async (t) => {
  const f = fixture(t);
  const pending = assert.rejects(f.run({ onEvent(event) { if (event.type === "accepted") throw new Error("private observer detail"); } }), (error) => {
    assert.equal(error.code, "ANTIGRAVITY_WORKER_OBSERVER_FAILED");
    assert.equal(error.deliveryState, "sent");
    assert.equal(error.sent, true);
    assert.doesNotMatch(error.message + JSON.stringify(error), /private observer detail/);
    return true;
  });
  await new Promise(setImmediate);
  f.child.result();
  await pending;
});

test("an unresponsive event observer cannot bypass the job deadline", async (t) => {
  for (const stuckAt of ["session", "accepted"]) {
    const f = fixture(t);
    const pending = assert.rejects(f.run({ timeoutMs: 30, onEvent(event) { if (event.type === stuckAt) return new Promise(() => {}); } }), {
      code: "ANTIGRAVITY_WORKER_TIMEOUT", deliveryState: stuckAt === "accepted" ? "sent" : "not_sent", sent: stuckAt === "accepted" ? true : false,
    });
    await new Promise(setImmediate);
    if (stuckAt === "accepted") f.child.result();
    await pending;
    assert.equal(f.child.writes.length, stuckAt === "accepted" ? 1 : 0);
  }
});
