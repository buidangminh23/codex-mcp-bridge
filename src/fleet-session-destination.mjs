import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { callAntigravityDesktop } from "./antigravity-ipc.mjs";
import { assertAccountIdentity, readBridgeAccounts, requireBridgeAccounts } from "./bridge-account-context.mjs";
import { readClaudeDesktopContext } from "./claude-desktop-context.mjs";
import { readClaudeInboundPolicy } from "./claude-inbound-policy.mjs";
import { sameClaudeDesktopRecipient } from "./claude-session-router.mjs";
import { captureCodexRolloutWatermark, resolveCodexNativeDispatchResponse } from "./codex-native-response.mjs";
import { readClaudeAccountContext } from "./desktop-account-context.mjs";
import { NativeDesktopRelay } from "./native-relay.mjs";
import { assertClaudeSessionProcess, listClaudeSessions, PeerEndpoint, readTranscriptOutcome } from "./peer-protocol.mjs";
import { captureCheckoutScope, recheckCheckoutScope } from "./project-scope.mjs";
import { assertRecipientClass } from "./recipient-preflight.mjs";
import { matchDesktopProject } from "./thread-delivery.mjs";
import { protectCurrentUserPipe } from "./windows-pipe-acl.mjs";

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const fingerprint = /^[a-f0-9]{64}$/;
const agents = ["codex", "claude", "antigravity"];
const unavailable = message => Object.assign(new Error(message), { code: "FLEET_SESSION_UNAVAILABLE", deliveryState: "not_sent" });

function sameProject(directory, cwd) {
  try { return typeof directory === "string" && path.isAbsolute(directory) && path.relative(fs.realpathSync.native(directory), cwd) === ""; }
  catch { return false; }
}

function checkoutScope(cwd, nativeCwd) {
  try { return captureCheckoutScope(cwd, nativeCwd); } catch { return null; }
}

function sessionRow(agent, id, title, status, accountFingerprint, taskId, scope) {
  const { path: cwd, identity, repository } = scope.recipient;
  const scopeFingerprint = createHash("sha256").update(JSON.stringify([cwd, identity, repository?.path, repository?.identity])).digest("hex");
  return { agent, id, title: String(title || id).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256), status, accountFingerprint, taskId, cwd, scopeFingerprint };
}

function matchTarget(rows, target, requireIdle = false) {
  const found = rows.filter(row => row.id === target.id && row.accountFingerprint === target.accountFingerprint && row.taskId === target.taskId
    && (!target.scopeFingerprint || row.scopeFingerprint === target.scopeFingerprint));
  if (found.length !== 1 || requireIdle && found[0].status !== "idle") throw unavailable("The selected native session is missing, changed, busy or waiting for user input");
  return found[0];
}

function messageFor(input) {
  const { sender, requestId, prompt } = input;
  if (!agents.includes(sender?.agent) || !uuid.test(sender.id) || !/^[a-zA-Z0-9_.-]{1,255}$/.test(sender.host)
      || !fingerprint.test(sender.account) || !["bypass", "prompting"].includes(sender.mode) || !uuid.test(requestId)
      || typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 65536 || prompt.includes("\0")) throw unavailable("Invalid fleet session handoff");
  return "[From " + sender.agent + " on " + sender.host + " · session " + sender.id + " · request " + requestId + "]\n\n" + prompt;
}

function codexStatus(thread) {
  const type = thread.status?.type ?? thread.status;
  if (thread.status?.activeFlags?.some(flag => ["waitingOnApproval", "waitingOnUserInput"].includes(flag))) return "waiting";
  return type === "idle" ? "idle" : type === "active" ? "running" : null;
}

