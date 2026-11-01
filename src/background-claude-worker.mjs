import { execFile, spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FRAME_LIMIT = 2 * 1024 * 1024;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const PROBE_LIMIT = 256 * 1024;
const TOOLS = ["worker_status", "list_workers", "send_to_worker", "read_worker_delivery"];
const API_CODES = new Set(["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "max_output_tokens", "cloud_credential_error", "unknown"]);
const STARTUP_CODES = new Set(["org_pin_api_key_conflict", "provider_not_allowed", "org_verify_failed", "org_pin_mismatch", "managed_settings_invalid", "remote_settings_required_unavailable", "gateway_signin_required", "gateway_access_denied", "proxy_invalid", "temp_dir_unusable", "cwd_unavailable", "shell_tool_missing", "session_held_by_background", "worktree_resume_refused", "worktree_unverified", "cli_version_too_old", "bypass_root", "org_config_required_unavailable", "org_config_refused"]);

function failure(code, message, phase, deliveryState = "not_sent") {
  return Object.assign(new Error(message), { code, phase, deliveryState, sent: deliveryState === "unknown" ? null : deliveryState === "sent" });
}

function executablePath(executable, env, platform = process.platform) {
  const selected = executable ?? env.CLAUDE_CLI_BIN;
  const windows = platform === "win32";
  const home = env.USERPROFILE ?? env.HOME ?? os.homedir();
  const name = windows ? "claude.exe" : "claude";
  const candidates = selected === undefined ? [
    path.join(home, ".local", "bin", name),
    ...(windows ? [path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", name)] : []),
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter).filter((entry) => path.isAbsolute(entry)).map((entry) => path.join(entry, name)),
  ] : [selected];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || /(?:^|[\\/])(?:AnthropicClaude|Claude\.app|Claude_[^\\/]*)(?:[\\/]|$)/i.test(candidate)) continue;
    try {
      const resolved = fs.realpathSync.native(candidate);
      if (/(?:^|[\\/])(?:AnthropicClaude|Claude\.app|Claude_[^\\/]*)(?:[\\/]|$)/i.test(resolved)
        || windows && !/\.exe$/i.test(resolved) || !fs.statSync(resolved).isFile()) continue;
      fs.accessSync(resolved, windows ? fs.constants.R_OK : fs.constants.X_OK);
      return resolved;
    } catch {}
  }
  throw failure("CLAUDE_CLI_UNAVAILABLE", "Claude Code CLI executable was not found; configure its absolute native executable path.", "preflight");
}

function runFile(executable, args, options) {
  return new Promise((resolve, reject) => execFile(executable, args, options, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  }));
}

async function probe(run, executable, args, env) {
  let result;
  try { result = await run(executable, args, { env, windowsHide: true, shell: false, timeout: 15000, maxBuffer: PROBE_LIMIT, encoding: "utf8" }); }
  catch (error) { result = { stdout: error.stdout, status: typeof error.code === "number" ? error.code : 1 }; }
  const stdout = String(result?.stdout ?? "");
  return { stdout: Buffer.byteLength(stdout) <= PROBE_LIMIT ? stdout : "", status: result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0) };
}

export async function inspectClaudeWorker({ env = process.env, executable, platform = process.platform, run = runFile } = {}) {
  const state = { agent: "claude", available: false, authenticated: null, ready: false };
  try { state.executable = executablePath(executable, env, platform); }
  catch (error) { return { ...state, code: error.code, reason: error.message }; }
  const version = await probe(run, state.executable, ["--version"], env);
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?\s+\(Claude Code\)\s*$/.exec(version.stdout.trim());
  if (version.status !== 0 || !match) return { ...state, code: "CLAUDE_CLI_PROBE_FAILED", reason: "The executable did not report a supported Claude Code CLI identity." };
  state.available = true;
  state.version = `${match[1]}.${match[2]}.${match[3]}`;
  if (Number(match[1]) < 2 || Number(match[1]) === 2 && (Number(match[2]) < 1 || Number(match[2]) === 1 && Number(match[3]) < 259)) {
    return { ...state, code: "CLAUDE_CLI_UNSUPPORTED_VERSION", reason: "Claude Code CLI 2.1.259 or later is required for unattended permission handling." };
  }
  const auth = await probe(run, state.executable, ["auth", "status", "--json"], env);
  let parsed;
  try { parsed = JSON.parse(auth.stdout); } catch {}
  if (parsed?.loggedIn === false) return { ...state, authenticated: false, code: "CLAUDE_CLI_AUTH_REQUIRED", reason: "Claude Code CLI is not signed in. Complete its official CLI login; Desktop sign-in is a separate readiness check." };
  if (auth.status !== 0 || parsed?.loggedIn !== true) return { ...state, code: "CLAUDE_CLI_AUTH_CHECK_FAILED", reason: "Claude Code CLI authentication status could not be verified." };
  return { ...state, authenticated: true, ready: true };
}

