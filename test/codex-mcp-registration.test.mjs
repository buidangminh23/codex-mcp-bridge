import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyStdioMcpRegistration, codexMcpRegistration, stdioMcpRegistration } from "../src/codex-mcp-registration.mjs";

const defaults = { name: "claude-bridge", node: "/runtime/node", entry: "/bridge/mcp-supervisor.mjs", entryArgs: ["claude-bridge.mjs"], env: {}, desktopOnly: true };
const existing = (env = {}) => ({ enabled: true, transport: { type: "stdio", env } });

it("records a downloaded CLI for fresh installs without changing customized existing environments", () => {
  const fresh = codexMcpRegistration({ ...defaults, env: { CODEX_BIN: "/managed/codex" } });
  assert.equal(fresh.environment.CODEX_BIN, "/managed/codex");
  const previous = { ...existing({ CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0" }), tool_timeout_sec: 90 };
  const kept = codexMcpRegistration({ ...defaults, existing: previous, env: { CODEX_BIN: "/managed/codex" } });
  assert.equal(kept.mode, "retarget");
  assert.equal(Object.hasOwn(kept.environment, "CODEX_BIN"), false);
});

it("preserves configured environment and pins Desktop mode without inventing a sender permission class", () => {
  const result = codexMcpRegistration({ ...defaults, existing: existing({ CLAUDE_BRIDGE_PEER_NAME: "keep", FUTURE_SETTING: "keep-too", CODEX_BRIDGE_AUTOSTART: "1" }) });
  assert.ok(result.args.includes("FUTURE_SETTING=keep-too"));
  assert.ok(result.args.includes("CLAUDE_BRIDGE_PEER_NAME=keep"));
  assert.ok(result.args.includes("CODEX_BRIDGE_DESKTOP_TASKS=1"));
  assert.ok(result.args.includes("CODEX_BRIDGE_AUTOSTART=0"));
  assert.equal(result.args.some((arg) => arg.startsWith("CLAUDE_BRIDGE_PERMISSION_MODE=")), false);
  assert.deepEqual(result.args.slice(-4), ["--", defaults.node, defaults.entry, "claude-bridge.mjs"]);
});

it("preserves an explicit legacy mode and an operator's existing permission declaration", () => {
  const result = codexMcpRegistration({ ...defaults, existing: existing({ CODEX_BRIDGE_DESKTOP_TASKS: "0", CLAUDE_BRIDGE_PERMISSION_MODE: "prompting" }) });
  assert.equal(result.mode, "retarget");
  assert.deepEqual(result.environment, { CODEX_BRIDGE_DESKTOP_TASKS: "0", CLAUDE_BRIDGE_PERMISSION_MODE: "prompting" });
  assert.deepEqual([result.command, ...result.commandArgs], [defaults.node, defaults.entry, "claude-bridge.mjs"]);
});

it("retargets a directly registered entry to the supervisor in place when codex mcp add would lose its settings", () => {
  const live = { enabled: true, transport: { type: "stdio", command: "/runtime/node", args: ["/bridge/claude-bridge.mjs"], env: { CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_DESKTOP_TASKS: "1" } } };
  const result = codexMcpRegistration({ ...defaults, existing: live });
  assert.equal(result.mode, "retarget");
  assert.deepEqual(result.args.slice(-3), ["/runtime/node", "/bridge/mcp-supervisor.mjs", "claude-bridge.mjs"]);
  assert.deepEqual(result.commandArgs, ["/bridge/mcp-supervisor.mjs", "claude-bridge.mjs"]);
  for (const patch of [{ enabled: false }, { enabled_tools: ["claude_bridge_status"] }, { disabled_tools: ["send_to_claude_session"] }, { tool_timeout_sec: 500 }, { transport: { type: "stdio", env_vars: ["CUSTOM"] } }, { transport: { type: "stdio", cwd: "/custom" } }]) {
    const relay = stdioMcpRegistration({ ...defaults, name: "codex-native-relay", entryArgs: ["native-relay-companion.mjs"], existing: { ...existing(), ...patch } });
    assert.equal(relay.mode, "retarget", JSON.stringify(patch));
    assert.equal(relay.args, undefined, "codex mcp add would drop these settings, so it is never a fallback");
    assert.deepEqual(relay.commandArgs, ["/bridge/mcp-supervisor.mjs", "native-relay-companion.mjs"]);
  }
});

it("refuses to reset custom access or transport settings when the environment must also change", () => {
  for (const patch of [{ enabled: false }, { enabled_tools: ["claude_bridge_status"] }, { disabled_tools: ["send_to_claude_session"] }, { tool_timeout_sec: 500 }, { transport: { type: "stdio", env_vars: ["CUSTOM"] } }, { transport: { type: "stdio", cwd: "/custom" } }, { transport: { type: "http", url: "https://example.com" } }]) {
    assert.throws(() => codexMcpRegistration({ ...defaults, existing: { ...existing(), ...patch } }), /will not remove or reset/);
  }
});

it("rejects invalid permission and Desktop declarations before registration", () => {
  assert.throws(() => codexMcpRegistration({ ...defaults, env: { CLAUDE_BRIDGE_PERMISSION_MODE: "auto" } }), /must be bypass or prompting/);
  assert.throws(() => codexMcpRegistration({ ...defaults, env: { CODEX_BRIDGE_DESKTOP_TASKS: "true" } }), /must be 0 or 1/);
});

it("preserves a Claude data-root override and accepts an explicit replacement without account binding", () => {
  const previous = existing({ CLAUDE_DESKTOP_USER_DATA: "/old/claude" });
  assert.ok(codexMcpRegistration({ ...defaults, existing: previous }).args.includes("CLAUDE_DESKTOP_USER_DATA=/old/claude"));
  const result = codexMcpRegistration({ ...defaults, existing: previous, env: { CLAUDE_DESKTOP_USER_DATA: "/new/claude" } });
  assert.ok(result.args.includes("CLAUDE_DESKTOP_USER_DATA=/new/claude"));
  assert.equal(result.args.some((arg) => arg.includes("ACCOUNT_ID=") || arg.includes("TOKEN=")), false);
});

it("reports an exact supervisor command for configurations it cannot safely rewrite", () => {
  assert.throws(() => codexMcpRegistration({ ...defaults, existing: { ...existing(), enabled: false } }), (error) => {
    assert.match(error.message, /command="\/runtime\/node"/);
    assert.match(error.message, /args=\["\/bridge\/mcp-supervisor.mjs","claude-bridge.mjs"\]/);
    return true;
  });
});

it("registers the native companion with its signed runtime and existing environment without a policy reset", () => {
  const result = stdioMcpRegistration({ ...defaults, name: "codex-native-relay", node: "/signed/runtime", entryArgs: ["native-relay-companion.mjs"], existing: existing({ CODEX_NATIVE_RELAY_SOCKET: "/relay/socket", CODEX_APP_TOOLS_PIPE_PATH: "/native/pipe", FUTURE_SETTING: "keep" }), envOverrides: { CLAUDE_DESKTOP_USER_DATA: "/claude" } });
  assert.equal(result.mode, "add");
  assert.deepEqual(result.args.slice(-4), ["--", "/signed/runtime", defaults.entry, "native-relay-companion.mjs"]);
  assert.deepEqual(result.environmentKeys, ["CLAUDE_DESKTOP_USER_DATA", "CODEX_APP_TOOLS_PIPE_PATH", "CODEX_NATIVE_RELAY_SOCKET", "FUTURE_SETTING"]);
  assert.ok(result.args.includes("CODEX_NATIVE_RELAY_SOCKET=/relay/socket"));
});

function codexStub(t, contents) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-apply-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.toml");
  fs.writeFileSync(configPath, contents);
  const calls = [];
  const entry = { enabled: true, transport: { type: "stdio", command: "/runtime/node", args: ["/bridge/native-relay-companion.mjs"], env: null, env_vars: null, cwd: null } };
  const run = (args) => {
    calls.push(args);
    if (args[1] === "add") {
      const separator = args.indexOf("--");
      entry.transport = { ...entry.transport, command: args[separator + 1], args: args.slice(separator + 2), env_vars: null };
      fs.writeFileSync(configPath, `mcp_servers.r = { command = ${JSON.stringify(entry.transport.command)}, args = ${JSON.stringify(entry.transport.args)} }\n`);
      return "";
    }
    if (args[1] === "get") return JSON.stringify(entry);
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { configPath, calls, run, entry };
}

it("falls back to codex mcp add for an inline-table entry and reports env_vars it could not add", (t) => {
  const stub = codexStub(t, 'mcp_servers.r = { command = "/runtime/node", args = ["/bridge/native-relay-companion.mjs"] }\n');
  const registration = stdioMcpRegistration({ ...defaults, name: "r", entryArgs: ["native-relay-companion.mjs"], existing: { ...stub.entry } });
  assert.equal(registration.mode, "retarget");
  const applied = applyStdioMcpRegistration({ name: "r", registration, existing: { ...stub.entry }, run: stub.run, configPath: stub.configPath, ensureEnvVars: ["PIPE"] });
  assert.equal(applied.mode, "add");
  assert.equal(applied.envVarsAdded, false);
  assert.match(applied.notice, /env_vars = \["PIPE"\]/);
  assert.deepEqual(stub.entry.transport.args, ["/bridge/mcp-supervisor.mjs", "native-relay-companion.mjs"]);
  assert.equal(stub.calls.filter((call) => call[1] === "add").length, 1);
});

it("never falls back to codex mcp add when that would drop the entry's env_vars", (t) => {
  const stub = codexStub(t, 'mcp_servers.r = { command = "/runtime/node", args = [], env_vars = ["PIPE"] }\n');
  stub.entry.transport.env_vars = ["PIPE"];
  const registration = stdioMcpRegistration({ ...defaults, name: "r", entryArgs: ["native-relay-companion.mjs"], existing: structuredClone(stub.entry) });
  assert.throws(() => applyStdioMcpRegistration({ name: "r", registration, existing: structuredClone(stub.entry), run: stub.run, configPath: stub.configPath }), /exactly one \[mcp_servers\.r\] table.*update only command=/s);
  assert.equal(stub.calls.length, 0);
  assert.equal(fs.readFileSync(stub.configPath, "utf8"), 'mcp_servers.r = { command = "/runtime/node", args = [], env_vars = ["PIPE"] }\n');
});
