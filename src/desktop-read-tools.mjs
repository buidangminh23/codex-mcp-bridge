import { createHash } from "node:crypto";
import { z } from "zod";
import { DESKTOP_TOOL_BUDGET_MS } from "./thread-delivery.mjs";
import { captureProjectScope, recheckProjectScope } from "./project-scope.mjs";
import { ResponseSnapshots, responsePreferencesSchema, normalizeResponsePreferences, projectHistory, projectReply, assertResponseResultSize } from "./response-preferences.mjs";

export function registerDesktopReadTools(registerTool, {
  desktopTasksEnabled, desktopTasks, replyReceipts, security, client,
  context: operationContext, assertOperation,
  assertThreadAccess, normalizeThreadCwd, textResult, replyResult, failure,
}) {
  const snapshots = new ResponseSnapshots();
  const invalid = (message) => Object.assign(new Error(message), { code: "INVALID_RESPONSE_PREFERENCES" });
  const receiptHash = (delivered) => createHash("sha256").update(JSON.stringify(delivered)).digest("hex");
  const binding = (operation) => {
    const { accounts, caller } = operationContext();
    return { operation, accounts, caller: { sessionId: caller.sessionId, taskId: caller.taskId, cwd: caller.cwd } };
  };
  const selector = (values) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));

  async function authorize(auth, deliveryId) {
    const context = operationContext();
    await assertOperation(context);
    if (deliveryId && receiptHash(replyReceipts.read(deliveryId, context)) !== auth.receiptHash) {
      throw new Error("Reply observation binding changed; cached content was withheld");
    }
    if (auth.projectScope) recheckProjectScope(auth.projectScope);
    if (auth.scopeBinding) security.hardenedRoots.recheck(auth.scopeBinding);
    if (auth.threadId) {
      const current = await desktopTasks.inspect(auth.threadId, auth.cwd, { deadline: context.deadline });
      if (auth.projectScope) recheckProjectScope(auth.projectScope, current.projectScope);
      if (auth.scopeBinding) security.hardenedRoots.recheck(auth.scopeBinding);
    }
    await assertOperation(context);
  }

  async function authorization(threadId, cwd, deliveryId, originalReceipt) {
    const inspected = threadId ? await desktopTasks.inspect(threadId, cwd, { deadline: operationContext().deadline }) : null;
    return { threadId, cwd: inspected?.thread.cwd ?? cwd, projectScope: inspected?.projectScope ?? captureProjectScope(operationContext().caller.cwd, cwd),
      scopeBinding: inspected?.scopeBinding ?? (security.hardenedRoots?.mode === "project-policy" ? security.hardenedRoots.capture(cwd) : undefined), ...(deliveryId ? { receiptHash: receiptHash(originalReceipt) } : {}) };
  }

  async function continuation(preferences, owner, selection, deliveryId) {
    const cached = snapshots.inspect(preferences, owner, selection);
    await authorize(cached.authorization, deliveryId);
    const result = snapshots.continue({ preferences, binding: owner, selection });
    await authorize(cached.authorization, deliveryId);
    return result;
  }

  async function respond({ preferences, owner, selection, metadata, items, auth, deliveryId }) {
    await authorize(auth, deliveryId);
    const result = snapshots.respond({ preferences, binding: owner, selection, metadata, items, authorization: auth });
    await authorize(auth, deliveryId);
    return result;
  }

  async function preferredRead({ threadId, turnId, limit, responsePreferences }) {
    const owner = binding("read_codex_thread");
    const selection = selector({ threadId, turnId, limit });
    if (responsePreferences.delivery?.options?.cursor) return continuation(responsePreferences, owner, selection);
    const preferences = normalizeResponsePreferences(responsePreferences);
    const auth = await authorization(threadId);
    const deadline = operationContext().deadline;
    if (turnId) {
      const response = await desktopTasks.inspectNativeTurn(threadId, turnId, auth.cwd, { deadline });
      const { assistantItems, text, ...metadata } = response;
      return respond({ preferences, owner, selection: { ...selection, limit: limit ?? 10 }, auth,
        metadata: { ...metadata, threadId, turnId, turnStatus: response.turnStatus ?? (["completed", "completed_no_reply"].includes(response.status) ? "completed" : null) },
        items: projectReply(assistantItems ?? [], turnId) });
    }
    const response = await desktopTasks.request("read_thread", { threadId, hostId: "local", turnLimit: Math.min(limit ?? 10, 10), includeOutputs: preferences.filter.includeToolPayloads, maxOutputCharsPerItem: 16000 }, { deadline });
    const projected = projectHistory(response.turns ?? [], preferences.filter);
    return respond({ preferences, owner, selection: { ...selection, limit: limit ?? 10 }, auth,
      metadata: { threadId, turnId: response.turns?.[0]?.id ?? null, turnStatus: response.turns?.[0]?.status ?? null,
        turns: projected.turns, sourceHasMore: response.page?.hasMore ?? Boolean(response.page?.nextCursor), omissions: projected.omissions },
      items: projected.items });
  }

  async function preferredWait({ deliveryId, timeoutSec, responsePreferences }) {
    const owner = binding("wait_codex_reply");
    const selection = { deliveryId };
    if (responsePreferences.delivery?.options?.cursor) {
      if (timeoutSec !== undefined) throw invalid("A cursor reads a snapshot; omit timeoutSec on continuation");
      return continuation(responsePreferences, owner, selection, deliveryId);
    }
    const preferences = normalizeResponsePreferences(responsePreferences);
    const context = operationContext();
    const originalReceipt = replyReceipts.read(deliveryId, context);
    let delivered = originalReceipt;
    // Leave time for the live authorization checks after observation.
    const remaining = Math.max(0, context.deadline - Date.now());
    const observationDeadline = context.deadline - Math.min(1000, Math.floor(remaining / 4));
    const timeout = () => ({ threadId: delivered.threadId, status: "timeout", responseStatus: "unavailable", text: "" });
    if (delivered.creationObservation) {
      delivered = await desktopTasks.resolveCreation(delivered, { deadline: observationDeadline }) ?? delivered;
    }
    const auth = await authorization(delivered.threadId, delivered.cwd, deliveryId, originalReceipt);
    const finish = async (result) => {
      const { text, assistantItems, activity, ...metadata } = result;
      return respond({ preferences, owner, selection, auth, deliveryId,
        metadata: { ...metadata, threadId: delivered.threadId, turnId: result.turnId ?? null,
          turnStatus: ["completed", "interrupted", "failed"].includes(result.status) ? result.status : null, deliveryId,
          deliveryStatus: ["completed", "completed_no_reply"].includes(result.responseStatus) ? "accepted" : delivered.deliveryStatus ?? "accepted",
          nextAction: result.status === "timeout" ? "wait_codex_reply" : "none" },
        items: projectReply(assistantItems ?? [], result.turnId) });
    };
    if (!delivered.threadId || Date.now() >= observationDeadline) return finish(timeout());
    const result = await desktopTasks.withThread(delivered.threadId, () => desktopTasks.wait(delivered.threadId, {
      timeoutMs: Math.max(0, observationDeadline - Date.now()), previousTurnId: delivered.previousTurnId,
      responseObservation: delivered.responseObservation,
    }), { deadline: observationDeadline, onDeadline: timeout });
    return finish(result);
  }