function workerInput({ executable, cwd, prompt, requestId, sessionId, env, relayMcp, timeoutMs, onEvent }) {
  const binary = executablePath(executable, env);
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw failure("CLAUDE_WORKER_INVALID_CWD", "The worker requires an absolute authorized working directory.", "preflight");
  let directory;
  try { directory = fs.realpathSync.native(cwd); if (!fs.statSync(directory).isDirectory()) throw new Error(); }
  catch { throw failure("CLAUDE_WORKER_INVALID_CWD", "The worker working directory is unavailable.", "preflight"); }
  if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > FRAME_LIMIT / 2) throw failure("CLAUDE_WORKER_INVALID_PROMPT", "The worker prompt must be non-empty text within its size limit.", "preflight");
  if (!UUID.test(requestId ?? "") || !UUID.test(sessionId ?? "")) throw failure("CLAUDE_WORKER_INVALID_ID", "The worker requires independent UUID request and session identities.", "preflight");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000 || typeof onEvent !== "function") throw failure("CLAUDE_WORKER_INVALID_OPTIONS", "Worker lifecycle options are invalid.", "preflight");
  if (!relayMcp || typeof relayMcp.command !== "string" || !path.isAbsolute(relayMcp.command) || relayMcp.command.includes("\0")
    || !Array.isArray(relayMcp.args) || relayMcp.args.some((value) => typeof value !== "string" || value.includes("\0"))
    || !relayMcp.env || typeof relayMcp.env !== "object" || Array.isArray(relayMcp.env)
    || Object.entries(relayMcp.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))) {
    throw failure("CLAUDE_WORKER_INVALID_MCP", "The worker requires a valid relay-only MCP registration.", "preflight");
  }
  const childEnv = { ...env, ...relayMcp.env };
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_PARENT_SESSION_ID"]) delete childEnv[key];
  childEnv.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = "1";
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--session-id", sessionId,
    "--no-session-persistence", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { "worker-relay": { command: relayMcp.command, args: relayMcp.args } } }),
    "--permission-prompts", "none", "--no-chrome", "--settings", JSON.stringify({ disableAllHooks: true }),
    "--allowedTools", TOOLS.map((name) => `mcp__worker-relay__${name}`).join(",")];
  const frame = `${JSON.stringify({ type: "user", uuid: requestId, session_id: sessionId, message: { role: "user", content: prompt }, parent_tool_use_id: null, client_composed: true, priority: "later" })}\n`;
  if (Buffer.byteLength(frame) > FRAME_LIMIT) throw failure("CLAUDE_WORKER_INVALID_PROMPT", "The encoded worker prompt exceeds its size limit.", "preflight");
  return { binary, directory, childEnv, args, frame };
}

