import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { inspectCodexWorker, runCodexWorker } from "../src/background-codex-worker.mjs";

const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const PROVIDER_ID = "87654321-4321-4321-8321-cba987654321";
const TOKEN = "worker-secret-capability-123456789";
const RELAY = {
  command: process.execPath,
  args: ["relay-worker.mjs"],
  env: {
    AGENT_RELAY_ENDPOINT: "local-relay",
    AGENT_RELAY_TOKEN: TOKEN,
    AGENT_RELAY_WORKER_ID: SESSION_ID,
    AGENT_RELAY_REQUEST_ID: "request-1",
  },
};

class Child extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.writes = [];
    this.killed = false;
    this.stdin.on("data", (data) => this.writes.push(data.toString("utf8")));
  }
  kill() { this.killed = true; }
  event(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  start() {
    this.event({ type: "thread.started", thread_id: PROVIDER_ID });
    this.event({ type: "turn.started" });
  }
  complete(text = "done") {
    this.event({ type: "item.completed", item: { id: "item-1", type: "agent_message", text } });
    this.event({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 } });
  }
  close(code = 0) { this.emit("close", code, null); }
}

function fixture(options = {}) {
  const calls = [];
  const events = [];
  const job = new Child();
  const initial = options.initial ?? [{ name: "codex-native-relay", enabled: true }, { name: "disabled-server", enabled: false }];
  const checked = options.checked ?? [
    ...(Array.isArray(initial) ? initial : []).map((entry) => ({ ...entry, enabled: false })),
    { name: "worker-relay", enabled: true, transport: { type: "stdio", command: RELAY.command, args: RELAY.args, env: null, env_vars: Object.keys(RELAY.env).sort(), cwd: null } },
  ];
  const settings = {
    executable: process.execPath,
    cwd: process.cwd(),
    prompt: 'Authorized prompt ` $(literal) & "quotes"\nTiếng Việt',
    requestId: "request-1",
    sessionId: SESSION_ID,
    relayMcp: RELAY,
    env: {
      CODEX_HOME: "preserved-codex-home",
      OPENAI_API_KEY: "preserved-user-auth",
      CODEX_APP_TOOLS_PIPE_PATH: "desktop-pipe",
      CODEX_THREAD_ID: "desktop-thread",
      CODEX_NATIVE_RELAY_SOCKET: "desktop-relay",
      CODEX_BRIDGE_AUTOSTART: "1",
      AGENT_RELAY_TOKEN: "old-parent-token",
    },
    onEvent: (event) => events.push(event),
    timeoutMs: 1000,
    spawn(executable, args, settings) {
      const isJob = args.includes("exec");
      const child = isJob ? job : new Child();
      const call = { executable, args, settings, child };
      calls.push(call);
      queueMicrotask(() => {
        if (options.onSpawn?.(call, calls.length) === false) return;
        child.emit("spawn");
        if (!isJob) {
          child.stdout.write(JSON.stringify(calls.length === 1 ? initial : checked));
          child.close();
        }
      });
      return child;
    },
    ...options.settings,
  };
  return { settings, calls, events, job, run: () => runCodexWorker(settings) };
}

async function launched(fixture) {
  const pending = fixture.run();
  await new Promise(setImmediate);
  return { pending };
}

function inspectionRun(login = { stderr: "Logged in using ChatGPT\n" }, capture = []) {
  return async (executable, args, options) => {
    capture.push({ executable, args, options });
    if (args[0] === "--version") return { stdout: "codex-cli 0.166.0-alpha.5.1\n" };
    if (args[0] === "exec") return { stdout: "--json --ephemeral --color --config" };
    if (login instanceof Error) throw login;
    return login;
  };
}

test("inspection verifies installed options and stored authentication without exposing credentials", async () => {
  const calls = [];
  const result = await inspectCodexWorker({ executable: process.execPath, run: inspectionRun({ stderr: `API key configured - ${TOKEN}\nAuthentication is checked when you send a request.` }, calls) });
  assert.equal(result.available, true);
  assert.equal(result.authenticated, true);
  assert.equal(result.ready, true);
  assert.equal(result.version, "0.166.0-alpha.5.1");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.deepEqual(calls.map(({ args }) => args), [["--version"], ["exec", "--help"], ["login", "status"]]);
  assert.ok(calls.every(({ options }) => options.shell === false && options.windowsHide === true && options.maxBuffer > 0));
});

