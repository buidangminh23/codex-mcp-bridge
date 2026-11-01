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
import { AntigravityDeliveries, antigravityDeliveryError } from "./antigravity-deliveries.mjs";
import { AntigravityCliSession } from "./antigravity-cli.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { NativeDesktopRelay, desktopTaskSocketPath, accountRelaySocketPath } from "./native-relay.mjs";
import { requireBridgeAccounts, readBridgeAccounts, assertAccountIdentity } from "./bridge-account-context.mjs";
import { bridgeDiagnostic, withBridgeDiagnostic, preflightFailure } from "./recipient-preflight.mjs";
import { createReloadControl, exitWhenClientCloses } from "./reload-control.mjs";

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
const reloadReason = () => startingSessions ? "Antigravity CLI sessions are still starting"
  : deliveries.active.size ? "Antigravity deliveries are still active"
    : sessions.size ? "Open Antigravity CLI sessions retain process pipes and cannot migrate" : null;
const reload = createReloadControl({
  entry: "antigravity-bridge.mjs",
  inspect: reloadReason,
  exportState: () => ({ caller: caller ?? null, directory }),
  restore: (state) => {
    if (state.caller !== (caller ?? null) || typeof state.directory !== "string" || path.relative(state.directory, directory)) {
      throw new Error("Antigravity caller or durable receipt directory changed during reload");
    }
  },
});

async function identifySender(extra) {
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

async function sender(extra) {
  try { return await identifySender(extra); }
  catch (error) {
    error.code ??= "ANTIGRAVITY_SENDER_UNVERIFIED";
    error.phase ??= "sender";
    error.deliveryState = "not_sent";
    throw error;
  }
}

function sameCwd(expected, actual) {
  try {
    if (!path.isAbsolute(expected) || !path.isAbsolute(actual)) throw new Error("Expected an absolute project directory");
    const left = fs.realpathSync.native(expected);
    const right = fs.realpathSync.native(actual);
    if (path.relative(left, right)) throw new Error("Antigravity destination must match the verified sender's project directory");
    rootPolicy.assert(left, "Antigravity project");
    return left;
  } catch (error) {
    error.code ??= "ANTIGRAVITY_PROJECT_SCOPE_INVALID";
    error.phase ??= "scope";
    error.deliveryState = "not_sent";
    throw error;
  }
}

function owns(record, identity) {
  if (!record || record.sender?.provider !== identity.provider || record.sender?.id !== identity.id) throw preflightFailure("ANTIGRAVITY_RECEIPT_OWNER_MISMATCH", "Delivery does not belong to this sending conversation");
  sameCwd(identity.cwd, record.cwd);
  return record;
}

function handoff(prompt, identity) {
  return `[Agent handoff from ${identity.provider} conversation ${identity.id}. Native Antigravity permissions remain in effect.]\n\n${prompt}`;
}

const server = new McpServer({ name: "antigravity-bridge", version }, { instructions: "Send authorized work to Antigravity Desktop through its native sidecar or to an explicitly created CLI streaming session. Always select the requested surface; never substitute CLI for Desktop. The exact destination directory must match the verified sending conversation. Desktop delivery acceptance is not an agent reply. CLI sessions are bridge-owned headless sessions, not attached interactive terminals. Preserve requestId across retries and read_antigravity_delivery after pending or unknown outcomes; never resend automatically. Native tool approvals remain in force. Antigravity Desktop can send authorized handoffs back to existing Codex Desktop tasks and live Claude Desktop Code sessions in the same project through its separate agent-bridge MCP server. From Antigravity, verify agent_bridge_status, discover list_agent_tasks, then use send_to_agent_task and read_agent_delivery. This inbound server does not initiate those outbound calls, and its status does not verify the outbound server's readiness. Antigravity CLI outbound and automatic App reply forwarding are not supported. An unreachable sidecar does not prove that the Antigravity App is closed; report its diagnostic and inspect sidecar configuration. Never use Computer Use, open an old chat, or create an empty, new, or error chat to load or recover a relay." });

function register(name, description, inputSchema, readOnly, handler) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly } }, async (args, extra) => {
    const options = { component: "antigravity-bridge", operation: name, requestId: args.requestId, conversationId: args.conversationId, readOnly };
    try {
      const value = await reload.run(() => handler(args, extra));
      const failure = antigravityDeliveryError(value);
      if (failure) return withBridgeDiagnostic({ ...result(value), isError: true }, failure, { ...options, readOnly: false, msgId: value.result?.msgId });
      if (value?.desktop?.available === false) return withBridgeDiagnostic({ ...result(value), isError: true }, { diagnostic: value.desktop.diagnostic }, options);
      return result(value);
    } catch (error) {
      const diagnostic = bridgeDiagnostic(error, options);
      return withBridgeDiagnostic({ ...result({ error: diagnostic.reason, code: diagnostic.code, deliveryState: error.deliveryState ?? diagnostic.deliveryState }), isError: true }, { diagnostic }, options);
    }
  });
}

