#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { IS_WINDOWS, PLATFORM_LABEL, claudeDesktopConfigPath, homeDir, resolveCodexBin } from "../src/platform.mjs";
import { readRegularConfigFile } from "../src/project-policy.mjs";
import { desktopTasksConfigured } from "../src/native-relay.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { createReleaseSnapshot, snapshotRoot } from "../src/release-snapshot.mjs";
import { enableCodexFullAccess, fullAccessEnabled } from "../src/codex-full-access.mjs";
import { stableInstallPath, stableNodeBin } from "../src/install-paths.mjs";

exitForVersionRequest(import.meta.url);

const root = stableInstallPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const cfgPath = process.env.CLAUDE_DESKTOP_CONFIG ?? claudeDesktopConfigPath();
const reset = process.argv.includes("--reset");
const forceDesktopTasks = process.argv.includes("--desktop-tasks");
const fullAccess = process.argv.includes("--full-access") || fullAccessEnabled();

/**
 * This bridge is intentionally the local hand-off point between Claude and
 * Codex. A thread can have been opened from any checkout on this machine (or
 * report a checkout from another machine), so a machine-specific install path
 * is the wrong default: it starts successfully and then refuses the useful
 * thread. The bridge still resolves/remaps the reported cwd and requires a
 * usable directory before it acts.
 */
const defaultRoots = "*";

const nodeBin = process.env.NODE_EXE ?? stableNodeBin();
const codexBin = resolveCodexBin(process.env.CODEX_EXE);

if (!fs.existsSync(nodeBin)) throw new Error(`node executable not found: ${nodeBin}`);
if (!path.isAbsolute(codexBin) || !fs.existsSync(codexBin)) {
  throw new Error(
    `codex binary not found (resolved to "${codexBin}"). Set CODEX_EXE to the absolute path of the codex CLI.`,
  );
}

fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