registerTool(
  "wait_codex_reply",
  {
    title: "Continue waiting for a Codex reply",
    description: "Continue a Desktop creation or send using its deliveryId; an unconfirmed acknowledgement does not prove delivery, including after MCP reconnect. Never sends a message or creates a task. On timeout, call again with the same deliveryId; do not ask the user to fetch the answer or resend. Stops for approval, user input or a verification error. Only the original verified Claude session and accounts can use the receipt.",
    inputSchema: {
      responsePreferences: responsePreferencesSchema.optional().describe("Opt in to versioned filtered responses and cursor delivery; omitted preserves existing behavior. Inspect the returned envelope and follow nextCursor with the same tool and selector."),
      deliveryId: z.string().uuid().describe("Exact deliveryId returned by send_to_codex_thread, delegate_to_codex or start_codex_thread"),
      timeoutSec: z.number().int().min(1).max(40).optional().describe("Bounded observation time, default 40 seconds; repeat with the same receipt if still running"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ deliveryId, timeoutSec, responsePreferences }) => {
    if (responsePreferences !== undefined) {
      try {
        if (!desktopTasksEnabled) throw invalid("responsePreferences requires Desktop native delivery");
        return await preferredWait({ deliveryId, timeoutSec, responsePreferences });
      } catch (error) { return failure(error); }
    }
    if (!desktopTasksEnabled) return failure(new Error("Reply continuations require Desktop native delivery"));
    const context = operationContext();
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
  "read_codex_thread",
  {
    title: "Read a Codex thread",
    description: "Read a Codex thread without sending anything. In Desktop mode, pass the exact turnId returned by send_to_codex_thread for authoritative assistant item IDs, text, and reply hash; without turnId the native recent-history view may omit items.",
    inputSchema: {
      responsePreferences: responsePreferencesSchema.optional().describe("Opt in to versioned filtered responses and cursor delivery; omitted preserves existing behavior. Inspect the returned envelope and follow nextCursor with the same tool and selector."),
      threadId: z.string().describe("Codex thread id"),
      turnId: z.string().optional().describe("Exact turn id to inspect authoritatively in Codex Desktop mode"),
      limit: z.number().int().min(1).max(50).optional().describe("How many recent messages to show (default 10)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ threadId, turnId, limit, responsePreferences }) => {
    try {
      if (responsePreferences !== undefined) {
        if (!desktopTasksEnabled) throw invalid("responsePreferences requires Desktop native delivery");
        return await preferredRead({ threadId, turnId, limit, responsePreferences });
      }
      if (desktopTasksEnabled) {
        const deadline = operationContext()?.deadline ?? Date.now() + DESKTOP_TOOL_BUDGET_MS;
        if (turnId) {
          const response = await desktopTasks.inspectNativeTurn(threadId, turnId, undefined, { deadline });
          return assertResponseResultSize(textResult(JSON.stringify(response, null, 2), response.status === "unavailable"));
        }
        await desktopTasks.inspect(threadId, undefined, { deadline });
        const response = await desktopTasks.request("read_thread", { threadId, hostId: "local", turnLimit: Math.min(limit ?? 10, 10), includeOutputs: false, maxOutputCharsPerItem: 2000 }, { deadline });
        return assertResponseResultSize(textResult(JSON.stringify(response, null, 2)));
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
}