register("antigravity_bridge_status", "Inspect native sidecar connectivity and supported inbound/outbound routes without sending prompts. Outbound readiness must be checked with agent_bridge_status inside Antigravity Desktop.", {}, true, async () => {
  let desktop;
  try { desktop = await callAntigravityDesktop({ operation: "status" }, { timeoutMs: 5000 }); }
  catch (cause) {
    const error = Object.assign(new Error("The native Antigravity sidecar could not be reached. This does not prove that the App is closed. Inspect its codex-bridge sidecar configuration and include the diagnostic in the report; do not open a chat to load the relay."), { code: "ANTIGRAVITY_SIDECAR_UNAVAILABLE", phase: cause.phase ?? "connect", cause });
    const diagnostic = bridgeDiagnostic(error, { component: "antigravity-bridge", operation: "antigravity_bridge_status", readOnly: true });
    desktop = { available: false, code: diagnostic.code, reason: diagnostic.reason, diagnostic };
  }
  return {
    version,
    caller: caller ?? "unconfigured",
    desktop,
    cli: { transport: "stream-json", activeSessions: sessions.size, permissionPolicy: "native-unchanged", interactiveTerminalAttachment: false },
    outbound: {
      supported: true,
      server: "agent-bridge",
      surface: "desktop",
      targets: ["codex-desktop", "claude-desktop-code"],
      scope: "existing-conversations-in-the-same-project",
      readiness: "not_checked",
      statusTool: "agent_bridge_status",
      cliSupported: false,
      automaticReplyForwarding: false,
    },
  };
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
  if (args.surface === "desktop" && (prompt.length > 30000 || prompt.includes("\0"))) throw preflightFailure("ANTIGRAVITY_PROMPT_INVALID", "Desktop handoff must fit within 30000 characters and contain no NUL");
  if (args.surface === "desktop") return callAntigravityDesktop({ operation: "send", ...args, cwd, prompt, sender: identity });
  const entry = sessions.get(args.conversationId);
  if (!entry || entry.sender.id !== identity.id || entry.sender.provider !== identity.provider) throw preflightFailure("ANTIGRAVITY_SESSION_OWNER_MISMATCH", "CLI session is not owned by this sender and bridge process");
  sameCwd(cwd, entry.session.read().cwd);
  return deliveries.dispatch({ ...args, cwd, sender: identity, prompt }, async () => {
    const current = await sender(extra);
    sameCwd(cwd, current.cwd);
    if (current.id !== identity.id) throw preflightFailure("ANTIGRAVITY_SENDER_CHANGED", "Sender changed before delivery");
    return entry.session.send(prompt);
  }, { component: "antigravity-bridge", operation: "send_to_antigravity_conversation" });
});

register("start_antigravity_cli_session", "Create a new bridge-owned Antigravity CLI streaming session for explicitly authorized new work; sends the initial prompt and returns a durable delivery receipt.", schema, false, async (args, extra) => {
  const identity = await sender(extra);
  const cwd = sameCwd(identity.cwd, args.cwd);
  if (sessions.size + startingSessions >= 4) throw preflightFailure("ANTIGRAVITY_SESSION_CAPACITY", "At most four CLI sessions may be open in one bridge");
  return deliveries.dispatch({ ...args, cwd, sender: identity, surface: "cli" }, async () => {
    if (sessions.size + startingSessions >= 4) throw preflightFailure("ANTIGRAVITY_SESSION_CAPACITY", "CLI session capacity reached");
    startingSessions++;
    let reserved = true;
    let session;
    let sending = false;
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
      if (current.id !== identity.id) throw preflightFailure("ANTIGRAVITY_SENDER_CHANGED", "Sender changed before delivery");
      sending = true;
      return await session.send(handoff(args.prompt, identity));
    } catch (error) {
      if (!sending) {
        error.code ??= "ANTIGRAVITY_CLI_START_FAILED";
        error.phase ??= "startup";
        error.deliveryState = "not_sent";
      }
      if (error.deliveryState !== "unknown") {
        for (const [id, entry] of sessions) if (entry.session === session) sessions.delete(id);
        await session?.close();
      }
      throw error;
    } finally {
      if (reserved) startingSessions--;
    }
  }, { component: "antigravity-bridge", operation: "start_antigravity_cli_session" });
});

register("read_antigravity_delivery", "Read the original receipt without resending. Desktop accepted means the native API accepted it, not that the agent completed a turn.", { surface: z.enum(["desktop", "cli"]), requestId: z.string().uuid() }, true, async (args, extra) => {
  const identity = await sender(extra);
  const record = args.surface === "desktop" ? await callAntigravityDesktop({ operation: "receipt", requestId: args.requestId }) : deliveries.read(args.requestId);
  return owns(record, identity);
});

register("close_antigravity_cli_session", "Close an idle bridge-owned CLI session belonging to the caller.", { conversationId: z.string().uuid() }, false, async ({ conversationId }, extra) => {
  const identity = await sender(extra);
  const entry = sessions.get(conversationId);
  if (!entry || entry.sender.id !== identity.id || entry.sender.provider !== identity.provider) throw preflightFailure("ANTIGRAVITY_SESSION_OWNER_MISMATCH", "CLI session is not owned by this sender");
  sameCwd(identity.cwd, entry.session.read().cwd);
  if (["running", "starting"].includes(entry.session.read().status)) throw preflightFailure("ANTIGRAVITY_SESSION_BUSY", "Wait for the active CLI delivery before closing");
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
await server.connect(new StdioServerTransport());
const shutdown = exitWhenClientCloses({ busy: () => startingSessions || deliveries.active.size ? "Antigravity deliveries are still active" : null, stop });
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void shutdown.close(signal); });
reload.listen();
