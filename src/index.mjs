#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CodexAppServerClient, writerLockWarning } from "./app-server-client.mjs";
import {
  IS_MACOS,
  PLATFORM_LABEL,
  claudeDesktopConfigPath,
  codexThreadUrl,
  hasCodexDesktopApp,
  isDesktopAppServerRunning,
  isLaunchAgentInstalled,
  launchAgentPath,
  openThreadInCodexApp,
  resolveWorkspacePath,
} from "./platform.mjs";
import { runTurn } from "./turn.mjs";
import { BridgeSecurityPolicy } from "./security-policy.mjs";

const VERSION = "1.9.4";
const log = (msg) => process.stderr.write(`[codex-mcp-bridge] ${msg}\n`);

/**
 * The Codex desktop app ignores ~/.codex/config.toml and runs its own model and
 * effort, so a thread opened through the bridge would otherwise be weaker than
 * the same work done in the app. These defaults keep both paths equivalent.
 */
const DEFAULT_MODEL = process.env.CODEX_BRIDGE_MODEL || null;
const DEFAULT_EFFORT = process.env.CODEX_BRIDGE_EFFORT || null;
const security = new BridgeSecurityPolicy();

const client = new CodexAppServerClient({
  clientInfo: { name: "codex-mcp-bridge", title: "Codex MCP Bridge", version: VERSION },
  log,
});

