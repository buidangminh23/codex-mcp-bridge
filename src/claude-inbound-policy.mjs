import fs from "node:fs";
import path from "node:path";

import { homeDir } from "./platform.mjs";

const VALUES = new Set(["accept", "hold", "refuse"]);

/**
 * Claude Code consults crossSessionInbound before comparing permission
 * classes: an explicit value always wins, managed settings override every
 * other source, and a project or local file may only tighten (refuse over
 * hold over the user's accept). An unrecognised value holds messages while it
 * is present. Flags such as --settings cannot be seen from outside the
 * process; Claude Desktop launches its sessions with the user, project and
 * local sources, which is what this reads.
 */
function managedSettingsFile(platform, env) {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (platform === "win32") return path.join(env.ProgramData || "C:\\ProgramData", "ClaudeCode", "managed-settings.json");
  return "/etc/claude-code/managed-settings.json";
}

function readValue(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return undefined; }
  try {
    const data = JSON.parse(text);
    const value = data && typeof data === "object" && !Array.isArray(data) ? data.crossSessionInbound : undefined;
    if (value === undefined) return undefined;
    return VALUES.has(value) ? value : "invalid";
  } catch {
    return undefined;
  }
}

export function readClaudeInboundPolicy(cwd, { platform = process.platform, env = process.env, home = homeDir(), managedFile = managedSettingsFile(platform, env) } = {}) {
  const managed = readValue(managedFile);
  if (managed !== undefined) return { value: managed === "invalid" ? "refuse" : managed, source: "managed" };
  const sources = [
    ["user", readValue(path.join(home, ".claude", "settings.json"))],
    ...(typeof cwd === "string" && path.isAbsolute(cwd)
      ? [["project", readValue(path.join(cwd, ".claude", "settings.json"))], ["local", readValue(path.join(cwd, ".claude", "settings.local.json"))]]
      : []),
  ];
  for (const [source, value] of sources) if (value === "refuse") return { value: "refuse", source };
  for (const [source, value] of sources) if (value === "hold" || value === "invalid") return { value: "hold", source };
  if (sources[0][1] === "accept") return { value: "accept", source: "user" };
  return { value: null, source: null };
}
