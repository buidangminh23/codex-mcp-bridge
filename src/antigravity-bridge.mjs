#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveCodexSenderContext } from "./codex-sender-context.mjs";
import { readClaudeSenderContext, requireClaudeSenderContext, stopProcessInspectors } from "./claude-sender-context.mjs";
import { readClaudeAccountContext } from "./desktop-account-context.mjs";
import { createHardenedRootPolicy } from "./hardened-root-policy.mjs";
import { antigravityBridgeDirectory, callAntigravityDesktop } from "./antigravity-ipc.mjs";
import { AntigravityDeliveries } from "./antigravity-deliveries.mjs";
import { AntigravityCliSession } from "./antigravity-cli.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { NativeDesktopRelay, desktopTaskSocketPath, accountRelaySocketPath } from "./native-relay.mjs";
import { requireBridgeAccounts, readBridgeAccounts, assertAccountIdentity } from "./bridge-account-context.mjs";

exitForVersionRequest(import.meta.url);

const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const rootPolicy = createHardenedRootPolicy();
const directory = antigravityBridgeDirectory();
const deliveries = new AntigravityDeliveries(path.join(directory, "cli-deliveries"));
const sessions = new Map();
let startingSessions = 0;
const caller = process.env.ANTIGRAVITY_BRIDGE_CALLER;
const senderRelay = new NativeDesktopRelay({ socketPath: desktopTaskSocketPath(), accountSocketPath: accountRelaySocketPath() });
const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const schema = { requestId: z.string().uuid(), cwd: z.string().min(1), prompt: z.string().min(1).max(65536) };

async function sender(extra) {
  if (caller === "codex") {
    const context = await resolveCodexSenderContext(extra?._meta, { inspectDesktopTask: async (threadId) => {
      const accounts = requireBridgeAccounts(readBridgeAccounts());
      const { result } = await senderRelay.requestDesktop("read_thread", { threadId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 }, { accountContext: accounts, beforeSend: () => assertAccountIdentity(accounts) });
      assertAccountIdentity(accounts);
      return { thread: result?.thread, latestTurnId: result?.turns?.[0]?.id ?? null };
    } });
    if (context.status !== "verified") throw new Error(context.reason ?? "Unverified Codex sender");
    return { provider: "codex", id: context.threadId, cwd: context.cwd };
  }
  if (caller === "claude") {
    const context = requireClaudeSenderContext(await readClaudeSenderContext({ account: readClaudeAccountContext() }));
    return { provider: "claude", id: context.sessionId, cwd: context.cwd };
  }
  throw new Error("Install this bridge for Codex or Claude; unknown callers cannot read conversations or send work");
}

function sameCwd(expected, actual) {
  if (!path.isAbsolute(expected) || !path.isAbsolute(actual)) throw new Error("Expected an absolute project directory");
  const left = fs.realpathSync.native(expected);
  const right = fs.realpathSync.native(actual);
  if (path.relative(left, right)) throw new Error("Antigravity destination must match the verified sender's project directory");
  rootPolicy.assert(left, "Antigravity project");
  return left;
}

function owns(record, identity) {
  if (!record || record.sender?.provider !== identity.provider || record.sender?.id !== identity.id) throw new Error("Delivery does not belong to this sending conversation");
  sameCwd(identity.cwd, record.cwd);
  return record;
}

function handoff(prompt, identity) {
  return `[Agent handoff from ${identity.provider} conversation ${identity.id}. Native Antigravity permissions remain in effect.]\n\n${prompt}`;
}

const server = new McpServer({ name: "antigravity-bridge", version }, { instructions: "Send authorized work to Antigravity Desktop through its native sidecar or to an explicitly created CLI streaming session. Always select the requested surface; never substitute CLI for Desktop. The exact destination directory must match the verified sending conversation. Desktop delivery acceptance is not an agent reply. CLI sessions are bridge-owned headless sessions, not attached interactive terminals. Preserve requestId across retries and read_antigravity_delivery after pending or unknown outcomes; never resend automatically. Native tool approvals remain in force. Do not claim support for Antigravity-origin handoffs into Codex or Claude; this server receives from those hosts." });

function register(name, description, inputSchema, readOnly, handler) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly } }, async (args, extra) => {
    try { return result(await handler(args, extra)); }
    catch (error) { return { ...result({ error: error.message, deliveryState: error.deliveryState ?? "not_sent" }), isError: true }; }
  });
}

register("antigravity_bridge_status", "Inspect connection capabilities without sending prompts.", {}, true, async () => {
  let desktop;
  try { desktop = await callAntigravityDesktop({ operation: "status" }, { timeoutMs: 5000 }); }
  catch { desktop = { available: false, reason: "Open Antigravity with the installed codex-bridge sidecar enabled" }; }
  return { version, caller: caller ?? "unconfigured", desktop, cli: { transport: "stream-json", activeSessions: sessions.size, permissionPolicy: "native-unchanged", interactiveTerminalAttachment: false } };
});

