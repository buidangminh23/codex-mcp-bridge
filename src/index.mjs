#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { realpathSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

import { CodexAppServerClient, writerLockWarning } from "./app-server-client.mjs";
import {
  IS_MACOS,
  IS_WINDOWS,
  PLATFORM_LABEL,
  claudeDesktopConfigPath,
  codexThreadUrl,
  hasCodexDesktopApp,
  isDesktopAppServerRunning,
  isLaunchAgentInstalled,
  launchAgentPath,
  openThreadInCodexApp,
  resolveWorkspacePath,
  supportsCodexThreadLinks,
} from "./platform.mjs";
import { runTurn } from "./turn.mjs";
import { BridgeSecurityPolicy } from "./security-policy.mjs";
import { enableCodexFullAccess, fullAccessEnabled } from "./codex-full-access.mjs";
import { DesktopTaskDelivery, DESKTOP_TOOL_BUDGET_MS } from "./thread-delivery.mjs";
import { desktopTasksConfigured } from "./native-relay.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { createRuntimeState } from "./runtime-state.mjs";
import { assertRoutingReload, clientReloadReason, createReloadControl } from "./reload-control.mjs";
import { accountIdentity, assertAccountIdentity, publicAccountState, readBridgeAccounts, requireBridgeAccounts } from "./bridge-account-context.mjs";
import { assertClaudeSenderContext, readClaudeSenderContext, requireClaudeSenderContext, stopProcessInspectors } from "./claude-sender-context.mjs";
import { AGENT_PROMPT_GUIDANCE, PROMPT_FIELD_HINT } from "./prompt-guidance.mjs";
import { bridgeReadiness } from "./bridge-readiness.mjs";
import { captureProjectScope } from "./project-scope.mjs";
import { DesktopReplyReceipts } from "./desktop-reply-receipts.mjs";
import { PROJECT_SETUP_TOOLS, registerProjectOnboardingTools } from "./project-onboarding-tools.mjs";

exitForVersionRequest(import.meta.url);

const VERSION = "1.21.1";
void import("./telemetry.mjs").then(({ startUsageReporting }) => startUsageReporting({ version: VERSION })).catch(() => {});
const log = (msg) => process.stderr.write(`[codex-mcp-bridge] ${msg}\n`);

/**
 * The Codex desktop app ignores ~/.codex/config.toml and runs its own model and
 * effort, so a thread opened through the bridge would otherwise be weaker than
 * the same work done in the app. These defaults keep both paths equivalent.
 */
const DEFAULT_MODEL = process.env.CODEX_BRIDGE_MODEL || null;
const DEFAULT_EFFORT = process.env.CODEX_BRIDGE_EFFORT || null;
const DEFAULT_OPEN_IN_APP = process.env.CODEX_BRIDGE_OPEN_IN_APP
  ? process.env.CODEX_BRIDGE_OPEN_IN_APP === "1"
  : IS_WINDOWS;
const DEFAULT_RELEASE_AFTER_TURN = process.env.CODEX_BRIDGE_RELEASE_AFTER_TURN
  ? process.env.CODEX_BRIDGE_RELEASE_AFTER_TURN === "1"
  : IS_WINDOWS;
const TERMINAL_TURN_STATUSES = new Set(["completed", "interrupted", "failed"]);
const RELEASE_TURN_STATUSES = TERMINAL_TURN_STATUSES;
const enforceFullAccess = fullAccessEnabled();
if (enforceFullAccess) {
  try {
    enableCodexFullAccess();
  } catch (error) {
    log(`Codex Full access repair failed: ${error.message}`);
  }
}
const security = new BridgeSecurityPolicy({
  ...process.env,
  ...(enforceFullAccess ? { CODEX_BRIDGE_ENFORCE_FULL_ACCESS: "1" } : {}),
});
const desktopTasksEnabled = desktopTasksConfigured();
const runtime = createRuntimeState({ configuration: desktopTasksConfigured });
const desktopOperation = new AsyncLocalStorage();
const replyReceipts = new DesktopReplyReceipts();
const desktopTasks = new DesktopTaskDelivery({ security, beforeRequest: beforeDesktopRequest, accountContext: () => desktopOperation.getStore()?.accounts, senderContext: () => desktopOperation.getStore()?.caller });

async function assertDesktopOperation(context, { verifyProcess = false } = {}) {
  if (!context || context.diagnostic) return;
  runtime.assertCurrent();
  const accounts = readBridgeAccounts();
  assertAccountIdentity(context.accounts, accounts);
  await assertClaudeSenderContext(context.caller, {
    account: accounts.claude,
    ...(!verifyProcess ? { readAncestry: async () => context.caller.lineage } : {}),
  });
  // Provisioning an explicitly selected new project must work before its grant
  // exists. Only these setup calls omit the scope check; identity/account checks
  // and every message/file operation retain their existing checks.
  if (!context.projectSetup && security.hardenedRoots.mode === "project-policy") security.hardenedRoots.assert(context.caller.cwd, "Claude sender working directory");
  assertAccountIdentity(context.accounts);
}

async function beforeDesktopRequest({ operation, args, phase }) {
  const context = desktopOperation.getStore();
  if (context?.diagnostic) return;
  if (!context) throw new Error("Desktop operations require a verified calling Code session.");
  const mutating = ["create_thread", "send_message_to_thread", "set_thread_title", "navigate_to_codex_page"].includes(operation);
  await assertDesktopOperation(context, { verifyProcess: mutating && phase === "write" });
  if (mutating && phase === "dispatch") {
    context.dispatched = true;
    if (args.threadId) context.threadId = args.threadId;
  }
}

function withheldDesktopResult(error, context) {
  if (context.dispatched) reload.defer("A Desktop operation was dispatched without a fully verified outcome");
  const reason = (error?.message ?? "The calling session or accounts could not be reverified.").replace(/\s*No message was sent\./g, "");
  return {
    ...textResult(`${reason} ${context.dispatched ? "A Desktop operation may already have been dispatched. Its original destination and any creation receipt were preserved." : "No Desktop mutation was dispatched."} Reply content was withheld. Inspect the original task and do not resend automatically.`, true),
    structuredContent: { accountContext: context.accounts, operation: { state: context.dispatched ? "dispatched_outcome_unverified" : "blocked", threadId: context.threadId ?? null } },
  };
}

const client = desktopTasksEnabled ? null : new CodexAppServerClient({
  clientInfo: { name: "codex-mcp-bridge", title: "Codex MCP Bridge", version: VERSION },
  log,
});

const reload = createReloadControl({
  entry: "index.mjs",
  inspect: () => desktopTasks.threadOperations.size ? "Desktop task operations are still active" : clientReloadReason(client),
  quiesce: () => { client?.close(); },
  exportState: () => ({ desktopTasksEnabled, ownedThreadIds: [...security.ownedThreadIds] }),
  restore: (state) => {
    assertRoutingReload(state.desktopTasksEnabled, desktopTasksEnabled);
    if (!Array.isArray(state.ownedThreadIds)
      || state.ownedThreadIds.some((id) => typeof id !== "string" || !id.trim())
      || new Set(state.ownedThreadIds).size !== state.ownedThreadIds.length) throw new Error("Invalid or incompatible Codex worker reload state");
    security.ownedThreadIds = new Set(state.ownedThreadIds);
  },
});

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const failure = (err) => textResult(`Codex bridge error: ${err?.message ?? String(err)}`, true);

