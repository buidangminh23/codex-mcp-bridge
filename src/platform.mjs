import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * A drive shared between a dual-boot Windows install and macOS is the case
 * this remapping exists for: the same project is `L:\\X` on one side and
 * `/Volumes/<label>/X` on the other. Both halves are configuration, not facts
 * about any particular machine, so both are overridable - the defaults only
 * decide which pair is probed when nobody says otherwise. Read per call rather
 * than at import, so a client that changes the environment does not have to
 * restart the bridge to be believed.
 */
const remapEnabled = () => process.env.CODEX_BRIDGE_REMAP !== "0";
const shareMount = () => process.env.CODEX_BRIDGE_SHARE_MOUNT || "/Volumes/Win_Dev";
const shareDrive = () => normalizeDriveLetter(process.env.CODEX_BRIDGE_SHARE_DRIVE || "L:");

const homeDir = () => process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();

function normalizeDriveLetter(value) {
  const letter = value.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(letter) ? `${letter}:` : "L:";
}

/**
 * Where the bridge itself is checked out answers the question "where does this
 * user keep projects?" without anyone having to say so: a bridge living in
 * ~/code/codex-mcp-bridge makes ~/code the obvious place to look for a sibling
 * project. That is a measurement, not a guess, and it keeps one developer's
 * directory layout out of the source.
 */
function bridgeParentDir() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return path.dirname(repoRoot);
}

/**
 * Set CODEX_BRIDGE_WORKSPACE_ROOTS to take over the search entirely - it
 * replaces the derived roots rather than adding to them, so the order is
 * exactly what was written.
 */
function workspaceRoots() {
  const configured = process.env.CODEX_BRIDGE_WORKSPACE_ROOTS;
  if (configured) {
    return configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [homeDir(), bridgeParentDir()];
}

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
  ];
}

/**
 * The desktop app ships its own codex build and holds ~/.codex/state_*.sqlite
 * open while it runs. Spawning the app-server from a different CLI build makes
 * two versions write that same state, so prefer the app's binary whenever the
 * app is installed and fall back to the standalone CLI installs otherwise.
 */
function macosCodexCandidates() {
  return [
    hasCodexDesktopApp() ? CODEX_DESKTOP_BIN_MACOS : null,
    ...unixCodexCandidates(),
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
    ...(IS_WINDOWS ? windowsCodexCandidates() : IS_MACOS ? macosCodexCandidates() : unixCodexCandidates()),
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
/**
 * A path is only usable as a Codex cwd when the agent can also write to it.
 * The NTFS mounts this project is shared through are read-only on macOS, so an
 * existence check alone would still hand Codex a directory it cannot edit.
 */
export function isWritableDir(target) {
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeSeparators(input) {
  return input.replace(/\\/g, "/").replace(/\/+$/, "") || input;
}

function shareRelativePath(input) {
  const normalized = normalizeSeparators(input);
  const mount = shareMount();
  if (normalized.toLowerCase().startsWith(`${mount.toLowerCase()}/`)) {
    return normalized.slice(mount.length + 1);
  }
  if (/^[a-z]:\//i.test(normalized) && normalized.slice(0, 2).toUpperCase() === shareDrive()) {
    return normalized.slice(3);
  }
  return null;
}

/**
 * The side the path came from is always tried last: a path quoted from the
 * other machine is the least likely to be the one this machine can write to,
 * and on macOS the NTFS mount is read-only anyway.
 */
function remapCandidates(input) {
  const relative = shareRelativePath(input);
  if (!relative) return [];
  const segments = relative.split("/").filter(Boolean);
  const roots = IS_WINDOWS ? [`${shareDrive()}\\`, ...workspaceRoots()] : [...workspaceRoots(), shareMount()];
  const candidates = roots.map((root) => path.join(root, ...segments));
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

/**
 * The same project lives at a different absolute path on each machine: on the
 * shared drive's own letter under Windows, under its mount point when that
 * drive is visible from macOS, and in a native checkout otherwise, because the
 * mount is read-only there. Handing Codex the wrong one starts the thread
 * against a directory the user is not looking at, or one the agent cannot write
 * to - which then stalls the turn on a permission request instead of failing
 * outright.
 */
export function resolveWorkspacePath(input) {
  if (!input) return { path: input, remapped: false, writable: false, note: null };
  const original = input;
  const candidates = remapEnabled() ? remapCandidates(input) : [];
  const ordered = candidates.length ? candidates : [input];

  const writable = ordered.find((candidate) => existsSync(candidate) && isWritableDir(candidate));
  if (writable) {
    return {
      path: writable,
      remapped: writable !== original,
      writable: true,
      note:
        writable !== original
          ? `cwd remapped for ${PLATFORM_LABEL}: ${original} -> ${writable}`
          : null,
    };
  }

  const existing = ordered.find((candidate) => existsSync(candidate));
  if (existing) {
    return {
      path: existing,
      remapped: existing !== original,
      writable: false,
      note: `cwd ${existing} exists but is not writable on ${PLATFORM_LABEL}; Codex will fail on any file edit.`,
    };
  }

  throw new Error(
    `No usable working directory for "${original}" on ${PLATFORM_LABEL}. Tried: ${ordered.join(", ")}.`,
  );
}

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
