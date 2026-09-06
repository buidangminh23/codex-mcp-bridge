import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildFrame, parseFrame, peerKeyPath } from "../src/peer-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CODEX_TOOLS = [
  "delegate_to_codex",
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

const NATIVE_RELAY_TOOLS = ["native_relay_status"];

/**
 * Both servers touch the real machine when they run for real, so the contract
 * check boots them against a throwaway HOME and an app-server endpoint nothing
 * listens on. Listing tools never opens either, but a wrong default here would
 * write peer registry entries into the developer's own ~/.claude.
 */
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-tools-"));

describe("Claude message receipts", () => {
  for (const scenario of ["nowait", "timeout", "peer", "desktop", "held", "refused", "diagnostic"]) {
    it(`reports ${scenario} from the actual MCP transport`, async () => {
      const home = fs.mkdtempSync(path.join(sandboxHome, "receipt-"));
      const registryDir = path.join(home, ".claude", "sessions");
      fs.mkdirSync(registryDir, { recursive: true });
      const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString("hex")}` : path.join(home, "mock.sock");
      const token = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "receipt-target", sessionId: "receipt-session", cwd: home, messagingSocketPath: socketPath, entrypoint: scenario === "desktop" ? "claude-desktop" : "cli" }));
      fs.writeFileSync(path.join(registryDir, path.basename(peerKeyPath(process.pid, socketPath))), JSON.stringify({ peerToken: token }));
      let count = 0;
      let received;
      const receipt = new Promise((resolve) => { received = resolve; });
      let handlerError;
      const receiver = net.createServer((socket) => {
        let buffer = "";
        let authenticated = false;
        socket.on("error", (error) => { handlerError = error; });
        socket.on("data", (data) => {
          buffer += data.toString();
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            try {
              const raw = JSON.parse(line);
              if (raw.type === "auth") { assert.equal(raw.token, token); authenticated = true; continue; }
              assert.equal(authenticated, true);
              if (scenario === "diagnostic") assert.match(raw.message.content, /from-mode="prompting"/);
              count += 1;
              received();
              const request = parseFrame(line);
              if (scenario === "desktop") {
                const dir = path.join(home, ".claude", "projects", "fixture");
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, "receipt-session.jsonl"), [
                  { uuid: raw.uuid, isMeta: true, message: raw.message },
                  { uuid: "desktop-answer", parentUuid: raw.uuid, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "desktop verified" }] } },
                ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
              } else if (["peer", "held", "refused", "diagnostic"].includes(scenario)) {
                const owner = fs.readdirSync(registryDir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(registryDir, file), "utf8"))).find((entry) => entry.messagingSocketPath === request.fromSocket);
                const key = JSON.parse(fs.readFileSync(path.join(registryDir, path.basename(peerKeyPath(owner.pid, request.fromSocket))), "utf8"));
                const frame = ["peer", "diagnostic"].includes(scenario) ? buildFrame({ text: "peer verified", fromSocket: socketPath }) : { type: "control", action: "peer_message_status", orig_msg_id: request.msgId, from: buildFrame({ text: "", fromSocket: socketPath }).from, status: scenario, reason: "Receiver policy" };
                const reply = net.connect(request.fromSocket, () => reply.end(JSON.stringify({ type: "auth", token: key.peerToken }) + "\n" + JSON.stringify(frame) + "\n"));
                reply.on("error", (error) => { handlerError = error; });
              }
            } catch (error) { handlerError = error; }
          }
        });
      });
      await new Promise((resolve, reject) => { receiver.once("error", reject); receiver.listen(socketPath, resolve); });
      if (scenario === "diagnostic") {
        try {
          const stdout = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(root, "scripts", "check-claude-bridge.mjs")], {
            env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_TARGET: "receipt-session", CLAUDE_WAIT: "2", CLAUDE_BRIDGE_PERMISSION_MODE: "prompting", CODEX_BRIDGE_AUTOSTART: "0", CODEX_THREAD_ID: "", CODEX_BRIDGE_NATIVE_RELAY: "0", CODEX_APP_SERVER_URL: "ws://127.0.0.1:9" },
            timeout: 20000,
            windowsHide: true,
          }, (error, stdout) => error ? reject(error) : resolve(stdout)));
          if (handlerError) throw handlerError;
          assert.match(stdout, /roundtrip passed: reply received/);
          assert.equal(count, 1);
        } finally { await new Promise((resolve) => receiver.close(resolve)); }
        return;
      }
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "claude-bridge.mjs")], env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_DESKTOP_TASKS: scenario === "desktop" ? "1" : "0" }, stderr: "ignore" });
      const client = new Client({ name: "receipt-test", version: "1" });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Test", waitSec: scenario === "nowait" ? 0 : 2 } });
        let receiptTimer;
        try {
          await Promise.race([receipt, new Promise((_, reject) => {
            receiptTimer = setTimeout(() => reject(new Error("Mock peer did not receive the message")), 5000);
          })]);
        } finally { clearTimeout(receiptTimer); }
        if (handlerError) throw handlerError;
        const expected = { nowait: "sent_unconfirmed", timeout: "reply_timeout", peer: "reply_received", desktop: "reply_received", held: "held", refused: "refused" }[scenario];
        assert.equal(result.structuredContent.receipt.status, expected);
        assert.equal(Boolean(result.isError), ["timeout", "held", "refused"].includes(scenario));
        assert.equal(count, 1);
        if (scenario === "desktop") {
          assert.equal(result.structuredContent.receipt.source, "transcript");
          assert.equal(result.structuredContent.receipt.entrypoint, "claude-desktop");
          assert.equal(result.structuredContent.receipt.cwd, home);
        }
        if (["nowait", "timeout", "held"].includes(scenario)) {
          const retry = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Never send this", waitSec: 1 } });
          assert.equal(retry.isError, true);
          assert.match(retry.content[0].text, /earlier message/);
          assert.equal(count, 1);
        }
      } finally {
        await client.close();
        await new Promise((resolve) => receiver.close(resolve));
      }
    });
  }
});

describe("Claude Desktop destination enforcement", () => {
  for (const policySource of ["environment", "shared-config"]) {
    it(`refuses CLI delivery before connecting when Desktop mode comes from ${policySource}`, async () => {
      const home = fs.mkdtempSync(path.join(sandboxHome, "desktop-only-"));
      const registryDir = path.join(home, ".claude", "sessions");
      fs.mkdirSync(registryDir, { recursive: true });
      const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString("hex")}` : path.join(home, "cli.sock");
      fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "cli-target", sessionId: "cli-session", cwd: home, messagingSocketPath: socketPath, entrypoint: "cli" }));
      fs.writeFileSync(path.join(registryDir, path.basename(peerKeyPath(process.pid, socketPath))), JSON.stringify({ peerToken: crypto.randomBytes(16).toString("hex") }));
      const env = { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CODEX_BRIDGE_AUTOSTART: "0" };
      if (policySource === "environment") env.CODEX_BRIDGE_DESKTOP_TASKS = "1";
      else {
        fs.mkdirSync(env.CODEX_HOME, { recursive: true });
        fs.writeFileSync(path.join(env.CODEX_HOME, "native-relay.json"), JSON.stringify({ desktopTasks: true }));
      }
      let connections = 0;
      const receiver = net.createServer((socket) => { connections += 1; socket.on("error", () => {}); socket.resume(); });
      await new Promise((resolve, reject) => { receiver.once("error", reject); receiver.listen(socketPath, resolve); });
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "claude-bridge.mjs")], env, stderr: "ignore" });
      const client = new Client({ name: "desktop-policy-test", version: "1" });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: "send_to_claude_session", arguments: { target: "cli-session", message: "Must never reach the CLI", waitSec: 0 } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Desktop-only.*refuses.*cli/s);
        assert.equal(connections, 0);
        const listing = await client.callTool({ name: "list_claude_sessions", arguments: {} });
        assert.match(listing.content[0].text, /No live Claude Desktop session/);
        assert.doesNotMatch(listing.content[0].text, /cli-target/);
        const status = await client.callTool({ name: "claude_bridge_status", arguments: {} });
        assert.match(status.content[0].text, /session policy: desktop-only/);
        assert.match(status.content[0].text, /live sessions: 0/);
        assert.match(status.content[0].text, /excluded.*1/);
      } finally {
        await client.close();
        await new Promise((resolve) => receiver.close(resolve));
      }
    });
  }
});

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
      "delegate_to_codex",
      "interrupt_codex_turn",
      "send_to_codex_thread",
      "start_codex_thread",
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

/**
 * The relay companion is launched by Codex Desktop like any other MCP server,
 * so it has to answer `initialize` on a machine with no Codex Desktop, no
 * relay thread and - where unix sockets are not the transport - no socket at
 * all. A companion that died on any of those would read as a hang to the app
 * that spawned it, which is the failure this project has already paid for once
 * in `peer-protocol.mjs`.
 */
describe("native relay companion tool contract", async () => {
  const tools = await listTools("native-relay-companion.mjs");

  it("exposes exactly the documented tools", () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), [...NATIVE_RELAY_TOOLS].sort());
  });

  for (const name of NATIVE_RELAY_TOOLS) {
    it(`${name} is annotated and described`, () => {
      const tool = tools.find((t) => t.name === name);
      assertDescribed(tool);
      assertAnnotated(tool);
    });
  }
});
