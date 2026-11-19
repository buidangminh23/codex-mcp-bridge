import { createHash } from "node:crypto";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { withBridgeDiagnostic } from "./recipient-preflight.mjs";

const uuid = z.string().uuid();
const requestId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).describe("A fresh v4 UUID for independent work. Keep it unchanged after any uncertain delivery.");
const waitSec = z.number().int().min(0).max(45).optional().describe("Seconds to observe the delivery, up to 45. Set to zero to return its current status immediately.");
export const FLEET_SESSION_TOOLS = ["send_to_fleet_session", "read_fleet_session_delivery"];

export function fleetSender(agent, identity, account) {
  const id = agent === "claude" ? identity.sessionId : agent === "codex" ? identity.threadId : identity.id;
  if (identity.status !== "verified" || !uuid.safeParse(id).success || !["bypass", "prompting"].includes(identity.mode)) {
    throw Object.assign(new Error("The native caller's session and current permission class must be verified."), { code: "FLEET_SENDER_UNVERIFIED" });
  }
  let binding = account;
  if (agent === "antigravity") {
    if (!uuid.safeParse(identity.projectId).success || !identity.permissionFingerprint || identity.surface !== "desktop") {
      throw Object.assign(new Error("The calling Antigravity Desktop project and permission settings must be verified."), { code: "FLEET_SENDER_UNVERIFIED" });
    }
    const user = os.userInfo();
    binding = createHash("sha256").update(JSON.stringify(["antigravity-desktop", user.uid, user.username, user.homedir, identity.projectId, id])).digest("hex");
  }
  if (typeof binding !== "string" || !/^[a-f0-9]{64}$/.test(binding)) {
    throw Object.assign(new Error("The native caller's identity binding is unavailable."), { code: "FLEET_SENDER_UNVERIFIED" });
  }
  const sender = { agent, id, cwd: identity.cwd, host: os.hostname(), account: binding, mode: identity.mode };
  return { sender, proof: agent === "claude" ? [identity.pid, identity.processStart, identity.taskId, identity.permissionMode]
    : agent === "codex" ? [identity.turnId, identity.approvalPolicy, identity.permissionProfile, identity.approvalsReviewer, identity.review]
    : [identity.projectId, identity.permissionFingerprint] };
}

export function registerFleetSessionTools(register, { identify, loadRouter = () => import("./fleet-session-routing.mjs") }) {
  function tool(name, title, description, inputSchema, readOnly) {
    register(name, { title, description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: true } }, async (args, extra) => {
      let started = false;
      try {
        const original = await identify(extra);
        const checkSender = async () => {
          if (!isDeepStrictEqual(await identify(extra), original)) throw Object.assign(new Error("The originating session or its permissions changed. The result was withheld."),
            { code: "FLEET_SENDER_CHANGED", deliveryState: started ? "unknown" : "not_sent" });
        };
        const { sendFleetSession, readFleetSession } = await loadRouter();
        const { waitSec, ...route } = args;
        const deadline = Date.now() + (waitSec ?? (readOnly ? 20 : 10)) * 1000;
        const origin = { sender: original.sender, checkSender, requestId: args.requestId };
        await checkSender();
        started = !readOnly;
        let receipt = readOnly ? await readFleetSession(origin) : await sendFleetSession({ ...route, ...origin });
        while (receipt?.requestId === args.requestId && receipt.status === "running" && Date.now() < deadline && !extra?.signal?.aborted) {
          await delay(Math.min(1500, deadline - Date.now()), undefined, { signal: extra?.signal });
          await checkSender();
          receipt = await readFleetSession(origin);
        }
        await checkSender();
        if (receipt?.requestId !== args.requestId || !["running", "completed", "uncertain", "failed"].includes(receipt.status)) {
          throw Object.assign(new Error("The returned receipt did not match this handoff."), { code: "FLEET_RECEIPT_INVALID" });
        }
        const failed = ["uncertain", "failed"].includes(receipt.status);
        return { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt, ...(failed ? { isError: true } : {}) };
      } catch (error) {
        if (started && !error.deliveryState) error.deliveryState = "unknown";
        return withBridgeDiagnostic({ isError: true, content: [] }, error, { component: "fleet-session", operation: name, requestId: args.requestId, readOnly });
      }
    });
  }
  tool(FLEET_SESSION_TOOLS[0], "Send work to an AI session on another computer", "Send authorized work to an existing AI session in this project on another configured computer. The bridge verifies the originating chat. Leave host and agent automatic, or specify the desired receiving computer, AI and exact session. A running receipt is pending; continue reading it in this originating chat until completed. Never repeat an uncertain send with a new requestId.", {
    requestId,
    prompt: z.string().min(1).max(30000).describe("The authorized instructions and expected result for the receiving AI session."),
    host: z.string().min(1).max(64).optional().describe("Configured destination computer name. Omit or use auto to let the router choose an eligible computer."),
    agent: z.enum(["auto", "claude", "codex", "antigravity"]).optional().describe("Receiving AI provider. Omit or use auto to allow any eligible provider."),
    sessionId: uuid.optional().describe("Exact native session ID when the work must go to a specific conversation. Omit for automatic session selection."),
    waitSec,
  }, false);
  tool(FLEET_SESSION_TOOLS[1], "Read the reply from a remote AI session", "Read or wait for the reply to an earlier cross-machine handoff in the original sending conversation. Keep reading a running receipt with its original requestId. The completed output is returned directly to this conversation.", {
    requestId: requestId.describe("The original request ID used to send this work from the current conversation."), waitSec,
  }, true);
}
