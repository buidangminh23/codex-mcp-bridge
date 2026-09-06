import assert from "node:assert/strict";
import { it } from "node:test";
import { codexMcpRegistration } from "../src/codex-mcp-registration.mjs";

const defaults = { name: "claude-bridge", node: "/runtime/node", entry: "/bridge/claude-bridge.mjs", env: {}, desktopOnly: true };
const existing = (env = {}) => ({ enabled: true, transport: { type: "stdio", env } });

it("preserves configured environment and pins Desktop mode without inventing a sender permission class", () => {
  const result = codexMcpRegistration({ ...defaults, existing: existing({ CLAUDE_BRIDGE_PEER_NAME: "keep", FUTURE_SETTING: "keep-too", CODEX_BRIDGE_AUTOSTART: "1" }) });
  assert.ok(result.args.includes("FUTURE_SETTING=keep-too"));
  assert.ok(result.args.includes("CLAUDE_BRIDGE_PEER_NAME=keep"));
  assert.ok(result.args.includes("CODEX_BRIDGE_DESKTOP_TASKS=1"));
  assert.ok(result.args.includes("CODEX_BRIDGE_AUTOSTART=0"));
  assert.equal(result.args.some((arg) => arg.startsWith("CLAUDE_BRIDGE_PERMISSION_MODE=")), false);
  assert.deepEqual(result.args.slice(-3), ["--", defaults.node, defaults.entry]);
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