function readConfig() {
  let descriptor;
  try {
    const before = fs.lstatSync(cfgPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4n * 1024n * 1024n) throw new Error("Unsafe Desktop configuration file");
    descriptor = fs.openSync(cfgPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
    const matches = (left, right) => fields.every(field => left[field] === right[field]);
    if (!opened.isFile() || opened.nlink !== 1n || !matches(before, opened)) throw new Error("Desktop configuration changed during access");
    const data = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw new Error("Desktop configuration changed during access");
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(cfgPath, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !matches(opened, after) || !matches(after, current)) throw new Error("Desktop configuration changed during access");
    return { data, version: fields.map(field => current[field]) };
  } catch (error) {
    if (error.code === "ENOENT" && descriptor === undefined) return null;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

const original = readConfig();
const cfg = original ? JSON.parse(original.data.toString("utf8")) : {};
cfg.mcpServers = cfg.mcpServers ?? {};

/**
 * Re-running the installer used to assign a whole new entry over the old one,
 * which silently deleted every setting the installer does not itself write -
 * CODEX_BRIDGE_ALLOWED_THREADS and a hand-added CODEX_BRIDGE_THREAD_POLICY
 * among them - and reset CODEX_BRIDGE_ALLOWED_ROOTS back to the install
 * directory. Upgrading is the moment people re-run this, so the command they
 * reach for to keep the bridge current was the command that broke it.
 *
 * Existing values are now the fallback rather than the casualty. Precedence,
 * highest first: an environment variable passed to this run, what the config
 * already says, then the default. `--reset` drops the middle one for the rare
 * case of wanting the defaults back.
 */
const KNOWN_ENTRY_NAMES = new Set(["codex-bridge", "codex-bridge-desktop"]);
const sourceDirectories = new Set([path.join(root, "src"), path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src")]);
const runsThisBridge = (entry) => {
  const script = entry?.args?.[0];
  if (typeof script !== "string" || !sourceDirectories.has(path.dirname(path.resolve(script)))) return false;
  const name = path.basename(script);
  return name === "index.mjs" || name === "mcp-supervisor.mjs" && entry.args[1] === "index.mjs";
};
const bridgeEntries = Object.keys(cfg.mcpServers).filter((name) => KNOWN_ENTRY_NAMES.has(name) || runsThisBridge(cfg.mcpServers[name]));
if (bridgeEntries.length > 1) {
  throw new Error(`Claude Desktop already has several bridge entries (${bridgeEntries.join(", ")}); remove all but one and re-run. No configuration was changed.`);
}
const entryName = bridgeEntries[0] ?? "codex-bridge";
if (fullAccess) enableCodexFullAccess();

const previousEntry = (reset ? {} : cfg.mcpServers[entryName]) ?? {};
const previousEnv = previousEntry.env ?? {};
const settled = (name, fallback) => process.env[name] ?? previousEnv[name] ?? fallback;
const desktopMode = forceDesktopTasks ? "1" : settled("CODEX_BRIDGE_DESKTOP_TASKS");
const desktopEnabled = desktopMode === undefined ? desktopTasksConfigured() : desktopMode === "1";

const kept = Object.keys(previousEnv).filter(
  (name) => process.env[name] === undefined && name !== "CODEX_BIN" &&
    !(forceDesktopTasks && name === "CODEX_BRIDGE_DESKTOP_TASKS") &&
    !(desktopEnabled && name === "CODEX_BRIDGE_AUTOSTART"),
);

cfg.mcpServers[entryName] = {
  ...previousEntry,
  command: nodeBin,
  args: [path.join(root, "src", "mcp-supervisor.mjs"), "index.mjs"],
  env: {
    /**
     * Keys this installer knows nothing about survive too - a setting added by
     * a later version, or by hand, is not this script's to throw away.
     */
    ...previousEnv,
    /**
     * These three are the point of re-running: they name where the code and
     * the codex binary actually live now, so they are resolved fresh rather
     * than inherited.
     */
    CODEX_BIN: codexBin,
    CODEX_APP_SERVER_URL: settled("CODEX_APP_SERVER_URL", "ws://127.0.0.1:8791"),
    CODEX_BRIDGE_ALLOWED_ROOTS: settled("CODEX_BRIDGE_ALLOWED_ROOTS", defaultRoots),
    CODEX_BRIDGE_APPROVAL: settled("CODEX_BRIDGE_APPROVAL", "deny"),
    CODEX_BRIDGE_AUTO_APPROVE_ACK: settled("CODEX_BRIDGE_AUTO_APPROVE_ACK", "0"),
    CODEX_BRIDGE_APPROVAL_POLICY: fullAccess ? "never" : settled("CODEX_BRIDGE_APPROVAL_POLICY", "on-request"),
    CODEX_BRIDGE_ENFORCE_FULL_ACCESS: fullAccess ? "1" : settled("CODEX_BRIDGE_ENFORCE_FULL_ACCESS", "0"),
    /**
     * Written out even at its default so it is visible in the file. Left
     * implicit, the one setting that decides whether the bridge can reach a
     * thread a human opened is a variable you have to already know exists -
     * and the symptom when you do not, every thread answering NOT AUTHORIZED,
     * points nowhere near it.
     */
    CODEX_BRIDGE_THREAD_POLICY: settled("CODEX_BRIDGE_THREAD_POLICY", "roots"),
    CODEX_BRIDGE_SANDBOX: fullAccess ? "danger-full-access" : settled("CODEX_BRIDGE_SANDBOX", "workspace-write"),
    CODEX_BRIDGE_OPEN_IN_APP: settled("CODEX_BRIDGE_OPEN_IN_APP", IS_WINDOWS ? "1" : "0"),
    CODEX_BRIDGE_RELEASE_AFTER_TURN: settled("CODEX_BRIDGE_RELEASE_AFTER_TURN", IS_WINDOWS ? "1" : "0"),
    ...(desktopMode !== undefined ? { CODEX_BRIDGE_DESKTOP_TASKS: desktopMode } : {}),
    CODEX_BRIDGE_AUTOSTART: desktopEnabled ? "0" : settled("CODEX_BRIDGE_AUTOSTART", "1"),
    ...(process.env.CODEX_BRIDGE_ALLOWED_THREADS !== undefined
      ? { CODEX_BRIDGE_ALLOWED_THREADS: process.env.CODEX_BRIDGE_ALLOWED_THREADS }
      : {}),
    ...(process.env.CODEX_BRIDGE_PATH_MAP !== undefined
      ? { CODEX_BRIDGE_PATH_MAP: process.env.CODEX_BRIDGE_PATH_MAP }
      : {}),
    ...(process.env.CODEX_BRIDGE_MODEL ? { CODEX_BRIDGE_MODEL: process.env.CODEX_BRIDGE_MODEL } : {}),
    ...(process.env.CODEX_BRIDGE_EFFORT ? { CODEX_BRIDGE_EFFORT: process.env.CODEX_BRIDGE_EFFORT } : {}),
    ...(process.env.CLAUDE_DESKTOP_USER_DATA !== undefined
      ? { CLAUDE_DESKTOP_USER_DATA: process.env.CLAUDE_DESKTOP_USER_DATA }
      : {}),
  },
};

createReleaseSnapshot(root, { cache: snapshotRoot({ ...process.env, ...cfg.mcpServers[entryName].env }) });

const backup = `${cfgPath}.bak-${new Date().toISOString().slice(0, 10)}-codexbridge`;
if (original) {
  try { fs.writeFileSync(backup, original.data, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
const temporary = `${cfgPath}.${randomUUID()}.tmp`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(cfg, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const current = readConfig();
  if (original === null ? current !== null : current === null || !original.data.equals(current.data) || original.version.some((value, index) => value !== current.version[index])) {
    throw new Error("Desktop configuration changed during installation; retry after the other writer finishes");
  }
  fs.renameSync(temporary, cfgPath);
} finally {
  try { fs.unlinkSync(temporary); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

console.log(`platform: ${PLATFORM_LABEL}`);
console.log(`updated ${cfgPath} (entry ${entryName})`);
console.log(JSON.stringify(cfg.mcpServers[entryName], null, 2));
console.log(`Desktop tasks: ${desktopEnabled ? "enabled" : "disabled"} (${desktopMode === undefined ? "automatic relay configuration" : forceDesktopTasks ? "--desktop-tasks" : "explicit environment setting"}).`);

if (reset) {
  console.log("\n--reset: existing values were discarded in favour of the defaults.");
} else if (kept.length) {
  console.log(`\nkept from the existing entry: ${kept.join(", ")}`);
  console.log("Pass the variable to override one, or --reset to drop them all.");
}

const writtenRoots = cfg.mcpServers[entryName].env.CODEX_BRIDGE_ALLOWED_ROOTS;
if (writtenRoots.split(path.delimiter).some((entry) => entry.split(path.sep).includes("node_modules"))) {
  console.log(
    "\nWARNING: CODEX_BRIDGE_ALLOWED_ROOTS points inside an install directory, which is not a workspace.\n" +
      "The bridge will start but refuse every thread. Re-run with the projects you actually work in:\n" +
      `  CODEX_BRIDGE_ALLOWED_ROOTS="${["<project-a>", "<project-b>"].join(path.delimiter)}" codex-mcp-bridge-install`,
  );
}

if (cfg.mcpServers[entryName].env.CODEX_BRIDGE_THREAD_POLICY === "owned") {
  console.log(
    "\nNOTE: thread policy is `owned` - this bridge may only act on threads it created itself.\n" +
      "A thread you open in the Codex app or the VS Code extension will answer NOT AUTHORIZED,\n" +
      "because its id is assigned as it opens and cannot be allowlisted in advance. To let the\n" +
      "bridge reach any thread working inside CODEX_BRIDGE_ALLOWED_ROOTS, re-run with:\n" +
      "  CODEX_BRIDGE_THREAD_POLICY=roots codex-mcp-bridge-install",
  );
}

if (entryName === "codex-bridge") {
  const codeConfig = path.join(process.env.CLAUDE_CONFIG_DIR || homeDir(), ".claude.json");
  let codeEntry;
  try { codeEntry = JSON.parse(readRegularConfigFile(codeConfig, { missing: true, maxBytes: 8 * 1024 * 1024 }) ?? "{}").mcpServers?.["codex-bridge"]; } catch {}
  if (codeEntry) {
    console.log(
      `\nWARNING: ${codeConfig} also registers codex-bridge for Claude Code. A Desktop entry with the same name can\n` +
        "shadow it inside Code sessions and hide the calling task. Rename this Desktop entry, for example to\n" +
        "codex-bridge-desktop; later installer runs update the renamed entry in place.",
    );
  }
}

console.log("\nReconnect codex-bridge once in the existing Claude task to load the supervisor. Subsequent compatible installed-source updates reload automatically when the worker is safely idle.");
console.log("Verify codex_bridge_status from that task: autoReload must be enabled and runtime state must be current. A separate diagnostic process does not verify the app's loaded MCP process.");
if (desktopEnabled) console.log("Verify Desktop tasks are enabled and the native relay is available. Configuration changes require MCP reconnect even when source auto-reload is enabled; keep the destination task open in Codex Desktop.");
