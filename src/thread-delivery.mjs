import { NativeDesktopRelay, desktopTaskSocketPath, desktopTasksConfigured } from "./native-relay.mjs";
import { runTurn } from "./turn.mjs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { DesktopTaskReceipts } from "./desktop-task-receipts.mjs";

/**
 * Which backend puts a message into a Codex thread.
 *
 * There are two, and they are not interchangeable. The app-server path resumes
 * the thread through a second app-server, which takes the per-thread writer
 * lock - correct for a thread nobody else has open, and guaranteed to fail with
 * `thread <id> already has an active writer` for a thread Codex Desktop is
 * showing. The native path asks Codex Desktop's own app-server to deliver the
 * message, so the app stays the single writer and the thread stays open.
 *
 * Naming the choice here rather than branching inside the relay keeps
 * `claude-bridge` unaware of either mechanism: it asks for delivery and is told
 * which backend did it.
 */
export const NATIVE_BACKEND = "codex-desktop-native";
export const APP_SERVER_BACKEND = "app-server";
export const DESKTOP_TOOL_BUDGET_MS = 40000;
const RELEASE_STATUSES = new Set(["completed", "interrupted", "failed"]);

export function matchDesktopProject(projects, cwd, { canonicalize = realpathSync.native, paths = path } = {}) {
  const requested = canonicalize(cwd);
  const matches = projects.filter((project) => {
    if (project.projectKind !== "local" || project.hostId !== "local" || !project.path || !project.projectId) return false;
    try {
      return paths.relative(requested, canonicalize(project.path)) === "";
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? `Multiple Codex Desktop projects match ${cwd}; keep one saved project for this directory before delegating.`
      : `No saved local Codex Desktop project exactly matches ${cwd}. Choose an existing saved project's directory or continue an existing task in this workspace. The bridge will not create a project or substitute a different directory.`);
  }
  return matches[0];
}

export class DesktopTaskDelivery {
  constructor({ relay = new NativeDesktopRelay({ socketPath: desktopTaskSocketPath() }), security, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, receipts = new DesktopTaskReceipts() } = {}) {
    this.relay = relay;
    this.security = security;
    this.sleep = sleep;
    this.now = now;
    this.receipts = receipts;
    this.threadOperations = new Map();
  }

  async request(operation, args, { deadline } = {}) {
    try {
      const remaining = deadline === undefined ? undefined : deadline - this.now();
      if (remaining !== undefined && remaining <= 0) throw new Error("The bridge's response deadline has elapsed; this operation was not sent");
      const response = await this.relay.requestDesktop(operation, args, remaining === undefined ? undefined : { timeoutMs: remaining });
      return response.result;
    } catch (err) {
      throw new Error(`Codex Desktop operation ${operation} failed: ${err.message}. Desktop-only mode will not start or use an external app-server. Open Codex Desktop and reconnect its native relay, then inspect the existing task before retrying a send.`, { cause: err });
    }
  }

  async withThread(threadId, operation, { deadline } = {}) {
    const previous = this.threadOperations.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      if (deadline !== undefined && this.now() >= deadline) throw new Error("The response deadline elapsed while another operation held this thread. No new prompt was sent.");
      return operation();
    });
    this.threadOperations.set(threadId, current);
    const cleanup = () => { if (this.threadOperations.get(threadId) === current) this.threadOperations.delete(threadId); };
    current.then(cleanup, cleanup);
    if (deadline === undefined) return current;
    let timer;
    try {
      return await Promise.race([current, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("The Desktop response deadline elapsed. A previous operation may still be running; inspect the existing task before sending anything again.")), Math.max(1, deadline - this.now()));
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    try {
      const response = await this.request("list_projects", {});
      if (!Array.isArray(response?.projects)) throw new Error("Desktop returned no project list");
      return { available: true, socketPath: this.relay.socketPath, localProjects: response.projects.filter((project) => project.projectKind === "local" && project.hostId === "local").length };
    } catch (err) {
      return { available: false, socketPath: this.relay.socketPath, reason: err.message };
    }
  }

  async list({ limit = 15, cwd, searchTerm, loadedOnly = false } = {}) {
    if (loadedOnly) throw new Error("Codex Desktop does not expose a loaded-only thread list. Omit loadedOnly to list its recent and pinned local tasks; no external app-server was contacted.");
    if (cwd) this.security.assertCwd(cwd);
    const response = await this.request("list_threads", { limit: 50 });
    if (!Array.isArray(response?.threads) || !Array.isArray(response?.pinnedThreads)) throw new Error("Codex Desktop returned an invalid thread list");
    if (response.unavailableHosts?.some((host) => host === "local" || host?.hostId === "local")) throw new Error("The local Codex Desktop host is unavailable; its thread list could not be confirmed");
    const seen = new Set();
    const rows = [...response.pinnedThreads, ...response.threads].filter((thread) => {
      if (thread.kind !== "codex" || thread.hostId !== "local" || !thread.id || !thread.cwd || seen.has(thread.id)) return false;
      seen.add(thread.id);
      if (!this.security.isThreadAuthorized(thread.id, thread.cwd)) return false;
      try {
        this.security.assertCwd(thread.cwd);
        if (cwd && path.relative(realpathSync.native(cwd), realpathSync.native(thread.cwd))) return false;
      } catch {
        return false;
      }
      return !searchTerm || String(thread.title ?? "").toLowerCase().includes(searchTerm.toLowerCase());
    }).slice(0, limit);
    return { rows, coverage: "Codex Desktop's recent/pinned snapshot; local Codex workspaces only. Agent-created tasks visible in the sidebar can be omitted; read a known task ID directly before assuming creation failed." };
  }

  async reuseReceipt(receipt, { cwd, promptHash, deadline }) {
    if (!receipt) return null;
    if (path.relative(cwd, realpathSync.native(receipt.cwd))) throw new Error("The stored Desktop creation receipt belongs to another workspace. No prompt was sent.");
    if (receipt.state !== "known") throw new Error(`An earlier Desktop creation is ${receipt.state} and may already have started. ${receipt.threadId ? `threadId: ${receipt.threadId}. ` : ""}Do not resend or create another task; inspect the existing Desktop task and resolve its creation receipt first.`);
    let response;
    try {
      this.security.assertThread(receipt.threadId, cwd);
      response = await this.request("read_thread", { threadId: receipt.threadId, hostId: "local", turnLimit: 1 }, { deadline });
    } catch (err) {
      throw new Error(`Existing Desktop task ${receipt.threadId} could not be verified. No prompt was resent and no duplicate task was created: ${err.message}`, { cause: err });
    }
    const thread = response?.thread;
    if (thread?.id !== receipt.threadId || thread.hostId !== "local" || !thread.cwd || path.relative(cwd, realpathSync.native(thread.cwd))) throw new Error(`Existing Desktop task ${receipt.threadId} did not confirm the requested local workspace. No prompt was sent.`);
    this.security.assertCwd(thread.cwd);
    this.security.assertThread(thread.id, thread.cwd);
    return { threadId: receipt.threadId, name: thread.title ?? receipt.name ?? "(unnamed)", cwd, projectId: receipt.projectId, projectName: receipt.projectName, backend: NATIVE_BACKEND, reused: true, promptChanged: receipt.promptHash !== promptHash };
  }

  async create({ cwd, prompt, name, dedupeName = name, model, effort, deadline = this.now() + DESKTOP_TOOL_BUDGET_MS }) {
    this.security.assertCwd(cwd);
    cwd = realpathSync.native(cwd);
    this.security.assertCwd(cwd);
    dedupeName = dedupeName?.normalize("NFC").trim().replace(/\s+/g, " ") || undefined;
    const identity = this.receipts.key({ cwd, prompt, name: dedupeName });
    const options = { cwd, promptHash: identity.promptHash, deadline };
    const reused = await this.reuseReceipt(await this.receipts.read(identity.key), options);
    if (reused) return reused;
    const listed = await this.request("list_projects", {}, { deadline });
    if (!Array.isArray(listed?.projects)) throw new Error("Codex Desktop returned no project list; no task was created.");
    const project = matchDesktopProject(listed.projects, cwd);
    return this.receipts.withLock(identity.key, async () => {
      const existing = await this.reuseReceipt(await this.receipts.read(identity.key), options);
      if (existing) return existing;
      if (this.now() >= deadline) throw new Error("The response deadline elapsed before Desktop creation. No task was created.");
      const receipt = { version: 1, ...identity, cwd, state: "pending", startedAt: this.now(), ...(dedupeName ? { name: dedupeName } : {}), projectId: project.projectId, ...(project.label ? { projectName: project.label } : {}) };
      await this.receipts.write(identity.key, receipt);
      let threadId;
      let creationConfirmed = false;
      try {
        const response = await this.request("create_thread", {
          prompt, title: name,
          target: { type: "project", projectId: project.projectId, environment: { type: "local" } },
          ...(model ? { model } : {}), ...(effort ? { thinking: effort } : {}),
        }, { deadline });
        const confirmedId = response?.threadId ?? response?.conversationId;
        threadId = confirmedId;
        if (!threadId && (response?.status === "outcome-unknown" || response?.firstTurn?.status === "outcome-unknown")) threadId = response?.clientThreadId;
        if (typeof confirmedId !== "string" || !confirmedId.trim() || response?.status === "outcome-unknown" || response.hostId !== "local") throw new Error(`Desktop creation is not confirmed: ${JSON.stringify(response)}`);
        await this.receipts.write(identity.key, { ...receipt, state: "known", threadId });
        creationConfirmed = true;
        this.security.registerThread(threadId);
        if (response.firstTurn && response.firstTurn.status !== "accepted") throw new Error(`Desktop created task ${threadId}; its first turn reports ${response.firstTurn.status ?? "an unconfirmed state"}: ${JSON.stringify(response)}`);
        return { threadId, name, cwd, projectId: project.projectId, projectName: project.label, backend: NATIVE_BACKEND };
      } catch (err) {
        if (!creationConfirmed) await this.receipts.write(identity.key, { ...receipt, state: "unknown", ...(typeof threadId === "string" && threadId ? { threadId } : {}) }).catch(() => {});
        throw new Error(`${err.message}. ${threadId ? `threadId: ${threadId}. ` : ""}Do not resend the prompt. The creation receipt blocks duplicate tasks even after a bridge restart.`, { cause: err });
      }
    });
  }

  async inspect(threadId, cwd, { deadline } = {}) {
    const response = await this.request("read_thread", { threadId, hostId: "local", turnLimit: 1 }, { deadline });
    const thread = response?.thread;
    if (thread?.id !== threadId || thread.hostId !== "local" || !thread.cwd) throw new Error("Desktop did not confirm the task's local workspace.");
    this.security.assertThread(threadId, thread.cwd);
    this.security.assertCwd(thread.cwd);
    if (cwd && path.relative(realpathSync.native(cwd), realpathSync.native(thread.cwd))) {
      throw new Error("Native Desktop delivery cannot change an existing task's workspace; create a new task at the requested cwd.");
    }
    return { thread, latestTurnId: response.turns?.[0]?.id ?? null };
  }

  async send({ threadId, prompt, cwd, model, effort, name, deadline }) {
    const inspected = await this.inspect(threadId, cwd, { deadline });
    if (name) await this.request("set_thread_title", { threadId, title: name.trim().slice(0, 200) }, { deadline });
    const response = await this.request("send_message_to_thread", {
      threadId, prompt,
      ...(model ? { model } : {}),
      ...(effort ? { thinking: effort } : {}),
    }, { deadline });
    if (response?.threadId !== threadId || response?.success === false || response?.isError === true ||
        (response?.status !== undefined && !["accepted", "sent"].includes(response.status)) ||
        (response?.firstTurn && response.firstTurn.status !== "accepted")) {
      throw new Error(`Desktop send is not confirmed for ${threadId}. Do not resend: ${JSON.stringify(response)}`);
    }
    return { threadId, cwd: inspected.thread.cwd, name: inspected.thread.title, previousTurnId: inspected.latestTurnId, backend: NATIVE_BACKEND };
  }

  async open(threadId, { deadline } = {}) {
    const response = await this.request("navigate_to_codex_page", { threadId }, { deadline });
    if (response?.navigated !== true) throw new Error(`Desktop did not confirm opening task ${threadId}`);
  }

  async wait(threadId, { timeoutMs = 240000, previousTurnId = null } = {}) {
    const startedAt = this.now();
    let cursor;
    let turnId = null;
    let text = "";
    const expired = () => ({ threadId, turnId, status: "timeout", text, activity: [], errors: [], durationMs: this.now() - startedAt });
    for (;;) {
      if (this.now() - startedAt >= timeoutMs) return expired();
      let response;
      try {
        response = await this.request("wait_threads", {
          targets: [{ threadId, hostId: "local", ...(cursor ? { afterCursor: cursor } : {}) }], timeoutMs: 0,
        }, { deadline: startedAt + timeoutMs });
      } catch (err) {
        if (this.now() - startedAt >= timeoutMs) return expired();
        throw err;
      }
      const poll = response?.polls?.find((item) => item.thread?.id === threadId && item.thread?.hostId === "local");
      if (response?.errors?.length || !poll) throw new Error(`Could not observe task ${threadId}; it may still be running. Read it before retrying: ${JSON.stringify(response)}`);
      cursor = poll.cursor;
      const turn = poll.latestTurn;
      const threadStatus = poll.thread.status?.type;
      if (["systemError", "waitingOnApproval", "waitingOnUserInput"].includes(threadStatus)) {
        return { threadId, turnId: turn?.id !== previousTurnId ? turn?.id ?? null : null, status: threadStatus, text: "", activity: [], errors: [], durationMs: this.now() - startedAt };
      }
      if (turn?.id && turn.id !== previousTurnId) {
        turnId = turn.id;
        if (poll.latestAssistantMessage?.turnId === turnId && poll.latestAssistantMessage?.phase === "final_answer") text = poll.latestAssistantMessage.text ?? text;
        const status = turn.status;
        if (RELEASE_STATUSES.has(status)) {
          return { threadId, turnId, status, text, activity: [], errors: turn.error ? [turn.error] : [], durationMs: turn.durationMs ?? this.now() - startedAt };
        }
      }
      if (this.now() - startedAt >= timeoutMs) return expired();
      await this.sleep(Math.min(1500, timeoutMs - (this.now() - startedAt)));
    }
  }
}

