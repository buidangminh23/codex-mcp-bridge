#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  MAX_FRAME_BYTES,
  NATIVE_DISPATCH_METHOD,
  NativeToolsClient,
  NativeRelayError,
  RELAY_PROTOCOL_VERSION,
  ACCOUNT_RELAY_PROTOCOL_VERSION,
  accountRelaySocketPath,
  relayAccountContext,
  relaySocketPath,
  resolveRelayThreadId,
  desktopTaskSocketPath,
  desktopTasksConfigured,
  validateDesktopOperation,
  decodeNativeToolResult,
} from "./native-relay.mjs";
import { IS_WINDOWS, PLATFORM_LABEL } from "./platform.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { assertAccountIdentity } from "./bridge-account-context.mjs";
import { createReloadControl } from "./reload-control.mjs";
import { createRuntimeState } from "./runtime-state.mjs";
import { hardenedBridgeEnabled } from "./hardened-root-policy.mjs";
import { protectCurrentUserPipe } from "./windows-pipe-acl.mjs";
import { createHardenedRootPolicy } from "./hardened-root-policy.mjs";

exitForVersionRequest(import.meta.url);

const VERSION = "1.18.2";
const log = (msg) => process.stderr.write(`[native-relay] ${msg}\n`);

function errorResponse(code, message, sent) {
  return { ok: false, v: RELAY_PROTOCOL_VERSION, error: { code, message, ...(sent === false ? { sent: false } : {}) } };
}

function boundRequest(payload) {
  return payload?.v === ACCOUNT_RELAY_PROTOCOL_VERSION;
}

function validProtocol(payload) {
  return boundRequest(payload) ? Object.hasOwn(payload, "accountContext") : (payload?.v === undefined || payload.v === RELAY_PROTOCOL_VERSION) && !Object.hasOwn(payload, "accountContext");
}

async function checkAccountContext(payload, assertAccount) {
  const accounts = relayAccountContext(payload.accountContext);
  if (boundRequest(payload) && !accounts) throw new NativeRelayError("Protocol 2 requires the original account context", "RELAY_BAD_REQUEST");
  if (accounts) await assertAccount(accounts);
  return accounts;
}

/**
 * A JSON-RPC error arrives with a numeric code, and passing that straight back
 * would put `-32601` in a field whose other values read `RELAY_TIMEOUT`. Only a
 * string code from this project's own errors is carried through.
 */
function errorCode(err) {
  return typeof err?.code === "string" ? err.code : "NATIVE_DISPATCH_FAILED";
}

