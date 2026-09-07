#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IS_WINDOWS, PLATFORM_LABEL, claudeDesktopConfigPath, resolveCodexBin } from "../src/platform.mjs";
import { desktopTasksConfigured } from "../src/native-relay.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { createReleaseSnapshot, snapshotRoot } from "../src/release-snapshot.mjs";

exitForVersionRequest(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = process.env.CLAUDE_DESKTOP_CONFIG ?? claudeDesktopConfigPath();
const reset = process.argv.includes("--reset");

/**
 * This bridge is intentionally the local hand-off point between Claude and
 * Codex. A thread can have been opened from any checkout on this machine (or
 * report a checkout from another machine), so a machine-specific install path
 * is the wrong default: it starts successfully and then refuses the useful
 * thread. The bridge still resolves/remaps the reported cwd and requires a
 * usable directory before it acts.
 */
const defaultRoots = "*";

const nodeBin = process.env.NODE_EXE ?? process.execPath;
const codexBin = resolveCodexBin(process.env.CODEX_EXE);

if (!fs.existsSync(nodeBin)) throw new Error(`node executable not found: ${nodeBin}`);
if (!path.isAbsolute(codexBin) || !fs.existsSync(codexBin)) {
  throw new Error(
    `codex binary not found (resolved to "${codexBin}"). Set CODEX_EXE to the absolute path of the codex CLI.`,
  );
}

fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
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
const previousEntry = (reset ? {} : cfg.mcpServers["codex-bridge"]) ?? {};
const previousEnv = previousEntry.env ?? {};
const settled = (name, fallback) => process.env[name] ?? previousEnv[name] ?? fallback;
const desktopMode = settled("CODEX_BRIDGE_DESKTOP_TASKS", desktopTasksConfigured() ? "1" : "0");

const kept = Object.keys(previousEnv).filter(
  (name) => process.env[name] === undefined && name !== "CODEX_BIN",
);

cfg.mcpServers["codex-bridge"] = {
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
    CODEX_BRIDGE_APPROVAL_POLICY: settled("CODEX_BRIDGE_APPROVAL_POLICY", "on-request"),
    /**
     * Written out even at its default so it is visible in the file. Left
     * implicit, the one setting that decides whether the bridge can reach a
     * thread a human opened is a variable you have to already know exists -
     * and the symptom when you do not, every thread answering NOT AUTHORIZED,
     * points nowhere near it.
     */
    CODEX_BRIDGE_THREAD_POLICY: settled("CODEX_BRIDGE_THREAD_POLICY", "roots"),
    CODEX_BRIDGE_SANDBOX: settled("CODEX_BRIDGE_SANDBOX", "workspace-write"),
    CODEX_BRIDGE_OPEN_IN_APP: settled("CODEX_BRIDGE_OPEN_IN_APP", IS_WINDOWS ? "1" : "0"),
    CODEX_BRIDGE_RELEASE_AFTER_TURN: settled("CODEX_BRIDGE_RELEASE_AFTER_TURN", IS_WINDOWS ? "1" : "0"),
    CODEX_BRIDGE_DESKTOP_TASKS: desktopMode,
    CODEX_BRIDGE_AUTOSTART: desktopMode === "1" ? "0" : settled("CODEX_BRIDGE_AUTOSTART", "1"),
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

createReleaseSnapshot(root, { cache: snapshotRoot({ ...process.env, ...cfg.mcpServers["codex-bridge"].env }) });

if (fs.existsSync(cfgPath)) {
  const backup = `${cfgPath}.bak-${new Date().toISOString().slice(0, 10)}-codexbridge`;
  if (!fs.existsSync(backup)) fs.copyFileSync(cfgPath, backup);
}
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

console.log(`platform: ${PLATFORM_LABEL}`);
console.log(`updated ${cfgPath}`);
console.log(JSON.stringify(cfg.mcpServers["codex-bridge"], null, 2));

if (reset) {
  console.log("\n--reset: existing values were discarded in favour of the defaults.");
} else if (kept.length) {
  console.log(`\nkept from the existing entry: ${kept.join(", ")}`);
  console.log("Pass the variable to override one, or --reset to drop them all.");
}

const writtenRoots = cfg.mcpServers["codex-bridge"].env.CODEX_BRIDGE_ALLOWED_ROOTS;
if (writtenRoots.split(path.delimiter).some((entry) => entry.split(path.sep).includes("node_modules"))) {
  console.log(
    "\nWARNING: CODEX_BRIDGE_ALLOWED_ROOTS points inside an install directory, which is not a workspace.\n" +
      "The bridge will start but refuse every thread. Re-run with the projects you actually work in:\n" +
      `  CODEX_BRIDGE_ALLOWED_ROOTS="${["<project-a>", "<project-b>"].join(path.delimiter)}" codex-mcp-bridge-install`,
  );
}

if (cfg.mcpServers["codex-bridge"].env.CODEX_BRIDGE_THREAD_POLICY === "owned") {
  console.log(
    "\nNOTE: thread policy is `owned` - this bridge may only act on threads it created itself.\n" +
      "A thread you open in the Codex app or the VS Code extension will answer NOT AUTHORIZED,\n" +
      "because its id is assigned as it opens and cannot be allowlisted in advance. To let the\n" +
      "bridge reach any thread working inside CODEX_BRIDGE_ALLOWED_ROOTS, re-run with:\n" +
      "  CODEX_BRIDGE_THREAD_POLICY=roots codex-mcp-bridge-install",
  );
}

console.log("\nReconnect codex-bridge once in the existing Claude task to load the supervisor. Subsequent compatible installed-source updates reload automatically when the worker is safely idle.");
console.log("Verify codex_bridge_status from that task: autoReload must be enabled and runtime state must be current. A separate diagnostic process does not verify the app's loaded MCP process.");