test("inspection distinguishes absent login, unknown authentication and unavailable executable", async () => {
  const missing = await inspectCodexWorker({ executable: process.execPath, run: inspectionRun(Object.assign(new Error(TOKEN), { stderr: "Not logged in" })) });
  assert.equal(missing.authenticated, false);
  assert.equal(missing.code, "AUTH_REQUIRED");
  const unknown = await inspectCodexWorker({ executable: process.execPath, run: inspectionRun({ stderr: TOKEN }) });
  assert.equal(unknown.authenticated, null);
  assert.equal(unknown.ready, false);
  assert.equal(unknown.code, "AUTH_UNVERIFIED");
  const unavailable = await inspectCodexWorker({ executable: process.execPath, run: async () => { throw Object.assign(new Error(TOKEN), { code: "ENOENT" }); } });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.code, "CLI_UNAVAILABLE");
  assert.equal(JSON.stringify([missing, unknown, unavailable]).includes(TOKEN), false);
});

test("inspection rejects shell shims and unsupported CLI options", async () => {
  const shim = await inspectCodexWorker({ executable: "codex.cmd", platform: "win32", run: () => assert.fail("must not execute a shell shim") });
  assert.equal(shim.code, "CLI_UNAVAILABLE");
  const unsupported = await inspectCodexWorker({ executable: process.execPath, run: async (_executable, args) => ({ stdout: args[0] === "--version" ? "codex-cli 0.1.0" : "--json" }) });
  assert.equal(unsupported.code, "CLI_UNSUPPORTED");
  assert.equal(unsupported.ready, false);
});

test("isolates native and plugin MCPs without changing auth or policy and sends prompt only through stdin", async () => {
  const f = fixture();
  const { pending } = await launched(f);
  assert.equal(f.calls.length, 3);
  const { args, settings } = f.calls[2];
  for (const call of f.calls) {
    assert.equal(call.settings.shell, false);
    assert.equal(call.settings.windowsHide, true);
    assert.equal(JSON.stringify(call.args).includes(TOKEN), false);
    assert.equal(JSON.stringify(call.args).includes(f.settings.prompt), false);
    assert.deepEqual(call.args.slice(0, 4), ["--disable", "plugins", "--disable", "apps"]);
  }
  assert.ok(args.includes("mcp_servers.codex-native-relay.enabled=false"));
  assert.ok(args.includes("mcp_servers.disabled-server.enabled=false"));
  assert.ok(args.includes("mcp_servers.worker-relay.required=true"));
  assert.ok(args.includes('mcp_servers.worker-relay.enabled_tools=["worker_status","list_workers","send_to_worker","read_worker_delivery"]'));
  assert.deepEqual(args.slice(-8), ["exec", "--json", "--ephemeral", "--color", "never", "-C", process.cwd(), "-"]);
  assert.equal(args.some((arg) => /sandbox|approval|ignore-user-config|resume|thread-source/.test(arg)), false);
  assert.equal(settings.env.CODEX_HOME, "preserved-codex-home");
  assert.equal(settings.env.OPENAI_API_KEY, "preserved-user-auth");
  assert.equal(settings.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  assert.equal(settings.env.CODEX_THREAD_ID, undefined);
  assert.equal(settings.env.CODEX_NATIVE_RELAY_SOCKET, undefined);
  assert.equal(settings.env.CODEX_BRIDGE_AUTOSTART, undefined);
  assert.equal(settings.env.AGENT_RELAY_TOKEN, TOKEN);
  assert.equal(f.job.writes.join(""), f.settings.prompt);
  assert.equal(f.job.stdin.writableEnded, true);
  assert.deepEqual(f.events, []);
  f.job.start();
  f.job.complete();
  f.job.close();
  const result = await pending;
  assert.equal(result.output, "done");
  assert.equal(result.sessionId, SESSION_ID);
  assert.equal(result.deliveryState, "sent");
  assert.deepEqual(f.events, [{ type: "session", sessionId: SESSION_ID }, { type: "accepted", sessionId: SESSION_ID }]);
});

test("thread.started alone never marks delivery accepted", async () => {
  const f = fixture();
  const { pending } = await launched(f);
  f.job.event({ type: "thread.started", thread_id: PROVIDER_ID });
  assert.deepEqual(f.events, [{ type: "session", sessionId: SESSION_ID }]);
  f.job.close(1);
  await assert.rejects(pending, { code: "PROCESS_EXIT", phase: "result", deliveryState: "unknown", sent: false });
});

test("requires turn completion and successful process exit", async () => {
  const f = fixture();
  const { pending } = await launched(f);
  f.job.start();
  f.job.complete();
  f.job.close(9);
  await assert.rejects(pending, { code: "PROCESS_EXIT", deliveryState: "unknown", sent: true });
  const incomplete = fixture();
  const next = await launched(incomplete);
  incomplete.job.start();
  incomplete.job.close();
  await assert.rejects(next.pending, { code: "INVALID_PROTOCOL", deliveryState: "unknown" });
});

test("handles split UTF-8 and a final JSON frame without a newline", async () => {
  const f = fixture();
  const { pending } = await launched(f);
  f.job.start();
  const message = Buffer.from(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Tiếng Việt 🛰️" } })}\n`);
  for (const byte of message) f.job.stdout.write(Buffer.from([byte]));
  f.job.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }));
  f.job.stderr.write("A harmless warning\n");
  f.job.close();
  assert.equal((await pending).output, "Tiếng Việt 🛰️");
});

