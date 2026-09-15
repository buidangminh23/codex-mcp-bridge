import fs from "node:fs";
import path from "node:path";

const REQUEST_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,128})$/i;
const PENDING = new Set(["awaiting_user", "launch_uncertain", "ambiguous", "awaiting_project_confirmation"]);
const STATUSES = new Set([...PENDING, "created", "abandoned"]);
const MAX_REQUESTS = 32;
const MAX_TASKS = 8192;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function string(value, max = 1024) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

function accountIdentity(account) {
  if (account?.status !== "verified" || !string(account.fingerprint) || !string(account.root, 8192)) {
    fail("CLAUDE_ACCOUNT_UNVERIFIED", "The current Claude Desktop account must be verified.");
  }
  return { fingerprint: account.fingerprint, root: account.root };
}

function sameAccount(left, right) {
  return left.fingerprint === right.fingerprint && left.root === right.root;
}

function augmentedPrompt(prompt, requestId) {
  if (!string(prompt, 14000) || !prompt.trim()) fail("CLAUDE_CREATION_PROMPT_INVALID", "Provide a nonempty prompt of at most 14000 characters.");
  const submitted = `${prompt.trim()}\n\n[Codex creation request: ${requestId}]`;
  if (submitted.length > 14000) fail("CLAUDE_CREATION_PROMPT_TOO_LONG", "The prompt including its correlation marker exceeds 14000 characters.");
  return submitted;
}

function matchesInitialMessage(text, expected) {
  if (text === expected) return true;
  if (typeof text !== "string" || !/^<system-reminder>\r?\nThe user started this session without choosing a project folder,/.test(text)) return false;
  const closing = text.indexOf("</system-reminder>");
  if (closing < 0 || closing > 32768) return false;
  const body = text.slice("<system-reminder>".length, closing);
  if (body.includes("<system-reminder") || body.includes("</system-reminder")) return false;
  const suffix = text.slice(closing + "</system-reminder>".length);
  const separator = /^\r?\n\r?\n/.exec(suffix);
  return separator !== null && suffix.slice(separator[0].length) === expected;
}

function receipt(request) {
  return structuredClone({ requestId: request.requestId, status: request.status, cwd: request.cwd, promptSubmitted: request.status === "created" || request.submissionObserved === true, reason: request.reason, ...(request.observedCwd ? { observedCwd: request.observedCwd } : {}), ...(request.sessionId ? { sessionId: request.sessionId, taskId: request.taskId, title: request.title } : {}) });
}

export class ClaudeSessionCreation {
  constructor({ open, listTasks, listSessions, readContext, readTranscript, readAccount, assertProcess, realpath = (directory) => {
    const canonical = fs.realpathSync.native(directory);
    if (!fs.statSync(canonical).isDirectory()) throw new Error("Not a directory");
    return canonical;
  }, platform = process.platform }) {
    for (const [name, dependency] of Object.entries({ open, listTasks, listSessions, readContext, readTranscript, readAccount, assertProcess, realpath })) {
      if (typeof dependency !== "function") throw new TypeError(`${name} must be a function`);
    }
    Object.assign(this, { open, listTasks, listSessions, readContext, readTranscript, readAccount, assertProcess, realpath, platform });
    this.requests = new Map();
    this.queue = Promise.resolve();
  }

  async canonical(directory) {
    const paths = this.platform === "win32" ? path.win32 : path.posix;
    if (!string(directory, 8192) || !paths.isAbsolute(directory)) fail("CLAUDE_CREATION_CWD_INVALID", "The project directory must be an existing absolute directory.");
    let canonical;
    try { canonical = await this.realpath(directory); } catch { fail("CLAUDE_CREATION_CWD_INVALID", "The project directory does not exist or cannot be resolved."); }
    if (!string(canonical, 8192) || !paths.isAbsolute(canonical)) fail("CLAUDE_CREATION_CWD_INVALID", "The canonical project directory is invalid.");
    return canonical;
  }

