import { execFile, spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { resolveCodexBin } from "./platform.mjs";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MCP_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_CAPTURE = 2 * 1024 * 1024;
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_STDERR = 256 * 1024;
const MCP_TOOLS = ["worker_status", "list_workers", "send_to_worker", "read_worker_delivery"];
const ISOLATION_FLAGS = ["--disable", "plugins", "--disable", "apps"];
const ERRORS = {
  INVALID_INPUT: "Codex worker input is invalid",
  CLI_UNAVAILABLE: "Codex CLI executable is unavailable",
  CLI_UNSUPPORTED: "Codex CLI does not support the required background worker options",
  AUTH_REQUIRED: "Codex CLI authentication is required or has expired",
  AUTH_UNVERIFIED: "Codex CLI authentication could not be verified",
  PERMISSION_DENIED: "Codex CLI permission policy denied the operation",
  CONFIG_INVALID: "Codex CLI configuration could not be loaded",
  MCP_CONFLICT: "A worker-relay MCP registration already exists; isolated worker configuration was not applied",
  MCP_ISOLATION_FAILED: "Codex worker MCP isolation could not be verified; no prompt was sent",
  INVALID_PROTOCOL: "Codex CLI emitted invalid or incomplete protocol data",
  OUTPUT_LIMIT: "Codex CLI output exceeded the worker limit",
  SPAWN_FAILED: "Codex CLI process could not be started",
  PROCESS_ERROR: "Codex CLI process or output pipe failed",
  PROCESS_EXIT: "Codex CLI exited before completing the operation",
  STDIN_ERROR: "Codex CLI input pipe failed",
  TURN_FAILED: "Codex CLI reported a failed turn",
  ABORTED: "Codex worker operation was cancelled",
  TIMEOUT: "Codex worker operation exceeded its deadline",
  EVENT_HANDLER_FAILED: "Codex worker event could not be recorded",
};

function failure(code, phase, deliveryState = "not-sent", sent = false) {
  return Object.assign(new Error(ERRORS[code]), { code, phase, deliveryState, sent });
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnosticCode(value, fallback) {
  const text = String(value ?? "").slice(0, MAX_STDERR);
  if (/\b(?:not logged in|not authenticated|authentication (?:is )?required|authentication failed|login required|please run codex login|unauthenticated|unauthorized|invalid_api_key|invalid authentication|token expired|token has expired|refresh_token_reused)\b|\b401\b/i.test(text)) return "AUTH_REQUIRED";
  if (/\b(?:permission denied|access denied|approval required|approval denied|sandbox denied|not allowed by|disallowed by|violates.*requirements|allowed_sandbox_modes|allowed_approval_policies)\b/i.test(text)) return "PERMISSION_DENIED";
  if (/error loading config|failed to load config|invalid.*(?:config|toml)|unknown feature flag|unexpected argument/i.test(text)) return "CONFIG_INVALID";
  return fallback;
}

function workerEnv(env, relayEnv = {}) {
  const clean = Object.fromEntries(Object.entries(env).filter(([name, value]) => value !== undefined
    && !/^(?:CODEX_BRIDGE_|CLAUDE_BRIDGE_|CODEX_NATIVE_RELAY_|CODEX_RELAY_ID$|CODEX_THREAD_ID$|CODEX_SESSION_ID$|CODEX_APP_TOOLS_PIPE_PATH$|CODEX_APP_SERVER_URL$|CODEX_INTERNAL_ORIGINATOR_OVERRIDE$|AGENT_RELAY_)/i.test(name)));
  return { ...clean, ...relayEnv };
}

function binary(executable, env, platform = process.platform) {
  const selected = executable ?? env.CODEX_BIN ?? env.CODEX_CLI_PATH ?? resolveCodexBin(undefined, { env, platform });
  try {
    if (typeof selected !== "string" || !path.isAbsolute(selected) || /[\u0000-\u001f\u007f]/.test(selected)) throw new Error();
    const resolved = fs.realpathSync.native(selected);
    if (!fs.statSync(resolved).isFile() || platform === "win32" && !/\.(?:exe|com)$/i.test(resolved)) throw new Error();
    fs.accessSync(resolved, platform === "win32" ? fs.constants.R_OK : fs.constants.X_OK);
    return resolved;
  } catch (cause) { throw Object.assign(failure("CLI_UNAVAILABLE", "inspect"), { cause }); }
}

function missingExecutable(error) {
  return ["ENOENT", "ENOTDIR"].includes(error?.code) || ["ENOENT", "ENOTDIR"].includes(error?.cause?.code);
}

async function inspectCodexWorkerAttempt({ env, executable, platform, run, retryMissing = false }) {
  const result = { agent: "codex", available: false, authenticated: null, ready: false };
  if (!object(env) || typeof run !== "function") return { ...result, code: "INVALID_INPUT", reason: ERRORS.INVALID_INPUT };
  let selected;
  try { selected = binary(executable, env, platform); }
  catch (error) {
    if (retryMissing && missingExecutable(error)) throw error;
    return { ...result, code: error.code, reason: error.message };
  }
  const options = { env: workerEnv(env), windowsHide: true, shell: false, timeout: 10000, maxBuffer: MAX_CAPTURE, encoding: "utf8" };
  try {
    const version = await run(selected, ["--version"], options);
    const match = /^codex-cli ([A-Za-z0-9][A-Za-z0-9.+_-]{0,95})\s*$/m.exec(String(version.stdout ?? ""));
    if (!match) return { ...result, code: "CLI_UNSUPPORTED", reason: ERRORS.CLI_UNSUPPORTED };
    Object.assign(result, { available: true, executable: selected, version: match[1] });
    const help = await run(selected, ["exec", "--help"], options);
    if (!["--json", "--ephemeral", "--color", "--config"].every((flag) => String(help.stdout ?? "").includes(flag))) {
      return { ...result, code: "CLI_UNSUPPORTED", reason: ERRORS.CLI_UNSUPPORTED };
    }
  } catch (error) {
    if (retryMissing && missingExecutable(error)) throw error;
    if (missingExecutable(error)) return { ...result, available: false, code: "CLI_UNAVAILABLE", reason: ERRORS.CLI_UNAVAILABLE };
    const code = diagnosticCode(error.stderr, result.available ? "CLI_UNSUPPORTED" : "CLI_UNAVAILABLE");
    return { ...result, code, reason: ERRORS[code] };
  }
  try {
    const login = await run(selected, ["login", "status"], options);
    const text = `${login.stdout ?? ""}\n${login.stderr ?? ""}`;
    if (/^Logged in using (?:ChatGPT|workload identity|an API key)\b|^API key configured\b/m.test(text)) {
      return { ...result, authenticated: true, ready: true, reason: "Codex CLI and stored authentication are available; model access is not verified" };
    }
    const code = diagnosticCode(text, "AUTH_UNVERIFIED");
    return { ...result, authenticated: code === "AUTH_REQUIRED" ? false : null, code, reason: ERRORS[code] };
  } catch (error) {
    if (retryMissing && missingExecutable(error)) throw error;
    if (missingExecutable(error)) return { ...result, available: false, code: "CLI_UNAVAILABLE", reason: ERRORS.CLI_UNAVAILABLE };
    const code = diagnosticCode(`${error.stdout ?? ""}\n${error.stderr ?? ""}`, "AUTH_UNVERIFIED");
    return { ...result, authenticated: code === "AUTH_REQUIRED" ? false : null, code, reason: ERRORS[code] };
  }
}

export async function inspectCodexWorker({ env = process.env, executable, platform = process.platform, run = execFileAsync } = {}) {
  const settings = { env, executable, platform, run };
  const pinned = executable != null || env?.CODEX_BIN != null || env?.CODEX_CLI_PATH != null;
  try { return await inspectCodexWorkerAttempt({ ...settings, retryMissing: !pinned }); }
  catch (error) {
    if (!missingExecutable(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return inspectCodexWorkerAttempt(settings);
  }
}

function capture(executable, args, { cwd, env, spawn, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure("ABORTED", "configure"));
    let child;
    let settled = false;
    let size = 0;
    const stdout = [];
    const stderr = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        try { child?.kill(); } catch {}
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(failure("ABORTED", "configure"));
    const timer = setTimeout(() => finish(failure("TIMEOUT", "configure")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
        stream.on("error", () => finish(failure("PROCESS_ERROR", "configure")));
        stream.on("data", (chunk) => {
          if (settled) return;
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > MAX_CAPTURE) return finish(failure("OUTPUT_LIMIT", "configure"));
          chunks.push(data);
        });
      }
      child.on("error", () => finish(failure("SPAWN_FAILED", "configure")));
      child.on("close", (code) => {
        const diagnostic = Buffer.concat(stderr).toString("utf8");
        if (code !== 0) return finish(failure(diagnosticCode(diagnostic, "MCP_ISOLATION_FAILED"), "configure"));
        finish(null, Buffer.concat(stdout).toString("utf8"));
      });
    } catch { finish(failure("SPAWN_FAILED", "configure")); }
  });
}

function inventory(text) {
  let entries;
  try { entries = JSON.parse(text); }
  catch { throw failure("MCP_ISOLATION_FAILED", "configure"); }
  if (!Array.isArray(entries) || entries.length > 512) throw failure("MCP_ISOLATION_FAILED", "configure");
  const names = new Set();
  for (const entry of entries) {
    if (!object(entry) || !MCP_NAME.test(entry.name ?? "") || typeof entry.enabled !== "boolean" || names.has(entry.name)) {
      throw failure("MCP_ISOLATION_FAILED", "configure");
    }
    names.add(entry.name);
  }
  return entries;
}

async function isolatedArgs(executable, settings, relayMcp) {
  const initial = inventory(await capture(executable, [...ISOLATION_FLAGS, "mcp", "list", "--json"], settings));
  if (initial.some((entry) => entry.name === "worker-relay")) throw failure("MCP_CONFLICT", "configure");
  const overrides = initial.flatMap(({ name }) => ["-c", `mcp_servers.${name}.enabled=false`]);
  const config = {
    command: relayMcp.command,
    args: relayMcp.args,
    env_vars: Object.keys(relayMcp.env).sort(),
    enabled: true,
    required: true,
    enabled_tools: MCP_TOOLS,
    startup_timeout_sec: 30,
    tool_timeout_sec: 90,
  };
  for (const [name, value] of Object.entries(config)) overrides.push("-c", `mcp_servers.worker-relay.${name}=${JSON.stringify(value)}`);
  const args = [...ISOLATION_FLAGS, ...overrides];
  const checked = inventory(await capture(executable, [...args, "mcp", "list", "--json"], settings));
  const enabled = checked.filter((entry) => entry.enabled);
  const transport = enabled[0]?.transport;
  const expectedNames = [...initial.map((entry) => entry.name), "worker-relay"].sort();
  if (JSON.stringify(checked.map((entry) => entry.name).sort()) !== JSON.stringify(expectedNames)
      || enabled.length !== 1 || enabled[0].name !== "worker-relay" || !object(transport)
      || transport.type !== "stdio" || transport.command !== config.command
      || JSON.stringify(transport.args) !== JSON.stringify(config.args)
      || JSON.stringify(transport.env_vars) !== JSON.stringify(config.env_vars)
      || transport.env !== null && (!object(transport.env) || Object.keys(transport.env).length !== 0)
      || transport.cwd !== null && transport.cwd !== undefined) throw failure("MCP_ISOLATION_FAILED", "configure");
  return args;
}

export async function runCodexWorker({ executable, cwd, prompt, requestId, sessionId, env = process.env, relayMcp, onEvent = () => {}, signal, timeoutMs = 600000, spawn = spawnProcess } = {}) {
  let directory;
  try {
    if (!object(env) || typeof spawn !== "function" || typeof cwd !== "string" || !path.isAbsolute(cwd) || typeof prompt !== "string" || !prompt.trim()
        || Buffer.byteLength(prompt) > MAX_FRAME || typeof requestId !== "string" || !requestId || requestId.length > 128
        || /[\u0000-\u001f\u007f]/.test(requestId) || sessionId !== undefined && (typeof sessionId !== "string" || !UUID.test(sessionId))
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || typeof onEvent !== "function"
        || !object(relayMcp) || typeof relayMcp.command !== "string" || !relayMcp.command || relayMcp.command.length > 32768
        || /[\u0000-\u001f\u007f]/.test(relayMcp.command) || !Array.isArray(relayMcp.args) || relayMcp.args.length > 128
        || relayMcp.args.some((arg) => typeof arg !== "string" || arg.length > 32768 || arg.includes("\0"))
        || !object(relayMcp.env) || Object.keys(relayMcp.env).length > 32
        || Object.entries(relayMcp.env).some(([name, value]) => !/^AGENT_RELAY_[A-Z0-9_]+$/.test(name)
          || typeof value !== "string" || !value || value.length > 65536 || value.includes("\0"))) throw new Error();
    if (relayMcp.env.AGENT_RELAY_TOKEN && [relayMcp.command, ...relayMcp.args].some((arg) => arg.includes(relayMcp.env.AGENT_RELAY_TOKEN))) throw new Error();
    directory = fs.realpathSync.native(cwd);
    if (!fs.statSync(directory).isDirectory()) throw new Error();
  } catch { throw failure("INVALID_INPUT", "validate"); }
  const selected = binary(executable, env);
  const workerSessionId = sessionId ?? randomUUID();
  const childEnv = workerEnv(env, relayMcp.env);
  const startedAt = Date.now();
  const settings = { cwd: directory, env: childEnv, spawn, signal, get timeoutMs() { return Math.max(1, Math.min(20000, timeoutMs - (Date.now() - startedAt))); } };
  const overrides = await isolatedArgs(selected, settings, relayMcp);
  if (signal?.aborted) throw failure("ABORTED", "launch");
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw failure("TIMEOUT", "launch");
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let wrote = false;
    let accepted = false;
    let completed = false;
    let providerSessionId = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let buffer = "";
    let diagnostic = "";
    let output = "";
    let usage;
    let pendingEvents = Promise.resolve();
    const decoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const state = () => wrote ? "unknown" : "not-sent";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        try { child?.kill(); } catch {}
        reject(error);
      } else resolve({ agent: "codex", output, sessionId: workerSessionId, requestId, deliveryState: "sent", sent: true, ...(usage ? { usage } : {}) });
    };
    const fail = (code, phase = "run") => finish(failure(code, phase, state(), accepted));
    const abort = () => fail("ABORTED");
    const timer = setTimeout(() => fail("TIMEOUT"), remaining);
    const notify = (event) => {
      try {
        pendingEvents = Promise.all([pendingEvents, onEvent(event)]).then(() => undefined);
        pendingEvents.catch(() => fail("EVENT_HANDLER_FAILED"));
      }
      catch { fail("EVENT_HANDLER_FAILED"); }
    };
    const event = (value) => {
      if (!object(value) || typeof value.type !== "string") return fail("INVALID_PROTOCOL");
      if (value.type === "thread.started") {
        if (providerSessionId || accepted || completed || !UUID.test(value.thread_id ?? "")) return fail("INVALID_PROTOCOL");
        providerSessionId = value.thread_id;
        notify({ type: "session", sessionId: workerSessionId });
      } else if (value.type === "turn.started") {
        if (!providerSessionId || accepted || completed) return fail("INVALID_PROTOCOL");
        accepted = true;
        notify({ type: "accepted", sessionId: workerSessionId });
      } else if (value.type === "turn.completed") {
        if (!accepted || completed || !object(value.usage)) return fail("INVALID_PROTOCOL");
        const entries = Object.entries(value.usage);
        if (entries.some(([name, count]) => !/^[a-z_]{1,64}$/.test(name) || !Number.isSafeInteger(count) || count < 0)) return fail("INVALID_PROTOCOL");
        usage = Object.fromEntries(entries);
        completed = true;
      } else if (value.type === "turn.failed" || value.type === "error") {
        const message = value.type === "turn.failed" ? value.error?.message : value.message;
        if (typeof message !== "string") return fail("INVALID_PROTOCOL");
        fail(diagnosticCode(message, "TURN_FAILED"));
      } else if (/^item\.(?:started|updated|completed)$/.test(value.type)) {
        if (!accepted || completed || !object(value.item) || typeof value.item.type !== "string") return fail("INVALID_PROTOCOL");
        if (value.type === "item.completed" && value.item.type === "agent_message") {
          if (typeof value.item.text !== "string") return fail("INVALID_PROTOCOL");
          output = value.item.text;
        }
      }
    };
    const consume = (chunk) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_OUTPUT) return fail("OUTPUT_LIMIT");
      buffer += decoder.write(data);
      let newline;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) return fail("OUTPUT_LIMIT");
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); }
        catch { return fail("INVALID_PROTOCOL"); }
        event(value);
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME) fail("OUTPUT_LIMIT");
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = spawn(selected, [...overrides, "exec", "--json", "--ephemeral", "--color", "never", "-C", directory, "-"], {
        cwd: directory, env: childEnv, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      child.on("error", () => fail(wrote ? "PROCESS_ERROR" : "SPAWN_FAILED", wrote ? "run" : "launch"));
      child.stdin.on("error", () => fail("STDIN_ERROR", "send"));
      child.stdout.on("error", () => fail("PROCESS_ERROR"));
      child.stderr.on("error", () => fail("PROCESS_ERROR"));
      child.stdout.on("data", consume);
      child.stderr.on("data", (chunk) => {
        if (settled) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stderrBytes += data.length;
        if (stderrBytes > MAX_STDERR) return fail("OUTPUT_LIMIT");
        diagnostic += stderrDecoder.write(data);
      });
      child.on("close", (code) => {
        if (settled) return;
        buffer += decoder.end();
        diagnostic += stderrDecoder.end();
        if (buffer.trim()) {
          consume(Buffer.from("\n"));
          if (settled) return;
        }
        if (code !== 0) return fail(diagnosticCode(diagnostic, "PROCESS_EXIT"), "result");
        if (!completed || !accepted) return fail("INVALID_PROTOCOL", "result");
        pendingEvents.then(() => finish(), () => fail("EVENT_HANDLER_FAILED"));
      });
      child.on("spawn", () => {
        if (settled) return;
        if (signal?.aborted) return abort();
        wrote = true;
        try { child.stdin.end(prompt, "utf8", (error) => { if (error) fail("STDIN_ERROR", "send"); }); }
        catch { fail("STDIN_ERROR", "send"); }
      });
    } catch { fail("SPAWN_FAILED", "launch"); }
  });
}