export function createNativeScopeAuthorizer({ dispatchDesktop, env = process.env } = {}) {
  const roots = createHardenedRootPolicy(env);
  if (typeof dispatchDesktop !== "function") throw new Error("Native metadata dispatcher is required");
  const call = async (executorThreadId, operation, arguments_, accountContext) => decodeNativeToolResult(await dispatchDesktop({ executorThreadId, operation, arguments: arguments_ }, { accountContext }));
  const fail = (message) => { throw new NativeRelayError(message, "NATIVE_SCOPE_UNVERIFIED"); };
  const projectRecord = (project) => {
    if (project?.projectKind !== "local" || project.hostId !== "local" || typeof project.projectId !== "string" || !project.projectId) return null;
    try {
      return { project, projectId: project.projectId, root: roots.capture(project.path, "Saved project directory") };
    } catch {
      return null;
    }
  };
  const projectsFor = async (executorThreadId, accountContext) => {
    const result = await call(executorThreadId, "list_projects", {}, accountContext);
    if (!Array.isArray(result?.projects)) fail("Native project metadata is unavailable");
    const projects = result.projects.map(projectRecord).filter(Boolean);
    return projects.filter((candidate) =>
      projects.filter((other) => other.projectId === candidate.projectId).length === 1
      && projects.filter((other) => other.root.path === candidate.root.path).length === 1);
  };
  const projectForThread = (thread, projects) => {
    const root = roots.capture(thread.cwd, "Native task working directory");
    const matching = projects.filter((project) => project.root.path === root.path);
    if (matching.length !== 1) fail("Native task does not map to exactly one allowed local saved project");
    if (thread.projectId !== undefined && thread.projectId !== matching[0].projectId) fail("Native task project identity conflicts with its saved project directory");
    return { root, project: matching[0] };
  };
  const validateThread = (thread, threadId, projects) => {
    if (thread?.id !== threadId || thread.kind !== "codex" || thread.hostId !== "local") fail("Native task metadata does not prove the exact allowed local task");
    const scope = projectForThread(thread, projects);
    return { threadId, kind: thread.kind, hostId: thread.hostId, root: scope.root, projectId: scope.project.projectId };
  };
  const threadFor = async (executorThreadId, threadId, accountContext, projects) => {
    if (typeof threadId !== "string" || !threadId) fail("Operation has no target task");
    const result = await call(executorThreadId, "read_thread", { threadId, hostId: "local", turnLimit: 1 }, accountContext);
    return validateThread(result?.thread, threadId, projects);
  };
  const targetIds = (operation, args, targetThreadId) => {
    if (["read_thread", "send_message_to_thread", "navigate_to_codex_page", "set_thread_title"].includes(operation)) return [targetThreadId ?? args?.threadId];
    if (operation === "wait_threads") {
      if (!Array.isArray(args?.targets) || !args.targets.length) fail("Wait targets are not verifiable");
      const ids = args.targets.map((target) => target?.threadId);
      if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) fail("Wait targets must be distinct exact task ids");
      return ids;
    }
    return [];
  };
  const contextFor = async ({ executorThreadId, targetThreadId, operation, arguments: args, accountContext }) => {
    const projects = await projectsFor(executorThreadId, accountContext);
    const executor = await threadFor(executorThreadId, executorThreadId, accountContext, projects);
    if (operation === "wait_threads" && targetIds(operation, args, targetThreadId).includes(executorThreadId)) {
      fail("The native wait operation cannot target its calling executor task");
    }
    const targets = [];
    for (const id of targetIds(operation, args, targetThreadId)) targets.push(await threadFor(executorThreadId, id, accountContext, projects));
    if (operation === "create_thread") {
      const requested = args?.target?.type === "project" ? args.target.projectId : null;
      const matching = projects.filter((project) => project.projectId === requested);
      if (matching.length !== 1 || args?.target?.environment?.type !== "local") fail("Creation target is not the exact allowed saved local project");
      return { executor, targets, requestedProject: matching[0], projects };
    }
    return { executor, targets, requestedProject: null, projects };
  };
  const compare = (expected, current) => {
    if (!expected) return;
    roots.recheck(expected.executor.root, "Relay executor working directory");
    if (expected.executor.threadId !== current.executor.threadId || expected.executor.projectId !== current.executor.projectId
        || expected.executor.root.path !== current.executor.root.path) fail("Relay executor identity changed while the operation was pending");
    if (expected.targets.length !== current.targets.length) fail("Native target set changed while the operation was pending");
    for (let index = 0; index < expected.targets.length; index += 1) {
      const before = expected.targets[index];
      const after = current.targets[index];
      roots.recheck(before.root, "Native target working directory");
      if (before.threadId !== after.threadId || before.kind !== after.kind || before.hostId !== after.hostId
          || before.projectId !== after.projectId || before.root.path !== after.root.path) fail("Native target identity changed while the operation was pending");
    }
    if (expected.requestedProject) {
      roots.recheck(expected.requestedProject.root, "Creation project directory");
      if (!current.requestedProject || expected.requestedProject.projectId !== current.requestedProject.projectId
          || expected.requestedProject.root.path !== current.requestedProject.root.path) fail("Creation project identity changed while the operation was pending");
    }
  };
  const filterProjects = (result, current) => {
    if (!Array.isArray(result?.projects)) fail("Native project list result is invalid");
    const allowed = new Map(current.projects.map((project) => [project.projectId, project]));
    return { projects: result.projects.filter((project) => {
      const scope = projectRecord(project);
      const expected = scope && allowed.get(scope.projectId);
      return Boolean(expected && expected.root.path === scope.root.path);
    }) };
  };
  const filterThreads = (result, current) => {
    if (!Array.isArray(result?.threads) || !Array.isArray(result?.pinnedThreads)) fail("Native thread list result is invalid");
    const seen = new Set();
    const filter = (rows) => rows.filter((thread) => {
      if (typeof thread?.id !== "string" || seen.has(thread.id)) return false;
      try {
        validateThread(thread, thread.id, current.projects);
        seen.add(thread.id);
        return true;
      } catch {
        return false;
      }
    });
    return { pinnedThreads: filter(result.pinnedThreads), threads: filter(result.threads) };
  };
  const filterWait = (result, current) => {
    if (typeof result?.timedOut !== "boolean" || !Array.isArray(result?.polls)) fail("Native wait result is invalid");
    const allowed = new Map(current.targets.map((target) => [target.threadId, target]));
    const checkReturnedBinding = (row, target) => {
      // Native wait rows may omit these fields; explicit contradictions cannot
      // override the independently reread target binding.
      if ((row.kind !== undefined && row.kind !== target.kind)
          || (row.projectId !== undefined && row.projectId !== target.projectId)) fail("Native wait result contradicts the selected task identity");
      if (row.cwd !== undefined) {
        const returned = roots.capture(row.cwd, "Native wait result working directory");
        if (returned.path !== target.root.path || returned.identity !== target.root.identity) fail("Native wait result contradicts the selected task directory");
      }
    };
    const seen = new Set();
    const polls = result.polls.filter((poll) => {
      const id = poll?.thread?.id;
      if (typeof id !== "string" || poll?.thread?.hostId !== "local" || !allowed.has(id) || seen.has(id)) return false;
      checkReturnedBinding(poll.thread, allowed.get(id));
      seen.add(id);
      return true;
    });
    const wake = result.wake && typeof result.wake === "object"
      && result.wake.hostId === "local" && allowed.has(result.wake.threadId)
      ? result.wake : null;
    if (wake) checkReturnedBinding(wake, allowed.get(wake.threadId));
    return { timedOut: result.timedOut, wake, polls };
  };
  return async (request) => {
    try {
      const current = await contextFor(request);
      compare(request.expected, current);
      if (request.phase !== "return") return current;
      const result = request.result;
      if (request.operation === "list_projects") return { ...current, result: filterProjects(result, current) };
      if (request.operation === "list_threads") return { ...current, result: filterThreads(result, current) };
      if (request.operation === "wait_threads") return { ...current, result: filterWait(result, current) };
      if (request.operation === "read_thread") {
        const returned = validateThread(result?.thread, request.targetThreadId ?? request.arguments?.threadId, current.projects);
        const selected = current.targets[0];
        if (!selected || returned.projectId !== selected.projectId || returned.root.path !== selected.root.path
            || returned.root.identity !== selected.root.identity) fail("Native read result does not match the selected task binding");
      }
      if (request.operation === "create_thread") {
        const createdId = result?.threadId;
        if (typeof createdId !== "string" || !createdId.trim()) throw new NativeRelayError("Native creation did not return a confirmed task id; inspect the existing outcome before any further creation", "NATIVE_DELIVERY_UNCONFIRMED");
        if (result.hostId !== undefined && result.hostId !== "local") fail("Native creation result does not identify the requested local host");
        const created = await threadFor(request.executorThreadId, createdId, request.accountContext, current.projects);
        roots.recheck(current.requestedProject.root, "Creation project directory");
        if (created.projectId !== current.requestedProject.projectId || created.root.path !== current.requestedProject.root.path
            || created.root.identity !== current.requestedProject.root.identity) fail("Created task does not belong to the requested saved project");
      }
      return { ...current, result };
    } catch (error) {
      if (typeof error?.code === "string") throw error;
      fail(error?.message ?? String(error));
    }
  };
}

