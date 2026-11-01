import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isMainModule } from "./install-paths.mjs";
import { callBackgroundRelay } from "./background-relay-client.mjs";
import { withBridgeDiagnostic } from "./recipient-preflight.mjs";

export function registerBackgroundTools(register, { env = process.env, call = callBackgroundRelay } = {}) {
  const tool = (name, description, inputSchema, readOnly, method) => register(name, { description, inputSchema,
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
    agent: z.enum(["codex", "claude", "antigravity"]), cwd: z.string().min(1), prompt: z.string().min(1).max(262144), requestId: z.string().uuid(),
  }, false, "send");
  tool("read_worker_delivery", "Read or wait for a durable background task receipt using its original requestId. A queued receipt is not a completed response. Failed and unknown receipts include the report block to show directly in this chat. Unknown work is never automatically replayed.", {
    requestId: z.string().uuid(), waitSec: z.number().int().min(0).max(60).optional(),
  }, true, "read");
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const server = new McpServer({ name: "worker-relay", version }, { instructions: "This relay owns separate CLI background workers. It does not impersonate or resume Desktop chats and does not need Desktop hosts. Show diagnostic codes and report blocks when a tool fails. Preserve request IDs, poll receipts until a terminal result, and never replay uncertain work. Delegate only authorized work in the same project. Native account logins and CLI logins are separate readiness checks; never copy credentials or open apps/chats to recover the relay." });
  registerBackgroundTools(server.registerTool.bind(server));
  await server.connect(new StdioServerTransport());
}