function replyResult(delivered, deliveryId, result, notes = []) {
  result = { activity: [], errors: [], ...result };
  const pending = result.status === "timeout";
  const continuation = deliveryId ? `deliveryId: ${deliveryId}\n${pending ? "Continue automatically with wait_codex_reply and this deliveryId; it only observes the original send. Do not resend the prompt." : "Keep this deliveryId to inspect the same send after reconnecting."}` : "";
  return {
    ...textResult([...notes, formatTurn(result, { desktop: true }), continuation].filter(Boolean).join("\n"), result.status === "failed" || result.status === "systemError"),
    structuredContent: { ...result, threadId: delivered.threadId, deliveryStatus: result.responseStatus === "completed" || result.responseStatus === "completed_no_reply" ? "accepted" : delivered.deliveryStatus ?? "accepted", ...(deliveryId ? { deliveryId } : {}), nextAction: pending && deliveryId ? "wait_codex_reply" : "none" },
  };
}

/**
 * Decides whether this bridge may act on a thread, before anything acts on it.
 *
 * Under `roots` the answer depends on where the thread works, which only
 * `thread/read` reports - and it must be asked before `thread/resume`, because
 * resuming takes the per-thread writer lock away from whoever else has the
 * thread open. Reading first means a thread outside every root is refused
 * without ever being locked. A thread the bridge already owns or the operator
 * allowlisted skips the round-trip entirely: its answer cannot change.
 */
async function assertThreadAccess(threadId) {
  if (security.threadPolicy !== "roots" && security.isThreadAuthorized(threadId)) return null;
  if (security.threadPolicy !== "roots") {
    security.assertThread(threadId);
    return null;
  }
  const res = await client.call("thread/read", { threadId });
  const thread = normalizeThreadCwd(res?.thread ?? res ?? {}, { strict: true });
  security.assertThread(threadId, thread.cwd);
  security.assertCwd(thread.cwd);
  return thread;
}

function normalizeThreadCwd(thread, { strict = false } = {}) {
  if (!thread?.cwd) return thread;
  try {
    const workspace = resolveWorkspacePath(thread.cwd);
    return workspace.path === thread.cwd ? thread : { ...thread, cwd: workspace.path };
  } catch (err) {
    if (strict) throw err;
    return thread;
  }
}

function projectLabel(cwd) {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) || cwd;
}