/**
 * The whole request handler, kept free of sockets and of the MCP connection so
 * the rules it enforces can be tested against a stub dispatcher rather than
 * against a running Codex Desktop.
 */
export async function handleRelayRequest(
  payload,
  { dispatch, dispatchDesktop, resolveExecutor = resolveRelayThreadId, env = process.env, assertAccount = assertAccountIdentity, authorize, strict = hardenedBridgeEnabled(env) } = {},
) {
  if (strict && (!boundRequest(payload) || !validProtocol(payload))) return errorResponse("RELAY_BAD_REQUEST", "Hardened relay accepts only protocol 2 requests with account context", false);
  if (strict && typeof authorize !== "function") return errorResponse("NATIVE_SCOPE_UNVERIFIED", "Hardened relay requires verified current native project and task metadata; no dispatch was attempted", false);
  if (payload && typeof payload === "object" && Object.hasOwn(payload, "operation")) {
    return handleDesktopRequest(payload, { dispatchDesktop, resolveExecutor, env, assertAccount, authorize, strict });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !["v", "targetThreadId", "message", "accountContext"].includes(key)) || !validProtocol(payload)) {
    return errorResponse("RELAY_BAD_REQUEST", "expected a relay request with targetThreadId and message");
  }
  const targetThreadId = typeof payload?.targetThreadId === "string" ? payload.targetThreadId.trim() : "";
  const message = typeof payload?.message === "string" ? payload.message : "";

  if (!targetThreadId) return errorResponse("RELAY_BAD_REQUEST", "targetThreadId must be a non-empty string");
  if (!message.trim()) return errorResponse("RELAY_BAD_REQUEST", "message must be a non-empty string");

  let executorThreadId;
  let accountContext;
  try {
    accountContext = await checkAccountContext(payload, assertAccount);
    executorThreadId = resolveExecutor(env).threadId;
    var authorization;
    if (strict) authorization = await authorize({ executorThreadId, targetThreadId, operation: "send_message_to_thread", accountContext });
  } catch (err) {
    return errorResponse(errorCode(err), err.message, false);
  }

  /**
   * Codex validates the executor thread, so a destination that is also the
   * executor would be dispatched rather than refused - and the message would
   * land in the relay thread instead of the thread the human is watching.
   * Nothing downstream can tell those two apart afterwards.
   */
  if (executorThreadId === targetThreadId) {
    return errorResponse(
      "RELAY_BAD_REQUEST",
      `${targetThreadId} is the relay's own executor thread, not a destination. Bind the thread you are watching in Codex Desktop.`,
    );
  }

  try {
    const result = await dispatch({ executorThreadId, targetThreadId, message }, {
      accountContext,
      ...(strict ? { beforeSend: () => authorize({ executorThreadId, targetThreadId, operation: "send_message_to_thread", accountContext, phase: "write", expected: authorization }) } : {}),
    });
    if (strict) await authorize({ executorThreadId, targetThreadId, operation: "send_message_to_thread", accountContext, phase: "return", expected: authorization, result });
    if (result?.success !== true || result?.isError === true) {
      const detail = typeof result?.error === "string" ? result.error : result?.error?.message;
      return errorResponse("NATIVE_DISPATCH_FAILED", detail ?? "Codex Desktop did not confirm successful native dispatch");
    }
    return { ok: true, v: boundRequest(payload) ? ACCOUNT_RELAY_PROTOCOL_VERSION : RELAY_PROTOCOL_VERSION, targetThreadId, executorThreadId, result: result ?? null };
  } catch (err) {
    return errorResponse(errorCode(err), err?.message ?? String(err), err?.sent === false && err?.reachedCompanion !== true ? false : undefined);
  }
}

