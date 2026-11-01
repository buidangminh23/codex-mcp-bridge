import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isMainModule } from "./install-paths.mjs";
import { callBackgroundRelay } from "./background-relay-client.mjs";
import { withBridgeDiagnostic } from "./recipient-preflight.mjs";

export const BACKGROUND_WORKER_GUIDANCE = "For explicitly authorized work that must run with Desktop apps closed or frozen, use worker_status, send_to_worker and read_worker_delivery for separate background CLI workers. These tools have independent identities and project authorization; they never open, resume or impersonate a Desktop chat. Keep native task IDs on native tools. Never replay an uncertain native send through a worker. Show diagnostic codes and report blocks in the current chat when a relay call fails. ";

export function registerBackgroundTools(register, { env = process.env, call = callBackgroundRelay } = {}) {
  const titles = { worker_status: "Inspect background relay", list_workers: "List background workers", send_to_worker: "Send work to a background agent", read_worker_delivery: "Read background delivery" };
  const tool = (name, description, inputSchema, readOnly, method) => register(name, { title: titles[name], description, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly } }, async args => {
    try {
      const result = await call(method, args, { env, timeoutMs: method === "read" ? ((args.waitSec ?? 0) + 10) * 1000 : 15000 });
      const failed = result.status === "failed" || result.status === "unknown";
      const response = { ...(failed ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      return failed ? withBridgeDiagnostic(response, { diagnostic: result.diagnostic, message: "The independent background worker did not complete successfully" },
        { component: "background-relay", operation: name, requestId: result.requestId, deliveryState: result.deliveryState }) : response;
    } catch (error) {
      return withBridgeDiagnostic({ isError: true, content: [] }, error, { component: "background-relay", operation: name,
        requestId: args.requestId, readOnly: readOnly && method !== "read" });
    }
  });
  tool("worker_status", "Inspect the independent background relay, CLI readiness and recent diagnostic reports. Desktop apps may be closed or frozen. Transport readiness is separate from each CLI's authentication/model readiness.", {}, true, "status");
  tool("list_workers", "List independently identified CLI workers and this caller's background task receipts. These are separate from Desktop chats; never use a native chat ID as a worker destination.", {}, true, "list");
  tool("send_to_worker", "Queue explicitly authorized work to a separate background CLI worker in an explicitly selected, authorized project. This does not address, open or resume any Desktop chat. Generate requestId once and keep it for retries; an uncertain result must be inspected with read_worker_delivery, never resent under another ID. Use worker-relay tools for subsequent cross-agent delegation. Work continues independently when Desktop apps close or freeze.", {
    agent: z.enum(["codex", "claude", "antigravity"]).describe("The separate CLI agent that will perform this authorized task."),
    cwd: z.string().min(1).describe("Absolute path to the explicitly selected and authorized project."),
    prompt: z.string().min(1).max(262144).describe("Complete authorized task brief, including context, scope, constraints and completion criteria. Never request a Desktop chat substitution."),
    requestId: z.string().uuid().describe("Generate once for this independent task and reuse for retries; inspect this ID after any uncertain delivery."),
  }, false, "send");
  tool("read_worker_delivery", "Read or wait for a durable background task receipt using its original requestId. A queued receipt is not a completed response. Failed and unknown receipts include the report block to show directly in this chat. Unknown work is never automatically replayed.", {
    requestId: z.string().uuid().describe("The original request ID returned by send_to_worker."),
    waitSec: z.number().int().min(0).max(60).optional().describe("Maximum seconds to wait for a terminal receipt; zero returns immediately."),
  }, true, "read");
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const server = new McpServer({ name: "worker-relay", version }, { instructions: BACKGROUND_WORKER_GUIDANCE + "Preserve request IDs, poll receipts until a terminal result, and never replay uncertain work. Delegate only authorized work in the same project. Native account logins and CLI logins are separate readiness checks; never copy credentials or open apps/chats to recover the relay." });
  registerBackgroundTools(server.registerTool.bind(server));
  await server.connect(new StdioServerTransport());
}