export async function runClaudeWorker({ executable, cwd, prompt, requestId, sessionId = randomUUID(), env = process.env, relayMcp, onEvent = () => {}, signal, timeoutMs = 600000, spawn = spawnProcess } = {}) {
  const input = workerInput({ executable, cwd, prompt, requestId, sessionId, env, relayMcp, timeoutMs, onEvent });
  if (signal?.aborted) throw failure("CLAUDE_WORKER_ABORTED", "The worker was cancelled before dispatch.", "preflight");
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let wrote = false;
    let initialized = false;
    let accepted = false;
    let totalBytes = 0;
    let stderrBytes = 0;
    let buffer = "";
    let result = null;
    let terminalError = null;
    let apiError = null;
    const pendingEvents = new Set();
    const decoder = new StringDecoder("utf8");
    const state = () => wrote ? "unknown" : "not_sent";
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { child?.kill(); } catch {}
      reject(error);
    };
    const abort = () => fail(failure("CLAUDE_WORKER_ABORTED", "The worker was cancelled; dispatched work is never replayed automatically.", "execution", state()));
    const timer = setTimeout(() => fail(failure("CLAUDE_WORKER_TIMEOUT", "The worker exceeded its deadline; dispatched work may have started and must not be replayed automatically.", wrote ? "execution" : "startup", state())), timeoutMs);
    const emit = (event) => {
      try {
        const pending = Promise.resolve(onEvent(event));
        pendingEvents.add(pending);
        pending.then(() => pendingEvents.delete(pending), () => {
          pendingEvents.delete(pending);
          fail(failure("CLAUDE_WORKER_EVENT_FAILED", "The worker receipt callback failed.", "receipt", state()));
        });
      }
      catch { fail(failure("CLAUDE_WORKER_EVENT_FAILED", "The worker receipt callback failed.", "receipt", state())); }
    };
    const accept = () => { if (!accepted) { accepted = true; emit({ type: "accepted", sessionId }); } };
    const protocolError = () => fail(failure("CLAUDE_WORKER_INVALID_PROTOCOL", "Claude Code CLI returned invalid or mismatched worker protocol data.", "response", state()));
    const sameId = (value, expected) => typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
    const correlated = (event) => {
      if (event.user_message_uuids !== undefined && !Array.isArray(event.user_message_uuids)) return false;
      const ids = [...(event.user_message_uuid === undefined ? [] : [event.user_message_uuid]), ...(Array.isArray(event.user_message_uuids) ? event.user_message_uuids : [])];
      return ids.length > 0 && ids.every((id) => sameId(id, requestId));
    };
    const event = (value) => {
      if (settled) return;
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") return protocolError();
      if (value.type === "system" && value.subtype === "init") {
        if (initialized || !sameId(value.session_id, sessionId) || typeof value.cwd !== "string") return protocolError();
        try { if (fs.realpathSync.native(value.cwd) !== input.directory) return protocolError(); } catch { return protocolError(); }
        initialized = true;
        emit({ type: "session", sessionId });
      } else if (value.type === "user" && value.isReplay === true && value.parent_tool_use_id == null) {
        if (!initialized || !sameId(value.session_id, sessionId) || !sameId(value.uuid, requestId)) return protocolError();
        accept();
      } else if (value.type === "assistant" && value.parent_tool_use_id == null && sameId(value.session_id, sessionId)) {
        if (API_CODES.has(value.error)) apiError = value.error;
      } else if (value.type === "result") {
        if (!sameId(value.session_id, sessionId) || result || terminalError) return protocolError();
        const matched = correlated(value);
        const failed = value.is_error === true || value.subtype !== "success";
        if (value.permission_denials !== undefined && !Array.isArray(value.permission_denials)) return protocolError();
        const denials = Array.isArray(value.permission_denials) ? value.permission_denials.length : 0;
        if (!failed && (!initialized || !matched || typeof value.result !== "string" || value.is_error !== false)) {
          return fail(failure("CLAUDE_WORKER_RESULT_UNCORRELATED", "Claude Code CLI returned a result without the worker's request correlation.", "response", state()));
        }
        if (matched) accept();
        const delivered = matched || accepted ? "sent" : state();
        if (STARTUP_CODES.has(value.startup_failure_reason)) {
          const reason = value.startup_failure_reason.toUpperCase();
          terminalError = failure(value.startup_failure_reason === "gateway_signin_required" ? "CLAUDE_CLI_AUTH_REQUIRED" : `CLAUDE_CLI_STARTUP_${reason}`, "Claude Code CLI refused to start the worker under its current configuration or policy.", "startup", delivered);
          terminalError.reasonCode = reason;
        } else if (denials) terminalError = failure("CLAUDE_WORKER_PERMISSION_DENIED", "Claude Code CLI denied one or more required tool permissions.", "execution", delivered);
        else if (!failed && value.num_turns === 0) terminalError = failure("CLAUDE_WORKER_TURN_NOT_STARTED", "Claude Code CLI ended the request without starting an agent turn.", "execution", delivered);
        else if (failed || apiError) {
          const code = apiError === "authentication_failed" ? "CLAUDE_CLI_AUTH_REQUIRED" : apiError ? `CLAUDE_CLI_${apiError.toUpperCase()}` : "CLAUDE_WORKER_EXECUTION_FAILED";
          terminalError = failure(code, "Claude Code CLI did not complete the requested work successfully.", "execution", delivered);
          if (typeof value.subtype === "string" && /^error_[a-z_]{1,80}$/.test(value.subtype)) terminalError.reasonCode = value.subtype.toUpperCase();
        } else result = { output: value.result, sessionId, deliveryState: "sent", sent: true, requestId };
        if (!settled) { try { child.stdin.end(); } catch { fail(failure("CLAUDE_WORKER_STDIN_FAILED", "Claude Code CLI input could not close cleanly.", "response", state())); } }
      }
    };
    const consume = (chunk, final = false) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (totalBytes > OUTPUT_LIMIT) return fail(failure("CLAUDE_WORKER_OUTPUT_LIMIT", "Claude Code CLI output exceeded its size limit.", "response", state()));
      buffer += decoder.write(bytes);
      if (final) buffer += decoder.end();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0 || final && buffer.length) {
        const line = newline >= 0 ? buffer.slice(0, newline).replace(/\r$/, "") : buffer;
        buffer = newline >= 0 ? buffer.slice(newline + 1) : "";
        if (Buffer.byteLength(line) > FRAME_LIMIT) return fail(failure("CLAUDE_WORKER_OUTPUT_LIMIT", "Claude Code CLI frame exceeded its size limit.", "response", state()));
        if (line.trim()) { try { event(JSON.parse(line)); } catch { protocolError(); } }
        if (settled) return;
      }
      if (Buffer.byteLength(buffer) > FRAME_LIMIT) fail(failure("CLAUDE_WORKER_OUTPUT_LIMIT", "Claude Code CLI frame exceeded its size limit.", "response", state()));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = spawn(input.binary, input.args, { cwd: input.directory, env: input.childEnv, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      child.on("error", () => fail(failure("CLAUDE_WORKER_PROCESS_FAILED", "Claude Code CLI process could not run.", wrote ? "execution" : "startup", state())));
      child.stdin.on("error", () => fail(failure("CLAUDE_WORKER_STDIN_FAILED", "Claude Code CLI input failed; do not replay dispatched work.", "dispatch", state())));
      child.stdout.on("error", () => fail(failure("CLAUDE_WORKER_STDOUT_FAILED", "Claude Code CLI output failed.", "response", state())));
      child.stderr.on("error", () => fail(failure("CLAUDE_WORKER_STDERR_FAILED", "Claude Code CLI diagnostics failed.", "response", state())));
      child.stdout.on("data", consume);
      child.stderr.on("data", (chunk) => {
        if (!settled && (stderrBytes += Buffer.byteLength(chunk)) > PROBE_LIMIT) fail(failure("CLAUDE_WORKER_OUTPUT_LIMIT", "Claude Code CLI diagnostics exceeded their size limit.", "response", state()));
      });
      child.once("spawn", () => {
        if (settled) return;
        wrote = true;
        try { child.stdin.write(input.frame, (error) => { if (error) fail(failure("CLAUDE_WORKER_STDIN_FAILED", "Claude Code CLI input write failed; delivery is uncertain.", "dispatch", "unknown")); }); }
        catch { fail(failure("CLAUDE_WORKER_STDIN_FAILED", "Claude Code CLI input write failed; delivery is uncertain.", "dispatch", "unknown")); }
      });
      child.once("close", async (code, exitSignal) => {
        if (settled) return;
        consume(Buffer.alloc(0), true);
        if (settled) return;
        try { await Promise.all([...pendingEvents]); }
        catch { return fail(failure("CLAUDE_WORKER_EVENT_FAILED", "The worker receipt callback failed.", "receipt", state())); }
        if (settled) return;
        settled = true;
        cleanup();
        if (terminalError && !exitSignal) reject(terminalError);
        else if (code !== 0 || exitSignal) reject(failure("CLAUDE_WORKER_EXIT_FAILED", "Claude Code CLI exited abnormally; dispatched work is not replayed.", "execution", state()));
        else if (!result) reject(failure("CLAUDE_WORKER_RESULT_MISSING", "Claude Code CLI exited without a correlated result.", "response", state()));
        else resolve(result);
      });
    } catch { fail(failure("CLAUDE_WORKER_SPAWN_FAILED", "Claude Code CLI could not be launched.", "startup", state())); }
  });
}