async function handleDesktopRequest(payload, { dispatchDesktop, resolveExecutor, env, assertAccount, authorize, strict = hardenedBridgeEnabled(env) }) {
  if (strict && !boundRequest(payload)) return errorResponse("RELAY_BAD_REQUEST", "Hardened relay accepts only protocol 2 Desktop operations", false);
  if (Array.isArray(payload) || ![RELAY_PROTOCOL_VERSION, ACCOUNT_RELAY_PROTOCOL_VERSION].includes(payload.v) || !validProtocol(payload) ||
      Object.keys(payload).some((key) => !["v", "operation", "arguments", "accountContext"].includes(key))) {
    return errorResponse("RELAY_BAD_REQUEST", "expected an allowlisted Desktop operation");
  }
  try {
    validateDesktopOperation(payload.operation, payload.arguments);
    let accountContext;
    try {
      accountContext = await checkAccountContext(payload, assertAccount);
    } catch (error) {
      return errorResponse(errorCode(error), error.message, false);
    }
    if (typeof dispatchDesktop !== "function") {
      return errorResponse("NATIVE_OPERATION_UNAVAILABLE", "This companion does not support Desktop operations; reload the native relay");
    }
    const executorThreadId = resolveExecutor(env).threadId;
    const request = { executorThreadId, targetThreadId: payload.arguments?.threadId, operation: payload.operation, arguments: payload.arguments, accountContext };
    const authorization = strict ? await authorize(request) : null;
    if (payload.operation === "send_message_to_thread" && payload.arguments.threadId === executorThreadId) {
      return errorResponse("RELAY_BAD_REQUEST", "The relay executor cannot receive its own relayed message");
    }
    const nativeResult = await dispatchDesktop({
      executorThreadId,
      operation: payload.operation,
      arguments: payload.arguments,
    }, {
      accountContext,
      ...(strict ? { beforeSend: () => authorize({ ...request, phase: "write", expected: authorization }) } : {}),
    });
    const decoded = decodeNativeToolResult(nativeResult);
    const checked = strict ? await authorize({ ...request, phase: "return", expected: authorization, result: decoded }) : null;
    return {
      ok: true,
      v: boundRequest(payload) ? ACCOUNT_RELAY_PROTOCOL_VERSION : RELAY_PROTOCOL_VERSION,
      operation: payload.operation,
      executorThreadId,
      result: checked?.result ?? decoded,
    };
  } catch (err) {
    return errorResponse(errorCode(err), err?.message ?? String(err), err?.sent === false && err?.reachedCompanion !== true ? false : undefined);
  }
}

