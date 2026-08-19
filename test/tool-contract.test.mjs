import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CODEX_TOOLS = [
  "send_to_codex_thread",
  "list_codex_threads",
  "start_codex_thread",
  "read_codex_thread",
  "interrupt_codex_turn",
  "open_codex_thread",
  "stop_codex_app_server",
  "codex_bridge_status",
];

const CLAUDE_TOOLS = [
  "list_claude_sessions",
  "send_to_claude_session",
  "read_claude_inbox",
  "read_claude_transcript",
  "bind_codex_thread",
  "claude_bridge_status",
];

/**
 * Both servers touch the real machine when they run for real, so the contract
 * check boots them against a throwaway HOME and an app-server endpoint nothing
 * listens on. Listing tools never opens either, but a wrong default here would
 * write peer registry entries into the developer's own ~/.claude.
 */
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-tools-"));

async function listTools(entry) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", entry)],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      CODEX_APP_SERVER_URL: "ws://127.0.0.1:9",
      CODEX_BRIDGE_AUTOSTART: "0",
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "tool-contract", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

after(() => {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

/**
 * An MCP client decides whether a call needs a human in the loop from the
 * annotation hints, so a tool that ships without them is treated as an unknown
 * quantity. Every tool here can reach another agent that runs shell commands,
 * which makes "unknown" the wrong default.
 */
function assertAnnotated(tool) {
  const hints = tool.annotations;
  assert.ok(hints, `${tool.name} declares no annotations`);
  assert.equal(typeof hints.readOnlyHint, "boolean", `${tool.name} has no readOnlyHint`);
  assert.equal(typeof hints.openWorldHint, "boolean", `${tool.name} has no openWorldHint`);
  if (hints.readOnlyHint) return;
  assert.equal(
    typeof hints.destructiveHint,
    "boolean",
    `${tool.name} writes but declares no destructiveHint`,
  );
  assert.equal(
    typeof hints.idempotentHint,
    "boolean",
    `${tool.name} writes but declares no idempotentHint`,
  );
}

function assertDescribed(tool) {
  assert.equal(typeof tool.title, "string", `${tool.name} has no human-readable title`);
  assert.ok(tool.title.length > 0, `${tool.name} has an empty title`);
  assert.equal(typeof tool.description, "string", `${tool.name} has no description`);
  assert.ok(tool.description.length > 30, `${tool.name} has a stub description`);
  assert.equal(tool.inputSchema?.type, "object", `${tool.name} declares no object input schema`);
  for (const [param, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
    assert.ok(schema.description, `${tool.name}.${param} has no description`);
  }
}

describe("codex-bridge tool contract", async () => {
  const tools = await listTools("index.mjs");

  it("exposes exactly the documented tools", () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CODEX_TOOLS].sort());
  });

  for (const name of CODEX_TOOLS) {
    it(`${name} is annotated and described`, () => {
      const tool = tools.find((t) => t.name === name);
      assertDescribed(tool);
      assertAnnotated(tool);
    });
  }

  it("marks the tools that only read as read-only", () => {
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    assert.deepEqual(readOnly.sort(), ["codex_bridge_status", "list_codex_threads", "read_codex_thread"]);
  });

  it("marks the tools that can destroy work as destructive", () => {
    const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    assert.deepEqual(destructive.sort(), [
      "interrupt_codex_turn",
      "send_to_codex_thread",
      "stop_codex_app_server",
    ]);
  });
});

describe("claude-bridge tool contract", async () => {
  const tools = await listTools("claude-bridge.mjs");

  it("exposes exactly the documented tools", () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), [...CLAUDE_TOOLS].sort());
  });

  for (const name of CLAUDE_TOOLS) {
    it(`${name} is annotated and described`, () => {
      const tool = tools.find((t) => t.name === name);
      assertDescribed(tool);
      assertAnnotated(tool);
    });
  }

  /**
   * read_claude_inbox empties the inbox as it reads it: a client that treated
   * the name as a read would happily call it twice and lose the messages.
   */
  it("does not call the draining inbox read a read-only tool", () => {
    const inbox = tools.find((t) => t.name === "read_claude_inbox");
    assert.equal(inbox.annotations.readOnlyHint, false);
    assert.equal(inbox.annotations.destructiveHint, true);
    assert.equal(inbox.annotations.idempotentHint, false);
  });

  it("marks the tools that only read as read-only", () => {
    const readOnly = tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    assert.deepEqual(readOnly.sort(), ["list_claude_sessions", "read_claude_transcript"]);
  });
});