test("reports typed sanitized auth and policy failures without replaying", async () => {
  for (const [message, code] of [[`Unauthorized 401 ${TOKEN}`, "AUTH_REQUIRED"], [`Permission denied ${TOKEN}`, "PERMISSION_DENIED"], [TOKEN, "TURN_FAILED"]]) {
    const f = fixture();
    const { pending } = await launched(f);
    f.job.start();
    f.job.event({ type: "turn.failed", error: { message } });
    await assert.rejects(pending, (error) => {
      assert.equal(error.code, code);
      assert.equal(error.deliveryState, "unknown");
      assert.equal(error.sent, true);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    });
    assert.equal(f.calls.length, 3);
    assert.equal(f.job.writes.length, 1);
  }
});

test("rejects malformed or out-of-order terminal protocol data", async () => {
  for (const send of [
    (job) => job.stdout.write(`${TOKEN}\n`),
    (job) => job.event({ type: "turn.started" }),
    (job) => { job.start(); job.event({ type: "turn.completed", usage: { input_tokens: TOKEN } }); },
    (job) => { job.start(); job.event({ type: "thread.started", thread_id: PROVIDER_ID }); },
  ]) {
    const f = fixture();
    const { pending } = await launched(f);
    send(f.job);
    await assert.rejects(pending, { code: "INVALID_PROTOCOL", deliveryState: "unknown" });
    assert.equal(f.job.killed, true);
  }
});

test("rejects changed MCP inventory or unexpected enabled MCP before sending any prompt", async () => {
  for (const checked of [
    [{ name: "new-server", enabled: true }],
    [{ name: "codex-native-relay", enabled: true }, { name: "worker-relay", enabled: true }],
    [{ name: "unsafe.name", enabled: false }],
  ]) {
    const f = fixture({ checked });
    await assert.rejects(f.run(), { code: "MCP_ISOLATION_FAILED", phase: "configure", deliveryState: "not-sent", sent: false });
    assert.equal(f.calls.length, 2);
    assert.equal(f.job.writes.length, 0);
  }
});

test("rejects conflicting worker registration and malformed inventory without running a job", async () => {
  const conflict = fixture({ initial: [{ name: "worker-relay", enabled: false }] });
  await assert.rejects(conflict.run(), { code: "MCP_CONFLICT", deliveryState: "not-sent" });
  assert.equal(conflict.calls.length, 1);
  const invalid = fixture({ initial: { private: TOKEN } });
  await assert.rejects(invalid.run(), { code: "MCP_ISOLATION_FAILED", deliveryState: "not-sent" });
});

test("rejects mismatched relay transport or inherited relay environment", async () => {
  for (const change of [{ command: "wrong" }, { args: [] }, { env_vars: ["CODEX_APP_TOOLS_PIPE_PATH"] }, { env: { SECRET: TOKEN } }, { cwd: "unrelated" }]) {
    const f = fixture({ initial: [], checked: [{ name: "worker-relay", enabled: true, transport: { type: "stdio", command: RELAY.command, args: RELAY.args, env: null, env_vars: Object.keys(RELAY.env).sort(), cwd: null, ...change } }] });
    await assert.rejects(f.run(), { code: "MCP_ISOLATION_FAILED", deliveryState: "not-sent" });
    assert.equal(f.calls.length, 2);
  }
});