/**
 * Listens on a private local socket or Windows named pipe and answers one NDJSON line per request.
*
 * POSIX sockets are mode 0600 inside the Codex home directory. Windows uses the
 * Claude-compatible local named-pipe namespace instead of a filesystem mode.
 */
export class RelaySocketServer {
  constructor({
    socketPath,
    dispatch,
    dispatchDesktop,
    resolveExecutor = resolveRelayThreadId,
    assertAccount = assertAccountIdentity,
    authorize,
    requireAccountContext = false,
    strict = hardenedBridgeEnabled(),
    protectSocket = protectCurrentUserPipe,
    restrictSocket = (target) => {
      if (!IS_WINDOWS) fs.chmodSync(target, 0o600);
    },
    log: logFn = () => {},
  } = {}) {
    this.socketPath = socketPath;
    this.dispatch = dispatch;
    this.dispatchDesktop = dispatchDesktop;
    this.resolveExecutor = resolveExecutor;
    this.assertAccount = assertAccount;
    this.authorize = authorize;
    this.requireAccountContext = requireAccountContext;
    this.strict = strict;
    this.protectSocket = protectSocket;
    this.restrictSocket = restrictSocket;
    this.log = logFn;
    this.server = null;
    this.started = false;
    this.connections = new Set();
    this.handlers = new Set();
    this.accepting = true;
    this.closed = Promise.resolve();
    this.processHandlers = new Map();
    this.aclReady = !IS_WINDOWS || !strict;
    this.provisionalSockets = new Set();
    this.startGeneration = 0;
    this.startPromise = null;
  }

  start() {
    if (this.started) return this.socketPath;
    if (this.startPromise) return this.startPromise;
    const starting = this.#startOnce();
    const shared = starting.finally(() => {
      if (this.startPromise === shared) this.startPromise = null;
    });
    this.startPromise = shared;
    return shared;
  }

