#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveAntigravitySenderContext } from "./antigravity-sender-context.mjs";
import { createAntigravityOutboundTargets } from "./antigravity-outbound-targets.mjs";
import { AntigravityDeliveries, antigravityDeliveryError } from "./antigravity-deliveries.mjs";
import { antigravityBridgeDirectory } from "./antigravity-ipc.mjs";
import { createHardenedRootPolicy } from "./hardened-root-policy.mjs";
import { stopProcessInspectors } from "./claude-sender-context.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { BACKGROUND_WORKER_GUIDANCE, registerBackgroundTools } from "./background-relay-mcp.mjs";
import { assertAccountIdentity } from "./bridge-account-context.mjs";
import { bridgeDiagnostic, withBridgeDiagnostic, preflightFailure } from "./recipient-preflight.mjs";
import { createReloadControl, exitWhenClientCloses } from "./reload-control.mjs";

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}) });
const targetSchema = { target: z.enum(["codex", "claude"]) };
const taskSchema = { ...targetSchema, conversationId: z.string().uuid(), taskId: z.string().min(1).max(256).optional() };

export function createAntigravityOutboundBridge({ resolveSender = resolveAntigravitySenderContext, targets = createAntigravityOutboundTargets(), deliveries = new AntigravityDeliveries(path.join(antigravityBridgeDirectory(), "outbound-deliveries")), rootPolicy = createHardenedRootPolicy(), env = process.env, channel = process } = {}) {
  const reload = createReloadControl({
    entry: "antigravity-outbound-bridge.mjs", env, channel,
    inspect: () => deliveries.active.size ? "Antigravity outbound deliveries are still active" : targets.reloadReason?.() ?? null,
    quiesce: () => targets.quiesce(),
    exportState: () => ({ directory: deliveries.directory, targets: targets.exportReloadState() }),
    restore: (state) => {
      if (typeof state.directory !== "string" || path.relative(state.directory, deliveries.directory)) throw new Error("Antigravity durable receipt directory changed during reload");
      targets.restoreReloadState(state.targets);
    },
    activate: () => targets.activate(),
  });
  const server = new McpServer({ name: "agent-bridge", version }, { instructions: "Send user-authorized work FROM the current Antigravity Desktop conversation to an exact existing Codex Desktop task or Claude Desktop Code session in the same project. Use list_agent_tasks first, verify title and identity, then send_to_agent_task with a fresh requestId. Keep requestId after uncertainty and read_agent_delivery; never automatically resend. Native permissions and sender identity are verified on every call. Do not launch a CLI substitute for a native task, impersonate Codex/Claude, or change permissions to overcome a rejection. Native acceptance is not task completion; read_agent_task for Codex or read_agent_delivery for a Claude reply. Independent new native work requires a separate native conversation; native handoff tools only continue existing tasks. Never use Computer Use, open an old chat, or create an empty, new, or error chat to load or recover a relay. Report the structured diagnostic when a native relay or session is unavailable. Agent-authored handoffs must be in English and name Antigravity as the author. " + BACKGROUND_WORKER_GUIDANCE });

  registerBackgroundTools((name, config, handler) => server.registerTool(name, config, async (args, extra) => {
    try { return await reload.run(() => handler(args, extra)); }
    catch (error) {
      return withBridgeDiagnostic({ isError: true, content: [] }, error, { component: "agent-bridge", operation: name, requestId: args.requestId, readOnly: config.annotations?.readOnlyHint === true });
    }
  }), { env });

  function scope(expected, actual) {
    try {
      if (!path.isAbsolute(expected) || !path.isAbsolute(actual)) throw new Error("An absolute project directory is required");
      const canonical = fs.realpathSync.native(expected);
      if (path.relative(canonical, fs.realpathSync.native(actual))) throw new Error("Destination must match the verified Antigravity sender's project");
      rootPolicy.assert(canonical, "Antigravity sender project");
      return canonical;
    } catch (error) {
      error.code ??= "ANTIGRAVITY_PROJECT_SCOPE_INVALID";
      error.phase ??= "scope";
      error.deliveryState = "not_sent";
      throw error;
    }
  }

  async function sender(extra) {
    let identity;
    try {
      identity = await resolveSender(extra?._meta);
      if (identity.status !== "verified" || identity.provider !== "antigravity" || !identity.id || !["bypass", "prompting"].includes(identity.mode)) throw new Error(identity.reason ?? "Antigravity sender is not verified");
    } catch (error) {
      error.code ??= "ANTIGRAVITY_SENDER_UNVERIFIED";
      error.phase ??= "sender";
      error.deliveryState = "not_sent";
      throw error;
    }
    scope(identity.cwd, identity.cwd);
    return identity;
  }

  function recheck(identity, extra) {
    return async () => {
      const current = await sender(extra);
      if (JSON.stringify(current) !== JSON.stringify(identity)) throw preflightFailure("ANTIGRAVITY_SENDER_CHANGED", "Antigravity sender identity or permissions changed before delivery");
    };
  }

  function register(name, description, inputSchema, readOnly, handler) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly } }, async (args, extra) => {
      const options = { component: "agent-bridge", operation: name, requestId: args.requestId, conversationId: args.conversationId, readOnly };
      try {
        const value = await reload.run(() => handler(args, extra));
        const failure = antigravityDeliveryError(value);
        if (failure) return withBridgeDiagnostic({ ...result(value), isError: true }, failure, { ...options, readOnly: false, msgId: value.result?.msgId });
        if (value?.diagnostic && (value.nativeReceipt === null || value.sender?.status !== "verified")) return withBridgeDiagnostic({ ...result(value), isError: true }, { diagnostic: value.diagnostic }, options);
        return result(value);
      } catch (error) {
        const diagnostic = bridgeDiagnostic(error, options);
        return withBridgeDiagnostic({ ...result({ error: diagnostic.reason, code: diagnostic.code, deliveryState: error.deliveryState ?? diagnostic.deliveryState }), isError: true }, { diagnostic }, options);
      }
    });
  }

  register("agent_bridge_status", "Check this Antigravity caller's native identity and outbound bridge capabilities without sending work.", {}, true, async (_, extra) => {
    const identity = await resolveSender(extra?._meta);
    const metadataFields = Object.fromEntries(Object.entries(extra?._meta ?? {}).filter(([key]) => key.startsWith("antigravity.google/")).map(([key, value]) => [key, Array.isArray(value) ? "array" : typeof value]));
    const diagnostic = identity.status === "verified" ? null : bridgeDiagnostic(Object.assign(new Error(identity.reason ?? "Antigravity sender is not verified"), { code: "ANTIGRAVITY_SENDER_UNVERIFIED", phase: "sender" }), { component: "agent-bridge", operation: "agent_bridge_status", readOnly: true });
    return { version, sender: identity, metadataFields, targets: ["codex-desktop", "claude-desktop"], permissions: "native-unchanged", createsConversations: false, ...(diagnostic ? { diagnostic } : {}) };
  });

  register("list_agent_tasks", "List exact existing native tasks in this Antigravity conversation's project before selecting a destination. Dormant Claude tasks remain unavailable until their native session is already connected.", targetSchema, true, async (args, extra) => {
    const identity = await sender(extra);
    return targets.list({ ...args, sender: identity, beforeSend: recheck(identity, extra) });
  });

  register("send_to_agent_task", "Continue an exact existing Codex or connected Claude Desktop task with authorized work. Unavailable native sessions produce a diagnostic without opening chats; native permissions remain unchanged. Preserve requestId across retries; inspect the durable receipt.", { ...taskSchema, requestId: z.string().uuid(), cwd: z.string().min(1), prompt: z.string().min(1).max(30000) }, false, async (args, extra) => {
    const identity = await sender(extra);
    const cwd = scope(identity.cwd, args.cwd);
    if (args.prompt.includes("\0")) throw preflightFailure("ANTIGRAVITY_PROMPT_INVALID", "Prompt must not contain NUL");
    const prompt = `[From Antigravity Desktop · ${path.basename(cwd)} · Authorized task handoff]\n[Source conversation: ${identity.id}]\n\n${args.prompt}`;
    return deliveries.dispatch({ ...args, cwd, surface: args.target, sender: { provider: identity.provider, id: identity.id }, prompt }, async () => {
      await recheck(identity, extra)();
      const sent = await targets.send({ ...args, cwd, prompt, sender: identity, ...(args.target === "codex" ? { threadId: args.conversationId } : { sessionId: args.conversationId }), beforeSend: recheck(identity, extra) });
      return { ...sent, completed: false };
    }, { component: "agent-bridge", operation: "send_to_agent_task" });
  });

  register("read_agent_delivery", "Read an owned delivery without resending. Accepted or pending does not prove a completed response.", { requestId: z.string().uuid() }, true, async ({ requestId }, extra) => {
    const identity = await sender(extra);
    const record = deliveries.read(requestId);
    if (!record || record.sender?.provider !== "antigravity" || record.sender.id !== identity.id) throw preflightFailure("ANTIGRAVITY_RECEIPT_OWNER_MISMATCH", "Delivery does not belong to this Antigravity conversation");
    scope(identity.cwd, record.cwd);
    if (record.result?.accountContext) assertAccountIdentity(record.result.accountContext);
    if (record.surface === "claude" && record.result?.msgId) {
      try {
        return { ...record, nativeReceipt: await targets.read({ target: "claude", msgId: record.result.msgId, sender: identity, beforeSend: recheck(identity, extra) }) };
      } catch (error) {
        if (error.code !== "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE") throw error;
        const diagnostic = bridgeDiagnostic(error, { component: "agent-bridge", operation: "read_agent_delivery", phase: "receipt", readOnly: true, requestId, msgId: record.result.msgId, conversationId: record.conversationId });
        return { ...record, nativeReceipt: null, recovery: "The original native receipt is unavailable. Report the diagnostic before further action; do not resend or open a chat to load the relay.", receiptError: diagnostic.reason, diagnostic: record.diagnostic ?? diagnostic, receiptDiagnostic: diagnostic };
      }
    }
    return record;
  });

  register("read_agent_task", "Read the exact destination task's current native state and available response in the same project.", taskSchema, true, async (args, extra) => {
    const identity = await sender(extra);
    return targets.read({ ...args, cwd: identity.cwd, sender: identity, ...(args.target === "codex" ? { threadId: args.conversationId } : { sessionId: args.conversationId }), beforeSend: recheck(identity, extra) });
  });

  reload.listen();
  return { server, reload, busy: () => deliveries.active.size ? "Antigravity outbound deliveries are still active" : null, close: async () => { await targets.close(); await server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitForVersionRequest(import.meta.url);
  const bridge = createAntigravityOutboundBridge();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.close();
    await stopProcessInspectors();
  };
  await bridge.server.connect(new StdioServerTransport());
  const shutdown = exitWhenClientCloses({ busy: bridge.busy, stop });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown.close(signal); });
}