export function createThreadDelivery({
  codex,
  relay = new NativeDesktopRelay(),
  log = () => {},
  timeoutMs = 240000,
  desktopOnly = desktopTasksConfigured(),
  releaseAfterTurn =
    process.env.CODEX_BRIDGE_RELEASE_AFTER_TURN !== undefined
      ? process.env.CODEX_BRIDGE_RELEASE_AFTER_TURN === "1"
      : process.platform === "win32",
} = {}) {
  let reportedUnavailable = null;

  /**
   * Falling back is right when the companion never answered - an absent relay
   * says nothing about the target thread, and the older path is exactly as good
   * as it was before this backend existed. It is wrong once the companion has
   * answered: Codex has already refused, and retrying through a second
   * app-server only spawns a process that contends for the ~/.codex state and
   * then fails on the writer lock the native path exists to avoid.
   */
  async function deliver(threadId, text) {
    const status = relay.status();
    if (status.enabled) {
      try {
        const ack = await relay.sendMessage(threadId, text);
        reportedUnavailable = null;
        return { backend: NATIVE_BACKEND, threadId, ack };
      } catch (err) {
        if (err.reachedCompanion || err.code !== "RELAY_UNREACHABLE") throw err;
        if (desktopOnly) throw new Error(`Codex Desktop relay is unavailable: ${err.message}. Desktop-only mode will not start or use an external app-server.`);
        log(`native relay unreachable (${err.message}); falling back to the app-server path`);
      }
    } else if (status.reason !== reportedUnavailable) {
      reportedUnavailable = status.reason;
      log(`native relay not in use: ${status.reason}`);
    }

    if (desktopOnly) throw new Error(`Codex Desktop relay is unavailable: ${status.reason ?? "no native acknowledgement"}. Desktop-only mode will not start or use an external app-server.`);
    if (!codex) throw new Error("No Codex app-server client is configured to deliver this message");
    const send = async () => {
      await codex.ensureThreadAttached(threadId);
      const turn = await runTurn(codex, {
        threadId,
        input: [{ type: "text", text }],
        timeoutMs,
      });
      if (releaseAfterTurn && RELEASE_STATUSES.has(turn.status) && typeof codex.releaseThread === "function") {
        try {
          const released = await codex.releaseThread(threadId);
          if (!released?.released) log("thread release pending: " + (released.reason ?? released.status ?? "awaiting unload"));
        } catch (err) {
          log("thread release failed: " + err.message);
        }
      }
      return { backend: APP_SERVER_BACKEND, threadId, turn };
    };
    return codex.withThread ? codex.withThread(threadId, send) : send();
  }

  function describe() {
    const status = relay.status();
    return status.enabled
      ? `${NATIVE_BACKEND} via ${status.socketPath}`
      : desktopOnly ? `${NATIVE_BACKEND} unavailable (${status.reason}); external app-server disabled` : `${APP_SERVER_BACKEND} (${status.reason})`;
  }

  return { deliver, describe };
}
