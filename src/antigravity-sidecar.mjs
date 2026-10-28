#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { antigravityBridgeDirectory, serveAntigravityDesktop } from "./antigravity-ipc.mjs";
import { AntigravityDeliveries } from "./antigravity-deliveries.mjs";
import { listAntigravityConversations, runAgentApi, sanitizeAntigravityMetadata } from "./antigravity-desktop.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";

export async function startAntigravitySidecar({ directory = antigravityBridgeDirectory(), env = process.env } = {}) {
  if (!env.ANTIGRAVITY_AGENTAPI_EXE || !env.ANTIGRAVITY_LS_ADDRESS) throw new Error("Antigravity must launch this sidecar. Do not run it as a replacement app server.");
  const deliveries = new AntigravityDeliveries(path.join(directory, "desktop-deliveries"));
  const sending = new Set();
  return serveAntigravityDesktop(async (request) => {
    if (!request || typeof request !== "object") throw new Error("Invalid sidecar request");
    if (request.operation === "status") return { available: true, transport: "native-agentapi", permissionPolicy: "native-unchanged" };
    if (request.operation === "list") return listAntigravityConversations({ surface: "desktop" });
    if (request.operation === "read") {
      const records = await listAntigravityConversations({ surface: "desktop" });
      const record = records.find((item) => item.conversationId === request.conversationId);
      if (!record) throw new Error("Exact Antigravity Desktop conversation not found");
      const native = sanitizeAntigravityMetadata(await runAgentApi({ command: "metadata", conversationId: request.conversationId, env }), request.conversationId);
      return { ...record, ...native };
    }
    if (request.operation === "receipt") return deliveries.read(request.requestId);
    if (request.operation !== "send" || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 30000 || request.prompt.includes("\0")
      || typeof request.cwd !== "string" || !path.isAbsolute(request.cwd) || !request.sender || !["codex", "claude"].includes(request.sender.provider)
      || typeof request.sender.id !== "string" || !request.sender.id) throw new Error("Invalid Antigravity delivery request");
    return deliveries.dispatch({ requestId: request.requestId, surface: "desktop", conversationId: request.conversationId, cwd: request.cwd, sender: request.sender, prompt: request.prompt }, async () => {
      if (sending.has(request.conversationId)) throw Object.assign(new Error("Another delivery is pending for this conversation"), { deliveryState: "not_sent" });
      sending.add(request.conversationId);
      try { return await runAgentApi({ command: "send", conversationId: request.conversationId, expectedCwd: request.cwd, prompt: request.prompt, env }); }
      finally { sending.delete(request.conversationId); }
    });
  }, { directory });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitForVersionRequest(import.meta.url);
  const sidecar = await startAntigravitySidecar();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void sidecar.close().then(() => process.exit(0)); });
}