function threadNameFor({ cwd, prompt, name }) {
  const explicit = name?.trim();
  if (explicit) return explicit.slice(0, 200);
  const summary = String(prompt ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return `[${projectLabel(cwd)}] ${(summary || "Claude delegation").replace(/\s+/g, " ").slice(0, 160)}`.slice(
    0,
    200,
  );
}

async function delegateDesktopTask({ cwd, prompt, name, requestId, model, effort, timeoutSec, openInApp, waitForReply = true }) {
  const deadline = desktopOperation.getStore()?.deadline ?? Date.now() + Math.min((timeoutSec ?? 40) * 1000, DESKTOP_TOOL_BUDGET_MS);
  const workspace = resolveWorkspacePath(cwd);
  const created = await desktopTasks.create({
    cwd: workspace.path, prompt, name: threadNameFor({ cwd: workspace.path, prompt, name }),
    dedupeName: name ?? "", requestId, model: model ?? DEFAULT_MODEL, effort: effort ?? DEFAULT_EFFORT, deadline,
    onPrepared: (delivered) => replyReceipts.create(delivered, desktopOperation.getStore()),
  });
  const deliveryId = created.deliveryId;
  let delivered = deliveryId ? replyReceipts.read(deliveryId, desktopOperation.getStore()) : null;
  if (delivered?.creationObservation) {
    const resolved = await desktopTasks.resolveCreation(delivered, { deadline });
    if (!resolved) return replyResult(delivered, deliveryId, { threadId: null, status: "timeout", responseStatus: "unavailable", text: "" }, ["Creation acknowledgement pending; do not create again."]);
    delivered = resolved;
    created.threadId = resolved.threadId;
  }
  const notes = [];
  if (workspace.note) notes.push(workspace.note);
  if (openInApp ?? DEFAULT_OPEN_IN_APP) {
    try {
      await desktopTasks.open(created.threadId, { deadline });
      notes.push(created.reused ? "opened the existing task in Codex Desktop" : "opened in Codex Desktop while the task runs");
    } catch (err) {
      notes.push(`${created.reused ? "existing task retained" : "task was accepted"}; opening its page failed: ${err.message}`);
    }
  }
  const lines = [
    created.reused ? "Reused the existing Codex Desktop task; the prompt was not resent" : "Delegated through Codex Desktop", `threadId: ${created.threadId}`, `name: ${created.name}`,
    ...(requestId ? [`requestId: ${requestId}`] : []),
    `cwd: ${created.cwd}`,
    ...(created.projectAssignmentStatus === "unverified"
      ? [`expected projectId: ${created.expectedProjectId}`, `expected project: ${created.expectedProjectName ?? "(unnamed)"}`, "project assignment: unverified", created.projectAssignmentNote]
      : [`projectId: ${created.projectId}`, `project: ${created.projectName ?? "(unnamed)"}`, ...(created.projectAssignmentStatus === "verified" ? ["project assignment: verified in Desktop's current listing"] : [])]),
    "permissions: Codex Desktop settings; no external app-server writer",
    ...(created.promptChanged ? [created.projectAssignmentStatus === "unverified"
      ? "The edited brief was not sent. Inspect this task's project assignment before continuing it."
      : "The edited brief was not sent. Continue the same unfinished work with send_to_codex_thread and this threadId. For independent new work, create a task with a fresh requestId; never change requestId merely to retry uncertain delivery."] : []), ...notes,
  ];
  if (created.projectAssignmentStatus === "unverified") return textResult([...lines, "status: existing task retained; project assignment needs inspection"].join("\n"));
  if (!waitForReply) return textResult([...lines, created.reused ? "status: existing task; read it to check its current progress" : "status: accepted; the task is running in Desktop", ...(deliveryId ? [`deliveryId: ${deliveryId}`, "Use wait_codex_reply with this deliveryId to observe the original creation without resending."] : [])].join("\n"));
  if (!delivered) return textResult([...lines, "The existing creation has no original reply binding. Inspect it without resending; a new binding cannot be inferred from a retry."].join("\n"));
  try {
    const result = await desktopTasks.wait(created.threadId, { timeoutMs: Math.max(0, deadline - Date.now()), previousTurnId: delivered.previousTurnId, responseObservation: delivered.responseObservation });
    return replyResult(delivered, deliveryId, result, lines);
  } catch (err) {
    if (Date.now() >= deadline && /deadline|timed out|within \d+ms/.test(err.message)) {
      return replyResult(delivered, deliveryId, { threadId: created.threadId, status: "timeout", responseStatus: "unavailable", text: "" }, lines);
    }
    return textResult([...lines, `Task was accepted; observation failed: ${err.message}`, `deliveryId: ${deliveryId}`, "Do not resend the prompt. Resolve the observation error, then use wait_codex_reply."].join("\n"), true);
  }
}

async function createCodexThread({ cwd, model, name, prompt }) {
  const workspace = resolveWorkspacePath(cwd);
  security.assertCwd(workspace.path);
  const res = await client.call("thread/start", {
    cwd: workspace.path,
    ...(model ?? DEFAULT_MODEL ? { model: model ?? DEFAULT_MODEL } : {}),
    approvalPolicy: security.approvalPolicy,
    sandbox: security.sandbox,
  });
  const thread = res?.thread ?? {};
  if (!thread.id) throw new Error("Codex app-server created no thread id");
  try {
    security.assertCwd(thread.cwd);
    if (!path.isAbsolute(thread.cwd) || path.relative(realpathSync(workspace.path), realpathSync(thread.cwd))) {
      throw new Error("Codex app-server created the thread in a different workspace than requested");
    }
  } catch (err) {
    await client.releaseThread(thread.id).catch(() => {});
    throw err;
  }
  const threadName = name || prompt ? threadNameFor({ cwd: thread.cwd ?? workspace.path, prompt, name }) : null;
  if (threadName) {
    await client.call("thread/name/set", { threadId: thread.id, name: threadName });
  }
  client.markAttached(thread.id, thread);
  security.registerThread(thread.id);
  return {
    threadId: thread.id,
    name: threadName ?? thread.name ?? "(unnamed)",
    cwd: thread.cwd ?? workspace.path,
    rollout: thread.path ?? "(not written yet)",
    workspace,
  };
}

async function finishDesktopHandoff({ threadId, result, openInApp, releaseAfterTurn }) {
  const notes = [];
  let canOpenAfterRelease = true;
  const terminal = TERMINAL_TURN_STATUSES.has(result.status);
  const releasable = RELEASE_TURN_STATUSES.has(result.status);

  if (releaseAfterTurn && releasable) {
    try {
      const released = await client.releaseThread(threadId);
      if (released.released) {
        notes.push(`released thread ${threadId}; other app-server threads remain active`);
      } else {
        canOpenAfterRelease = false;
        notes.push(released.unsubscribed
          ? `unsubscribed from thread ${threadId}; desktop opening is deferred until the server unloads it`
          : `could not release thread: ${released.reason ?? released.status}`);
      }
    } catch (err) {
      canOpenAfterRelease = false;
      notes.push(`could not release thread: ${err.message}`);
    }
  }

  if (openInApp && (terminal ? canOpenAfterRelease : !releaseAfterTurn)) {
    try {
      notes.push(`opened in Codex app: ${await openThreadInCodexApp(threadId)}`);
    } catch (err) {
      notes.push(`could not open the thread in the Codex app: ${err.message}`);
    }
  } else if (openInApp && releaseAfterTurn && !terminal) {
    notes.push(`desktop open deferred because the turn status is ${result.status}; release it after the turn finishes`);
  }

  return notes;
}

function formatThreadRow(t) {
  const title = t.title || t.name || (t.preview ?? "").replace(/\s+/g, " ").slice(0, 70) || "(no title)";
  const updated = t.updatedAt ? new Date(t.updatedAt * 1000).toISOString().replace("T", " ").slice(0, 16) : "?";
  const status = typeof t.status === "string" ? t.status : t.status?.type ?? "?";
  const deepLink = supportsCodexThreadLinks() ? `\n    open: ${codexThreadUrl(t.id)}` : "";
  const authorized = security.isThreadAuthorized(t.id, t.cwd)
    ? ""
    : "\n    NOT AUTHORIZED: add this id to CODEX_BRIDGE_ALLOWED_THREADS, or set " +
      "CODEX_BRIDGE_THREAD_POLICY=roots to reach every thread inside an allowed root";
  return `- ${t.id}\n    title: ${title}\n    cwd: ${t.cwd ?? "?"}\n    updated: ${updated}  status: ${status}  source: ${t.source ?? "?"}${deepLink}${authorized}`;
}

function formatTurn(result, { desktop = false } = {}) {
  const lines = [];
  lines.push(`thread: ${result.threadId}`);
  lines.push(`turn:   ${result.turnId ?? "?"}  status: ${result.status}`);
  if (result.durationMs != null) lines.push(`took:   ${Math.round(result.durationMs / 1000)}s`);
  if (result.activity.length) {
    const trail = result.activity.slice(-12).map((a) => {
      if (a.kind === "command") {
        const cmd = Array.isArray(a.command) ? a.command.join(" ") : a.command;
        return `  * run: ${String(cmd ?? "?").slice(0, 160)}${a.exitCode != null ? ` (exit ${a.exitCode})` : ""}`;
      }
      if (a.kind === "fileChange") return `  * edit: ${a.files.join(", ").slice(0, 200)}`;
      if (a.kind === "mcpToolCall") return `  * tool: ${a.server}/${a.tool}`;
      if (a.kind === "webSearch") return `  * search: ${a.query}`;
      return `  * ${a.kind}`;
    });
    lines.push(`activity (${result.activity.length} items, last ${trail.length}):`, ...trail);
  }
  if (result.errors.length) {
    lines.push(`errors: ${result.errors.map((e) => e.message ?? JSON.stringify(e)).join(" | ")}`);
  }
  if (result.responseStatus) lines.push(`response: ${result.responseStatus}`);
  if (result.assistantItems?.length) lines.push(`assistant item IDs: ${result.assistantItems.map((item) => item.id).join(", ")}`);
  if (result.replySha256) lines.push(`reply sha256: ${result.replySha256}`);
  if (result.observationStatus === "unavailable") lines.push(`response observation: unavailable${result.observationReason ? ` - ${result.observationReason}` : ""}`);
  lines.push("", "--- Codex reply ---", result.text || (result.observationStatus === "unavailable"
    ? "(assistant response unavailable; inspect the original Codex Desktop task and do not resend automatically)"
    : result.responseStatus === "completed_no_reply" ? "(the exact completed turn produced no assistant reply)" : "(no assistant text was produced)"));
  if (result.status === "timeout") {
    lines.push(
      "",
      "NOTE: the bridge stopped waiting; it did not pause or cancel the task.",
      desktop ? "Inspect the task in Codex Desktop; use its Stop button to stop the running turn. Do not resend the prompt." :
        `Read it later with read_codex_thread, or stop it with interrupt_codex_turn (turnId ${result.turnId}).`,
    );
  }
  if (result.status === "disconnected") {
    lines.push(
      "",
      "NOTE: the app-server connection dropped mid-turn - typically the machine slept, rebooted, or the",
      "Codex desktop app reclaimed the shared state. The turn may have kept running inside Codex.",
      `Reconnect happens on the next call: check with read_codex_thread (threadId ${result.threadId}).`,
    );
  }
  return lines.join("\n");
}

const server = new McpServer(
  { name: "codex-bridge", version: VERSION },
  {
    instructions:
      "Bridge Claude work into Codex. When the user requests a new conversation or has given standing authorization to create one for each independent task, " +
      "use delegate_to_codex or start_codex_thread with the initial prompt and a fresh requestId for each independent task or feature in Desktop mode, even in the same project. " +
      "In legacy app-server mode, use delegate_to_codex with the initial prompt and omit requestId; durable creation deduplication is unavailable there. " +
      "Reuse that requestId only for retries of that creation. Continue unfinished work, fixes, clarifications, and results in its verified original threadId with send_to_codex_thread. " +
      "A completed turn alone does not mean the task is finished. Do not choose an old task merely because its project matches or it was recently active. " +
      "Without authorization to create a new conversation, ask before creating it. With Desktop tasks enabled it assigns the exact saved project and starts visibly in " +
      "Codex Desktop using Desktop permissions. Otherwise it releases the bridge writer lock and opens the exact thread in " +
      "Codex Desktop. Desktop creation and sends always require the verified calling Claude task and the Codex destination to belong to the same project, even when cwd is omitted. " +
      "Use send_to_codex_thread only when an existing threadId is intentional; use " +
      "list_codex_threads or read_codex_thread to inspect sessions and codex_bridge_status to inspect wiring. " +
      "When a Desktop send returns nextAction=wait_codex_reply, continue observing with that tool and the returned deliveryId until completion, user input is required, or the user stops the task. Never resend to obtain a reply. Each observation is bounded, and the receipt survives reconnection. " +
      AGENT_PROMPT_GUIDANCE,
  },
);

function registerTool(name, definition, handler) {
  server.registerTool(name, definition, async (...args) => {
    try {
      return await reload.run(async () => {
      if (!definition.annotations?.readOnlyHint) runtime.assertCurrent();
      if (name === "codex_bridge_status") {
        const state = runtime.status();
        if (!state.current) return { ...failure(new Error(`${state.reason}; reconnect this MCP server in the existing task.`)), structuredContent: { runtime: state } };
        const accounts = desktopTasksEnabled ? readBridgeAccounts() : null;
        const result = await desktopOperation.run({ diagnostic: true, accounts: accountIdentity(accounts) }, () => handler(...args));
        result.content.push({ type: "text", text: `runtime pid: ${state.pid}\nloaded source: ${state.revision}\nruntime state: current` });
        result.structuredContent = { ...result.structuredContent, runtime: state };
        if (desktopTasksEnabled) {
          result.structuredContent.projectScope = { enabled: true, policy: "verified-sender-same-project", match: "canonical-directory-or-git-repository", checkedBeforeMutation: true };
          result.structuredContent.accounts = { claude: publicAccountState(accounts.claude), codex: publicAccountState(accounts.codex) };
        }
        return result;
      }
      if (desktopTasksEnabled) {
        const deadline = Date.now() + Math.min((args[0]?.timeoutSec ?? 40) * 1000, DESKTOP_TOOL_BUDGET_MS);
        const accounts = readBridgeAccounts();
        const identity = requireBridgeAccounts(accounts);
        const caller = requireClaudeSenderContext(await readClaudeSenderContext({ account: accounts.claude }));
        const context = { accounts: identity, caller, dispatched: false, deadline, projectSetup: PROJECT_SETUP_TOOLS.has(name) };
        return await desktopOperation.run(context, async () => {
          try {
            await assertDesktopOperation(context);
            const result = await handler(...args);
            await assertDesktopOperation(context);
            if (result.isError && !context.dispatched) {
              result.structuredContent = { ...result.structuredContent, accountContext: context.accounts, operation: { state: "blocked", threadId: context.threadId ?? null } };
            }
            return result;
          } catch (error) {
            return withheldDesktopResult(error, context);
          }
        });
      }
      return await handler(...args);
      });
    } catch (err) {
      return failure(err);
    }
  });
}

registerProjectOnboardingTools(registerTool, { beforePrepare: async () => {
  if (!desktopTasksEnabled || !desktopOperation.getStore()?.caller) throw new Error("Project onboarding requires a verified Desktop caller");
  await assertDesktopOperation(desktopOperation.getStore(), { verifyProcess: true });
} });

registerTool(
  "delegate_to_codex",
  {
    title: "Delegate work to a new Codex session",
    description:
      "Create a named Codex session at the requested project directory, send Claude's prompt into it, " +
      "return Codex's reply, and hand the session to Codex Desktop without leaving the bridge writer lock behind. " +
      "Use for independent new work when the user explicitly or through standing instructions authorizes new conversations. " +
      "Desktop creation returns a durable deliveryId; on timeout continue with wait_codex_reply instead of resending. In Desktop mode, supply a fresh requestId per independent task and keep it on retries; omit requestId in legacy app-server mode. Use send_to_codex_thread for unfinished work.",
    inputSchema: {
      cwd: z.string().describe("Absolute project directory where Codex must work"),
      requestId: z.string().uuid().optional().describe("Desktop creation identity: fresh UUID for each independent new task; retain exactly on retries. Omitting it preserves legacy title/prompt deduplication and can return an older task. Not supported in legacy app-server mode."),
      prompt: z.string().describe(`The complete task Claude is delegating to Codex. ${PROMPT_FIELD_HINT}`),
      name: z.string().min(1).max(200).optional().describe("Optional Codex session title; otherwise one is derived from the prompt"),
      timeoutSec: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe("How long to observe the task (Desktop caps the entire call, including creation, at 40s; the task continues and its threadId is returned)"),
      model: z.string().optional().describe("Model override, e.g. gpt-5.6-luna"),
      effort: z
        .enum(["minimal", "low", "medium", "high", "xhigh", "ultra"])
        .optional()
        .describe(`Override reasoning effort (default ${DEFAULT_EFFORT ?? "whatever ~/.codex/config.toml says"})`),
      openInApp: z
        .boolean()
        .optional()
        .describe("Show the task in Codex Desktop; native tasks open immediately while running"),
      releaseAfterTurn: z
        .boolean()
        .optional()
        .describe("Unsubscribe this thread after a terminal turn; open Desktop only after its unload is confirmed"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ cwd, prompt, name, requestId, timeoutSec, model, effort, openInApp, releaseAfterTurn }) => {
    const shouldOpen = openInApp ?? DEFAULT_OPEN_IN_APP;
    const shouldRelease = releaseAfterTurn ?? DEFAULT_RELEASE_AFTER_TURN;
    const notes = [];
    try {
      if (desktopTasksEnabled) return await delegateDesktopTask({ cwd, prompt, name, requestId, model, effort, timeoutSec, openInApp });
      if (requestId !== undefined) throw new Error("Creation requestId requires Desktop native delivery; legacy app-server mode cannot safely deduplicate this request. No task was created.");
      const created = await createCodexThread({ cwd, prompt, name, model });
      if (created.workspace.note) notes.push(created.workspace.note);
      if (shouldOpen && !shouldRelease) {
        try {
          notes.push(`opened in Codex app: ${await openThreadInCodexApp(created.threadId)}`);
        } catch (err) {
          notes.push(`could not open the thread in the Codex app: ${err.message}`);
        }
      }
      const result = await runTurn(client, {
        threadId: created.threadId,
        input: [{ type: "text", text: prompt }],
        timeoutMs: (timeoutSec ?? 240) * 1000,
        turnOverrides: {
          ...(model ?? DEFAULT_MODEL ? { model: model ?? DEFAULT_MODEL } : {}),
          ...(effort ?? DEFAULT_EFFORT ? { effort: effort ?? DEFAULT_EFFORT } : {}),
        },
      });
      notes.push(
        ...(await finishDesktopHandoff({
          threadId: created.threadId,
          result,
          openInApp: shouldOpen,
          releaseAfterTurn: shouldRelease,
        })),
      );
      const failed = result.status === "failed" || result.status === "disconnected";
      return textResult(
        [
          "Delegated to Codex",
          `threadId: ${created.threadId}`,
          `name:     ${created.name}`,
          `cwd:      ${created.cwd}`,
          `rollout:  ${created.rollout}`,
          ...notes,
          "",
          formatTurn(result),
        ].join("\n"),
        failed,
      );
    } catch (err) {
      return failure(err);
    }
  },
);

registerTool(
  "send_to_codex_thread",
  {
    title: "Send a prompt to a Codex thread",
    description:
      "Send a prompt as a new user turn inside an existing Codex thread and wait for Codex to answer. " +
      "Use only for the same unfinished task, including follow-up fixes, clarifications, or results; independent new work belongs in a new conversation when authorized. " +
      "The thread keeps its full history, cwd and model. Use list_codex_threads first if you do not know the threadId. " +
      "Desktop-owned tasks must use Desktop native delivery; an open task is a valid destination. " +
      "A Desktop send prepares a durable deliveryId before dispatch. An ambiguous acknowledgement is marked unconfirmed, never accepted without evidence. If it times out, continue automatically with wait_codex_reply using that ID; never resend to obtain the answer. " +
      "If legacy delivery reports an active writer, inspect codex_bridge_status and repair the native relay/configuration. " +
      "Do not close the task, create a replacement, or ask the user to copy the message manually.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id (UUID) - get it from list_codex_threads"),
      prompt: z.string().describe(`The message to send to Codex as a new user turn. ${PROMPT_FIELD_HINT}`),
      timeoutSec: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe("How long to observe the task (Desktop caps the entire call at 40s; the task continues and its threadId is returned)"),
      cwd: z.string().optional().describe("Expected destination directory; Desktop always checks the verified sender's project and cannot change the task's workspace"),
      model: z.string().optional().describe("Override the model for this turn"),
      effort: z
        .enum(["minimal", "low", "medium", "high", "xhigh", "ultra"])
        .optional()
        .describe(`Override reasoning effort (default ${DEFAULT_EFFORT ?? "whatever ~/.codex/config.toml says"})`),
      name: z.string().min(1).max(200).optional().describe("Optional title to show for this Codex session"),
      openInApp: z
        .boolean()
        .optional()
        .describe("Open the thread in Codex Desktop on Windows or macOS so a human can watch it live"),
      releaseAfterTurn: z
        .boolean()
        .optional()
        .describe("Unsubscribe this thread after a terminal turn; open Desktop only after its unload is confirmed"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ threadId, prompt, timeoutSec, cwd, model, effort, name, openInApp, releaseAfterTurn }) => {
    const deadline = desktopTasksEnabled ? desktopOperation.getStore()?.deadline ?? Date.now() + Math.min((timeoutSec ?? 40) * 1000, DESKTOP_TOOL_BUDGET_MS) : undefined;
    let acceptedDelivery;
    let deliveryId;
    return (desktopTasksEnabled ? desktopTasks : client).withThread(threadId, async () => {
      const notes = [];
      const shouldOpen = openInApp ?? DEFAULT_OPEN_IN_APP;
      const shouldRelease = releaseAfterTurn ?? DEFAULT_RELEASE_AFTER_TURN;
      try {
        if (desktopTasksEnabled) {
          const workspace = cwd ? resolveWorkspacePath(cwd) : null;
          if (workspace) security.assertCwd(workspace.path);
          const delivered = await desktopTasks.send({ threadId, prompt, cwd: workspace?.path, model: model ?? DEFAULT_MODEL, effort: effort ?? DEFAULT_EFFORT, name, deadline, onPrepared: (prepared) => {
            deliveryId = replyReceipts.create(prepared, desktopOperation.getStore());
            acceptedDelivery = prepared;
          } });
          acceptedDelivery = delivered;
          notes.push(delivered.deliveryStatus === "unconfirmed" ? "Desktop delivery acknowledgement timed out; delivery is unconfirmed. Continue observing this receipt; do not resend." : "sent through Codex Desktop; no external app-server writer", `cwd: ${delivered.cwd}`);
          if (delivered.deliveryStatus === "unconfirmed") return replyResult(delivered, deliveryId, { threadId, status: "timeout", responseStatus: "unavailable", text: "" }, notes);
          if (shouldOpen) {
            try {
              await desktopTasks.open(threadId, { deadline });
              notes.push("opened in Codex Desktop while the task runs");
            } catch (err) {
              notes.push(`task was accepted; opening its page failed: ${err.message}`);
            }
          }
          try {
            const result = await desktopTasks.wait(threadId, { timeoutMs: Math.max(0, deadline - Date.now()), previousTurnId: delivered.previousTurnId, responseObservation: delivered.responseObservation });
            return replyResult(delivered, deliveryId, result, notes);
          } catch (err) {
            return textResult([...notes, `threadId: ${threadId}`, `deliveryId: ${deliveryId}`, `Task was accepted; observation failed: ${err.message}. Do not resend. Use wait_codex_reply only after resolving the observation error.`].join("\n"), true);
          }
        }
        const authorizedThread = await assertThreadAccess(threadId);
        let resolvedCwd = null;
        if (cwd) {
          const workspace = resolveWorkspacePath(cwd);
          security.assertCwd(workspace.path);
          resolvedCwd = workspace.path;
          if (workspace.note) notes.push(workspace.note);
        } else if (authorizedThread?.cwd) {
          const workspace = resolveWorkspacePath(authorizedThread.cwd);
          resolvedCwd = workspace.path;
          if (workspace.note) notes.push(workspace.note);
        }
        const attached = await client.ensureThreadAttached(threadId, resolvedCwd ? { cwd: resolvedCwd } : {});
        const attachedThread = normalizeThreadCwd(attached.thread ?? authorizedThread, { strict: true });
        security.assertCwd(attachedThread?.cwd);
        if (name) {
          await client.call("thread/name/set", { threadId, name: name.trim().slice(0, 200) });
          notes.push(`session name: ${name.trim().slice(0, 200)}`);
        }
        /**
         * Opening the thread in the app comes after both gates. It ran first
         * once, which meant a thread this bridge was about to refuse still got
         * raised on screen - a refusal that leaked which threads exist.
         */
        if (shouldOpen && !shouldRelease) {
          try {
            notes.push(`opened in Codex app: ${await openThreadInCodexApp(threadId)}`);
          } catch (err) {
            notes.push(`could not open the thread in the Codex app: ${err.message}`);
          }
        }
        const result = await runTurn(client, {
          threadId,
          input: [{ type: "text", text: prompt }],
          timeoutMs: (timeoutSec ?? 240) * 1000,
          turnOverrides: {
            ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
            ...(model ?? DEFAULT_MODEL ? { model: model ?? DEFAULT_MODEL } : {}),
            ...(effort ?? DEFAULT_EFFORT ? { effort: effort ?? DEFAULT_EFFORT } : {}),
          },
        });
        const body = formatTurn(result);
        const failed = result.status === "failed" || result.status === "disconnected";
        notes.push(...(await finishDesktopHandoff({
          threadId,
          result,
          openInApp: shouldOpen,
          releaseAfterTurn: shouldRelease,
        })));
        const held = shouldOpen && !shouldRelease && client.holdsThread(threadId) ? writerLockWarning(threadId) : "";
        return textResult(`${notes.length ? `${notes.join("\n")}\n` : ""}${body}${held}`, failed);
      } catch (err) {
        if (acceptedDelivery?.deliveryStatus === "accepted") return textResult(`threadId: ${threadId}\nTask was accepted, but its reply receipt could not be prepared: ${err.message}. Inspect the existing task; do not resend.`, true);
        return failure(err);
      }
    }, {
      deadline,
      onDeadline(error) {
        if (!acceptedDelivery) throw error;
        return replyResult(acceptedDelivery, deliveryId, { threadId, status: "timeout", responseStatus: "unavailable", text: "" });
      },
    }).catch(failure);
  },
);

registerTool(
  "wait_codex_reply",
  {
    title: "Continue waiting for a Codex reply",
    description: "Continue a Desktop creation or send using its deliveryId; an unconfirmed acknowledgement does not prove delivery, including after MCP reconnect. Never sends a message or creates a task. On timeout, call again with the same deliveryId; do not ask the user to fetch the answer or resend. Stops for approval, user input or a verification error. Only the original verified Claude session and accounts can use the receipt.",
    inputSchema: {
      deliveryId: z.string().uuid().describe("Exact deliveryId returned by send_to_codex_thread, delegate_to_codex or start_codex_thread"),
      timeoutSec: z.number().int().min(1).max(40).optional().describe("Bounded observation time, default 40 seconds; repeat with the same receipt if still running"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ deliveryId }) => {
    if (!desktopTasksEnabled) return failure(new Error("Reply continuations require Desktop native delivery"));
    const context = desktopOperation.getStore();
    let delivered = replyReceipts.read(deliveryId, context);
    if (delivered.creationObservation) {
      const resolved = await desktopTasks.resolveCreation(delivered, { deadline: context.deadline });
      if (!resolved) return replyResult(delivered, deliveryId, { threadId: null, status: "timeout", responseStatus: "unavailable", text: "" });
      delivered = resolved;
    }
    const { threadId } = delivered;
    const expired = () => replyResult(delivered, deliveryId, { threadId, status: "timeout", responseStatus: "unavailable", text: "" });
    return desktopTasks.withThread(threadId, async () => {
      await desktopTasks.inspect(threadId, delivered.cwd, { deadline: context.deadline });
      const result = await desktopTasks.wait(threadId, { timeoutMs: Math.max(0, context.deadline - Date.now()), previousTurnId: delivered.previousTurnId, responseObservation: delivered.responseObservation });
      return replyResult(delivered, deliveryId, result);
    }, { deadline: context.deadline, onDeadline: expired });
  },
);

registerTool(
  "list_codex_threads",
  {
    title: "List Codex threads",
    description:
      "List recent Codex threads (id, title, cwd, last update, status) so you can pick the exact threadId to talk to.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("How many threads to return (default 15)"),
      cwd: z.string().optional().describe("Only threads whose session cwd matches this path exactly"),
      searchTerm: z.string().optional().describe("Substring filter on the thread title"),
      loadedOnly: z
        .boolean()
        .optional()
        .describe("Only threads currently loaded/live inside this app-server (default false)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ limit, cwd, searchTerm, loadedOnly }) => {
    try {
      if (desktopTasksEnabled) {
        const workspace = cwd ? resolveWorkspacePath(cwd) : null;
        const { rows, coverage } = await desktopTasks.list({ limit, cwd: workspace?.path, searchTerm, loadedOnly });
        return textResult(`${rows.length} Codex thread(s) via Codex Desktop:\n${coverage}\n\n${rows.length ? rows.map(formatThreadRow).join("\n") : "No matching authorized local Codex tasks in this snapshot."}`);
      }
      const params = { limit: limit ?? 15 };
      if (cwd) {
        const workspace = resolveWorkspacePath(cwd);
        security.assertCwd(workspace.path);
        params.cwd = { paths: [workspace.path] };
      }
      if (searchTerm) params.searchTerm = searchTerm;
      const method = loadedOnly ? "thread/loaded/list" : "thread/list";
      const rows = [];
      const seenIds = new Set();
      const seenCursors = new Set();
      let cursor;
      do {
        const res = await client.call(method, loadedOnly ? { limit: params.limit, ...(cursor ? { cursor } : {}) } : params);
        let threads = res?.data ?? res?.threads ?? [];
        if (loadedOnly) {
          threads = await Promise.all(threads.map(async (threadId) => {
            if (seenIds.has(threadId)) return null;
            seenIds.add(threadId);
            try {
              const read = await client.call("thread/read", { threadId });
              return read?.thread ?? null;
            } catch {
              return null;
            }
          }));
        }
        rows.push(...security.filterThreads(threads.flatMap((thread) => {
          try {
            const normalized = normalizeThreadCwd(thread, { strict: true });
            if (loadedOnly && params.cwd && (!normalized?.cwd || path.relative(params.cwd.paths[0], normalized.cwd))) return [];
            if (loadedOnly && searchTerm && !String(normalized?.name ?? normalized?.preview ?? "").toLowerCase().includes(searchTerm.toLowerCase())) return [];
            return [normalized];
          } catch {
            return [];
          }
        })));
        cursor = res?.nextCursor;
        if (!loadedOnly || !cursor || seenCursors.has(cursor)) break;
        seenCursors.add(cursor);
      } while (rows.length < params.limit);
      rows.splice(params.limit);
      if (!rows.length) {
        return textResult(
          security.summary().allowedRoots.length
            ? "No Codex threads matched inside the allowed workspace roots."
            : "No workspace roots are configured, so no thread can be listed. Set CODEX_BRIDGE_ALLOWED_ROOTS to one or more project directories.",
          !security.summary().allowedRoots.length,
        );
      }
      return textResult(
        `${rows.length} Codex thread(s) via ${client.url}:\n\n${rows.map(formatThreadRow).join("\n")}`,
      );
    } catch (err) {
      return failure(err);
    }
  },
);

registerTool(
  "start_codex_thread",
  {
    title: "Start a new Codex thread",
    description: "Start a new Codex task when the user explicitly or through standing instructions authorizes a new conversation for independent work. In Desktop mode include the initial prompt and a fresh requestId to create and assign a visible task atomically; keep requestId unchanged on retries. Continue unfinished work with send_to_codex_thread and its original threadId. Use delegate_to_codex to also wait for its reply.",
    inputSchema: {
      cwd: z.string().describe("Absolute working directory for the new Codex session"),
      requestId: z.string().uuid().optional().describe("Desktop creation identity: fresh UUID per independent task, same UUID on retries. Omit only for legacy title/prompt deduplication. Not supported in legacy app-server mode."),
      prompt: z.string().min(1).optional().describe(`Initial task; required with CODEX_BRIDGE_DESKTOP_TASKS=1, starts immediately. ${PROMPT_FIELD_HINT}`),
      model: z.string().optional().describe("Model override, e.g. gpt-5.6-luna"),
      name: z.string().min(1).max(200).optional().describe("Optional title to show for the new Codex session"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ cwd, model, name, prompt, requestId }) => {
    try {
      if (desktopTasksEnabled) {
        if (!prompt?.trim()) throw new Error("Desktop task creation requires the initial prompt. Use delegate_to_codex, or pass prompt to start_codex_thread. No task was created.");
        return await delegateDesktopTask({ cwd, model, name, prompt, requestId, waitForReply: false });
      }
      if (requestId !== undefined) throw new Error("Creation requestId requires Desktop native delivery; legacy app-server mode cannot safely deduplicate this request. No task was created.");
      if (prompt) throw new Error("Use delegate_to_codex to send an initial prompt in app-server mode.");
      const created = await createCodexThread({ cwd, model, name });
      return textResult(
        [
          "Created Codex thread",
          `  threadId: ${created.threadId}`,
          `  name: ${created.name}`,
          `  cwd: ${created.cwd}`,
          `  rollout: ${created.rollout}`,
          ...(created.workspace.note ? [`  note: ${created.workspace.note}`] : []),
        ].join("\n"),
      );
    } catch (err) {
      return failure(err);
    }
  },
);

registerTool(
  "read_codex_thread",
  {
    title: "Read a Codex thread",
    description: "Read a Codex thread without sending anything. In Desktop mode, pass the exact turnId returned by send_to_codex_thread for authoritative assistant item IDs, text, and reply hash; without turnId the native recent-history view may omit items.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id"),
      turnId: z.string().optional().describe("Exact turn id to inspect authoritatively in Codex Desktop mode"),
      limit: z.number().int().min(1).max(50).optional().describe("How many recent messages to show (default 10)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ threadId, turnId, limit }) => {
    try {
      if (desktopTasksEnabled) {
        const deadline = desktopOperation.getStore()?.deadline ?? Date.now() + DESKTOP_TOOL_BUDGET_MS;
        if (turnId) {
          const response = await desktopTasks.inspectNativeTurn(threadId, turnId, undefined, { deadline });
          return textResult(JSON.stringify(response, null, 2), response.status === "unavailable");
        }
        await desktopTasks.inspect(threadId, undefined, { deadline });
        const response = await desktopTasks.request("read_thread", { threadId, hostId: "local", turnLimit: Math.min(limit ?? 10, 10) }, { deadline });
        return textResult(JSON.stringify(response, null, 2));
      }
      await assertThreadAccess(threadId);
      const res = await client.call("thread/read", { threadId, includeTurns: true });
      const thread = normalizeThreadCwd(res?.thread ?? res ?? {}, { strict: true });
      security.assertCwd(thread.cwd);
      const items = (thread.turns ?? []).flatMap((t) => t.items ?? []);
      const msgs = items
        .filter((i) => i?.type === "agentMessage" || i?.type === "userMessage")
        .slice(-(limit ?? 10))
        .map((i) => {
          const body =
            i.type === "userMessage"
              ? (i.content ?? [])
                  .map((c) => (c.type === "text" ? c.text : `<${c.type}>`))
                  .join(" ")
              : (i.text ?? "");
          return `[${i.type === "userMessage" ? "user" : "codex"}] ${body.trim()}`;
        });
      const header = `thread ${threadId}\n  title: ${thread.name ?? "(unnamed)"}\n  cwd: ${thread.cwd ?? "?"}\n  status: ${thread.status?.type ?? "?"}`;
      return textResult(msgs.length ? `${header}\n\n${msgs.join("\n\n")}` : `${header}\n\n(no messages found)`);
    } catch (err) {
      return failure(err);
    }
  },
);

registerTool(
  "interrupt_codex_turn",
  {
    title: "Interrupt a Codex turn",
    description: "Stop a turn that is still running in a Codex thread.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id"),
      turnId: z.string().describe("Turn id reported by send_to_codex_thread"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ threadId, turnId }) => {
    try {
      if (desktopTasksEnabled) {
        await desktopTasks.inspect(threadId);
        return textResult("This task is owned by Codex Desktop. Use its Stop button; the separate app-server cannot interrupt a Desktop turn.", true);
      }
      await assertThreadAccess(threadId);
      const res = await client.call("thread/read", { threadId });
      const thread = normalizeThreadCwd(res?.thread ?? res ?? {}, { strict: true });
      security.assertCwd(thread.cwd);
      await client.call("turn/interrupt", { threadId, turnId });
      return textResult(`Interrupted turn ${turnId} in thread ${threadId}.`);
    } catch (err) {
      return failure(err);
    }
  },
);

registerTool(
  "open_codex_thread",
  {
    title: "Open a Codex thread in the desktop app",
    description:
      "Bring a Codex thread to the front on Windows or macOS using (codex://threads/<id>) " +
      "so a human can watch the work live instead of reading the transcript afterwards.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id"),
      background: z
        .boolean()
        .optional()
        .describe("Open without stealing focus from the current app (default false)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ threadId, background }) => {
    try {
      if (desktopTasksEnabled) {
        const deadline = desktopOperation.getStore()?.deadline ?? Date.now() + DESKTOP_TOOL_BUDGET_MS;
        await desktopTasks.inspect(threadId, undefined, { deadline });
        if (background) {
          await beforeDesktopRequest({ operation: "navigate_to_codex_page", args: { threadId }, phase: "write" });
          await openThreadInCodexApp(threadId, { activate: false });
        }
        else await desktopTasks.open(threadId, { deadline });
        return textResult(`Opened ${codexThreadUrl(threadId)} in Codex Desktop.`);
      }
      await assertThreadAccess(threadId);
      const res = await client.call("thread/read", { threadId });
      const thread = normalizeThreadCwd(res?.thread ?? res ?? {}, { strict: true });
      security.assertCwd(thread.cwd);
      const url = await openThreadInCodexApp(threadId, { activate: !background });
      const held = client.holdsThread(threadId) ? writerLockWarning(threadId) : "";
      return textResult(`Opened ${url} in the Codex desktop app.${held}`);
    } catch (err) {
      return textResult(`${err.message}`, true);
    }
  },
);

registerTool(
  "stop_codex_app_server",
  {
    title: "Stop the shared Codex app-server",
    description:
      "Stop the shared app-server this bridge talks to. Use it when work is handed off and the Codex desktop " +
      "app is open: two app-servers on the same ~/.codex state make the app stutter. The bridge starts a new " +
      "one automatically the next time it needs it.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      if (desktopTasksEnabled) return textResult("Desktop-only mode does not manage an external app-server. Codex Desktop and its running tasks were left unchanged.");
      const result = await client.stopServer();
      if (result.stillListening) {
        return textResult("The app-server is still listening after the stop request; its thread writer locks are not confirmed released.", true);
      }
      return textResult(
        result.stopped
          ? `Stopped the shared app-server (pid ${result.pids.join(", ")}). Its thread writer locks are released, so the Codex desktop app now owns ~/.codex and every thread it was holding.`
          : `Nothing to stop: ${result.reason}.`,
      );
    } catch (err) {
      return failure(err);
    }
  },
);

registerTool(
  "codex_bridge_status",
  {
    title: "Check the Codex bridge environment",
    description:
      "Report how this bridge is wired on the current machine: platform, resolved codex binary, " +
      "app-server endpoint and whether it is live, plus desktop deep-link support and macOS integrations.",
    inputSchema: { cwd: z.string().optional().describe("Optional intended target project directory to check before sending; does not grant access") },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ cwd }) => {
    const summary = security.summary();
    if (desktopTasksEnabled) {
      const native = await desktopTasks.status();
      const sender = await readClaudeSenderContext({ account: readBridgeAccounts().claude });
      const readiness = bridgeReadiness({ sender, scope: security.hardenedRoots.mode === "project-policy" ? security.hardenedRoots : { assert: (candidate) => { security.assertCwd(candidate); return candidate; } }, targetCwd: cwd, nativeAvailable: native.available, verifyTargetProject: captureProjectScope });
      return { ...textResult([
        `platform:       ${PLATFORM_LABEL} (${process.platform}/${process.arch})`,
        `bridge version: ${VERSION}`,
        `node:           ${process.version} at ${process.execPath}`,
        "desktop tasks:  enabled; Desktop permissions, exact saved project, immediate visibility",
        "project scope:  verified Claude sender; same directory or Git repository, checked before each mutation",
        `native relay:   ${native.available ? "available; verified through Codex Desktop" : "unavailable"}`,
        `native endpoint: ${native.socketPath}`,
        ...(native.available ? [`local projects: ${native.localProjects}`] : [`reason: ${native.reason}`]),
        "app-server:     disabled in Desktop-only mode; no external endpoint is contacted",
        "autostart:      off; external app-server fallback is disabled",
        `security:       thread policy ${security.threadPolicy}, ${summary.allowAllRoots ? "all directories" : `${summary.allowedRoots.length} allowed root(s)`}; task permissions belong to Codex Desktop`,
        `claude desktop config: ${claudeDesktopConfigPath()}`,
        `sender context: ${sender.status}${sender.taskId ? `; task ${sender.taskId}` : ""}`,
        ...(readiness.projectPolicy ? [`project policy: ${readiness.projectPolicy.file}; revision ${readiness.projectPolicy.revision ?? "unavailable"}; changes apply on the next operation`] : []),
        ...(readiness.target ? [`target: ${readiness.target.cwd}; authorized=${readiness.target.authorized}${readiness.target.authorizedBy ? `; via ${readiness.target.authorizedBy.kind} ${readiness.target.authorizedBy.path}` : ""}`] : []),
        ...readiness.issues.map((issue) => `${issue.code}: ${issue.detail ?? ""} ${issue.action}`),
      ].join("\n"), !readiness.ready), structuredContent: { readiness, projectScope: { enabled: true, policy: "verified-sender-same-project", match: "canonical-directory-or-git-repository", checkedBeforeMutation: true } } };
    }
    const up = await client.isServerUp();
    let liveThreads = null;
    if (up) {
      try {
        const res = await client.call("thread/loaded/list", { limit: 20 });
        liveThreads = (res?.data ?? res?.threads ?? []).length;
      } catch {
        liveThreads = null;
      }
    }
    const lines = [
      `platform:       ${PLATFORM_LABEL} (${process.platform}/${process.arch})`,
      `bridge version: ${VERSION}`,
      `node:           ${process.version} at ${process.execPath}`,
      `codex binary:   ${client.codexBin}`,
      `defaults:       model ${DEFAULT_MODEL ?? "(from ~/.codex/config.toml)"}, effort ${DEFAULT_EFFORT ?? "(from ~/.codex/config.toml)"}`,
      `app-server:     ${client.url} - ${up ? "live" : "not reachable"}`,
      `autostart:      ${client.autoStart ? "on" : "off"}   approvals: ${client.approval}`,
      `desktop links:  ${supportsCodexThreadLinks() ? "codex:// available" : "not available on this platform"}`,
      `security:       thread policy ${security.threadPolicy} (${summary.allowAllThreads ? "all threads" : `${summary.authorizedThreads} pre-authorized thread(s)`}), ${summary.allowAllRoots ? "all directories" : `${summary.allowedRoots.length} allowed root(s)`}, sandbox ${security.sandbox}, approvals ${security.approvalPolicy}`,
      `desktop tasks:  ${desktopTasksEnabled ? "enabled; Desktop permissions, exact saved project, immediate visibility" : "disabled; app-server permissions (enable CODEX_BRIDGE_DESKTOP_TASKS=1 to use Desktop permissions)"}`,
      `live threads:   ${liveThreads ?? "(unknown)"}`,
      `claude desktop config: ${claudeDesktopConfigPath()}`,
    ];
    if (IS_MACOS) {
      const desktopServer = isDesktopAppServerRunning();
      lines.push(
        `codex desktop app:     ${hasCodexDesktopApp() ? "installed (codex:// deep links available)" : "not installed"}`,
        `desktop app-server:    ${desktopServer ? "running (its own stdio server)" : "not running"}`,
        `launchd agent:         ${isLaunchAgentInstalled() ? `installed at ${launchAgentPath()}` : "not installed"}`,
      );
      if (desktopServer && isLaunchAgentInstalled()) {
        lines.push(
          "",
          "WARNING: the desktop app-server and the launchd app-server both hold the sqlite state in ~/.codex.",
          "That contention makes the Codex app stutter. Keep only one alive:",
          "  node scripts/install-launch-agent.mjs --uninstall   # let the desktop app own it",
        );
      }
    }
    if (!up) {
      lines.push(
        "",
        `Start one with: ${client.codexBin} app-server --listen ${client.url}`,
      );
    }
    return textResult(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
let shutdownPromise;
const shutdown = () => shutdownPromise ??= (async () => {
  client?.close();
  await server.close();
  await stopProcessInspectors();
})();
process.stdin.once("end", () => { void shutdown().catch((error) => log(`shutdown failed: ${error.message}`)); });
process.once("disconnect", () => { void shutdown().catch((error) => log(`shutdown failed: ${error.message}`)); });
reload.listen();
log(desktopTasksEnabled ? `ready on ${PLATFORM_LABEL} (Codex Desktop only; external app-server disabled)` : `ready on ${PLATFORM_LABEL} (app-server endpoint: ${client.url}, codex: ${client.codexBin})`);