const textResult = (text, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const failure = (err) => textResult(`Codex bridge error: ${err?.message ?? String(err)}`, true);

function formatThreadRow(t) {
  const title = t.name || (t.preview ?? "").replace(/\s+/g, " ").slice(0, 70) || "(no title)";
  const updated = t.updatedAt ? new Date(t.updatedAt * 1000).toISOString().replace("T", " ").slice(0, 16) : "?";
  const status = t.status?.type ?? "?";
  const deepLink = IS_MACOS && hasCodexDesktopApp() ? `\n    open: ${codexThreadUrl(t.id)}` : "";
  const authorized = security.isThreadAuthorized(t.id)
    ? ""
    : "\n    NOT AUTHORIZED: add this id to CODEX_BRIDGE_ALLOWED_THREADS to send into it";
  return `- ${t.id}\n    title: ${title}\n    cwd: ${t.cwd ?? "?"}\n    updated: ${updated}  status: ${status}  source: ${t.source ?? "?"}${deepLink}${authorized}`;
}

function formatTurn(result) {
  const lines = [];
  lines.push(`thread: ${result.threadId}`);
  lines.push(`turn:   ${result.turnId ?? "?"}  status: ${result.status}`);
  if (result.durationMs != null) lines.push(`took:   ${Math.round(result.durationMs / 1000)}s`);
  if (result.activity.length) {
    const trail = result.activity.slice(-12).map((a) => {
      if (a.kind === "command") {
        const cmd = Array.isArray(a.command) ? a.command.join(" ") : a.command;
        return `  * run: ${String(cmd ?? "?").slice(0, 160)}${a.exitCode != null ? ` (exit ${a.exitCode})` : ""}`;
      }
      if (a.kind === "fileChange") return `  * edit: ${a.files.join(", ").slice(0, 200)}`;
      if (a.kind === "mcpToolCall") return `  * tool: ${a.server}/${a.tool}`;
      if (a.kind === "webSearch") return `  * search: ${a.query}`;
      return `  * ${a.kind}`;
    });
    lines.push(`activity (${result.activity.length} items, last ${trail.length}):`, ...trail);
  }
  if (result.errors.length) {
    lines.push(`errors: ${result.errors.map((e) => e.message ?? JSON.stringify(e)).join(" | ")}`);
  }
  lines.push("", "--- Codex reply ---", result.text || "(no assistant text was produced)");
  if (result.status === "timeout") {
    lines.push(
      "",
      "NOTE: the bridge stopped waiting, but the turn is still running inside Codex.",
      `Read it later with read_codex_thread, or stop it with interrupt_codex_turn (turnId ${result.turnId}).`,
    );
  }
  if (result.status === "disconnected") {
    lines.push(
      "",
      "NOTE: the app-server connection dropped mid-turn - typically the machine slept, rebooted, or the",
      "Codex desktop app reclaimed the shared state. The turn may have kept running inside Codex.",
      `Reconnect happens on the next call: check with read_codex_thread (threadId ${result.threadId}).`,
    );
  }
  return lines.join("\n");
}

const server = new McpServer(
  { name: "codex-bridge", version: VERSION },
  {
    instructions:
      "Bridge into a live Codex session. Use list_codex_threads to find the right threadId, " +
      "then send_to_codex_thread to push a prompt into that exact thread and read Codex's reply. " +
      "On macOS, open_codex_thread (or openInApp) surfaces the thread in the Codex desktop app so a " +
      "human can watch it run, and codex_bridge_status reports how the bridge is wired on this machine.",
  },
);

server.registerTool(
  "send_to_codex_thread",
  {
    title: "Send a prompt to a Codex thread",
    description:
      "Send a prompt as a new user turn inside an existing Codex thread and wait for Codex to answer. " +
      "The thread keeps its full history, cwd and model. Use list_codex_threads first if you do not know the threadId.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id (UUID) - get it from list_codex_threads"),
      prompt: z.string().describe("The message to send to Codex, exactly as a user would type it"),
      timeoutSec: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe("How long to wait for the turn to finish (default 240s)"),
      cwd: z.string().optional().describe("Override the working directory for this turn"),
      model: z.string().optional().describe("Override the model for this turn"),
      effort: z
        .enum(["minimal", "low", "medium", "high", "xhigh", "ultra"])
        .optional()
        .describe(`Override reasoning effort (default ${DEFAULT_EFFORT ?? "whatever ~/.codex/config.toml says"})`),
      openInApp: z
        .boolean()
        .optional()
        .describe("macOS only: open the thread in the Codex desktop app before sending so a human can watch it live"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ threadId, prompt, timeoutSec, cwd, model, effort, openInApp }) => {
    let openNote = null;
    try {
      security.assertThread(threadId);
      if (openInApp) {
        try {
          openNote = `opened in Codex app: ${await openThreadInCodexApp(threadId)}`;
        } catch (err) {
          openNote = `could not open the thread in the Codex app: ${err.message}`;
        }
      }
      let resolvedCwd = null;
      if (cwd) {
        const workspace = resolveWorkspacePath(cwd);
        security.assertCwd(workspace.path);
        resolvedCwd = workspace.path;
        if (workspace.note) openNote = openNote ? `${openNote}\n${workspace.note}` : workspace.note;
      }
      const attached = await client.ensureThreadAttached(threadId, resolvedCwd ? { cwd: resolvedCwd } : {});
      security.assertCwd(attached.thread?.cwd);
      const result = await runTurn(client, {
        threadId,
        input: [{ type: "text", text: prompt }],
        timeoutMs: (timeoutSec ?? 240) * 1000,
        turnOverrides: {
          ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
          ...(model ?? DEFAULT_MODEL ? { model: model ?? DEFAULT_MODEL } : {}),
          ...(effort ?? DEFAULT_EFFORT ? { effort: effort ?? DEFAULT_EFFORT } : {}),
        },
      });
      const body = formatTurn(result);
      const failed = result.status === "failed" || result.status === "disconnected";
      const held = openInApp && client.holdsThread(threadId) ? writerLockWarning(threadId) : "";
      return textResult(`${openNote ? `${openNote}\n${body}` : body}${held}`, failed);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "list_codex_threads",
  {
    title: "List Codex threads",
    description:
      "List recent Codex threads (id, title, cwd, last update, status) so you can pick the exact threadId to talk to.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe("How many threads to return (default 15)"),
      cwd: z.string().optional().describe("Only threads whose session cwd matches this path exactly"),
      searchTerm: z.string().optional().describe("Substring filter on the thread title"),
      loadedOnly: z
        .boolean()
        .optional()
        .describe("Only threads currently loaded/live inside this app-server (default false)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ limit, cwd, searchTerm, loadedOnly }) => {
    try {
      const params = { limit: limit ?? 15 };
      if (cwd) {
        const workspace = resolveWorkspacePath(cwd);
        security.assertCwd(workspace.path);
        params.cwd = { paths: [workspace.path] };
      }
      if (searchTerm) params.searchTerm = searchTerm;
      const method = loadedOnly ? "thread/loaded/list" : "thread/list";
      const res = await client.call(method, loadedOnly ? { limit: limit ?? 15 } : params);
      const rows = security.filterThreads(res?.data ?? res?.threads ?? []);
      if (!rows.length) {
        return textResult(
          security.summary().allowedRoots.length
            ? "No Codex threads matched inside the allowed workspace roots."
            : "No workspace roots are configured, so no thread can be listed. Set CODEX_BRIDGE_ALLOWED_ROOTS to one or more project directories.",
          !security.summary().allowedRoots.length,
        );
      }
      return textResult(
        `${rows.length} Codex thread(s) via ${client.url}:\n\n${rows.map(formatThreadRow).join("\n")}`,
      );
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "start_codex_thread",
  {
    title: "Start a new Codex thread",
    description: "Create a brand new Codex thread in the shared app-server and return its threadId.",
    inputSchema: {
      cwd: z.string().describe("Absolute working directory for the new Codex session"),
      model: z.string().optional().describe("Model override, e.g. gpt-5.6-luna"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ cwd, model }) => {
    try {
      const workspace = resolveWorkspacePath(cwd);
      security.assertCwd(workspace.path);
      const res = await client.call("thread/start", {
        cwd: workspace.path,
        ...(model ?? DEFAULT_MODEL ? { model: model ?? DEFAULT_MODEL } : {}),
        approvalPolicy: security.approvalPolicy,
        sandbox: security.sandbox,
      });
      const thread = res?.thread ?? {};
      if (thread.id) {
        client.markAttached(thread.id, thread);
        security.registerThread(thread.id);
      }
      return textResult(
        [
          "Created Codex thread",
          `  threadId: ${thread.id}`,
          `  cwd: ${thread.cwd}`,
          `  rollout: ${thread.path ?? "(not written yet)"}`,
          ...(workspace.note ? [`  note: ${workspace.note}`] : []),
        ].join("\n"),
      );
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "read_codex_thread",
  {
    title: "Read a Codex thread",
    description: "Read the recent conversation of a Codex thread without sending anything.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id"),
      limit: z.number().int().min(1).max(50).optional().describe("How many recent messages to show (default 10)"),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
    },
  },
  async ({ threadId, limit }) => {
    try {
      security.assertThread(threadId);
      const res = await client.call("thread/read", { threadId, includeTurns: true });
      const thread = res?.thread ?? res ?? {};
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

server.registerTool(
  "interrupt_codex_turn",
  {
    title: "Interrupt a Codex turn",
    description: "Stop a turn that is still running in a Codex thread.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id"),
      turnId: z.string().describe("Turn id reported by send_to_codex_thread"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ threadId, turnId }) => {
    try {
      security.assertThread(threadId);
      const thread = await client.call("thread/read", { threadId });
      security.assertCwd((thread?.thread ?? thread)?.cwd);
      await client.call("turn/interrupt", { threadId, turnId });
      return textResult(`Interrupted turn ${turnId} in thread ${threadId}.`);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "open_codex_thread",
  {
    title: "Open a Codex thread in the desktop app",
    description:
      "macOS only: bring a Codex thread to the front in the Codex desktop app (codex://threads/<id>) " +
      "so a human can watch the work live instead of reading the transcript afterwards.",
    inputSchema: {
      threadId: z.string().describe("Codex thread id"),
      background: z
        .boolean()
        .optional()
        .describe("Open without stealing focus from the current app (default false)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ threadId, background }) => {
    try {
      security.assertThread(threadId);
      const thread = await client.call("thread/read", { threadId });
      security.assertCwd((thread?.thread ?? thread)?.cwd);
      const url = await openThreadInCodexApp(threadId, { activate: !background });
      const held = client.holdsThread(threadId) ? writerLockWarning(threadId) : "";
      return textResult(`Opened ${url} in the Codex desktop app.${held}`);
    } catch (err) {
      return textResult(`${err.message}`, true);
    }
  },
);

server.registerTool(
  "stop_codex_app_server",
  {
    title: "Stop the shared Codex app-server",
    description:
      "Stop the shared app-server this bridge talks to. Use it when work is handed off and the Codex desktop " +
      "app is open: two app-servers on the same ~/.codex state make the app stutter. The bridge starts a new " +
      "one automatically the next time it needs it.",
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const result = await client.stopServer();
      return textResult(
        result.stopped
          ? `Stopped the shared app-server (pid ${result.pids.join(", ")}). Its thread writer locks are released, so the Codex desktop app now owns ~/.codex and every thread it was holding.`
          : `Nothing to stop: ${result.reason}.`,
      );
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "codex_bridge_status",
  {
    title: "Check the Codex bridge environment",
    description:
      "Report how this bridge is wired on the current machine: platform, resolved codex binary, " +
      "app-server endpoint and whether it is live, plus the macOS integrations (LaunchAgent, desktop app).",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const up = await client.isServerUp();
    let liveThreads = null;
    if (up) {
      try {
        const res = await client.call("thread/loaded/list", { limit: 20 });
        liveThreads = (res?.data ?? res?.threads ?? []).length;
      } catch {
        liveThreads = null;
      }
    }
    const lines = [
      `platform:       ${PLATFORM_LABEL} (${process.platform}/${process.arch})`,
      `bridge version: ${VERSION}`,
      `node:           ${process.version} at ${process.execPath}`,
      `codex binary:   ${client.codexBin}`,
      `defaults:       model ${DEFAULT_MODEL ?? "(from ~/.codex/config.toml)"}, effort ${DEFAULT_EFFORT ?? "(from ~/.codex/config.toml)"}`,
      `app-server:     ${client.url} - ${up ? "live" : "not reachable"}`,
      `autostart:      ${client.autoStart ? "on" : "off"}   approvals: ${client.approval}`,
      `security:       ${security.summary().authorizedThreads} authorized thread(s), ${security.summary().allowedRoots.length} allowed root(s), sandbox ${security.sandbox}, thread policy ${security.approvalPolicy}`,
      `live threads:   ${liveThreads ?? "(unknown)"}`,
      `claude desktop config: ${claudeDesktopConfigPath()}`,
    ];
    if (IS_MACOS) {
      const desktopServer = isDesktopAppServerRunning();
      lines.push(
        `codex desktop app:     ${hasCodexDesktopApp() ? "installed (codex:// deep links available)" : "not installed"}`,
        `desktop app-server:    ${desktopServer ? "running (its own stdio server)" : "not running"}`,
        `launchd agent:         ${isLaunchAgentInstalled() ? `installed at ${launchAgentPath()}` : "not installed"}`,
      );
      if (desktopServer && isLaunchAgentInstalled()) {
        lines.push(
          "",
          "WARNING: the desktop app-server and the launchd app-server both hold the sqlite state in ~/.codex.",
          "That contention makes the Codex app stutter. Keep only one alive:",
          "  node scripts/install-launch-agent.mjs --uninstall   # let the desktop app own it",
        );
      }
    }
    if (!up) {
      lines.push(
        "",
        `Start one with: ${client.codexBin} app-server --listen ${client.url}`,
      );
    }
    return textResult(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready on ${PLATFORM_LABEL} (app-server endpoint: ${client.url}, codex: ${client.codexBin})`);
