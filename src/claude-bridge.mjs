#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CodexAppServerClient } from "./app-server-client.mjs";
import { PLATFORM_LABEL } from "./platform.mjs";
import { PeerEndpoint, findClaudeSession, listClaudeSessions, readTranscript } from "./peer-protocol.mjs";
import { createThreadDelivery } from "./thread-delivery.mjs";

const VERSION = "1.12.5";
const FORWARD_MIN_INTERVAL_MS = 5000;
const FORWARD_MAX_PER_SESSION = 50;

const log = (msg) => process.stderr.write(`[claude-bridge] ${msg}\n`);

const defaultPeerName = process.env.CLAUDE_BRIDGE_PEER_NAME ?? `codex-${process.pid}`;

const peer = new PeerEndpoint({
  name: defaultPeerName,
  cwd: process.env.CLAUDE_BRIDGE_CWD ?? process.cwd(),
  log,
});

const codex = new CodexAppServerClient({
  clientInfo: { name: "claude-bridge", title: "Claude Bridge", version: VERSION },
  log,
});

/**
 * Delivery is a backend choice, not a call: a thread the human is watching in
 * Codex Desktop is written through the desktop's own app-server, and every
 * other thread through the shared one. `claude-bridge` never picks between
 * them - see `thread-delivery.mjs`.
 */
const delivery = createThreadDelivery({ codex, log });

const forwarding = {
  threadId: process.env.CODEX_THREAD_ID ?? null,
  lastAt: 0,
  count: 0,
};

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const failure = (err) => textResult(`Claude bridge error: ${err?.message ?? String(err)}`, true);

function formatSessionRow(s) {
  const started = s.startedAt ? new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 16) : "?";
  return `- ${s.name ?? "(unnamed)"}  [pid ${s.pid}]\n    session: ${s.sessionId ?? "?"}\n    cwd: ${s.cwd ?? "?"}\n    started: ${started}  kind: ${s.kind ?? "?"}  via: ${s.entrypoint ?? "?"}`;
}

/**
 * A message Claude sends back only reaches the human if it lands in a Codex
 * thread, so relay it into the bound thread instead of leaving it in a buffer
 * nobody reads. Rate limited so two agents cannot ping-pong unattended.
 */
async function forwardToCodexThread(record) {
  if (!forwarding.threadId) return;
  const now = Date.now();
  if (now - forwarding.lastAt < FORWARD_MIN_INTERVAL_MS) {
    log(`forward skipped (rate limit): ${record.text.slice(0, 60)}`);
    return;
  }
  if (forwarding.count >= FORWARD_MAX_PER_SESSION) {
    log("forward skipped (per-session cap reached)");
    return;
  }
  forwarding.lastAt = now;
  forwarding.count += 1;
  try {
    const { backend } = await delivery.deliver(
      forwarding.threadId,
      `[message from Claude session ${record.fromSocket ?? "?"}]\n\n${record.text}`,
    );
    log(`forwarded a Claude message into thread ${forwarding.threadId} via ${backend}`);
  } catch (err) {
    log(`forward failed: ${err.message}`);
  }
}

peer.onMessage((record) => {
  void forwardToCodexThread(record);
});

const server = new McpServer(
  { name: "claude-bridge", version: VERSION },
  {
    instructions:
      "Talk to a live Claude Code session from Codex. list_claude_sessions finds the session, " +
      "send_to_claude_session sends to its peer transport and waits for a reply to confirm receipt. " +
      "This bridge registers itself as a peer, so Claude sees it in its own agent list and can " +
      "message back; bind_codex_thread relays those messages into a Codex thread.",
  },
);

