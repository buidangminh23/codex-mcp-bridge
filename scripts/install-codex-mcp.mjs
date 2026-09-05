#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_LABEL, resolveCodexBin, spawnEnv } from "../src/platform.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";

exitForVersionRequest(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexBin = resolveCodexBin(process.env.CODEX_EXE);
const serverName = process.env.CLAUDE_BRIDGE_NAME ?? "claude-bridge";
const entry = path.join(root, "src", "claude-bridge.mjs");
const remove = process.argv.includes("--remove");
const permissionMode = process.env.CLAUDE_BRIDGE_PERMISSION_MODE;
if (!remove && permissionMode && !["bypass", "prompting"].includes(permissionMode)) throw new Error("CLAUDE_BRIDGE_PERMISSION_MODE must be bypass or prompting");

if (!fs.existsSync(entry)) throw new Error(`bridge entry point missing: ${entry}`);
if (!path.isAbsolute(codexBin) || !fs.existsSync(codexBin)) {
  throw new Error(`codex binary not found (resolved to "${codexBin}"). Set CODEX_EXE to its absolute path.`);
}

const run = (args) => execFileSync(codexBin, args, { env: spawnEnv(), stdio: "pipe" }).toString().trim();

if (remove) {
  console.log(run(["mcp", "remove", serverName]) || `removed ${serverName}`);
  process.exit(0);
}

try {
  run(["mcp", "remove", serverName]);
} catch {
  // not registered yet
}

const args = ["mcp", "add", serverName];
const peerName = process.env.CLAUDE_BRIDGE_PEER_NAME;
if (peerName) args.push("--env", `CLAUDE_BRIDGE_PEER_NAME=${peerName}`);
if (permissionMode) args.push("--env", `CLAUDE_BRIDGE_PERMISSION_MODE=${permissionMode}`);
args.push("--", process.execPath, entry);

run(args);

console.log(`platform: ${PLATFORM_LABEL}`);
console.log(`registered MCP server "${serverName}" with Codex:`);
console.log(run(["mcp", "get", serverName]));
console.log("\nRestart the Codex app (or start a new Codex session) to load the bridge.");
console.log(`remove: node scripts/install-codex-mcp.mjs --remove`);