  async #startOnce() {
    if (!IS_WINDOWS) fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });

    const generation = ++this.startGeneration;
    this.aclReady = !IS_WINDOWS || !this.strict;
    this.server = net.createServer((socket) => this.#handleConnection(socket));
    await this.#listen({ replaceStale: true });

    /**
     * The file mode is the whole security boundary, so a socket whose mode
     * could not be set is not a degraded relay - it is an open one. Refuse it
     * and let the caller fall back to the app-server path, rather than serving
     * thread writes on an address anyone can open.
     */
    try {
      if (IS_WINDOWS && this.strict) {
        await this.protectSocket(this.socketPath);
        if (generation !== this.startGeneration) throw new Error("Windows pipe ACL startup was cancelled");
        this.aclReady = true;
        for (const provisional of this.provisionalSockets) provisional.destroy();
        this.provisionalSockets.clear();
      } else this.restrictSocket(this.socketPath);
      if (generation !== this.startGeneration) throw new Error("Relay socket startup was cancelled");
    } catch (err) {
      this.aclReady = !IS_WINDOWS || !this.strict;
      for (const socket of this.provisionalSockets) socket.destroy();
      this.provisionalSockets.clear();
      await this.#closeServer();
      throw new Error(`refusing to serve on ${this.socketPath}: its mode could not be restricted (${err.message})`);
    }
    this.started = true;

    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => {
        this.stop();
        process.exit(0);
      };
      this.processHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    const onExit = () => this.stop();
    this.processHandlers.set("exit", onExit);
    process.on("exit", onExit);

    this.log(`relay socket listening on ${this.socketPath}`);
    return this.socketPath;
  }

  #closeServer() {
    const server = this.server;
    return new Promise((resolve) => {
      if (!server) return resolve();
      try {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  /**
   * A companion killed with SIGKILL leaves its socket file behind, and the next
   * one then fails to bind a path nothing is listening on. Removing it blindly
   * would be worse: Codex Desktop can launch more than one companion, and the
   * second would silently steal the address from the first. So an in-use path
   * is probed - a refused connection means the owner is gone and the file is
   * swept, an accepted one means a live companion already has the socket and
   * this process leaves it alone.
   */
  async #listen({ replaceStale }) {
    try {
      await new Promise((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.socketPath, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      if (err.code !== "EADDRINUSE" || !replaceStale) throw err;
      if (IS_WINDOWS) {
        if (await this.#socketIsLive()) {
          throw new Error(`another native relay companion already owns ${this.socketPath}`);
        }
        await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
        return this.#listen({ replaceStale: false });
      }
      if (await this.#socketIsLive()) {
        throw new Error(`another native relay companion already owns ${this.socketPath}`);
      }
      this.log(`removing the stale relay socket left at ${this.socketPath}`);
      fs.rmSync(this.socketPath, { force: true });
      await this.#listen({ replaceStale: false });
    }
  }

  #socketIsLive() {
    return new Promise((resolve) => {
      const probe = net.connect({ path: this.socketPath });
      const timer = globalThis.setTimeout(() => done(false), 1000);
      const done = (answer) => {
        globalThis.clearTimeout(timer);
        probe.destroy();
        resolve(answer);
      };
      probe.on("connect", () => done(true));
      probe.on("error", () => done(false));
    });
  }

  async isListening() {
    if (this.startPromise) {
      try { await this.startPromise; } catch { return false; }
      return this.started;
    }
    return this.started || this.#socketIsLive();
  }

  #handleConnection(socket) {
    if (IS_WINDOWS && !this.aclReady) {
      this.provisionalSockets.add(socket);
      socket.once("close", () => this.provisionalSockets.delete(socket));
      socket.once("error", () => {});
      return;
    }
    if (!this.accepting) {
      socket.on("error", () => {});
      socket.end(`${JSON.stringify(errorResponse("RELAY_RELOADING", "The native relay is reloading; no message was sent", false))}\n`);
      return;
    }
    let buffer = Buffer.alloc(0);
    let handled = false;
    this.connections.add(socket);
    socket.on("close", () => this.connections.delete(socket));
    socket.setTimeout(30000, () => socket.destroy());
    socket.on("error", (err) => this.log(`relay socket error: ${err.message}`));
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        handled = true;
        this.#reply(socket, errorResponse("RELAY_MESSAGE_TOO_LARGE", `a relay frame may not exceed ${MAX_FRAME_BYTES} bytes`));
        return;
      }
      const index = buffer.indexOf(10);
      if (index < 0) return;
      handled = true;
      const handler = this.#handleLine(socket, buffer.subarray(0, index).toString("utf8"));
      this.handlers.add(handler);
      void handler.catch((error) => {
        this.log(`relay request failed: ${error.message}`);
        this.#reply(socket, errorResponse("NATIVE_DISPATCH_FAILED", "The native relay request failed before delivery was confirmed"));
      }).finally(() => this.handlers.delete(handler));
      buffer = Buffer.alloc(0);
    });
  }

  async #handleLine(socket, line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (err) {
      this.#reply(socket, errorResponse("RELAY_BAD_REQUEST", `malformed JSON: ${err.message}`));
      return;
    }
    if ((this.requireAccountContext || this.strict) && !boundRequest(payload)) {
      this.#reply(socket, errorResponse("RELAY_BAD_REQUEST", "The account relay requires protocol 2 and the original account context", false));
      return;
    }
    const response = await handleRelayRequest(payload, {
      dispatch: this.dispatch,
      dispatchDesktop: this.dispatchDesktop,
      resolveExecutor: this.resolveExecutor,
      assertAccount: this.assertAccount,
      authorize: this.authorize,
      strict: this.strict,
    });
    if (!response.ok) this.log(`relay refused ${payload?.targetThreadId ?? "?"}: ${response.error.message}`);
    else this.log(response.operation ? `completed Desktop operation ${response.operation}` : `relayed a message into thread ${response.targetThreadId}`);
    this.#reply(socket, response);
  }

  #reply(socket, response) {
    if (socket.destroyed) return;
    socket.end(`${JSON.stringify(response)}\n`);
  }

  stop() {
    this.startGeneration += 1;
    this.aclReady = !IS_WINDOWS || !this.strict;
    for (const socket of this.provisionalSockets) socket.destroy();
    this.provisionalSockets.clear();
    for (const [event, handler] of this.processHandlers) process.off(event, handler);
    this.processHandlers.clear();
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.closed = new Promise((resolve) => {
      if (!server) return resolve();
      try { server.close(() => resolve()); }
      catch { resolve(); }
    });
    try {
      if (this.started && !IS_WINDOWS) fs.rmSync(this.socketPath, { force: true });
    } catch {}
    this.started = false;
  }
}