  sameCwd(left, right) {
    return this.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  async checkAccount(account, expected) {
    const provided = accountIdentity(account);
    const current = accountIdentity(await this.readAccount());
    if (!sameAccount(provided, current) || (expected && !sameAccount(provided, expected))) fail("CLAUDE_CREATION_ACCOUNT_CHANGED", "Claude Desktop account changed; this creation request cannot be used in another account.");
    return provided;
  }

  start(args) {
    const pending = this.queue.then(() => this.startLocked(args));
    this.queue = pending.catch(() => {});
    return pending;
  }

  async startLocked({ requestId, cwd, prompt, account, senderThreadId, beforeOpen }) {
    if (!REQUEST_ID.test(requestId ?? "") || typeof requestId !== "string") fail("CLAUDE_CREATION_REQUEST_INVALID", "requestId must be a UUID or 32–128 hexadecimal characters.");
    if (!string(senderThreadId, 256)) fail("CLAUDE_CREATION_SENDER_INVALID", "A verified sender thread identity is required.");
    const identity = await this.checkAccount(account);
    const canonical = await this.canonical(cwd);
    const initialMessage = augmentedPrompt(prompt, requestId);
    const prior = this.requests.get(requestId);
    if (prior) {
      if (!sameAccount(identity, prior.account) || prior.senderThreadId !== senderThreadId || !this.sameCwd(prior.cwd, canonical) || prior.prompt !== prompt) {
        fail("CLAUDE_CREATION_REQUEST_CONFLICT", "This requestId is already bound to a different creation payload.");
      }
      return receipt(prior);
    }
    if (this.requests.size >= MAX_REQUESTS) fail("CLAUDE_CREATION_LIMIT", "The creation receipt limit has been reached; existing requests remain available for inspection.");
    for (const existing of this.requests.values()) {
      if (sameAccount(existing.account, identity) && PENDING.has(existing.status)) fail("CLAUDE_CREATION_PENDING", "A creation request is already pending for this account; inspect or explicitly abandon that request before opening another project in the shared composer.");
    }
    const tasks = await this.listTasks(account);
    if (!Array.isArray(tasks) || tasks.length > MAX_TASKS || tasks.some((task) => !string(task?.taskId, 256) || (task.fileTaskId !== undefined && task.fileTaskId !== task.taskId))) fail("CLAUDE_CREATION_TASKS_INVALID", "The existing native task baseline cannot be verified.");
    let existingProject = false;
    for (const task of tasks) {
      if (task.isArchived !== false) continue;
      try { if (this.sameCwd(await this.canonical(task.cwd), canonical)) existingProject = true; } catch {}
    }
    if (!existingProject) fail("CLAUDE_CREATION_PROJECT_NOT_FOUND", "The canonical directory must already belong to a nonarchived Claude Desktop task.");
    const url = `claude://code/new?q=${encodeURIComponent(initialMessage)}&folder=${encodeURIComponent(canonical)}`;
    if (url.length > 30000) fail("CLAUDE_CREATION_URL_TOO_LONG", "The encoded Claude Desktop link exceeds 30000 characters.");
    await this.checkAccount(account, identity);
    if (beforeOpen !== undefined) {
      if (typeof beforeOpen !== "function") fail("CLAUDE_CREATION_PREFLIGHT_INVALID", "beforeOpen must be a function.");
      await beforeOpen();
    }
    const request = { requestId, cwd: canonical, prompt, initialMessage, account: identity, senderThreadId, baseline: [...new Set(tasks.map((task) => task.taskId))], status: "launch_uncertain", reason: "The Desktop launch outcome is uncertain; inspect this request before taking further action." };
    this.requests.set(requestId, request);
    try {
      await this.open(url);
      request.status = "awaiting_user";
      request.reason = "Claude Desktop was asked to prefill a new session. Confirm the folder if prompted and press Send; no prompt has been submitted by the bridge.";
    } catch {
      request.reason = "The Desktop launcher failed or returned an uncertain outcome. This request will not be launched again; inspect it to check whether the session was created.";
    }
    return receipt(request);
  }

  async inspect(requestId, { account, senderThreadId }) {
    const request = this.requests.get(requestId);
    if (!request) fail("CLAUDE_CREATION_REQUEST_NOT_FOUND", "No retained creation request has this requestId.");
    if (request.senderThreadId !== senderThreadId) fail("CLAUDE_CREATION_SENDER_MISMATCH", "This creation request belongs to another sender thread.");
    await this.checkAccount(account, request.account);
    if (request.status === "created") return receipt(request);
    const sessions = await this.listSessions(account);
    if (!Array.isArray(sessions) || sessions.length > MAX_TASKS) fail("CLAUDE_CREATION_SESSIONS_INVALID", "Live native sessions could not be inspected within the limit.");
    const matches = new Map();
    for (const session of sessions) {
      if (!session?.alive || session.entrypoint !== "claude-desktop" || !string(session.sessionId, 256)) continue;
      try {
        const observedCwd = await this.canonical(session.cwd);
        if (await this.assertProcess(session) === false) continue;
        const context = await this.readContext(session, account);
        if (context?.status !== "matched" || context.isArchived || !string(context.taskId, 256) || request.baseline.includes(context.taskId)) continue;
        if (context.fileTaskId !== undefined && context.fileTaskId !== context.taskId) continue;
        if (context.accountFingerprint && context.accountFingerprint !== request.account.fingerprint) continue;
        if (!this.sameCwd(await this.canonical(context.cwd), observedCwd)) continue;
        const transcript = await this.readTranscript(session.sessionId, observedCwd, 1000);
        if (transcript?.truncated || transcript?.incomplete) continue;
        const firstUser = transcript?.messages?.find((message) => message.role === "user");
        if (!matchesInitialMessage(firstUser?.text, request.initialMessage)) continue;
        if (await this.assertProcess(session) === false) continue;
        matches.set(JSON.stringify([context.taskId, session.sessionId]), { sessionId: session.sessionId, taskId: context.taskId, title: string(context.title, 65536) && context.title.trim() ? context.title.trim().slice(0, 4096) : null, observedCwd });
      } catch {}
    }
    await this.checkAccount(account, request.account);
    if (matches.size > 1) {
      request.submissionObserved = true;
      request.ambiguitySeen = true;
      request.status = "ambiguous";
      for (const key of ["sessionId", "taskId", "title", "observedCwd"]) delete request[key];
      request.reason = "Multiple new native sessions contain the exact creation message; no session was selected.";
    } else if (matches.size === 1 && request.status !== "ambiguous" && !request.ambiguitySeen) {
      const match = [...matches.values()][0];
      const projectConfirmed = this.sameCwd(match.observedCwd, request.cwd);
      Object.assign(request, match, { submissionObserved: true, status: projectConfirmed ? "created" : "awaiting_project_confirmation", reason: projectConfirmed ? "A new live native Claude Desktop task has the exact initial user message, verified project, account, and process identity." : "The prompt was submitted in a new native Claude Desktop task, but its actual directory differs from the requested project. Select or adopt the requested project folder in Claude Desktop and inspect this request again; project creation is not confirmed." });
    }
    return receipt(request);
  }

  abandon(requestId, args) {
    const pending = this.queue.then(() => this.abandonLocked(requestId, args));
    this.queue = pending.catch(() => {});
    return pending;
  }

  async abandonLocked(requestId, { account, senderThreadId }) {
    const request = this.requests.get(requestId);
    if (!request) fail("CLAUDE_CREATION_REQUEST_NOT_FOUND", "No retained creation request has this requestId.");
    if (request.senderThreadId !== senderThreadId) fail("CLAUDE_CREATION_SENDER_MISMATCH", "This creation request belongs to another sender thread.");
    await this.checkAccount(account, request.account);
    if (request.status === "created") return receipt(request);
    if (request.status === "ambiguous") request.ambiguitySeen = true;
    request.status = "abandoned";
    request.reason = "The creation request was abandoned and its composer lock released. Claude Desktop and its composer may still be open, and the prompt could still be submitted later. The receipt is retained for inspection and will never relaunch.";
    return receipt(request);
  }

  exportState() {
    return structuredClone({ version: 1, requests: [...this.requests.values()] });
  }

  restoreState(state) {
    if (this.requests.size || state?.version !== 1 || !Array.isArray(state.requests) || state.requests.length > MAX_REQUESTS) fail("CLAUDE_CREATION_STATE_INVALID", "Creation state cannot be restored.");
    const restored = new Map();
    const paths = this.platform === "win32" ? path.win32 : path.posix;
    for (const request of state.requests) {
      if (!request || typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId) || restored.has(request.requestId) || !string(request.cwd, 8192) || !paths.isAbsolute(request.cwd) || !string(request.senderThreadId, 256) || !string(request.account?.fingerprint) || !string(request.account?.root, 8192) || !STATUSES.has(request.status) || !string(request.reason, 4096) || !Array.isArray(request.baseline) || request.baseline.length > MAX_TASKS || request.baseline.some((id) => !string(id, 256)) || request.initialMessage !== augmentedPrompt(request.prompt, request.requestId)) fail("CLAUDE_CREATION_STATE_INVALID", "A retained creation receipt is invalid.");
      const hasSession = ["created", "awaiting_project_confirmation"].includes(request.status) || request.sessionId !== undefined;
      if (hasSession && (!string(request.sessionId, 256) || !string(request.taskId, 256) || request.baseline.includes(request.taskId) || (request.title !== null && !string(request.title, 4096)))) fail("CLAUDE_CREATION_STATE_INVALID", "A submitted creation receipt is invalid.");
      if (request.submissionObserved !== undefined && typeof request.submissionObserved !== "boolean") fail("CLAUDE_CREATION_STATE_INVALID", "A retained submission marker is invalid.");
      if ((request.status === "awaiting_project_confirmation" || request.observedCwd !== undefined) && (!string(request.observedCwd, 8192) || !paths.isAbsolute(request.observedCwd))) fail("CLAUDE_CREATION_STATE_INVALID", "A retained observed directory is invalid.");
      if (request.status === "awaiting_project_confirmation" && (request.submissionObserved !== true || this.sameCwd(request.cwd, request.observedCwd))) fail("CLAUDE_CREATION_STATE_INVALID", "A pending project confirmation is invalid.");
      if (request.ambiguitySeen !== undefined && typeof request.ambiguitySeen !== "boolean") fail("CLAUDE_CREATION_STATE_INVALID", "A retained ambiguity marker is invalid.");
      restored.set(request.requestId, structuredClone({ requestId: request.requestId, cwd: request.cwd, prompt: request.prompt, initialMessage: request.initialMessage, account: { fingerprint: request.account.fingerprint, root: request.account.root }, senderThreadId: request.senderThreadId, baseline: request.baseline, status: request.status, reason: request.reason, ...(request.ambiguitySeen || request.status === "ambiguous" ? { ambiguitySeen: true } : {}), ...(request.submissionObserved ? { submissionObserved: true } : {}), ...(request.observedCwd ? { observedCwd: request.observedCwd } : {}), ...(hasSession ? { sessionId: request.sessionId, taskId: request.taskId, title: request.title } : {}) }));
    }
    this.requests = restored;
  }
}