function codexAdapter(cwd, { accounts, codex, watermark, observe }, check) {
  const identity = requireBridgeAccounts(accounts());
  const guard = async () => { await check(); assertAccountIdentity(identity, accounts()); };
  async function call(name, args, beforeSend = guard) {
    await guard();
    const envelope = await codex.requestDesktop(name, args, { accountContext: identity, beforeSend, timeoutMs: 8000 });
    await guard();
    return envelope;
  }
  async function list(sender) {
    if (sender && sender.mode !== "bypass") return [];
    const { result } = await call("list_projects", {});
    const { result: snapshot, executorThreadId } = await call("list_threads", { limit: 50 });
    if (!uuid.test(executorThreadId) || !Array.isArray(snapshot.threads) || !Array.isArray(snapshot.pinnedThreads)
        || snapshot.unavailableHosts?.some(host => (host?.hostId ?? host) === "local")) throw unavailable("Codex Desktop did not confirm the local host");
    const rows = new Map();
    for (const thread of [...snapshot.pinnedThreads, ...snapshot.threads]) {
      const status = codexStatus(thread);
      if (!status || !uuid.test(thread.id) || thread.id === executorThreadId || thread.kind !== "codex" || thread.hostId !== "local") continue;
      const scope = checkoutScope(cwd, thread.cwd);
      if (!scope) continue;
      let project;
      try { project = matchDesktopProject(result.projects, scope.recipient.path); } catch { continue; }
      if (thread.projectId !== project.projectId) continue;
      rows.set(thread.id, sessionRow("codex", thread.id, thread.title, status, identity.codex, project.projectId, scope));
    }
    return [...rows.values()];
  }
  async function inspect(target, idle) {
    matchTarget(await list(), target, idle);
    const { result, executorThreadId } = await call("read_thread", { threadId: target.id, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 });
    const thread = result.thread;
    if (!uuid.test(executorThreadId) || executorThreadId === target.id || thread?.id !== target.id || thread.kind !== "codex"
        || thread.hostId !== "local" || thread.projectId !== undefined && thread.projectId !== target.taskId || !sameProject(thread.cwd, cwd)
        || idle && thread.status !== undefined && codexStatus(thread) !== "idle") throw unavailable("Codex Desktop no longer confirms the selected session");
    return { thread, latestTurnId: result.turns?.[0]?.id ?? null, executorThreadId };
  }
  return {
    list,
    async send(input, text, prepare) {
      if (input.sender.mode !== "bypass") throw unavailable("Remote Codex dispatch requires a verified full-access sender");
      const evidence = await inspect(input.target, true);
      const binding = { threadId: input.target.id, previousTurnId: evidence.latestTurnId, expectedCwd: cwd, executorThreadId: evidence.executorThreadId, prompt: text,
        watermark: watermark({ threadId: input.target.id, expectedCwd: cwd, desktopEvidence: evidence }), accountContext: identity };
      if (binding.watermark?.status !== "available") throw unavailable("The exact Codex session has no verifiable reply watermark");
      await prepare(binding);
      const { result, executorThreadId } = await call("send_message_to_thread", { threadId: input.target.id, prompt: text }, async () => {
        const now = await inspect(input.target, true);
        if (now.executorThreadId !== evidence.executorThreadId || now.latestTurnId !== evidence.latestTurnId) throw unavailable("Codex session changed before delivery");
        await guard();
      });
      if (executorThreadId !== evidence.executorThreadId || result?.threadId !== input.target.id || result.success === false || result.isError
          || result.status !== undefined && !["accepted", "sent"].includes(result.status) || result.firstTurn && result.firstTurn.status !== "accepted") return { status: "uncertain" };
      return { status: "running" };
    },
    async read(input, binding) {
      if (!isDeepStrictEqual(binding.accountContext, identity) || binding.threadId !== input.target.id || binding.expectedCwd !== cwd) throw unavailable("The receiving Codex account or task changed");
      const initial = await inspect(input.target, false);
      if (initial.executorThreadId !== binding.executorThreadId) throw unavailable("Codex relay executor changed");
      const seen = observe({ ...binding, desktopEvidence: initial });
      const final = await inspect(input.target, false);
      if (final.executorThreadId !== initial.executorThreadId || final.latestTurnId !== initial.latestTurnId) return { status: "running" };
      if (seen.status === "completed" && seen.threadId === input.target.id && uuid.test(seen.turnId) && typeof seen.text === "string"
          && createHash("sha256").update(seen.text).digest("hex") === seen.replySha256) return { status: "completed", output: seen.text };
      if (seen.status === "completed_no_reply") return { status: "completed", output: "" };
      return { status: seen.status === "pending" ? "running" : "uncertain" };
    },
  };
}

