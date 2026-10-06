import { NativeDesktopRelay, accountRelaySocketPath, desktopTaskSocketPath, desktopTasksConfigured } from "./native-relay.mjs";
import { runTurn } from "./turn.mjs";
import { realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { creationRequestHash } from "./native-creation-receipts.mjs";
import { DesktopTaskReceipts } from "./desktop-task-receipts.mjs";
import { captureCodexRolloutWatermark, inspectCodexNativeTurn, readCodexNativeTurnResponse, readCodexNativeCreationResponse } from "./codex-native-response.mjs";
import { captureProjectScope, recheckProjectScope } from "./project-scope.mjs";
import { requireClaudeSenderContext } from "./claude-sender-context.mjs";

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

function sameAccountContext(expected, current) {
  return Boolean(expected && current && ["claude", "codex"].every((provider) =>
    typeof expected[provider] === "string" && expected[provider] === current[provider]));
}

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
  constructor({ relay = new NativeDesktopRelay({ socketPath: desktopTaskSocketPath(), accountSocketPath: accountRelaySocketPath() }), security, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, receipts = new DesktopTaskReceipts(), beforeRequest, accountContext, senderContext, captureResponse = captureCodexRolloutWatermark, readResponse = readCodexNativeTurnResponse, inspectResponse = inspectCodexNativeTurn } = {}) {
    this.relay = relay;
    this.security = security;
    this.sleep = sleep;
    this.now = now;
    this.receipts = receipts;
    this.beforeRequest = beforeRequest;
    this.accountContext = accountContext;
    this.senderContext = senderContext;
    this.captureResponse = captureResponse;
    this.readResponse = readResponse;
    this.inspectResponse = inspectResponse;
    this.threadOperations = new Map();
  }

  senderProjectScope(cwd) {
    if (!this.senderContext) return null;
    const sender = requireClaudeSenderContext(this.senderContext());
    return captureProjectScope(sender.cwd, cwd);
  }

  async mutationProjectScope(operation, args, { deadline } = {}) {
    if (!this.senderContext) return null;
    if (operation === "create_thread") {
      const listed = await this.request("list_projects", {}, { deadline });
      const projects = listed?.projects?.filter((project) => project.projectId === args.target?.projectId && project.projectKind === "local" && project.hostId === "local");
      if (projects?.length !== 1) throw new Error("Desktop did not confirm the destination project before creation");
      this.security.assertCwd(projects[0].path);
      return this.senderProjectScope(projects[0].path);
    }
    if (!["send_message_to_thread", "set_thread_title", "navigate_to_codex_page"].includes(operation)) return null;
    const inspected = await this.inspect(args.threadId, undefined, { deadline });
    return inspected.projectScope;
  }

  async request(operation, args, { deadline, includeRelayContext = false, scopeBinding, creationReceiptId, projectScope: expectedScope } = {}) {
    try {
      await this.beforeRequest?.({ operation, args });
      if (scopeBinding) this.security.hardenedRoots.recheck(scopeBinding);
      const projectScope = expectedScope ?? await this.mutationProjectScope(operation, args, { deadline });
      if (expectedScope) recheckProjectScope(expectedScope, this.senderProjectScope(expectedScope.recipient.input));
      const remaining = deadline === undefined ? undefined : deadline - this.now();
      if (remaining !== undefined && remaining <= 0) throw new Error("The bridge's response deadline has elapsed; this operation was not sent");
      const accountContext = this.accountContext?.();
      const response = await this.relay.requestDesktop(operation, args, {
        ...(remaining === undefined ? {} : { timeoutMs: remaining }),
        ...(this.beforeRequest || projectScope || scopeBinding ? { beforeSend: async () => {
          await this.beforeRequest?.({ operation, args, phase: "write" });
          if (projectScope) {
            recheckProjectScope(projectScope);
            recheckProjectScope(projectScope, await this.mutationProjectScope(operation, args, { deadline }));
          }
          await this.beforeRequest?.({ operation, args, phase: "dispatch" });
          if (scopeBinding) this.security.hardenedRoots.recheck(scopeBinding);
        } } : {}),
        ...(accountContext ? { accountContext } : {}),
        ...(creationReceiptId ? { creationReceiptId } : {}),
      });
      return includeRelayContext ? { result: response.result, executorThreadId: response.executorThreadId } : response.result;
    } catch (err) {
      if (err.code?.startsWith("PROJECT_SCOPE_") || err.code === "CLAUDE_SENDER_CONTEXT_UNVERIFIED") throw err;
      throw new Error(`Codex Desktop operation ${operation} failed: ${err.message}. Desktop-only mode will not start or use an external app-server. Open Codex Desktop and reconnect its native relay, then inspect the existing task before retrying a send.`, { cause: err });
    }
  }

  async withThread(threadId, operation, { deadline, onDeadline } = {}) {
    const previous = this.threadOperations.get(threadId) ?? Promise.resolve();
    let expired = false;
    const current = previous.catch(() => {}).then(() => {
      if (expired || (deadline !== undefined && this.now() >= deadline)) throw new Error("The response deadline elapsed while another operation held this thread. No new prompt was sent.");
      return operation();
    });
    this.threadOperations.set(threadId, current);
    const cleanup = () => { if (this.threadOperations.get(threadId) === current) this.threadOperations.delete(threadId); };
    current.then(cleanup, cleanup);
    if (deadline === undefined) return current;
    let timer;
    try {
      return await Promise.race([current, new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error("The Desktop response deadline elapsed. A previous operation may still be running; inspect the existing task before sending anything again."));
        }, Math.max(1, deadline - this.now()));
      })]);
    } catch (error) {
      // Preserve confirmed dispatch state while the underlying operation retains its lock.
      if (expired && onDeadline) return onDeadline(error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async status() {
    const accountContext = this.accountContext?.();
    const socketPath = this.relay.status?.({ accountContext })?.socketPath ?? this.relay.socketPath;
    if (this.accountContext && !accountContext) return { available: false, socketPath, reason: "The current Claude and Codex accounts could not both be verified. Finish signing in and inspect the account diagnostics before sending work." };
    try {
      const response = await this.request("list_projects", {});
      if (!Array.isArray(response?.projects)) throw new Error("Desktop returned no project list");
      return { available: true, socketPath, localProjects: response.projects.filter((project) => project.projectKind === "local" && project.hostId === "local").length };
    } catch (err) {
      return { available: false, socketPath, reason: err.message };
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

  async reuseReceipt(receipt, { cwd, promptHash, deadline, accountContext, includeReplyReceipt }) {
    if (!receipt) return null;
    if (accountContext && (!receipt.accountContext || ["claude", "codex"].some((provider) => receipt.accountContext[provider] !== accountContext[provider]))) {
      throw new Error(`The existing Desktop creation receipt ${receipt.threadId ? `for task ${receipt.threadId} ` : ""}${receipt.accountContext ? "belongs to different accounts" : "has no verified original account binding"}. Its receipt and task ID were retained. No creation or prompt resend was attempted; inspect the explicit existing task before continuing.`);
    }
    if (path.relative(cwd, realpathSync.native(receipt.cwd))) throw new Error("The stored Desktop creation receipt belongs to another workspace. No prompt was sent.");
    if (receipt.state === "unknown" && includeReplyReceipt && receipt.deliveryId) return {
      threadId: null, cwd, deliveryId: receipt.deliveryId, deliveryStatus: "unconfirmed", reused: true, name: receipt.name,
      projectId: receipt.projectId, projectName: receipt.projectName, promptChanged: receipt.promptHash !== promptHash,
    };
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
    const assignment = await this.receiptProjectAssignment(receipt, cwd, { deadline });
    return { threadId: receipt.threadId, name: thread.title ?? receipt.name ?? "(unnamed)", cwd, ...assignment, backend: NATIVE_BACKEND, reused: true, promptChanged: receipt.promptHash !== promptHash, ...(includeReplyReceipt && receipt.deliveryId ? { deliveryId: receipt.deliveryId } : {}) };
  }

  async receiptProjectAssignment(receipt, cwd, { deadline }) {
    let project;
    try {
      const listed = await this.request("list_projects", {}, { deadline });
      if (!Array.isArray(listed?.projects)) throw new Error("Desktop returned no project list");
      project = matchDesktopProject(listed.projects, cwd);
      if (receipt.projectId && receipt.projectId !== project.projectId) throw new Error("The saved project identity changed for this directory");
    } catch (err) {
      throw new Error(`Existing Desktop task ${receipt.threadId}'s saved project could not be verified: ${err.message}. No prompt was resent and no duplicate task was created. Inspect this existing task and its project settings.`, { cause: err });
    }
    const unverified = (reason) => ({
      expectedProjectId: project.projectId,
      expectedProjectName: project.label,
      projectAssignmentStatus: "unverified",
      projectAssignmentNote: `${reason} The task's current project assignment is unverified. Its workspace and existing ID were retained; no prompt was resent and no duplicate task was created. Inspect this task in Codex Desktop.`,
    });
    let snapshot;
    try {
      snapshot = await this.request("list_threads", { limit: 50 }, { deadline });
      if (!Array.isArray(snapshot?.threads) || !Array.isArray(snapshot?.pinnedThreads)) throw new Error("Desktop returned an invalid thread list");
      if (snapshot.unavailableHosts?.some((host) => host === "local" || host?.hostId === "local")) throw new Error("The local Desktop host is unavailable");
    } catch (err) {
      return unverified(`Desktop's recent/pinned listing could not be confirmed: ${err.message}.`);
    }
    const observed = [...snapshot.pinnedThreads, ...snapshot.threads].filter((thread) => thread?.id === receipt.threadId && thread.kind === "codex" && thread.hostId === "local");
    if (observed.length === 0) return unverified("This task is absent from Desktop's recent/pinned listing.");
    for (const thread of observed) {
      if (thread.projectId !== undefined && thread.projectId !== project.projectId) throw new Error(`Existing Desktop task ${receipt.threadId}'s project assignment changed. No prompt was resent and no duplicate task was created. Inspect its assignment in Codex Desktop.`);
      if (thread.cwd) {
        this.security.assertCwd(thread.cwd);
        if (path.relative(cwd, realpathSync.native(thread.cwd))) throw new Error(`Existing Desktop task ${receipt.threadId}'s listed workspace changed. No prompt was resent and no duplicate task was created.`);
      }
    }
    if (observed.some((thread) => thread.projectId === undefined || !thread.cwd)) return unverified("Desktop's listing omitted this task's project or workspace metadata.");
    return { projectId: project.projectId, projectName: project.label, projectAssignmentStatus: "verified" };
  }

  async create({ cwd, prompt, name, dedupeName = name, requestId, model, effort, onAccepted, onPrepared, deadline = this.now() + DESKTOP_TOOL_BUDGET_MS }) {
    this.security.assertCwd(cwd);
    const projectScope = this.senderProjectScope(cwd);
    cwd = realpathSync.native(cwd);
    this.security.assertCwd(cwd);
    const scopeBinding = this.security.hardenedRoots?.mode === "project-policy" ? this.security.hardenedRoots.capture(cwd) : undefined;
    dedupeName = dedupeName?.normalize("NFC").trim().replace(/\s+/g, " ") || undefined;
    const identity = this.receipts.key({ cwd, prompt, name: dedupeName, requestId });
    const accountContext = this.accountContext?.();
    if (this.accountContext && !accountContext) throw new Error("Desktop creation requires the original verified account context.");
    const options = { cwd, promptHash: identity.promptHash, deadline, accountContext, includeReplyReceipt: Boolean(onAccepted || onPrepared) };
    const reused = await this.reuseReceipt(await this.receipts.read(identity.key), options);
    if (reused) return reused;
    const listed = await this.request("list_projects", {}, { deadline });
    if (!Array.isArray(listed?.projects)) throw new Error("Codex Desktop returned no project list; no task was created.");
    const project = matchDesktopProject(listed.projects, cwd);
    return this.receipts.withLock(identity.key, async () => {
      const existing = await this.reuseReceipt(await this.receipts.read(identity.key), options);
      if (existing) return existing;
      if (this.now() >= deadline) throw new Error("The response deadline elapsed before Desktop creation. No task was created.");
      const receipt = { version: 1, ...identity, cwd, state: "pending", startedAt: this.now(), ...(accountContext ? { accountContext: { ...accountContext } } : {}), ...(dedupeName ? { name: dedupeName } : {}), projectId: project.projectId, ...(project.label ? { projectName: project.label } : {}) };
      const creationArgs = { prompt, title: name,
        target: { type: "project", projectId: project.projectId, environment: { type: "local" } },
        ...(model ? { model } : {}), ...(effort ? { thinking: effort } : {}) };
      const creationReceiptId = onPrepared ? randomUUID() : undefined;
      if (onPrepared) {
        // Feature-detect before mutation; old companions refuse this read-only
        // probe. Never create first and discover missing recovery afterwards.
        if (!accountContext) throw new Error("Creation continuation requires verified accounts");
        const requestHash = creationRequestHash(creationArgs);
        const probe = await this.request("get_creation_receipt", { receiptId: creationReceiptId, requestHash }, { deadline });
        if (probe?.status !== "missing") throw new Error("Native creation receipt capability could not be confirmed; no task was created");
        receipt.deliveryId = onPrepared({ threadId: null, cwd, previousTurnId: null, deliveryStatus: "unconfirmed",
          creationObservation: { receiptId: creationReceiptId, requestHash, receiptKey: identity.key, args: creationArgs, accountContext: { ...accountContext } } });
      }
      await this.receipts.write(identity.key, receipt);
      let threadId;
      let creationConfirmed = false;
      try {
        const envelope = await this.request("create_thread", creationArgs,
          { deadline, projectScope, scopeBinding, creationReceiptId, includeRelayContext: true });
        const response = envelope.result;
        const confirmedId = response?.threadId ?? response?.conversationId;
        threadId = confirmedId;
        if (!threadId && (response?.status === "outcome-unknown" || response?.firstTurn?.status === "outcome-unknown")) threadId = response?.clientThreadId;
        if (typeof confirmedId !== "string" || !confirmedId.trim() || response?.status === "outcome-unknown" || response.hostId !== "local") throw new Error(`Desktop creation is not confirmed: ${JSON.stringify(response)}`);
        await this.receipts.write(identity.key, { ...receipt, state: "known", threadId });
        creationConfirmed = true;
        this.security.registerThread(threadId);
        if (response.firstTurn && response.firstTurn.status !== "accepted") throw new Error(`Desktop created task ${threadId}; its first turn reports ${response.firstTurn.status ?? "an unconfirmed state"}: ${JSON.stringify(response)}`);
        const created = { threadId, name, cwd, projectId: project.projectId, projectName: project.label, backend: NATIVE_BACKEND };
        const delivered = { ...created, previousTurnId: null, deliveryStatus: "accepted", responseObservation: {
            operation: "create_thread", threadId, previousTurnId: null, expectedCwd: cwd,
            executorThreadId: envelope.executorThreadId ?? null, prompt,
            accountContext: accountContext ? { ...accountContext } : null,
          },
        };
        const deliveryId = receipt.deliveryId ?? onAccepted?.(delivered);
        if (deliveryId) {
          await this.receipts.write(identity.key, { ...receipt, state: "known", threadId, deliveryId });
          created.deliveryId = deliveryId;
        }
        return created;
      } catch (err) {
        if (!creationConfirmed) await this.receipts.write(identity.key, { ...receipt, state: "unknown", ...(typeof threadId === "string" && threadId ? { threadId } : {}) }).catch(() => {});
        const cause = err.cause ?? err;
        if (receipt.deliveryId && cause.reachedCompanion === true && ["RELAY_TIMEOUT", "RELAY_DELIVERY_UNCONFIRMED"].includes(cause.code)) {
          return { threadId: null, cwd, name, projectId: project.projectId, projectName: project.label, deliveryStatus: "unconfirmed", deliveryId: receipt.deliveryId };
        }
        throw new Error(`${err.message}. ${threadId ? `threadId: ${threadId}. ` : ""}Do not resend the prompt. The creation receipt blocks duplicate tasks even after a bridge restart.`, { cause: err });
      }
    });
  }

  async resolveCreation(delivered, { deadline = this.now() + DESKTOP_TOOL_BUDGET_MS } = {}) {
    const binding = delivered.creationObservation;
    if (!binding) return delivered;
    for (;;) {
      if (this.now() >= deadline) return null;
      this.security.assertCwd(delivered.cwd);
      this.senderProjectScope(delivered.cwd);
      if (!sameAccountContext(binding.accountContext, this.accountContext?.())) throw new Error("Creation receipt account changed");
      const receipt = await this.receipts.read(binding.receiptKey);
      if (!receipt || !sameAccountContext(receipt.accountContext, binding.accountContext) || receipt.cwd !== delivered.cwd ||
          receipt.promptHash !== this.receipts.key({ cwd: delivered.cwd, prompt: binding.args.prompt }).promptHash) throw new Error("Original creation receipt binding changed");
      let envelope;
      try { envelope = await this.request("get_creation_receipt", { receiptId: binding.receiptId, requestHash: binding.requestHash }, { deadline, includeRelayContext: true }); }
      catch (error) { if (this.now() >= deadline && ["RELAY_TIMEOUT", "RELAY_UNREACHABLE"].includes(error.cause?.code)) return null; throw error; }
      const row = envelope.result;
      if (row?.status === "completed") {
        const response = row.result, threadId = response?.threadId;
        if (typeof threadId !== "string" || !threadId.trim() || response.hostId !== "local" || response.status === "outcome-unknown" ||
            response.firstTurn && response.firstTurn.status !== "accepted" || receipt.threadId && receipt.threadId !== threadId) throw new Error("Native creation is not confirmed; do not resend");
        let inspected;
        try { inspected = await this.#inspectMetadata(threadId, delivered.cwd, { deadline }); }
        catch (error) { if (this.now() >= deadline && /deadline|within \d+ms/.test(error.message)) return null; throw error; }
        if (inspected.executorThreadId !== envelope.executorThreadId) throw new Error("Native creation executor changed");
        if (!sameAccountContext(binding.accountContext, this.accountContext?.())) throw new Error("Creation receipt account changed");
        this.security.assertCwd(delivered.cwd);
        this.senderProjectScope(delivered.cwd);
        if (this.security.hardenedRoots?.mode === "project-policy") this.security.hardenedRoots.recheck(inspected.scopeBinding);
        if (inspected.projectScope) recheckProjectScope(inspected.projectScope);
        this.security.registerThread(threadId);
        this.security.assertThread(threadId, inspected.thread.cwd);
        return { threadId, cwd: delivered.cwd, previousTurnId: null, deliveryStatus: "accepted",
          responseObservation: { operation: "create_thread", threadId, previousTurnId: null, expectedCwd: delivered.cwd,
            executorThreadId: envelope.executorThreadId, prompt: binding.args.prompt, accountContext: binding.accountContext } };
      }
      if (row?.status === "failed") throw new Error(`Native creation remains unconfirmed: ${row.error?.message ?? "unknown failure"}. Do not resend.`);
      if (!["missing", "pending"].includes(row?.status)) throw new Error("Invalid native creation receipt response");
      await this.sleep(Math.min(1000, Math.max(0, deadline - this.now())));
    }
  }

  async inspect(threadId, cwd, { deadline } = {}) {
    const inspected = await this.#inspectMetadata(threadId, cwd, { deadline });
    this.security.assertThread(threadId, inspected.thread.cwd);
    return inspected;
  }

  async #inspectMetadata(threadId, cwd, { deadline } = {}) {
    const envelope = await this.request("read_thread", { threadId, hostId: "local", turnLimit: 1 }, { deadline, includeRelayContext: true });
    const response = envelope.result;
    const thread = response?.thread;
    if (thread?.id !== threadId || thread.hostId !== "local" || !thread.cwd) throw new Error("Desktop did not confirm the task's local workspace.");
    this.security.assertCwd(thread.cwd);
    const projectScope = this.senderProjectScope(thread.cwd);
    if (cwd && path.relative(realpathSync.native(cwd), realpathSync.native(thread.cwd))) {
      throw new Error("Native Desktop delivery cannot change an existing task's workspace; create a new task at the requested cwd.");
    }
    const scopeBinding = this.security.hardenedRoots?.mode === "project-policy" ? this.security.hardenedRoots.capture(thread.cwd) : undefined;
    return { thread, latestTurnId: response.turns?.[0]?.id ?? null, projectScope, scopeBinding, executorThreadId: envelope.executorThreadId ?? null };
  }

  async send({ threadId, prompt, cwd, model, effort, name, deadline, onPrepared }) {
    const inspected = await this.inspect(threadId, cwd, { deadline });
    const scopeBinding = this.security.hardenedRoots?.mode === "project-policy" ? this.security.hardenedRoots.capture(inspected.thread.cwd) : undefined;
    if (name) await this.request("set_thread_title", { threadId, title: name.trim().slice(0, 200) }, { deadline, projectScope: inspected.projectScope, scopeBinding });
    const expectedCwd = realpathSync.native(inspected.thread.cwd);
    const accountContext = this.accountContext?.();
    const watermark = this.captureResponse({ threadId, expectedCwd, desktopEvidence: inspected });
    // Preserve the exact pre-send observation before any possibly ambiguous write.
    // An unconfirmed receipt permits observation, never resending or an approval bypass.
    const delivered = {
      threadId, cwd: expectedCwd, name: inspected.thread.title, previousTurnId: inspected.latestTurnId, backend: NATIVE_BACKEND,
      deliveryStatus: "unconfirmed",
      responseObservation: {
        threadId, previousTurnId: inspected.latestTurnId, expectedCwd,
        executorThreadId: inspected.executorThreadId, prompt,
        accountContext: accountContext ? { ...accountContext } : null, watermark,
      },
    };
    onPrepared?.(delivered);
    let envelope;
    try { envelope = await this.request("send_message_to_thread", {
      threadId, prompt,
      ...(model ? { model } : {}),
      ...(effort ? { thinking: effort } : {}),
    }, { deadline, includeRelayContext: true, projectScope: inspected.projectScope, scopeBinding });
    } catch (error) {
      const cause = error.cause ?? error;
      if (onPrepared && cause.reachedCompanion === true && ["RELAY_TIMEOUT", "RELAY_DELIVERY_UNCONFIRMED"].includes(cause.code)) {
        return { ...delivered, deliveryNote: error.message };
      }
      throw error;
    }
    const response = envelope.result;
    if (response?.threadId !== threadId || response?.success === false || response?.isError === true ||
        (response?.status !== undefined && !["accepted", "sent"].includes(response.status)) ||
        (response?.firstTurn && response.firstTurn.status !== "accepted")) {
      throw new Error(`Desktop send is not confirmed for ${threadId}. Do not resend: ${JSON.stringify(response)}`);
    }
    if ((envelope.executorThreadId ?? null) !== inspected.executorThreadId) throw new Error("Native executor changed during dispatch; inspect the existing task without resending");
    return { ...delivered, deliveryStatus: "accepted" };
  }

  async open(threadId, { deadline } = {}) {
    const response = await this.request("navigate_to_codex_page", { threadId }, { deadline });
    if (response?.navigated !== true) throw new Error(`Desktop did not confirm opening task ${threadId}`);
  }

  async observeNativeResponse(threadId, turnId, responseObservation, { deadline } = {}) {
    if (!responseObservation) return unavailableObservation("Codex Desktop completed the turn without exposing assistant response text or a pre-send observation binding.");
    const { expectedCwd } = responseObservation;
    const args = { threadId, hostId: "local", turnLimit: 1 };
    const recheck = async () => {
      await this.beforeRequest?.({ operation: "read_thread", args, phase: "observe" });
      if (this.accountContext && !sameAccountContext(responseObservation.accountContext, this.accountContext())) throw new Error("The original account changed while the native response was being observed; reply content was withheld");
      this.security.assertCwd(expectedCwd);
      this.security.assertThread(threadId, expectedCwd);
      if (realpathSync.native(expectedCwd) !== expectedCwd) throw new Error("The selected native task workspace changed while its response was being observed");
    };
    await recheck();
    const initial = await this.inspect(threadId, expectedCwd, { deadline });
    if (initial.latestTurnId !== turnId) throw new Error("The selected native task changed before its response could be read; reply content was withheld");
    const read = responseObservation.operation === "create_thread" ? readCodexNativeCreationResponse : this.readResponse;
    const observed = read({ ...responseObservation, threadId, turnId, desktopEvidence: initial });
    await recheck();
    const inspected = await this.inspect(threadId, expectedCwd, { deadline });
    if (inspected.latestTurnId !== turnId) throw new Error("The selected native task changed before its response could be confirmed; reply content was withheld");
    await recheck();
    return observed;
  }

  async inspectNativeTurn(threadId, turnId, cwd, { deadline } = {}) {
    const initial = await this.inspect(threadId, cwd, { deadline });
    const expectedCwd = realpathSync.native(initial.thread.cwd);
    const accountContext = this.accountContext?.() ?? null;
    const args = { threadId, hostId: "local", turnLimit: 1 };
    const recheck = async () => {
      await this.beforeRequest?.({ operation: "read_thread", args, phase: "inspect-turn" });
      if (this.accountContext && !sameAccountContext(accountContext, this.accountContext())) throw new Error("The account changed while the native turn was being inspected; response content was withheld");
      this.security.assertCwd(expectedCwd);
      this.security.assertThread(threadId, expectedCwd);
      if (realpathSync.native(expectedCwd) !== expectedCwd) throw new Error("The selected native task workspace changed while its turn was being inspected");
    };
    await recheck();
    const result = this.inspectResponse({ threadId, turnId, expectedCwd, desktopEvidence: initial });
    await recheck();
    await this.inspect(threadId, expectedCwd, { deadline });
    await recheck();
    return result;
  }

  async wait(threadId, { timeoutMs = 240000, previousTurnId = null, responseObservation = null } = {}) {
    const startedAt = this.now();
    let cursor;
    let turnId = null;
    const expired = () => ({ threadId, turnId, status: "timeout", text: "", responseStatus: "unavailable", assistantItems: [], replySha256: null, activity: [], errors: [], durationMs: this.now() - startedAt });
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
        const status = turn.status;
        if (RELEASE_STATUSES.has(status)) {
          const observed = await this.observeNativeResponse(threadId, turnId, responseObservation, { deadline: startedAt + timeoutMs });
          const responseStatus = observed.status;
          return {
            threadId, turnId, status,
            text: responseStatus === "completed" ? observed.text : "",
            responseStatus,
            observationStatus: responseStatus,
            ...(observed.reason ? { observationReason: observed.reason } : {}),
            assistantItems: observed.assistantItems ?? [],
            replySha256: observed.replySha256 ?? null,
            responseSource: observed.source ?? null,
            activity: [], errors: turn.error ? [turn.error] : [], durationMs: turn.durationMs ?? this.now() - startedAt,
          };
        }
      }
      if (this.now() - startedAt >= timeoutMs) return expired();
      await this.sleep(Math.min(1500, timeoutMs - (this.now() - startedAt)));
    }
  }
}

function unavailableObservation(reason) {
  return { status: "unavailable", reason };
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
  async function deliver(threadId, text, options = {}) {
    const status = relay.status(options);
    if (status.enabled) {
      try {
        const ack = await relay.sendMessage(threadId, text, options);
        reportedUnavailable = null;
        return { backend: NATIVE_BACKEND, threadId, ack };
      } catch (err) {
        if (err.reachedCompanion || err.code !== "RELAY_UNREACHABLE") throw err;
        if (desktopOnly) throw Object.assign(new Error(`Codex Desktop relay is unavailable: ${err.message}. Desktop-only mode will not start or use an external app-server.`), { code: "RELAY_UNREACHABLE", sent: false });
        log(`native relay unreachable (${err.message}); falling back to the app-server path`);
      }
    } else if (status.reason !== reportedUnavailable) {
      reportedUnavailable = status.reason;
      log(`native relay not in use: ${status.reason}`);
    }

    if (desktopOnly) throw Object.assign(new Error(`Codex Desktop relay is unavailable: ${status.reason ?? "no native acknowledgement"}. Desktop-only mode will not start or use an external app-server.`), { code: "RELAY_UNREACHABLE", sent: false });
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
