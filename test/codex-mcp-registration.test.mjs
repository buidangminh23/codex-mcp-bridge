import assert from "node:assert/strict";
import { it } from "node:test";
import { codexMcpRegistration, stdioMcpRegistration } from "../src/codex-mcp-registration.mjs";

const defaults = { name: "claude-bridge", node: "/runtime/node", entry: "/bridge/mcp-supervisor.mjs", entryArgs: ["claude-bridge.mjs"], env: {}, desktopOnly: true };
const existing = (env = {}) => ({ enabled: true, transport: { type: "stdio", env } });

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
  assert.ok(result.args.includes("CODEX_BRIDGE_DESKTOP_TASKS=0"));
  assert.ok(result.args.includes("CLAUDE_BRIDGE_PERMISSION_MODE=prompting"));
  assert.equal(result.args.some((arg) => arg.startsWith("CODEX_BRIDGE_AUTOSTART=")), false);
});

it("refuses to reset custom access or transport settings during an upgrade", () => {
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
  const result = stdioMcpRegistration({ ...defaults, name: "codex-native-relay", node: "/signed/runtime", entryArgs: ["native-relay-companion.mjs"], existing: existing({ CODEX_NATIVE_RELAY_SOCKET: "/relay/socket", CODEX_APP_TOOLS_PIPE_PATH: "/native/pipe", FUTURE_SETTING: "keep" }) });
  assert.deepEqual(result.args.slice(-4), ["--", "/signed/runtime", defaults.entry, "native-relay-companion.mjs"]);
  assert.deepEqual(result.environmentKeys, ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_NATIVE_RELAY_SOCKET", "FUTURE_SETTING"]);
  assert.ok(result.args.includes("CODEX_NATIVE_RELAY_SOCKET=/relay/socket"));
});