function claudeAdapter(cwd, deps, check) {
  const account = deps.claudeAccount();
  if (account.status !== "verified" || !fingerprint.test(account.fingerprint)) throw unavailable("The Claude Desktop account is unavailable");
  async function candidates() {
    await check();
    const list = [];
    const current = deps.claudeSessions({ includeActivity: true });
    for (const session of current) {
      if (!session.alive || session.entrypoint !== "claude-desktop" || !uuid.test(session.sessionId) || !session.socket) continue;
      const scope = checkoutScope(cwd, session.cwd);
      if (!scope) continue;
      try {
        deps.assertProcess(session);
        const desktop = deps.claudeContext(session, { account });
        if (desktop.status !== "matched" || desktop.accountFingerprint !== account.fingerprint || !desktop.taskId || !sameProject(desktop.cwd, scope.recipient.path)) continue;
        const activity = String(session.activity || "").toLowerCase();
        const status = activity === "idle" ? "idle" : ["running", "busy", "working", "active"].includes(activity) ? "running" : "connected";
        list.push({ row: sessionRow("claude", session.sessionId, desktop.title, status, account.fingerprint, desktop.taskId, scope),
          session: { ...session, desktop, inbound: deps.inbound(scope.recipient.path) } });
      } catch {}
    }
    const confirmed = deps.claudeAccount();
    if (confirmed.status !== "verified" || confirmed.fingerprint !== account.fingerprint) throw unavailable("Claude Desktop account changed");
    await check();
    return list;
  }
  async function inspect(target, idle) {
    const candidatesNow = await candidates();
    const row = matchTarget(candidatesNow.map(item => item.row), target, idle);
    return candidatesNow.find(item => item.row === row).session;
  }
  return {
    async list(sender) {
      const rows = await candidates();
      return rows.filter(({ session }) => {
        if (!sender) return true;
        try { assertRecipientClass(session, sender); return true; }
        catch { return false; }
      }).map(item => item.row);
    },
    async send(input, text, prepare) {
      const selected = await inspect(input.target, true);
      assertRecipientClass(selected, input.sender);
      const peer = deps.peer({ name: "fleet-" + input.sender.agent, cwd, signalExit: false, protectSocket: protectCurrentUserPipe });
      try {
        await peer.start();
        const delivery = await peer.sendAndWait(selected.socket, text, { timeoutMs: 0, permissionMode: input.sender.mode, transcriptSession: selected,
          onPrepared: msgId => prepare({ msgId, pid: selected.pid, processStart: selected.processStart }),
          beforeSend: async () => {
            const now = await inspect(input.target, true);
            if (!sameClaudeDesktopRecipient(selected, now)) throw unavailable("The Claude process or socket changed");
            assertRecipientClass(now, input.sender);
            await check();
          } });
        return { status: delivery.delivery?.status === "refused" ? "failed" : "running" };
      } finally { peer.stop(); await peer.closed; }
    },
    async read(input, binding) {
      const confirm = async () => {
        const session = await inspect(input.target, false);
        if (!uuid.test(binding.msgId) || session.pid !== binding.pid || session.processStart !== binding.processStart) throw unavailable("The receiving Claude process changed");
        assertRecipientClass(session, input.sender);
      };
      await confirm();
      const seen = deps.claudeReply(input.target.id, cwd, binding.msgId);
      await confirm();
      if (seen?.status === "reply_received" && seen.reply?.inReplyTo === binding.msgId && typeof seen.reply.text === "string") return { status: "completed", output: seen.reply.text };
      return { status: seen?.status === "interrupted" ? "uncertain" : "running" };
    },
  };
}

function antigravityAdapter(cwd, { antigravity }, check) {
  async function call(request) {
    await check();
    const result = await antigravity(request, { timeoutMs: request.operation === "send" ? 20000 : 5000 });
    await check();
    return result;
  }
  async function instance() {
    const { instanceId } = await call({ operation: "fleet-status" });
    if (!uuid.test(instanceId)) throw unavailable("The Antigravity sidecar needs fleet session support");
    return instanceId;
  }
  function rowFor(row, instanceId) {
    if (row.surface !== "desktop" || !uuid.test(row.conversationId) || typeof row.projectId !== "string" || !row.projectId) return null;
    const scope = checkoutScope(cwd, row.cwd);
    if (!scope) return null;
    const status = row.status === "CASCADE_RUN_STATUS_IDLE" ? "idle" : "running";
    const binding = createHash("sha256").update(JSON.stringify([instanceId, row.projectId])).digest("hex");
    return sessionRow("antigravity", row.conversationId, row.title, status, binding, row.projectId, scope);
  }
  async function inspect(target, idle) {
    const instanceId = await instance();
    const native = await call({ operation: "read", instanceId, conversationId: target.id });
    const row = rowFor(native, instanceId);
    matchTarget(row ? [row] : [], target, idle);
    return instanceId;
  }
  return {
    async list() {
      const instanceId = await instance();
      const rows = await call({ operation: "list", instanceId });
      return rows.map(row => rowFor(row, instanceId)).filter(Boolean);
    },
    async send(input, text, prepare) {
      if (text.length > 30000) throw unavailable("The prompt exceeds the Antigravity Desktop limit");
      const instanceId = await inspect(input.target, true);
      const sender = { provider: input.sender.agent, id: input.sender.id, host: input.sender.host, accountFingerprint: input.sender.account };
      await prepare({ instanceId, sender });
      const receipt = await call({ operation: "send", instanceId, conversationId: input.target.id, cwd, prompt: text, requestId: input.requestId, expectedProjectId: input.target.taskId, projectScope: input.projectScope, sender });
      if (receipt?.requestId !== input.requestId || receipt.conversationId !== input.target.id || !isDeepStrictEqual(receipt.sender, sender)) return { status: "uncertain" };
      return { status: receipt.status === "failed" ? "failed" : "running" };
    },
    async read(input, binding) {
      const instanceId = await inspect(input.target, false);
      if (binding.instanceId !== instanceId) throw unavailable("The original Antigravity sidecar changed");
      const record = await call({ operation: "receipt", requestId: input.requestId, instanceId });
      if (record?.requestId !== input.requestId || record.conversationId !== input.target.id || !sameProject(record.cwd, cwd)
          || !isDeepStrictEqual(record.sender, binding.sender) || await instance() !== instanceId) throw unavailable("The Antigravity reply belongs to another delivery");
      if (record.status === "reply_received" && record.replyObservation?.status === "reply_received" && typeof record.result?.reply === "string"
          && createHash("sha256").update(record.result.reply).digest("hex") === record.replyObservation.replySha256) return { status: "completed", output: record.result.reply };
      if (["failed", "refused"].includes(record.status)) return { status: "failed" };
      return { status: record.status === "unknown" ? "uncertain" : "running" };
    },
  };
}

