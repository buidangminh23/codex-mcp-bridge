import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function failure(message, code, deliveryState = "not-sent") {
  return Object.assign(new Error(message), { code, deliveryState });
}

function directory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Antigravity CLI cwd must be an absolute directory");
  const resolved = fs.realpathSync.native(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Antigravity CLI cwd must be a directory");
  return resolved;
}

function positive(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`);
  return result;
}

export function resolveAntigravityCliBinary({ binary, env = process.env, platform = process.platform } = {}) {
  const selected = binary ?? env.ANTIGRAVITY_CLI_BIN;
  const windows = platform === "win32";
  const name = windows ? "agy.exe" : "agy";
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const candidates = selected !== undefined ? [selected] : [
    ...(windows ? [path.join(env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "agy", "bin", name)] : [path.join(home, ".local", "bin", name)]),
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter).filter((item) => path.isAbsolute(item)).map((item) => path.join(item, name)),
  ];
  if (selected !== undefined && (typeof selected !== "string" || !path.isAbsolute(selected))) throw new Error("Antigravity CLI binary must be an absolute executable path");
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync.native(candidate);
      if (!fs.statSync(resolved).isFile() || windows && !/\.exe$/i.test(resolved)) continue;
      fs.accessSync(resolved, windows ? fs.constants.R_OK : fs.constants.X_OK);
      return resolved;
    } catch {}
  }
  throw new Error("Antigravity CLI executable was not found; set ANTIGRAVITY_CLI_BIN to its absolute path");
}

export class AntigravityCliSession {
  constructor(options = {}) {
    this.cwd = directory(options.cwd);
    this.env = { ...(options.env ?? process.env) };
    this.binary = resolveAntigravityCliBinary({ binary: options.binary, env: this.env });
    this.spawn = options.spawn ?? spawnProcess;
    this.requestedConversationId = options.conversationId ?? null;
    if (this.requestedConversationId !== null && !UUID.test(this.requestedConversationId)) throw new Error("Invalid Antigravity conversation ID");
    this.startupTimeoutMs = positive(options.startupTimeoutMs, 30000, "startupTimeoutMs");
    this.turnTimeoutMs = positive(options.turnTimeoutMs, 600000, "turnTimeoutMs");
    this.closeTimeoutMs = positive(options.closeTimeoutMs, 3000, "closeTimeoutMs");
    this.maxFrameBytes = positive(options.maxFrameBytes, 2 * 1024 * 1024, "maxFrameBytes");
    this.maxTurnBytes = positive(options.maxTurnBytes, 16 * 1024 * 1024, "maxTurnBytes");
    this.status = "new";
    this.conversationId = null;
    this.permissionMode = null;
    this.child = null;
    this.pending = null;
    this.awaitingResult = false;
    this.lastResult = null;
    this.lastError = null;
    this.deliveryState = "not-sent";
    this.turnBytes = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.exited = false;
  }

  read() {
    return {
      conversationId: this.conversationId,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      pid: this.child?.pid ?? null,
      status: this.status,
      deliveryState: this.deliveryState,
      result: this.lastResult ? structuredClone(this.lastResult) : null,
      error: this.lastError ? { code: this.lastError.code, message: this.lastError.message } : null,
    };
  }

  start() {
    if (this.startPromise) return this.startPromise;
    if (this.status !== "new") return Promise.reject(failure("Antigravity CLI session cannot be started", "SESSION_CLOSED"));
    this.status = "starting";
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.startTimer = setTimeout(() => this.fail(failure("Antigravity CLI did not emit a valid init event before the deadline", "STARTUP_TIMEOUT")), this.startupTimeoutMs);
    const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
    if (this.requestedConversationId) args.push("--conversation", this.requestedConversationId);
    try {
      this.child = this.spawn(this.binary, args, { cwd: this.cwd, env: this.env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.child.on("error", () => this.fail(failure("Antigravity CLI process failed", "PROCESS_ERROR", this.pending ? "unknown" : this.deliveryState)));
      this.child.stdin.on("error", () => this.fail(failure("Antigravity CLI input pipe failed", "STDIN_ERROR", this.pending ? "unknown" : this.deliveryState)));
      this.child.stdout.on("error", () => this.fail(failure("Antigravity CLI output pipe failed", "STDOUT_ERROR", this.pending ? "unknown" : this.deliveryState)));
      this.child.stderr.on("error", () => this.fail(failure("Antigravity CLI diagnostic pipe failed", "STDERR_ERROR", this.pending ? "unknown" : this.deliveryState)));
      this.child.stderr.resume();
      this.child.stdout.on("data", (chunk) => this.consume(chunk));
      this.child.on("close", (code, signal) => {
        this.exited = true;
        this.exitCode = code;
        this.exitSignal = signal;
        if (this.status === "starting" || this.pending) this.fail(failure("Antigravity CLI exited before completing the operation", "PROCESS_EXIT", this.pending ? "unknown" : this.deliveryState));
        else if (!["failed", "unknown"].includes(this.status)) this.status = "closed";
        this.closeResolve?.();
      });
    } catch {
      this.fail(failure("Antigravity CLI could not be launched", "SPAWN_FAILED"));
    }
    return this.startPromise;
  }

  consume(chunk) {
    if (["failed", "closed"].includes(this.status)) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.turnBytes += bytes.length;
    if (this.turnBytes > this.maxTurnBytes) return this.fail(failure("Antigravity CLI output exceeds its per-turn limit", "OUTPUT_LIMIT", this.pending ? "unknown" : this.deliveryState));
    this.buffer += this.decoder.write(bytes);
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxFrameBytes) return this.fail(failure("Antigravity CLI frame exceeds its limit", "FRAME_LIMIT", this.pending ? "unknown" : this.deliveryState));
      if (!line.trim()) continue;
      try { this.event(JSON.parse(line)); }
      catch (error) { return this.fail(failure(error.message === "Invalid Antigravity event" ? error.message : "Antigravity CLI emitted invalid protocol data", "INVALID_PROTOCOL", this.pending ? "unknown" : this.deliveryState)); }
      if (["failed", "closed"].includes(this.status)) return;
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) this.fail(failure("Antigravity CLI frame exceeds its limit", "FRAME_LIMIT", this.pending ? "unknown" : this.deliveryState));
  }

  event(event) {
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.event !== "string") throw new Error("Invalid Antigravity event");
    if (event.event === "init") {
      if (this.status !== "starting" || !UUID.test(event.conversation_id ?? "")
          || this.requestedConversationId && event.conversation_id.toLowerCase() !== this.requestedConversationId.toLowerCase()
          || directory(event.init?.cwd) !== this.cwd
          || typeof event.init?.permission_mode !== "string" || !event.init.permission_mode || event.init.permission_mode.length > 128) throw new Error("Invalid Antigravity event");
      this.conversationId = event.conversation_id;
      this.permissionMode = event.init.permission_mode;
      this.status = "idle";
      clearTimeout(this.startTimer);
      this.startResolve(this.read());
      this.startResolve = null;
      this.startReject = null;
      return;
    }
    if (!this.conversationId) throw new Error("Invalid Antigravity event");
    if (event.event !== "result") return;
    const result = event.result;
    if (!this.awaitingResult || !result || result.conversation_id !== this.conversationId
        || typeof result.status !== "string" || !/^[A-Z][A-Z_]{0,127}$/.test(result.status)
        || typeof result.response !== "string" || result.error !== undefined && typeof result.error !== "string") throw new Error("Invalid Antigravity event");
    this.lastResult = { conversation_id: result.conversation_id, status: result.status, response: result.response, ...(result.error === undefined ? {} : { error: result.error }) };
    this.awaitingResult = false;
    this.deliveryState = "completed";
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      this.status = "idle";
      pending.resolve(structuredClone(this.lastResult));
    }
  }

  async send(prompt) {
    if (typeof prompt !== "string" || !prompt.trim()) throw failure("Antigravity prompt must be non-empty text", "INVALID_PROMPT");
    const frame = `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
    if (Buffer.byteLength(frame) > this.maxFrameBytes) throw failure("Antigravity prompt exceeds its frame limit", "PROMPT_LIMIT");
    await this.start();
    if (this.status !== "idle" || this.pending) throw failure("Antigravity CLI session is busy, closed, or has an uncertain delivery; inspect its receipt instead of resending", "SESSION_UNAVAILABLE", this.deliveryState);
    if (directory(this.cwd) !== this.cwd) throw failure("Antigravity CLI working directory changed", "CWD_CHANGED");
    this.status = "running";
    this.awaitingResult = true;
    this.deliveryState = "unknown";
    this.turnBytes = 0;
    this.lastResult = null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending;
        if (!pending) return;
        this.pending = null;
        this.status = "unknown";
        this.lastError = failure("Antigravity CLI turn exceeded the observation deadline; it may still be running. Do not resend.", "TURN_TIMEOUT", "unknown");
        pending.reject(this.lastError);
      }, this.turnTimeoutMs);
      this.pending = { resolve, reject, timer };
      try {
        this.child.stdin.write(frame, (error) => {
          if (error) this.fail(failure("Antigravity CLI input write failed; delivery may have started", "STDIN_ERROR", "unknown"));
        });
      } catch {
        this.fail(failure("Antigravity CLI input write failed; delivery may have started", "STDIN_ERROR", "unknown"));
      }
    });
  }

  fail(error) {
    this.lastError = error;
    this.deliveryState = error.deliveryState;
    this.status = error.deliveryState === "unknown" ? "unknown" : "failed";
    clearTimeout(this.startTimer);
    this.startReject?.(error);
    this.startResolve = null;
    this.startReject = null;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    try { this.child?.kill(); } catch {}
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  async finishClose() {
    if (!this.child || this.exited) {
      this.status = "closed";
      return this.read();
    }
    const closed = new Promise((resolve) => { this.closeResolve = resolve; });
    try { this.child.stdin.end(); } catch {}
    let timer;
    await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, this.closeTimeoutMs); })]);
    clearTimeout(timer);
    if (!this.exited) {
      if (this.pending || this.status === "starting") this.fail(failure("Antigravity CLI session was closed before its operation completed", "SESSION_CLOSED", this.pending ? "unknown" : this.deliveryState));
      else try { this.child.kill(); } catch {}
      await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(resolve, this.closeTimeoutMs); })]);
      clearTimeout(timer);
    }
    this.status = this.exited ? "closed" : "closing";
    return this.read();
  }
}
