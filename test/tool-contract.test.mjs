import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
  "read_claude_delivery",
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
  for (const scenario of ["nowait", "timeout", "peer", "desktop", "desktop-reviewed", "desktop-reviewed-held", "desktop-reviewed-refused", "held", "refused", "diagnostic"]) {
    it(`reports ${scenario} from the actual MCP transport`, async () => {
      const desktop = scenario.startsWith("desktop");
      const reviewed = scenario.startsWith("desktop-reviewed");
      const controlStatus = scenario.endsWith("held") ? "held" : scenario.endsWith("refused") ? "refused" : null;
      const senderMode = reviewed ? "prompting" : "bypass";
      const home = fs.mkdtempSync(path.join(sandboxHome, "receipt-"));
      const registryDir = path.join(home, ".claude", "sessions");
      fs.mkdirSync(registryDir, { recursive: true });
      const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cc-msg-${crypto.randomBytes(16).toString("hex")}` : path.join(home, "mock.sock");
      const token = crypto.randomBytes(16).toString("hex");
      fs.writeFileSync(path.join(registryDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, name: "receipt-target", sessionId: "receipt-session", cwd: home, messagingSocketPath: socketPath, entrypoint: desktop ? "claude-desktop" : "cli" }));
      fs.writeFileSync(path.join(registryDir, path.basename(peerKeyPath(process.pid, socketPath))), JSON.stringify({ peerToken: token }));
      const desktopTaskId = "local_11111111-1111-4111-8111-111111111111";
      const callerId = "22222222-2222-4222-8222-222222222222";
      const turnId = "33333333-3333-4333-8333-333333333333";
      const meta = { "x-codex-turn-metadata": { thread_id: callerId, turn_id: turnId, thread_source: "user", auto_review_enabled: false, node_repl_auto_review_required: reviewed } };
      if (desktop) {
        const registryFile = path.join(registryDir, `${process.pid}.json`);
        const identity = process.platform === "win32"
          ? { procStartFt: execFileSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()`]).toString().trim() }
          : { procStart: execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).toString().trim() };
        fs.writeFileSync(registryFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(registryFile)), ...identity }));
        assert.ok(Object.values(identity)[0], "The fixture must capture the actual process start identity");
        const configRoot = process.platform === "darwin" ? path.join(home, "Library", "Application Support") : process.platform === "win32" ? path.join(home, "AppData", "Roaming") : path.join(home, ".config");
        const tasks = path.join(configRoot, "Claude", "claude-code-sessions", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555");
        fs.mkdirSync(tasks, { recursive: true });
        fs.writeFileSync(path.join(tasks, desktopTaskId + ".json"), JSON.stringify({ sessionId: desktopTaskId, cliSessionId: "receipt-session", title: "Receipt test", cwd: home, isArchived: false }));
        const rollouts = path.join(home, ".codex", "sessions", "2026", "09", "06");
        fs.mkdirSync(rollouts, { recursive: true });
        fs.writeFileSync(path.join(rollouts, `rollout-fixture-${callerId}.jsonl`), [
          { type: "session_meta", payload: { id: callerId, originator: "Codex Desktop", source: "vscode", cwd: home } },
          { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
          { type: "turn_context", payload: { turn_id: turnId, cwd: home, approval_policy: "never", approvals_reviewer: "user", permission_profile: { type: "disabled" }, sandbox_policy: { type: "danger-full-access" } } },
        ].map(JSON.stringify).join("\n") + "\n");
      }
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
              if (desktop) assert.match(raw.message.content, new RegExp(`from-mode="${senderMode}"`));
              count += 1;
              received();
              const request = parseFrame(line);
              if (desktop && !controlStatus) {
                const dir = path.join(home, ".claude", "projects", "fixture");
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, "receipt-session.jsonl"), [
                  { uuid: raw.uuid, isMeta: true, message: raw.message },
                  { uuid: "desktop-answer", parentUuid: raw.uuid, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "desktop verified" }] } },
                ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
              } else if (["peer", "diagnostic"].includes(scenario) || controlStatus) {
                const owner = fs.readdirSync(registryDir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(fs.readFileSync(path.join(registryDir, file), "utf8"))).find((entry) => entry.messagingSocketPath === request.fromSocket);
                const key = JSON.parse(fs.readFileSync(path.join(registryDir, path.basename(peerKeyPath(owner.pid, request.fromSocket))), "utf8"));
                const frame = ["peer", "diagnostic"].includes(scenario) ? buildFrame({ text: "peer verified", fromSocket: socketPath }) : { type: "control", action: "peer_message_status", orig_msg_id: request.msgId, from: buildFrame({ text: "", fromSocket: socketPath }).from, status: controlStatus, reason: "Receiver policy" };
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
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "claude-bridge.mjs")], env: { PATH: process.env.PATH ?? "", HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"), CODEX_BRIDGE_AUTOSTART: "0", CLAUDE_BRIDGE_PERMISSION_MODE: "bypass", CODEX_BRIDGE_DESKTOP_TASKS: desktop ? "1" : "0" }, stderr: "ignore" });
      const client = new Client({ name: "receipt-test", version: "1" });
      try {
        await client.connect(transport);
        if (desktop) {
          const listing = await client.callTool({ name: "list_claude_sessions", arguments: { expectedCwd: home } });
          assert.equal(listing.structuredContent.sessions[0].desktop.title, "Receipt test");
          assert.equal(listing.structuredContent.sessions[0].desktop.taskId, desktopTaskId);
          const wrongProject = await client.callTool({ name: "list_claude_sessions", arguments: { expectedCwd: path.dirname(home) } });
          assert.match(wrongProject.content[0].text, /No live Claude Desktop session/);
          for (const expectedCwd of [undefined, path.dirname(home), "relative", path.join(home, "missing")]) {
            const refused = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Wrong workspace", expectedCwd, waitSec: 0 } });
            assert.equal(refused.isError, true);
            assert.match(refused.content[0].text, /expectedCwd|no longer exists/);
            assert.equal(count, 0);
          }
          for (const expectedTaskId of [undefined, "local_99999999-9999-4999-8999-999999999999"]) {
            const refused = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Wrong task", expectedCwd: home, expectedTaskId, waitSec: 0 }, _meta: meta });
            assert.equal(refused.structuredContent.preflight.code, "CLAUDE_DESKTOP_TASK_MISMATCH");
            assert.equal(refused.structuredContent.preflight.sent, false);
            assert.equal(count, 0);
          }
          await client.callTool({ name: "bind_codex_thread", arguments: { threadId: callerId } });
          for (const _meta of [undefined, { "x-codex-turn-metadata": { ...meta["x-codex-turn-metadata"], turn_id: "66666666-6666-4666-8666-666666666666" } }]) {
            const refused = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Unknown sender", expectedCwd: home, expectedTaskId: desktopTaskId, waitSec: 0 }, _meta });
            assert.equal(refused.structuredContent?.preflight?.code, "CODEX_SENDER_CONTEXT_UNVERIFIED", refused.content?.[0]?.text);
            assert.equal(refused.structuredContent.preflight.sent, false);
            assert.equal(count, 0);
          }
          const status = await client.callTool({ name: "claude_bridge_status", arguments: {}, _meta: meta });
          assert.equal(status.structuredContent.sender.mode, senderMode);
          assert.equal(status.structuredContent.sender.review.nodeReplReview, reviewed ? "enabled" : "disabled");
          for (const invalid of [undefined, "false"]) {
            const invalidMeta = { "x-codex-turn-metadata": { ...meta["x-codex-turn-metadata"], auto_review_enabled: invalid } };
            const refused = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Invalid review evidence", expectedCwd: home, expectedTaskId: desktopTaskId, waitSec: 0 }, _meta: invalidMeta });
            assert.equal(refused.structuredContent.preflight.sent, false);
            assert.equal(count, 0);
          }
          assert.equal(status.structuredContent.sender.threadId, callerId);
        }
        const result = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Test", expectedCwd: home, expectedTaskId: desktopTaskId, waitSec: scenario === "nowait" ? 0 : 2 }, ...(desktop ? { _meta: meta } : {}) });
        let receiptTimer;
        try {
          await Promise.race([receipt, new Promise((_, reject) => {
            receiptTimer = setTimeout(() => reject(new Error("Mock peer did not receive the message")), 5000);
          })]);
        } finally { clearTimeout(receiptTimer); }
        if (handlerError) throw handlerError;
        const expected = controlStatus ?? (desktop ? "reply_received" : { nowait: "sent_unconfirmed", timeout: "reply_timeout", peer: "reply_received", desktop: "reply_received", held: "held", refused: "refused" }[scenario]);
        assert.equal(result.structuredContent.receipt.status, expected);
        assert.equal(Boolean(result.isError), scenario === "timeout" || Boolean(controlStatus));
        assert.equal(count, 1);
        if (desktop) {
          if (!controlStatus) assert.equal(result.structuredContent.receipt.source, "transcript");
          assert.equal(result.structuredContent.receipt.entrypoint, "claude-desktop");
          assert.equal(result.structuredContent.receipt.cwd, home);
          assert.equal(result.structuredContent.receipt.title, "Receipt test");
          assert.equal(result.structuredContent.receipt.senderMode, senderMode);
          assert.equal(result.structuredContent.receipt.senderThreadId, callerId);
          assert.equal(result.structuredContent.receipt.senderTurnId, turnId);
          const senderReview = { autoReview: "disabled", nodeReplReview: reviewed ? "enabled" : "disabled" };
          assert.deepEqual(result.structuredContent.receipt.senderReview, senderReview);
          let inspected = await client.callTool({ name: "read_claude_delivery", arguments: { msgId: result.structuredContent.receipt.msgId } });
          assert.deepEqual(inspected.structuredContent.receipt.senderReview, senderReview);
          if (controlStatus) assert.equal(inspected.structuredContent.receipt.forwarding, null);
          else {
            const deadline = Date.now() + 2000;
            while (["queued", "sending"].includes(inspected.structuredContent.receipt.forwarding?.status) && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 10));
              inspected = await client.callTool({ name: "read_claude_delivery", arguments: { msgId: result.structuredContent.receipt.msgId } });
            }
            assert.equal(inspected.structuredContent.receipt.status, "reply_received");
            assert.equal(inspected.structuredContent.receipt.forwarding.status, "failed");
            assert.equal(inspected.structuredContent.receipt.forwarding.reasonCode, "RELAY_UNREACHABLE");
            assert.equal(inspected.structuredContent.receipt.forwarding.threadId, callerId);
          }
        }
        if (["nowait", "timeout"].includes(scenario) || controlStatus === "held") {
          for (const waitSec of [1, 0]) {
            const retry = await client.callTool({ name: "send_to_claude_session", arguments: { target: "receipt-session", message: "Never send this", expectedCwd: home, expectedTaskId: desktopTaskId, waitSec }, ...(desktop ? { _meta: meta } : {}) });
            assert.equal(retry.isError, true);
            assert.match(retry.content[0].text, /earlier message/);
            assert.equal(count, 1);
          }
          const inspected = await client.callTool({ name: "read_claude_delivery", arguments: { msgId: result.structuredContent.receipt.msgId } });
          assert.equal(inspected.structuredContent.receipt.status, controlStatus === "held" ? "held" : "sent_unconfirmed");
          assert.equal(inspected.structuredContent.receipt.pending, true);
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

describe("Loaded MCP runtime freshness", () => {
  for (const entry of ["claude-bridge.mjs", "index.mjs"]) {
    it(`blocks sends from ${entry} after a source update until reconnect`, async () => {
      const directory = fs.mkdtempSync(path.join(sandboxHome, "runtime-"));
      fs.cpSync(path.join(root, "src"), path.join(directory, "src"), { recursive: true });
      fs.copyFileSync(path.join(root, "package.json"), path.join(directory, "package.json"));
      fs.symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const client = new Client({ name: "runtime-test", version: "1" });
      const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(directory, "src", entry)], env: {
        PATH: process.env.PATH ?? "", HOME: directory, USERPROFILE: directory, CODEX_HOME: path.join(directory, ".codex"), CODEX_BRIDGE_AUTOSTART: "0", CODEX_APP_SERVER_URL: "ws://127.0.0.1:9", CODEX_BRIDGE_DESKTOP_TASKS: "0",
      }, stderr: "ignore" });
      try {
        await client.connect(transport);
        const statusName = entry === "index.mjs" ? "codex_bridge_status" : "claude_bridge_status";
        const original = await client.callTool({ name: statusName, arguments: {} });
        assert.equal(original.structuredContent.runtime.current, true);
        fs.appendFileSync(path.join(directory, "src", "peer-protocol.mjs"), "\n");
        const stale = await client.callTool({ name: statusName, arguments: {} });
        assert.equal(stale.isError, true);
        assert.equal(stale.structuredContent.runtime.current, false);
        const sent = await client.callTool(entry === "index.mjs"
          ? { name: "send_to_codex_thread", arguments: { threadId: "existing-task", prompt: "Must not send" } }
          : { name: "send_to_claude_session", arguments: { target: "existing-session", message: "Must not send", waitSec: 0 } });
        assert.equal(sent.isError, true);
        assert.match(sent.content[0].text, /source changed.*No message was sent/s);
        if (entry === "claude-bridge.mjs") {
          const inbox = await client.callTool({ name: "read_claude_inbox", arguments: {} });
          assert.match(inbox.content[0].text, /Inbox is empty/);
        }
      } finally {
        await client.close();
      }
    });
  }
});

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
    assert.deepEqual(readOnly.sort(), ["list_claude_sessions", "read_claude_delivery", "read_claude_transcript"]);
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
