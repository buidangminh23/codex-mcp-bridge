import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AntigravityCliSession, resolveAntigravityCliBinary } from "./antigravity-cli.mjs";

const runFile = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELAY_TOOLS = ["worker_status", "list_workers", "send_to_worker", "read_worker_delivery"];
const RELAY_ENV = ["AGENT_RELAY_ENDPOINT", "AGENT_RELAY_TOKEN", "AGENT_RELAY_WORKER_ID", "AGENT_RELAY_REQUEST_ID"];
const MAX_STDERR_BYTES = 65536;

function failure(code, reason, phase, deliveryState = "not_sent") {
  return Object.assign(new Error(reason), { code, phase, deliveryState, sent: deliveryState === "sent" ? true : deliveryState === "not_sent" ? false : null });
}

export async function inspectAntigravityWorker({ env = process.env, executable, platform = process.platform, run = runFile } = {}) {
  const state = { agent: "antigravity", available: false, authenticated: null, ready: false };
  let binary;
  try { binary = resolveAntigravityCliBinary({ binary: executable, env, platform }); }
  catch { return { ...state, code: "ANTIGRAVITY_CLI_UNAVAILABLE", reason: "The dedicated Antigravity CLI executable is unavailable." }; }
  try {
    const result = await run(binary, ["--version"], { env: { ...env }, windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096, encoding: "utf8" });
    const status = result?.exitCode ?? result?.status ?? result?.code ?? 0;
    const version = String(result?.stdout ?? "").trim();
    if (status !== 0 || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) throw new Error("Invalid version result");
    return { ...state, available: true, executable: binary, version, code: "ANTIGRAVITY_AUTH_UNVERIFIED", reason: "Antigravity CLI has no supported read-only authentication probe. An authorized job must establish runtime authentication." };
  } catch {
    return { ...state, executable: binary, code: "ANTIGRAVITY_INSPECTION_FAILED", reason: "Antigravity CLI version inspection failed or returned an unsupported response." };
  }
}

function classifyDiagnostic(value) {
  if (typeof value !== "string") return null;
  const text = value.slice(0, 8192).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  if (/\b(?:unauthenticated|auth(?:entication)?[ _-]+(?:required|failed)|not[ _-]+authenticated|not[ _-]+logged[ _-]+in|(?:login|sign[ -]?in)[ _-]+required|(?:credentials?|tokens?)[ _-]+(?:are[ _-]+|is[ _-]+|has[ _-]+|have[ _-]+)?(?:expired|invalid|missing))\b/i.test(text)) return "authentication";
  if (/\b(?:soft[ _-]+denied|permission[ _-]+(?:denied|required|rejected)|approval[ _-]+required|requires?[ _-]+(?:user[ _-]+)?(?:approval|permission))\b/i.test(text)
      || /\b(?:tool|mcp)\b[^\r\n]{0,160}\b(?:not allowed|blocked|denied)\b/i.test(text)) return "permission";
  return null;
}

function relayToolsAvailable(tools) {
  if (tools === undefined) return false;
  if (!Array.isArray(tools) || tools.length > 4096 || tools.some((name) => typeof name !== "string" || !name || name.length > 256)) {
    throw failure("ANTIGRAVITY_WORKER_PROTOCOL_ERROR", "Antigravity CLI advertised an invalid tool list.", "startup");
  }
  const names = new Set(tools.map((name) => name.replace(/[-_:/\.]+/g, "_")));
  if (!RELAY_TOOLS.every((name) => names.has(name) || names.has(`worker_relay_${name}`) || names.has(`mcp_worker_relay_${name}`))) {
    throw failure("ANTIGRAVITY_RELAY_TOOLS_MISSING", "Antigravity CLI did not advertise all required worker-relay tools. Inspect the CLI MCP configuration.", "relay");
  }
  return true;
}

function workerEnvironment(env, relayMcp, requestId) {
  const grant = relayMcp?.env;
  if (typeof relayMcp?.command !== "string" || !relayMcp.command || !Array.isArray(relayMcp.args)
      || relayMcp.args.some((value) => typeof value !== "string") || !grant || typeof grant !== "object" || Array.isArray(grant)
      || RELAY_ENV.some((key) => typeof grant[key] !== "string" || !grant[key] || grant[key].length > 8192 || grant[key].includes("\0"))
      || grant.AGENT_RELAY_REQUEST_ID !== requestId) {
    throw failure("ANTIGRAVITY_RELAY_GRANT_INVALID", "The Antigravity worker requires a complete relay grant bound to this request.", "preflight");
  }
  const cleaned = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:CODEX_|CLAUDE|ANTHROPIC_|MCP_|AGENT_RELAY_)/i.test(name)));
  for (const key of RELAY_ENV) cleaned[key] = grant[key];
  return cleaned;
}

