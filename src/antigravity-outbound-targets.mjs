import fs from "node:fs";
import path from "node:path";
import { NativeDesktopRelay, desktopTaskSocketPath, accountRelaySocketPath } from "./native-relay.mjs";
import { readBridgeAccounts, requireBridgeAccounts, assertAccountIdentity } from "./bridge-account-context.mjs";
import { PeerEndpoint, listClaudeSessions, assertClaudeSessionProcess } from "./peer-protocol.mjs";
import { readClaudeDesktopContext } from "./claude-desktop-context.mjs";
import { readClaudeInboundPolicy } from "./claude-inbound-policy.mjs";
import { assertRecipientClass } from "./recipient-preflight.mjs";
import { sameClaudeDesktopRecipient } from "./claude-session-router.mjs";
import { createHardenedRootPolicy } from "./hardened-root-policy.mjs";
import { protectCurrentUserPipe } from "./windows-pipe-acl.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function blocked(message) {
  return Object.assign(new Error(message), { deliveryState: "not_sent" });
}

function captureDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw blocked("An absolute existing project directory is required");
  const canonical = fs.realpathSync.native(value);
  const stat = fs.statSync(canonical, { bigint: true });
  if (!stat.isDirectory()) throw blocked("The project path must be a directory");
  return { path: canonical, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` };
}

function sameDirectory(left, right) {
  return path.relative(left, right) === "";
}

function senderIdentity(sender) {
  if (sender?.provider !== "antigravity" || !UUID.test(sender.id ?? "") || sender.conversationId !== sender.id
      || !["bypass", "prompting"].includes(sender.mode) || typeof sender.permissionFingerprint !== "string" || !sender.permissionFingerprint) {
    throw blocked("Verified Antigravity conversation identity and permission evidence are required");
  }
  return Object.freeze({ provider: sender.provider, id: sender.id, conversationId: sender.conversationId, cwd: sender.cwd, mode: sender.mode, permissionFingerprint: sender.permissionFingerprint });
}

export function createAntigravityOutboundTargets(options = {}) {
  const env = options.env ?? process.env;
  const relay = options.relay ?? new NativeDesktopRelay({ env, socketPath: desktopTaskSocketPath(env), accountSocketPath: accountRelaySocketPath(env) });
  const readAccounts = options.readAccounts ?? readBridgeAccounts;
  const assertAccounts = options.assertAccounts ?? ((identity) => assertAccountIdentity(identity, readAccounts()));
  const listSessions = options.listSessions ?? listClaudeSessions;
  const readContext = options.readContext ?? ((session, account) => readClaudeDesktopContext(session, { account }));
  const readInbound = options.readInbound ?? readClaudeInboundPolicy;
  const assertProcess = options.assertProcess ?? assertClaudeSessionProcess;
  const roots = options.roots ?? createHardenedRootPolicy(env);
  const peerFactory = options.peerFactory ?? ((settings) => new PeerEndpoint(settings));
  const receipts = new Map();
  let peer;
  let closed = false;

  function operation(sender, beforeSend, required = false) {
    if (closed) throw blocked("Antigravity outbound targets have been closed");
    if (required && typeof beforeSend !== "function") throw blocked("A live Antigravity sender revalidation callback is required");
    const identity = senderIdentity(sender);
    const cwd = captureDirectory(identity.cwd);
    const root = roots.capture(cwd.path, "Antigravity sender project");
    const accounts = readAccounts();
    const accountContext = requireBridgeAccounts(accounts);
    const check = async () => {
      if (closed) throw blocked("Antigravity outbound targets have been closed");
      assertAccounts(accountContext);
      roots.recheck(root, "Antigravity sender project");
      const current = captureDirectory(identity.cwd);
      if (!sameDirectory(current.path, cwd.path) || current.identity !== cwd.identity) throw blocked("Antigravity sender project changed before delivery");
      const refreshed = await beforeSend?.();
      if (refreshed?.provider && JSON.stringify(senderIdentity(refreshed)) !== JSON.stringify(identity)) throw blocked("Antigravity sender identity or permissions changed before delivery");
      assertAccounts(accountContext);
    };
    return { identity, cwd: cwd.path, accounts, accountContext, check };
  }

  async function request(context, name, args, beforeSend = context.check) {
    const response = await relay.requestDesktop(name, args, { accountContext: context.accountContext, beforeSend });
    try { await context.check(); }
    catch (error) { if (name === "send_message_to_thread") error.deliveryState = "unknown"; throw error; }
    return response.result;
  }

  async function projects(context) {
    const result = await request(context, "list_projects", {});
    if (!Array.isArray(result?.projects)) throw blocked("Native Codex saved projects are unavailable");
    const matches = result.projects.filter((project) => {
      try { return project.projectKind === "local" && project.hostId === "local" && typeof project.projectId === "string" && project.projectId && sameDirectory(captureDirectory(project.path).path, context.cwd); }
      catch { return false; }
    });
    if (matches.length !== 1 || result.projects.filter((project) => project.projectId === matches[0].projectId).length !== 1) throw blocked("Sender project must match exactly one saved local Codex project");
    return matches[0];
  }

  function threadRecord(thread, threadId, project, context, requireProjectId = true) {
    if (thread?.id !== threadId || thread.kind !== "codex" || thread.hostId !== "local"
        || (requireProjectId || thread.projectId !== undefined) && thread.projectId !== project.projectId
        || !sameDirectory(captureDirectory(thread.cwd).path, context.cwd)) throw blocked("Exact Codex task does not belong to the current account's matching saved project");
    return { threadId, projectId: project.projectId, cwd: context.cwd, title: thread.title ?? null, status: thread.status ?? null, hostId: "local", target: "codex" };
  }

  async function codexRecipient(context, threadId) {
    if (!UUID.test(threadId ?? "")) throw blocked("An exact existing Codex task UUID is required");
    const project = await projects(context);
    const inventory = await request(context, "list_threads", { limit: 50 });
    if (!Array.isArray(inventory?.threads) || !Array.isArray(inventory?.pinnedThreads ?? [])) throw blocked("Native Codex task inventory is unavailable");
    const matches = [...(inventory.pinnedThreads ?? []), ...inventory.threads].filter((thread) => thread?.id === threadId);
    if (!matches.length) throw blocked("Exact Codex task must be an existing recent or pinned task");
    for (const thread of matches) threadRecord(thread, threadId, project, context);
    const result = await request(context, "read_thread", { threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 });
    return threadRecord(result?.thread, threadId, project, context, false);
  }

  function claudeRecipient(context, sessionId, taskId) {
    if (typeof sessionId !== "string" || !sessionId || typeof taskId !== "string" || !taskId) throw blocked("Exact Claude sessionId and native taskId are required");
    const candidates = listSessions().filter((session) => session.sessionId === sessionId);
    if (candidates.length !== 1) throw blocked("Exact Claude session is missing or ambiguous");
    const session = candidates[0];
    if (!session.alive || session.entrypoint !== "claude-desktop" || !session.socket || !sameDirectory(captureDirectory(session.cwd).path, context.cwd)) throw blocked("Claude destination must be a live Desktop Code session in the sender project");
    assertProcess(session);
    const desktop = readContext(session, context.accounts.claude);
    if (desktop?.status !== "matched" || desktop.taskId !== taskId || desktop.accountFingerprint !== context.accountContext.claude
        || !sameDirectory(captureDirectory(desktop.cwd).path, context.cwd)) throw blocked("Claude native task identity or current account does not match");
    return { ...session, desktop, inbound: readInbound(session.cwd) };
  }

  async function list({ target, sender, beforeSend } = {}) {
    const context = operation(sender, beforeSend);
    await context.check();
    if (target === "codex") {
      const project = await projects(context);
      const result = await request(context, "list_threads", { limit: 50 });
      if (!Array.isArray(result?.threads) || !Array.isArray(result?.pinnedThreads ?? [])) throw blocked("Native Codex task inventory is unavailable");
      const records = [];
      const seen = new Set();
      for (const thread of [...(result.pinnedThreads ?? []), ...result.threads]) {
        if (seen.has(thread?.id)) continue;
        try {
          const row = threadRecord(thread, thread.id, project, context);
          if (!UUID.test(row.threadId)) continue;
          records.push(row);
          seen.add(thread.id);
        } catch {}
      }
      return records;
    }
    if (target !== "claude") throw blocked("Target must be codex or claude");
    const rows = [];
    for (const session of listSessions()) {
      try {
        const desktop = readContext(session, context.accounts.claude);
        const verified = claudeRecipient(context, session.sessionId, desktop?.taskId);
        rows.push({ target: "claude", sessionId: verified.sessionId, taskId: verified.desktop.taskId, cwd: context.cwd, title: verified.desktop.title ?? null, permissionClass: verified.desktop.permissionClass ?? null, inboundPolicy: verified.inbound?.value ?? null });
      } catch {}
    }
    await context.check();
    return rows;
  }

  async function send({ target, threadId, sessionId, taskId, cwd, prompt, sender, beforeSend } = {}) {
    const context = operation(sender, beforeSend, true);
    if (!sameDirectory(captureDirectory(cwd).path, context.cwd)) throw blocked("Destination directory must match the verified Antigravity sender project");
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 65536) throw blocked("Prompt must contain between 1 and 65536 UTF-8 bytes");
    await context.check();
    const text = `[Agent handoff from Antigravity conversation ${context.identity.id}; native recipient permissions remain in effect.]\n\n${prompt}`;
    if (target === "codex") {
      const recipient = await codexRecipient(context, threadId);
      try {
        const result = await request(context, "send_message_to_thread", { threadId, prompt: text }, async () => {
          await context.check();
          const current = await codexRecipient(context, threadId);
          if (current.projectId !== recipient.projectId || !sameDirectory(current.cwd, recipient.cwd)) throw blocked("Codex destination changed before delivery");
          await context.check();
        });
        return { target, threadId, cwd: context.cwd, status: "accepted", completed: false, accountContext: context.accountContext, result };
      } catch (error) {
        if (!error.deliveryState) error.deliveryState = error.sent === false || error.reachedCompanion === false ? "not_sent" : "unknown";
        if (error.deliveryState === "unknown") error.accountContext = context.accountContext;
        throw error;
      }
    }
    if (target !== "claude") throw blocked("Target must be codex or claude");
    const recipient = claudeRecipient(context, sessionId, taskId);
    assertRecipientClass(recipient, context.identity);
    if (!peer) peer = peerFactory({ name: `antigravity-${process.pid}`, cwd: context.cwd, signalExit: false, env, protectSocket: protectCurrentUserPipe });
    await peer.start();
    let msgId;
    try {
      const outcome = await peer.sendAndWait(recipient.socket, text, {
        timeoutMs: 0, permissionMode: context.identity.mode, transcriptSession: recipient, accountContext: context.accountContext,
        recipient: { permissionMode: recipient.desktop.permissionMode ?? null, permissionClass: recipient.desktop.permissionClass ?? null, inboundPolicy: recipient.inbound?.value ?? null },
        beforeSend: async () => {
          await context.check();
          const current = claudeRecipient(context, sessionId, taskId);
          if (!sameClaudeDesktopRecipient(recipient, current)) throw blocked("Claude session process or socket changed before delivery");
          assertRecipientClass(current, context.identity);
          await context.check();
        },
      });
      msgId = outcome.msgId;
      receipts.set(msgId, { sender: context.identity, accountContext: context.accountContext, cwd: context.cwd });
      await context.check();
      return { target, sessionId, taskId, cwd: context.cwd, msgId, status: outcome.delivery?.status ?? "sent_unconfirmed", completed: false, accountContext: context.accountContext };
    } catch (error) {
      if (error.msgId) receipts.set(error.msgId, { sender: context.identity, accountContext: context.accountContext, cwd: context.cwd });
      if (msgId) error.msgId = msgId;
      if (msgId || error.deliveryUncertain) error.deliveryState = "unknown";
      else if (!error.deliveryState) error.deliveryState = "not_sent";
      if (error.deliveryState === "unknown") error.accountContext = context.accountContext;
      throw error;
    }
  }

  async function read({ target, threadId, sessionId, taskId, cwd, msgId, sender, beforeSend } = {}) {
    const context = operation(sender, beforeSend);
    if (cwd !== undefined && !sameDirectory(captureDirectory(cwd).path, context.cwd)) throw blocked("Destination directory must match the verified Antigravity sender project");
    await context.check();
    if (target === "codex") {
      const recipient = await codexRecipient(context, threadId);
      const result = await request(context, "read_thread", { threadId, hostId: "local", turnLimit: 3, includeOutputs: false, maxOutputCharsPerItem: 4000 });
      threadRecord(result?.thread, threadId, { projectId: recipient.projectId }, context, false);
      return { target, threadId, cwd: context.cwd, result };
    }
    if (target !== undefined && target !== "claude") throw blocked("Target must be codex or claude");
    if (msgId === undefined) {
      const recipient = claudeRecipient(context, sessionId, taskId);
      await context.check();
      return { target: "claude", sessionId, taskId, cwd: context.cwd, title: recipient.desktop.title ?? null, permissionClass: recipient.desktop.permissionClass ?? null, inboundPolicy: recipient.inbound?.value ?? null };
    }
    const receipt = receipts.get(msgId);
    if (!receipt) throw Object.assign(blocked("The native receipt is unavailable in this bridge process"), { code: "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE" });
    if (receipt.sender.id !== context.identity.id || !sameDirectory(receipt.cwd, context.cwd)) throw blocked("Receipt does not belong to this Antigravity conversation");
    assertAccounts(receipt.accountContext);
    const result = peer.readDelivery(msgId);
    await context.check();
    return result;
  }

  async function close() {
    closed = true;
    peer?.stop();
    await peer?.closed;
  }

  return { list, send, read, close };
}