export function startRelayWhenAvailable({ nativeTools, relay, log: logFn = () => {}, retryDelayMs = 250, maxRetryDelayMs = 30000 }) {
  let stopped = false;
  let timer = null;
  let delayMs = retryDelayMs;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let pendingAttempt = null;
  let nativeConnected = false;
  const attempt = async () => {
    if (stopped) return;
    nativeConnected = false;
    try {
      await nativeTools.connect();
      nativeConnected = true;
      if (stopped) {
        nativeTools.close();
        return;
      }
      await relay.start();
      if (stopped) {
        relay.stop();
        nativeTools.close();
        return;
      }
      resolveReady(true);
    } catch (err) {
      if (stopped) return;
      if (!nativeConnected) nativeTools.close();
      logFn(`native relay unavailable (${err.message}); retrying in ${delayMs}ms`);
      timer = globalThis.setTimeout(() => {
        timer = null;
        runAttempt();
      }, delayMs);
      timer.unref();
      delayMs = Math.min(delayMs * 2, maxRetryDelayMs);
    }
  };
  const runAttempt = () => {
    const running = attempt();
    pendingAttempt = running;
    void running.finally(() => { if (pendingAttempt === running) pendingAttempt = null; });
    return running;
  };
  const firstAttempt = runAttempt();
  return {
    ready,
    firstAttempt,
    get connected() { return nativeConnected; },
    get busy() { return pendingAttempt !== null; },
    stop() {
      if (stopped) return pendingAttempt ?? Promise.resolve();
      stopped = true;
      globalThis.clearTimeout(timer);
      nativeTools.close();
      relay.stop();
      resolveReady(false);
      return (pendingAttempt ?? Promise.resolve()).then(() => relay.closed);
    },
  };
}

export function createNativeRelayLifecycle({ nativeTools, relays, log: logFn = () => {} }) {
  const servers = [...new Set(relays)];
  let startups = [];
  let ownedSockets = [];
  const inspect = () => {
    if (servers.some((relay) => relay.handlers.size)) return "Native relay requests are still active";
    if (servers.some((relay) => relay.connections.size)) return "Native relay clients are still connected";
    if (nativeTools.pending.size) return "Native Desktop dispatches are still pending";
    if (nativeTools.connecting || startups.some((startup) => startup.busy)) return "Native relay startup is still pending";
    return null;
  };
  const stop = async () => {
    for (const relay of servers) relay.accepting = false;
    const active = startups;
    startups = [];
    await Promise.all(active.map((startup) => startup.stop()));
    for (const relay of servers) relay.stop();
    await Promise.all(servers.map((relay) => relay.closed));
    nativeTools.close();
  };
  const activate = async () => {
    if (startups.length) {
      for (const relay of servers) relay.accepting = true;
      return;
    }
    for (const relay of servers) relay.accepting = true;
    startups = servers.map((relay) => startRelayWhenAvailable({ nativeTools, relay, log: logFn }));
    await Promise.all(startups.map((startup) => startup.firstAttempt));
    const restoredListeners = await Promise.all(servers.map(async (relay, index) =>
      !ownedSockets.includes(relay.socketPath) || startups[index].connected && await relay.isListening()));
    if (restoredListeners.some((available) => !available)) {
      await stop();
      throw new Error("The replacement native relay could not reclaim its listening sockets");
    }
  };
  return {
    inspect,
    activate,
    stop,
    async quiesce() {
      for (const relay of servers) relay.accepting = false;
      const reason = inspect();
      if (reason) throw new Error(reason);
      ownedSockets = servers.filter((relay) => relay.started).map((relay) => relay.socketPath);
      await stop();
    },
    exportState: () => ({ ownedSockets }),
    restore(payload) {
      if (Object.keys(payload).some((key) => key !== "ownedSockets") || !Array.isArray(payload.ownedSockets)
          || payload.ownedSockets.length > servers.length || new Set(payload.ownedSockets).size !== payload.ownedSockets.length
          || payload.ownedSockets.some((socket) => typeof socket !== "string" || !servers.some((relay) => relay.socketPath === socket))) {
        throw new Error("Native relay listener state does not match this worker");
      }
      ownedSockets = [...payload.ownedSockets];
    },
  };
}

/**
 * `import.meta.main` is Node 24 and up, and this project supports Node 22, so
 * the entry point is detected by comparing the resolved argv path instead.
 */