server.registerTool(
  "list_claude_sessions",
  {
    title: "List live Claude Code sessions",
    description:
      "List Claude Code sessions running on this machine (name, pid, sessionId, cwd, how it was started). " +
      "Use it to pick the session to talk to.",
    inputSchema: {
      includeDead: z.boolean().optional().describe("Also list sessions whose process is gone (default false)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ includeDead }) => {
    try {
      const sessions = listClaudeSessions({ includeDead: includeDead ?? false }).filter(
        (s) => s.pid !== process.pid,
      );
      if (!sessions.length) return textResult("No live Claude Code session found.");
      return textResult(`${sessions.length} Claude session(s):\n\n${sessions.map(formatSessionRow).join("\n")}`);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "send_to_claude_session",
  {
    title: "Send a message to a Claude session",
    description:
      "Send a message to a running Claude Code session's peer transport and wait for its reply. " +
      "A socket write alone does not confirm that Claude received the message. Set waitSec to 0 to send without confirmation. " +
      "A waited send is refused while earlier messages to that session still await replies; " +
      "wait for those replies and read_claude_inbox before trying again.",
    inputSchema: {
      target: z.string().describe("Session name, pid or sessionId from list_claude_sessions"),
      message: z.string().describe("The message text to deliver"),
      waitSec: z
        .number()
        .int()
        .min(0)
        .max(1800)
        .optional()
        .describe("How long to wait for Claude's reply (default 180, 0 = do not wait)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ target, message, waitSec }) => {
    try {
      await peer.start();
      const session = findClaudeSession(target);
      if (!session) return textResult(`No live Claude session matches "${target}".`, true);

      const wait = waitSec ?? 180;
      const desktop = session.entrypoint === "claude-desktop";
      const text = desktop ? `${message}\n\n[Bridge response routing: reply with ordinary text in this conversation. The bridge reads the response associated with this message from the local transcript; no cross-session reply tool is needed.]` : message;
      const { msgId, reply, delivery } = await peer.sendAndWait(session.socket, text, {
        timeoutMs: wait * 1000,
        ...(desktop ? { transcriptSession: session } : {}),
      });
      const status = reply ? "reply_received" : delivery?.status ?? (wait === 0 ? "sent_unconfirmed" : "reply_timeout");
      const receipt = { status, msgId, target: session.name ?? String(session.pid), sessionId: session.sessionId, waitSec: wait, ...(reply ? { source: reply.source ?? "peer" } : {}) };
      const result = (text, isError = false) => ({ ...textResult(text, isError), structuredContent: { receipt } });
      const targetLabel = `${session.name ?? session.pid} (pid ${session.pid}, session ${session.sessionId ?? "?"})`;

      if (!reply && delivery && delivery.status !== "delivered") {
        return result(`Claude inbox reported ${delivery.status} for ${targetLabel}.\n${delivery.reason}\nMessage id: ${msgId}`, true);
      }

      if (wait === 0) {
        return result(`Sent to peer transport for ${targetLabel}.\nClaude receipt unconfirmed; not waiting for a reply.\nMessage id: ${msgId}`);
      }

      if (!reply) {
        return result(
          `Sent to peer transport for ${targetLabel}.\n\nNo reply within ${wait}s; Claude receipt and outcome remain unconfirmed. ` +
          `Do not automatically retry: the message may still be processed. Check read_claude_inbox for a late reply.\nMessage id: ${msgId}`,
          true,
        );
      }
      return result(`Reply received from ${targetLabel}.\nMessage id: ${msgId}\n\n--- Claude reply ---\n${reply.text}`);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "read_claude_inbox",
  {
    title: "Read messages Claude sent to this bridge",
    description:
      "Read and clear messages Claude sessions pushed to this bridge on their own (replies that arrived late, " +
      "or messages Claude started).",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("How many messages to return (default 20)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ limit }) => {
    try {
      await peer.start();
      const messages = peer.drainInbox(limit ?? 20);
      if (!messages.length) return textResult("Inbox is empty.");
      return textResult(
        messages
          .map((m) => {
            const at = new Date(m.receivedAt).toISOString().replace("T", " ").slice(0, 19);
            return `[${at}] from ${m.fromSocket ?? "?"}\n${m.text}`;
          })
          .join("\n\n"),
      );
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "read_claude_transcript",
  {
    title: "Read a Claude session transcript",
    description: "Read the recent conversation of a Claude Code session without sending anything into it.",
    inputSchema: {
      target: z.string().describe("Session name, pid or sessionId from list_claude_sessions"),
      limit: z.number().int().min(1).max(100).optional().describe("How many recent messages (default 10)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ target, limit }) => {
    try {
      const session = findClaudeSession(target);
      if (!session) return textResult(`No live Claude session matches "${target}".`, true);
      const { file, messages } = readTranscript(session.sessionId, session.cwd, limit ?? 10);
      if (!messages.length) return textResult(`No transcript entries found (looked at ${file}).`);
      const body = messages.map((m) => `[${m.role}] ${m.text}`).join("\n\n");
      return textResult(`${session.name ?? session.pid} (${session.cwd})\n\n${body}`);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "bind_codex_thread",
  {
    title: "Relay Claude messages into a Codex thread",
    description:
      "Bind a Codex thread so every message Claude pushes to this bridge is relayed into that thread, where it " +
      "shows up in the Codex desktop app. On macOS a thread already open in Codex Desktop is written through " +
      "the desktop's own app-server, so it keeps its writer lock and stays open. Pass an empty threadId to stop.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id, or an empty string to unbind"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ threadId }) => {
    const trimmed = threadId.trim();
    forwarding.threadId = trimmed || null;
    forwarding.count = 0;
    const name = trimmed ? `codex-${trimmed.slice(0, 8)}` : defaultPeerName;
    peer.rename(name);
    return textResult(
      trimmed
        ? `Relaying Claude messages into Codex thread ${trimmed} (max ${FORWARD_MAX_PER_SESSION} per bridge run, at most one every ${FORWARD_MIN_INTERVAL_MS / 1000}s).\ndelivery: ${delivery.describe()}\nClaude now sees this bridge as "${name}".`
        : `Relay disabled. Messages stay in the inbox. Claude sees this bridge as "${name}".`,
    );
  },
);

server.registerTool(
  "claude_bridge_status",
  {
    title: "Check the Claude bridge",
    description:
      "Report the peer endpoint this bridge exposes, how many Claude sessions are live, and whether messages " +
      "are being relayed into a Codex thread.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      await peer.start();
      const sessions = listClaudeSessions().filter((s) => s.pid !== process.pid);
      const lines = [
        `platform:      ${PLATFORM_LABEL} (${process.platform}/${process.arch})`,
        `bridge:        claude-bridge ${VERSION}`,
        `peer name:     ${peer.name}   (Claude sees this in its agent list)`,
        `peer socket:   ${peer.socketPath}`,
        `sender mode:   ${peer.permissionMode ?? "unknown (recipient may hold messages for approval)"}`,
        `live sessions: ${sessions.length}`,
        `relay thread:  ${forwarding.threadId ?? "(none - use bind_codex_thread)"}`,
        `delivery:      ${delivery.describe()}`,
        `inbox:         ${peer.inbox.length} pending message(s)`,
      ];
      return textResult(lines.join("\n"));
    } catch (err) {
      return failure(err);
    }
  },
);

/**
 * Never let peer registration take the MCP server down: a client that spawns
 * this server waits on the initialize handshake, and a crash here shows up as
 * a hung session rather than an error. Without the peer endpoint the bridge
 * still lists sessions, reads transcripts and sends one-way messages.
 */
try {
  await peer.start();
} catch (err) {
  log(`peer endpoint unavailable (${err.message}) - replies from Claude cannot be received`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready on ${PLATFORM_LABEL} as peer "${peer.name}" (${peer.started ? peer.socketPath : "peer endpoint down"})`);
