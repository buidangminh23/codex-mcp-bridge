import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const IS_MACOS = process.platform === "darwin";
export const IS_WINDOWS = process.platform === "win32";
export const IS_LINUX = process.platform === "linux";

export const PLATFORM_LABEL = IS_MACOS
  ? "macOS"
  : IS_WINDOWS
    ? "Windows"
    : IS_LINUX
      ? "Linux"
      : process.platform;

const CODEX_DESKTOP_APP_MACOS = "/Applications/ChatGPT.app";
const CODEX_DESKTOP_BIN_MACOS = `${CODEX_DESKTOP_APP_MACOS}/Contents/Resources/codex`;
const CODEX_THREAD_URL_PREFIX = "codex://threads/";

const homeDir = () => process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();

function isRunnable(candidate) {
  if (!candidate || !existsSync(candidate)) return false;
  if (IS_WINDOWS) return true;
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsCodexCandidates() {
  const roaming = process.env.APPDATA;
  const local = process.env.LOCALAPPDATA;
  return [
    local && path.join(local, "Programs", "OpenAI", "Codex", "bin", "codex.exe"),
    roaming && path.join(roaming, "npm", "codex.cmd"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs", "codex.cmd"),
  ];
}

function unixCodexCandidates() {
  const home = homeDir();
  return [
    path.join(home, ".local", "bin", "codex"),
    path.join(home, ".npm-global", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(home, ".volta", "bin", "codex"),
    path.join(home, ".bun", "bin", "codex"),
    path.join(home, ".cargo", "bin", "codex"),
    path.join(home, ".codex", "packages", "standalone", "current", "codex"),
    IS_MACOS ? CODEX_DESKTOP_BIN_MACOS : null,
  ];
}

function pathCandidates() {
  const separator = IS_WINDOWS ? ";" : ":";
  const names = IS_WINDOWS ? ["codex.exe", "codex.cmd"] : ["codex"];
  return (process.env.PATH ?? "")
    .split(separator)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => path.join(dir, name)));
}

/**
 * Claude Desktop and launchd start child processes with a trimmed PATH, so a
 * bare `codex` lookup fails on macOS where the CLI usually lives under
 * ~/.local/bin, ~/.npm-global/bin or Homebrew. Probe every known install
 * location for the running platform before giving up on PATH resolution.
 */
export function resolveCodexBin(explicit) {
  const candidates = [
    explicit,
    process.env.CODEX_BIN,
    ...(IS_WINDOWS ? windowsCodexCandidates() : unixCodexCandidates()),
    ...pathCandidates(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isRunnable(candidate)) return candidate;
  }
  return "codex";
}

/**
 * The macOS and Linux `codex` launcher is a Node script with a
 * `#!/usr/bin/env node` shebang, so the spawned child needs a PATH that
 * actually contains node - the trimmed PATH handed to MCP servers does not.
 */
export function spawnEnv(extra = {}) {
  const separator = IS_WINDOWS ? ";" : ":";
  const systemDirs = IS_WINDOWS
    ? []
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const merged = [path.dirname(process.execPath), ...systemDirs, ...(process.env.PATH ?? "").split(separator)]
    .filter(Boolean)
    .filter((dir, index, all) => all.indexOf(dir) === index)
    .join(separator);
  return { ...process.env, PATH: merged, ...extra };
}

export function claudeDesktopConfigPath() {
  const home = homeDir();
  if (IS_MACOS) {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (IS_WINDOWS) {
    const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(roaming, "Claude", "claude_desktop_config.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return path.join(configHome, "Claude", "claude_desktop_config.json");
}

export function launchAgentPath() {
  return path.join(homeDir(), "Library", "LaunchAgents", "com.codex-mcp-bridge.app-server.plist");
}

export const LAUNCH_AGENT_LABEL = "com.codex-mcp-bridge.app-server";

export function codexThreadUrl(threadId) {
  return `${CODEX_THREAD_URL_PREFIX}${threadId}`;
}

export function hasCodexDesktopApp() {
  return IS_MACOS && existsSync(CODEX_DESKTOP_APP_MACOS);
}

export function isLaunchAgentInstalled() {
  return IS_MACOS && existsSync(launchAgentPath());
}

/**
 * The desktop app runs its own stdio app-server against the same ~/.codex
 * sqlite state. A second long-lived app-server contends for that state and the
 * app's UI stutters, so the two should not both sit idle in the background.
 */
export function isDesktopAppServerRunning() {
  if (!IS_MACOS) return false;
  try {
    const out = execFileSync("/bin/ps", ["-Ao", "command="], { maxBuffer: 4 * 1024 * 1024 }).toString();
    return out.split("\n").some((line) => line.includes("ChatGPT.app") && line.includes("app-server"));
  } catch {
    return false;
  }
}

/**
 * Bring a thread to the foreground in the Codex desktop app so a human can
 * watch the turn run instead of only reading the transcript afterwards.
 * macOS registers the `codex://` scheme through /Applications/ChatGPT.app.
 */
export async function openThreadInCodexApp(threadId, { activate = true } = {}) {
  const url = codexThreadUrl(threadId);
  if (!IS_MACOS) {
    throw new Error(`Opening a Codex thread in the desktop app is macOS-only. Open ${url} manually.`);
  }
  if (!hasCodexDesktopApp()) {
    throw new Error(`Codex desktop app not found at ${CODEX_DESKTOP_APP_MACOS}. Install it to use ${url}.`);
  }
  const args = activate ? [url] : ["-g", url];
  await execFileAsync("open", args, { timeout: 10000 });
  return url;
}
