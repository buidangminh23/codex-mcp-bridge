#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveAntigravitySenderContext } from "./antigravity-sender-context.mjs";
import { createAntigravityOutboundTargets } from "./antigravity-outbound-targets.mjs";
import { AntigravityDeliveries } from "./antigravity-deliveries.mjs";
import { antigravityBridgeDirectory } from "./antigravity-ipc.mjs";
import { createHardenedRootPolicy } from "./hardened-root-policy.mjs";
import { stopProcessInspectors } from "./claude-sender-context.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { assertAccountIdentity } from "./bridge-account-context.mjs";

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const targetSchema = { target: z.enum(["codex", "claude"]) };
const taskSchema = { ...targetSchema, conversationId: z.string().uuid(), taskId: z.string().min(1).max(256).optional() };

export function createAntigravityOutboundBridge({ resolveSender = resolveAntigravitySenderContext, targets = createAntigravityOutboundTargets(), deliveries = new AntigravityDeliveries(path.join(antigravityBridgeDirectory(), "outbound-deliveries")), rootPolicy = createHardenedRootPolicy() } = {}) {
  const server = new McpServer({ name: "agent-bridge", version }, { instructions: "Send user-authorized work FROM the current Antigravity Desktop conversation to an exact existing Codex Desktop task or Claude Desktop Code session in the same project. Use list_agent_tasks first, verify title and identity, then send_to_agent_task with a fresh requestId. Keep requestId after uncertainty and read_agent_delivery; never automatically resend. Native permissions and sender identity are verified on every call. Do not launch a CLI substitute, impersonate Codex/Claude, or change permissions to overcome a rejection. Native acceptance is not task completion; read_agent_task for Codex or read_agent_delivery for a Claude reply. Independent new work requires a separate native conversation; this bridge only continues existing tasks. Agent-authored handoffs must be in English and name Antigravity as the author." });

  function scope(expected, actual) {
    if (!path.isAbsolute(expected) || !path.isAbsolute(actual)) throw new Error("An absolute project directory is required");
    const canonical = fs.realpathSync.native(expected);
    if (path.relative(canonical, fs.realpathSync.native(actual))) throw new Error("Destination must match the verified Antigravity sender's project");
    rootPolicy.assert(canonical, "Antigravity sender project");
    return canonical;
  }

  async function sender(extra) {
    const identity = await resolveSender(extra?._meta);
    if (identity.status !== "verified" || identity.provider !== "antigravity" || !identity.id || !["bypass", "prompting"].includes(identity.mode)) throw new Error(identity.reason ?? "Antigravity sender is not verified");
    scope(identity.cwd, identity.cwd);
    return identity;
  }

  function recheck(identity, extra) {
    return async () => {
      const current = await sender(extra);
      if (JSON.stringify(current) !== JSON.stringify(identity)) throw Object.assign(new Error("Antigravity sender identity or permissions changed before delivery"), { deliveryState: "not_sent" });
    };
  }

  function register(name, description, inputSchema, readOnly, handler) {
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly } }, async (args, extra) => {
      try { return result(await handler(args, extra)); }
      catch (error) { return { ...result({ error: error.message, deliveryState: error.deliveryState ?? "not_sent" }), isError: true }; }
    });
  }

  register("agent_bridge_status", "Check this Antigravity caller's native identity and outbound bridge capabilities without sending work.", {}, true, async (_, extra) => {
    const identity = await resolveSender(extra?._meta);
    const metadataFields = Object.fromEntries(Object.entries(extra?._meta ?? {}).filter(([key]) => key.startsWith("antigravity.google/")).map(([key, value]) => [key, Array.isArray(value) ? "array" : typeof value]));
    return { version, sender: identity, metadataFields, targets: ["codex-desktop", "claude-desktop"], permissions: "native-unchanged", createsConversations: false };
  });

  register("list_agent_tasks", "List exact existing native tasks in this Antigravity conversation's project before selecting a destination.", targetSchema, true, async (args, extra) => {
    const identity = await sender(extra);
    return targets.list({ ...args, sender: identity, beforeSend: recheck(identity, extra) });
  });

  register("send_to_agent_task", "Continue an exact existing Codex or Claude Desktop task with authorized work. Preserve requestId across retries; inspect the durable receipt.", { ...taskSchema, requestId: z.string().uuid(), cwd: z.string().min(1), prompt: z.string().min(1).max(30000) }, false, async (args, extra) => {
    const identity = await sender(extra);
    const cwd = scope(identity.cwd, args.cwd);
    if (args.prompt.includes("\0")) throw new Error("Prompt must not contain NUL");
    const prompt = `[From Antigravity Desktop · ${path.basename(cwd)} · Authorized task handoff]\n[Source conversation: ${identity.id}]\n\n${args.prompt}`;
    return deliveries.dispatch({ ...args, cwd, surface: args.target, sender: { provider: identity.provider, id: identity.id }, prompt }, async () => {
      await recheck(identity, extra)();
      const sent = await targets.send({ ...args, cwd, prompt, sender: identity, ...(args.target === "codex" ? { threadId: args.conversationId } : { sessionId: args.conversationId }), beforeSend: recheck(identity, extra) });
      return { ...sent, completed: false };
    });
  });

  register("read_agent_delivery", "Read an owned delivery without resending. Accepted or pending does not prove a completed response.", { requestId: z.string().uuid() }, true, async ({ requestId }, extra) => {
    const identity = await sender(extra);
    const record = deliveries.read(requestId);
    if (!record || record.sender?.provider !== "antigravity" || record.sender.id !== identity.id) throw new Error("Delivery does not belong to this Antigravity conversation");
    scope(identity.cwd, record.cwd);
    if (record.result?.accountContext) assertAccountIdentity(record.result.accountContext);
    if (record.surface === "claude" && record.result?.msgId) {
      try {
        return { ...record, nativeReceipt: await targets.read({ target: "claude", msgId: record.result.msgId, sender: identity, beforeSend: recheck(identity, extra) }) };
      } catch (error) {
        if (error.code !== "ANTIGRAVITY_NATIVE_RECEIPT_UNAVAILABLE") throw error;
        return { ...record, nativeReceipt: null, recovery: "The original native receipt is unavailable. Inspect the exact Claude Desktop task before further action; do not resend.", receiptError: error.message };
      }
    }
    return record;
  });

  register("read_agent_task", "Read the exact destination task's current native state and available response in the same project.", taskSchema, true, async (args, extra) => {
    const identity = await sender(extra);
    return targets.read({ ...args, cwd: identity.cwd, sender: identity, ...(args.target === "codex" ? { threadId: args.conversationId } : { sessionId: args.conversationId }), beforeSend: recheck(identity, extra) });
  });

  return { server, close: async () => { await targets.close(); await server.close(); } };
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
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop(); });
  process.stdin.once("end", () => { void stop(); });
  await bridge.server.connect(new StdioServerTransport());
}
