export function codexMcpRegistration({ name, existing, node, entry, env, desktopOnly }) {
  if (existing) {
    const customized = ["enabled_tools", "disabled_tools", "startup_timeout_sec", "tool_timeout_sec", "disabled_reason"]
      .some((key) => existing[key] != null && (!Array.isArray(existing[key]) || existing[key].length > 0));
    if (existing.enabled === false || customized || existing.transport?.type !== "stdio" || existing.transport?.cwd || existing.transport?.env_vars?.length) {
      throw new Error("The existing MCP entry has custom access, timeout, or transport settings. Keep that entry and update only its command/args using Codex settings; the installer will not remove or reset it.");
    }
  }
  const values = { ...existing?.transport?.env };
  for (const key of ["CLAUDE_BRIDGE_PEER_NAME", "CLAUDE_BRIDGE_PERMISSION_MODE", "CODEX_BRIDGE_DESKTOP_TASKS"]) {
    if (env[key] !== undefined) values[key] = env[key];
  }
  values.CODEX_BRIDGE_DESKTOP_TASKS ??= desktopOnly ? "1" : "0";
  if (!["0", "1"].includes(values.CODEX_BRIDGE_DESKTOP_TASKS)) throw new Error("CODEX_BRIDGE_DESKTOP_TASKS must be 0 or 1");
  if (values.CLAUDE_BRIDGE_PERMISSION_MODE !== undefined && !["bypass", "prompting"].includes(values.CLAUDE_BRIDGE_PERMISSION_MODE)) {
    throw new Error("CLAUDE_BRIDGE_PERMISSION_MODE must be bypass or prompting; never infer it from the recipient");
  }
  if (values.CODEX_BRIDGE_DESKTOP_TASKS === "1") values.CODEX_BRIDGE_AUTOSTART = "0";
  const args = ["mcp", "add", name];
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof value !== "string") throw new Error(`MCP environment value ${key} must be a string`);
    args.push("--env", `${key}=${value}`);
  }
  return { args: [...args, "--", node, entry], environmentKeys: Object.keys(values).sort() };
}