const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const mcp = new McpServer(
    { name: "codex-native-relay", version: VERSION },
    {
      instructions:
        "Companion process for the Codex Desktop native relay. It carries no work of its own: it accepts " +
        "messages from claude-bridge on a private local socket and asks the Codex Desktop app-server that " +
        "launched it to deliver them into an already-open thread, so that thread keeps its writer lock.",
    },
  );

  const nativeTools = new NativeToolsClient();
  const dispatch = (args, options) => nativeTools.dispatch(args, options);

  const hardened = hardenedBridgeEnabled();
  if (hardened && !desktopTasksConfigured()) throw new Error("CODEX_BRIDGE_HARDENED=1 requires CODEX_BRIDGE_DESKTOP_TASKS=1; legacy relay listeners are disabled");
  const relay = new RelaySocketServer({
    socketPath: relaySocketPath(),
    dispatch,
    dispatchDesktop: (args, options) => nativeTools.dispatchDesktop(args, options),
    log,
  });
  const desktopRelay = desktopTaskSocketPath() === relay.socketPath ? relay : new RelaySocketServer({
    socketPath: desktopTaskSocketPath(),
    dispatchDesktop: (args, options) => nativeTools.dispatchDesktop(args, options),
    log,
  });
  const accountRelay = new RelaySocketServer({
    socketPath: accountRelaySocketPath(),
    requireAccountContext: true,
    strict: hardened,
    dispatch,
    dispatchDesktop: (args, options) => nativeTools.dispatchDesktop(args, options),
    authorize: hardened ? createNativeScopeAuthorizer({ dispatchDesktop: (args, options) => nativeTools.dispatchDesktop(args, options) }) : undefined,
    log,
  });
  const runtime = createRuntimeState();
  const strictDesktop = hardened && desktopTasksConfigured();
  const lifecycle = createNativeRelayLifecycle({ nativeTools, relays: strictDesktop ? [accountRelay] : [relay, desktopRelay, accountRelay], log });
  const reload = createReloadControl({ entry: "native-relay-companion.mjs", ...lifecycle });

  mcp.registerTool(
    "native_relay_status",
    {
      title: "Check the Codex Desktop native relay",
      description:
        "Report the local socket this companion listens on, the executor thread it dispatches through, and " +
        "whether the relay is ready to deliver messages into threads Codex Desktop has open.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async () => reload.run(async () => {
      const listening = await (strictDesktop ? accountRelay : relay).isListening();
      let executor = "(unconfigured)";
      try {
        const resolved = resolveRelayThreadId();
        executor = `${resolved.threadId}  (from ${resolved.source})`;
      } catch (err) {
        executor = err.message;
      }
      return {
        structuredContent: { runtime: runtime.status() },
        content: [
          {
            type: "text",
            text: [
              `platform:       ${PLATFORM_LABEL} (${process.platform}/${process.arch})`,
              `companion:      codex-native-relay ${VERSION}`,
              `runtime state:  ${runtime.status().current ? "current" : "stale"} (${reload.inspect().phase}, PID ${process.pid})`,
               `relay socket:   ${strictDesktop ? "disabled by hardened Desktop profile" : relay.started ? relay.socketPath : `${relay.socketPath} (${listening ? "shared companion listening" : "not listening"})`}`,
               `desktop tasks:  ${strictDesktop ? "disabled by hardened Desktop profile" : `${desktopRelay.socketPath} (${await desktopRelay.isListening() ? "listening" : "not listening"})`}`,
              `account relay:  ${accountRelay.socketPath} (protocol ${ACCOUNT_RELAY_PROTOCOL_VERSION}, ${await accountRelay.isListening() ? "listening" : "not listening"})`,
              `executor:       ${executor}`,
              `dispatch:       ${process.env.CODEX_NATIVE_RELAY_METHOD ?? NATIVE_DISPATCH_METHOD}`,
              `native pipe:    ${nativeTools.socketPath ?? "unavailable (requires Codex Desktop)"}`,
            ].join("\n"),
          },
        ],
      };
    }),
  );

  if (!reload.staged) void lifecycle.activate().catch((error) => log(`native relay startup failed: ${error.message}`));
  mcp.server.onclose = () => { void lifecycle.stop(); };
  await mcp.connect(new StdioServerTransport());
  reload.listen();
  log(`ready on ${PLATFORM_LABEL} (${strictDesktop ? accountRelay.socketPath : relay.started ? relay.socketPath : "socket down"})`);
}