const factories = { codex: codexAdapter, claude: claudeAdapter, antigravity: antigravityAdapter };
export function createSessionDestinations(overrides = {}) {
  const deps = { accounts: readBridgeAccounts, codex: new NativeDesktopRelay(), watermark: captureCodexRolloutWatermark, observe: resolveCodexNativeDispatchResponse,
    claudeSessions: listClaudeSessions, claudeAccount: readClaudeAccountContext, claudeContext: readClaudeDesktopContext, assertProcess: assertClaudeSessionProcess,
    inbound: readClaudeInboundPolicy, peer: options => new PeerEndpoint(options), claudeReply: readTranscriptOutcome, antigravity: callAntigravityDesktop, ...overrides };
  async function boundDestination(input, storedScope) {
    if (!agents.includes(input.target?.agent) || !uuid.test(input.target.id) || !fingerprint.test(input.target.accountFingerprint)
        || typeof input.target.taskId !== "string" || !input.target.taskId || typeof input.check !== "function"
        || input.target.scopeFingerprint !== undefined && !fingerprint.test(input.target.scopeFingerprint)) throw unavailable("The native recipient is not bound to a project and identity");
    const cwd = fs.realpathSync.native(input.cwd);
    const factory = factories[input.target.agent];
    let scope = storedScope;
    if (!scope) {
      const rows = await factory(cwd, deps, input.check).list();
      const selected = matchTarget(rows, input.target);
      if (!input.target.scopeFingerprint && !sameProject(selected.cwd, cwd)) throw unavailable("Dispatch to a linked worktree requires a pinned checkout identity");
      scope = checkoutScope(cwd, selected.cwd);
    }
    if (!scope || !sameProject(scope.sender.path, cwd)) throw unavailable("The destination checkout changed");
    const guard = async () => { await input.check(); recheckCheckoutScope(scope); };
    await guard();
    return { scope, guard, destination: factory(scope.recipient.path, deps, guard) };
  }
  return {
    async listSessionTargets(project, { sender } = {}) {
      const cwd = fs.realpathSync.native(project);
      const snapshots = await Promise.allSettled(agents.map(async agent => factories[agent](cwd, deps, () => {}).list(sender)));
      const sessions = snapshots.flatMap(result => result.status === "fulfilled" ? result.value : []);
      const missing = agents.filter((agent, i) => snapshots[i].status === "rejected");
      return { sessions: sessions.slice(0, 256), ...(missing.length ? { note: "Unavailable session sources: " + missing.join(", ") } : {}) };
    },
    async dispatchSession(input) {
      const text = messageFor(input);
      const { destination, scope, guard } = await boundDestination(input);
      let adapterReceipt;
      const result = await destination.send({ ...input, projectScope: scope }, text, async binding => {
        adapterReceipt = { ...binding, projectScope: scope };
        await guard();
        await input.onPrepared?.(adapterReceipt);
      });
      if (!adapterReceipt) throw new Error("No native observation receipt was prepared");
      await guard();
      return { ...result, adapterReceipt };
    },
    async readSessionReply(input) {
      if (!input.receipt || typeof input.receipt !== "object") return { status: "uncertain" };
      const { destination, guard } = await boundDestination(input, input.receipt.projectScope);
      const result = await destination.read(input, input.receipt);
      await guard();
      return result;
    },
  };
}

export const { listSessionTargets, dispatchSession, readSessionReply } = createSessionDestinations();