test("classifies configuration auth and policy errors without retaining raw stderr", async () => {
  for (const [message, code] of [["Not logged in", "AUTH_REQUIRED"], ["allowed_sandbox_modes", "PERMISSION_DENIED"], ["Error loading config.toml", "CONFIG_INVALID"]]) {
    const f = fixture({ onSpawn: ({ child }, count) => {
      if (count !== 1) return;
      child.stderr.write(`${message} ${TOKEN}`);
      child.close(1);
      return false;
    } });
    await assert.rejects(f.run(), (error) => error.code === code && error.deliveryState === "not-sent" && !error.message.includes(TOKEN));
  }
});

test("launch failure before stdin is not sent and partial input failure is unknown", async () => {
  const early = fixture({ onSpawn: ({ child, args }) => {
    if (!args.includes("exec")) return;
    child.emit("error", new Error(TOKEN));
    return false;
  } });
  await assert.rejects(early.run(), { code: "SPAWN_FAILED", phase: "launch", deliveryState: "not-sent", sent: false });
  const partial = fixture();
  const { pending } = await launched(partial);
  partial.job.stdin.emit("error", new Error(TOKEN));
  await assert.rejects(pending, { code: "STDIN_ERROR", phase: "send", deliveryState: "unknown", sent: false });
  assert.equal(partial.job.writes.length, 1);
});

test("abort before launch starts no process and abort after stdin never retries", async () => {
  const before = new AbortController();
  before.abort();
  const early = fixture({ settings: { signal: before.signal } });
  await assert.rejects(early.run(), { code: "ABORTED", deliveryState: "not-sent" });
  assert.equal(early.calls.length, 0);
  const after = new AbortController();
  const f = fixture({ settings: { signal: after.signal } });
  const { pending } = await launched(f);
  after.abort();
  await assert.rejects(pending, { code: "ABORTED", deliveryState: "unknown" });
  assert.equal(f.calls.length, 3);
  assert.equal(f.job.killed, true);
});

test("bounds output and diagnostics and reports timeout after writing as unknown", async () => {
  for (const write of [(job) => job.stdout.write("x".repeat(2 * 1024 * 1024 + 1)), (job) => job.stderr.write("x".repeat(256 * 1024 + 1))]) {
    const f = fixture();
    const { pending } = await launched(f);
    write(f.job);
    await assert.rejects(pending, { code: "OUTPUT_LIMIT", deliveryState: "unknown" });
  }
  const timed = fixture({ settings: { timeoutMs: 30 } });
  await assert.rejects(timed.run(), { code: "TIMEOUT", deliveryState: "unknown" });
  assert.equal(timed.calls.length, 3);
});

test("rejects input and capability leakage before launching a process", async () => {
  for (const settings of [
    { sessionId: "not-a-uuid" },
    { cwd: "relative" },
    { prompt: "" },
    { relayMcp: { ...RELAY, args: [TOKEN] } },
    { relayMcp: { ...RELAY, env: { CODEX_HOME: "override" } } },
  ]) {
    const f = fixture({ settings });
    await assert.rejects(f.run(), { code: "INVALID_INPUT", phase: "validate", deliveryState: "not-sent" });
    assert.equal(f.calls.length, 0);
  }
});

test("does not report success before asynchronous receipt recording completes", async () => {
  let release;
  const recorded = new Promise((resolve) => { release = resolve; });
  const f = fixture({ settings: { onEvent: () => recorded } });
  const { pending } = await launched(f);
  let finished = false;
  pending.then(() => { finished = true; });
  f.job.start();
  f.job.complete();
  f.job.close();
  await new Promise(setImmediate);
  assert.equal(finished, false);
  release();
  assert.equal((await pending).deliveryState, "sent");
  const failed = fixture({ settings: { onEvent: async () => { throw new Error(TOKEN); } } });
  const next = await launched(failed);
  failed.job.start();
  await assert.rejects(next.pending, { code: "EVENT_HANDLER_FAILED", deliveryState: "unknown" });
});