register("list_antigravity_conversations", "List native Desktop conversations and bridge-owned CLI sessions in the sending project.", { surface: z.enum(["desktop", "cli"]) }, true, async ({ surface }, extra) => {
  const identity = await sender(extra);
  const records = surface === "desktop" ? await callAntigravityDesktop({ operation: "list" }) : [...sessions.values()].map((entry) => ({ ...entry.session.read(), sender: entry.sender }));
  return records.filter((record) => {
    try { sameCwd(identity.cwd, record.cwd); return surface !== "cli" || record.sender.id === identity.id && record.sender.provider === identity.provider; }
    catch { return false; }
  });
});

register("send_to_antigravity_conversation", "Send one authorized prompt to an exact existing Desktop conversation or a bridge-owned CLI session. Retain requestId and poll the delivery receipt.", { ...schema, surface: z.enum(["desktop", "cli"]), conversationId: z.string().uuid() }, false, async (args, extra) => {
  const identity = await sender(extra);
  const cwd = sameCwd(identity.cwd, args.cwd);
  const prompt = handoff(args.prompt, identity);
  if (args.surface === "desktop" && (prompt.length > 30000 || prompt.includes("\0"))) throw new Error("Desktop handoff must fit within 30000 characters and contain no NUL");
  if (args.surface === "desktop") return callAntigravityDesktop({ operation: "send", ...args, cwd, prompt, sender: identity });
  const entry = sessions.get(args.conversationId);
  if (!entry || entry.sender.id !== identity.id || entry.sender.provider !== identity.provider) throw new Error("CLI session is not owned by this sender and bridge process");
  sameCwd(cwd, entry.session.read().cwd);
  return deliveries.dispatch({ ...args, cwd, sender: identity, prompt }, async () => {
    const current = await sender(extra);
    sameCwd(cwd, current.cwd);
    if (current.id !== identity.id) throw Object.assign(new Error("Sender changed before delivery"), { deliveryState: "not_sent" });
    return entry.session.send(prompt);
  });
});

register("start_antigravity_cli_session", "Create a new bridge-owned Antigravity CLI streaming session for explicitly authorized new work; sends the initial prompt and returns a durable delivery receipt.", schema, false, async (args, extra) => {
  const identity = await sender(extra);
  const cwd = sameCwd(identity.cwd, args.cwd);
  if (sessions.size + startingSessions >= 4) throw new Error("At most four CLI sessions may be open in one bridge");
  return deliveries.dispatch({ ...args, cwd, sender: identity, surface: "cli" }, async () => {
    if (sessions.size + startingSessions >= 4) throw Object.assign(new Error("CLI session capacity reached"), { deliveryState: "not_sent" });
    startingSessions++;
    let reserved = true;
    let session;
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CODEX_|CLAUDE|ANTHROPIC_|MCP_)/i.test(name)));
      session = new AntigravityCliSession({ cwd, env });
      const started = await session.start();
      deliveries.identify(args.requestId, started.conversationId);
      sessions.set(started.conversationId, { session, sender: identity });
      startingSessions--;
      reserved = false;
      const current = await sender(extra);
      sameCwd(cwd, current.cwd);
      if (current.id !== identity.id) throw Object.assign(new Error("Sender changed before delivery"), { deliveryState: "not_sent" });
      return await session.send(handoff(args.prompt, identity));
    } catch (error) {
      if (error.deliveryState !== "unknown") {
        for (const [id, entry] of sessions) if (entry.session === session) sessions.delete(id);
        await session?.close();
      }
      throw error;
    } finally {
      if (reserved) startingSessions--;
    }
  });
});

register("read_antigravity_delivery", "Read the original receipt without resending. Desktop accepted means the native API accepted it, not that the agent completed a turn.", { surface: z.enum(["desktop", "cli"]), requestId: z.string().uuid() }, true, async (args, extra) => {
  const identity = await sender(extra);
  const record = args.surface === "desktop" ? await callAntigravityDesktop({ operation: "receipt", requestId: args.requestId }) : deliveries.read(args.requestId);
  return owns(record, identity);
});

register("close_antigravity_cli_session", "Close an idle bridge-owned CLI session belonging to the caller.", { conversationId: z.string().uuid() }, false, async ({ conversationId }, extra) => {
  const identity = await sender(extra);
  const entry = sessions.get(conversationId);
  if (!entry || entry.sender.id !== identity.id || entry.sender.provider !== identity.provider) throw new Error("CLI session is not owned by this sender");
  sameCwd(identity.cwd, entry.session.read().cwd);
  if (["running", "starting"].includes(entry.session.read().status)) throw new Error("Wait for the active CLI delivery before closing");
  const closed = await entry.session.close();
  if (closed.status !== "closing") sessions.delete(conversationId);
  return { closed: closed.status !== "closing", conversationId, status: closed.status };
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([...sessions.values()].map(({ session }) => session.close()));
  await stopProcessInspectors();
  await server.close();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void stop(); });
process.stdin.once("end", () => { void stop(); });
await server.connect(new StdioServerTransport());