export async function runAntigravityWorker({ executable, cwd, prompt, requestId, sessionId, env = process.env, relayMcp, onEvent = () => {}, signal, timeoutMs = 600000, spawn, conversationId, resume } = {}) {
  if (conversationId !== undefined || resume !== undefined) throw failure("ANTIGRAVITY_WORKER_RESUME_UNSUPPORTED", "Background Antigravity jobs require a fresh CLI conversation and cannot resume an external conversation.", "preflight");
  if (typeof prompt !== "string" || !prompt.trim() || !UUID.test(requestId ?? "")
      || sessionId !== undefined && !UUID.test(sessionId) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || typeof onEvent !== "function") {
    throw failure("ANTIGRAVITY_WORKER_INPUT_INVALID", "The Antigravity worker requires a non-empty prompt, valid request identity, and bounded timeout.", "preflight");
  }
  if (signal?.aborted) throw failure("ANTIGRAVITY_WORKER_ABORTED", "The Antigravity worker was canceled before dispatch.", "cancellation");
  const workerEnv = workerEnvironment(env, relayMcp, requestId);
  const deadline = Date.now() + timeoutMs;
  let session;
  let initialized;
  let accepted = false;
  let terminal = false;
  let diagnosticKind = null;
  let stderrBytes = 0;
  let stderrTail = "";
  let stderrOverflow = false;
  let observerFailed = false;
  let finalError;
  let deadlineTimer;
  let rejectInterruption;
  const interrupted = new Promise((resolve, reject) => { rejectInterruption = reject; });
  interrupted.catch(() => {});
  const observers = [];
  const deliveryState = () => accepted ? "sent" : session && ["unknown", "completed"].includes(session.read().deliveryState) ? "unknown" : "not_sent";
  const notify = (event) => {
    try { observers.push(Promise.resolve(onEvent(event)).catch(() => { observerFailed = true; })); }
    catch { observerFailed = true; }
  };
  const accept = () => {
    if (accepted) return;
    accepted = true;
    notify({ type: "accepted", sessionId: initialized.conversation_id });
  };
  const observeDiagnostic = (value) => {
    const kind = classifyDiagnostic(value);
    if (kind && (!diagnosticKind || kind === "authentication")) diagnosticKind = kind;
  };
  const diagnosticFailure = () => diagnosticKind === "authentication"
    ? failure("ANTIGRAVITY_AUTH_REQUIRED", "Antigravity CLI could not authenticate the background worker. Restore its configured credentials without opening a Desktop chat.", "authentication", deliveryState())
    : diagnosticKind === "permission"
      ? failure("ANTIGRAVITY_PERMISSION_DENIED", "Antigravity CLI denied a required tool operation. Inspect its scoped permission rules; no permissions were changed.", "permission", deliveryState())
      : stderrOverflow ? failure("ANTIGRAVITY_WORKER_DIAGNOSTIC_LIMIT", "Antigravity CLI exceeded its bounded diagnostic limit; successful execution could not be verified.", "observation", deliveryState()) : null;
  const abort = () => {
    if (!terminal) {
      const error = failure("ANTIGRAVITY_WORKER_ABORTED", "The Antigravity worker was canceled. Inspect its existing receipt before further action.", "cancellation", deliveryState());
      session?.fail(error);
      rejectInterruption(error);
    }
  };
  const observe = (promise) => Promise.race([promise, interrupted]);
  try {
    session = new AntigravityCliSession({
      binary: executable, cwd, env: workerEnv, spawn,
      startupTimeoutMs: Math.min(30000, timeoutMs), turnTimeoutMs: timeoutMs, closeTimeoutMs: Math.min(1000, timeoutMs),
      onStderr(chunk) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.length > MAX_STDERR_BYTES - stderrBytes) stderrOverflow = true;
        if (stderrBytes >= MAX_STDERR_BYTES) return;
        const text = bytes.subarray(0, MAX_STDERR_BYTES - stderrBytes).toString("utf8");
        stderrBytes += Math.min(bytes.length, MAX_STDERR_BYTES - stderrBytes);
        for (let offset = 0; offset < text.length; offset += 4096) {
          stderrTail = `${stderrTail}${text.slice(offset, offset + 4096)}`.slice(-8192);
          observeDiagnostic(stderrTail);
        }
      },
      onEvent(event) {
        if (event.event === "init") {
          initialized = { conversation_id: event.conversation_id, tools: event.init.tools };
          return;
        }
        if (event.event === "result") {
          accept();
          terminal = true;
          observeDiagnostic(event.result.error);
          return;
        }
        if (event.event !== "step_update") return;
        const step = event.step_update;
        if (!step || step.conversation_id !== initialized?.conversation_id) throw new Error("Invalid Antigravity event");
        if (!session.awaitingResult) throw new Error("Invalid Antigravity event");
        if (step.step_type === "user_input" && step.state === "DONE") accept();
        const error = step.tool_info?.error;
        if (error) observeDiagnostic(typeof error === "string" ? error : `${typeof error.type === "string" ? error.type : ""} ${typeof error.message === "string" ? error.message : ""}`);
      },
    });
    deadlineTimer = setTimeout(() => {
      const error = failure("ANTIGRAVITY_WORKER_TIMEOUT", "The Antigravity worker exceeded its observation deadline. Inspect its existing receipt before further action.", "observation", deliveryState());
      session.fail(error);
      rejectInterruption(error);
    }, Math.max(1, deadline - Date.now()));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) throw failure("ANTIGRAVITY_WORKER_ABORTED", "The Antigravity worker was canceled before dispatch.", "cancellation");
    const started = await observe(session.start());
    if (diagnosticFailure()) throw diagnosticFailure();
    const relayToolsVerified = relayToolsAvailable(initialized?.tools);
    notify({ type: "session", sessionId: started.conversationId });
    await observe(Promise.all(observers));
    if (observerFailed) throw failure("ANTIGRAVITY_WORKER_OBSERVER_FAILED", "The Antigravity worker could not record its session event.", "observation");
    if (signal?.aborted) throw failure("ANTIGRAVITY_WORKER_ABORTED", "The Antigravity worker was canceled before dispatch.", "cancellation");
    const remaining = deadline - Date.now();
    if (remaining < 1) throw failure("ANTIGRAVITY_WORKER_TIMEOUT", "The Antigravity worker exceeded its observation deadline.", "observation");
    session.turnTimeoutMs = remaining;
    const result = await observe(session.send(prompt));
    await observe(session.close());
    await observe(Promise.all(observers));
    if (observerFailed) throw failure("ANTIGRAVITY_WORKER_OBSERVER_FAILED", "The Antigravity worker could not record its acceptance event.", "observation", deliveryState());
    if (diagnosticFailure()) throw diagnosticFailure();
    if (result.status !== "SUCCESS" || result.error) throw failure("ANTIGRAVITY_WORKER_TURN_FAILED", "Antigravity CLI returned an unsuccessful background turn. Inspect the existing worker receipt.", "execution", deliveryState());
    return { output: result.response, sessionId: result.conversation_id, ...(sessionId ? { workerSessionId: sessionId } : {}), deliveryState: "sent", sent: true, authenticated: true, relayToolsVerified };
  } catch (error) {
    const state = deliveryState();
    if (/^ANTIGRAVITY_[A-Z_]+$/.test(error?.code ?? "")) finalError = failure(error.code, error.message, error.phase, state);
    else if (diagnosticFailure()) finalError = diagnosticFailure();
    else if (["STARTUP_TIMEOUT", "TURN_TIMEOUT"].includes(error?.code)) finalError = failure("ANTIGRAVITY_WORKER_TIMEOUT", "The Antigravity worker exceeded its observation deadline. Inspect its existing receipt before further action.", "observation", state);
    else if (error?.code === "INVALID_PROTOCOL") finalError = failure("ANTIGRAVITY_WORKER_PROTOCOL_ERROR", "Antigravity CLI returned invalid or mismatched streaming data.", "protocol", state);
    else finalError = failure("ANTIGRAVITY_WORKER_FAILED", "The Antigravity CLI worker could not complete its operation. Inspect its existing receipt before further action.", state === "not_sent" ? "startup" : "execution", state);
    finalError.requestId = requestId;
    if (initialized?.conversation_id) finalError.sessionId = initialized.conversation_id;
    if (sessionId) finalError.workerSessionId = sessionId;
    throw finalError;
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", abort);
    const closed = await session?.close();
    if (!finalError && closed?.status === "closing") throw failure("ANTIGRAVITY_WORKER_STOP_FAILED", "The Antigravity worker did not confirm process shutdown.", "shutdown", deliveryState());
  }
}
