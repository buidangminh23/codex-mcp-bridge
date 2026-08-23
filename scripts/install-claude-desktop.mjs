#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_LABEL, claudeDesktopConfigPath, resolveCodexBin } from "../src/platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = process.env.CLAUDE_DESKTOP_CONFIG ?? claudeDesktopConfigPath();
const reset = process.argv.includes("--reset");

/**
 * When the package is installed as a dependency its own directory is never a
 * workspace anybody wants to drive Codex in - defaulting to it produces an
 * entry that starts fine and then refuses every thread. Fall back to the
 * directory the operator ran the installer from instead, and say so out loud.
 */
const installedAsDependency = root.split(path.sep).includes("node_modules");
const defaultRoots = installedAsDependency ? process.cwd() : root;

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
const previousEnv = (reset ? {} : cfg.mcpServers["codex-bridge"]?.env) ?? {};
const settled = (name, fallback) => process.env[name] ?? previousEnv[name] ?? fallback;

const kept = Object.keys(previousEnv).filter(
  (name) => process.env[name] === undefined && name !== "CODEX_BIN",
);

cfg.mcpServers["codex-bridge"] = {
  command: nodeBin,
  args: [path.join(root, "src", "index.mjs")],
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
    CODEX_BRIDGE_APPROVAL_POLICY: settled("CODEX_BRIDGE_APPROVAL_POLICY", "on-request"),
    /**
     * Written out even at its default so it is visible in the file. Left
     * implicit, the one setting that decides whether the bridge can reach a
     * thread a human opened is a variable you have to already know exists -
     * and the symptom when you do not, every thread answering NOT AUTHORIZED,
     * points nowhere near it.
     */
    CODEX_BRIDGE_THREAD_POLICY: settled("CODEX_BRIDGE_THREAD_POLICY", "owned"),
    CODEX_BRIDGE_SANDBOX: settled("CODEX_BRIDGE_SANDBOX", "workspace-write"),
    ...(process.env.CODEX_BRIDGE_MODEL ? { CODEX_BRIDGE_MODEL: process.env.CODEX_BRIDGE_MODEL } : {}),
    ...(process.env.CODEX_BRIDGE_EFFORT ? { CODEX_BRIDGE_EFFORT: process.env.CODEX_BRIDGE_EFFORT } : {}),
  },
};

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

console.log("\nRestart Claude Desktop to load the bridge.");
