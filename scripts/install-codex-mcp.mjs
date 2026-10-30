#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_LABEL, resolveCodexBin, spawnEnv } from "../src/platform.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { desktopTasksConfigured } from "../src/native-relay.mjs";
import { applyStdioMcpRegistration, codexMcpRegistration } from "../src/codex-mcp-registration.mjs";
import { createReleaseSnapshot, snapshotRoot } from "../src/release-snapshot.mjs";
import { codexAccessPaths, enableCodexFullAccess, fullAccessEnabled } from "../src/codex-full-access.mjs";
import { stableInstallPath, stableNodeBin } from "../src/install-paths.mjs";

exitForVersionRequest(import.meta.url);

const root = stableInstallPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const nodeBin = process.env.NODE_EXE ?? stableNodeBin();
const codexBin = resolveCodexBin(process.env.CODEX_EXE);
const serverName = process.env.CLAUDE_BRIDGE_NAME ?? "claude-bridge";
const entry = path.join(root, "src", "mcp-supervisor.mjs");
const entryArgs = ["claude-bridge.mjs"];
const remove = process.argv.includes("--remove");
if (!remove && (process.argv.includes("--full-access") || !process.argv.includes("--setup") && fullAccessEnabled())) enableCodexFullAccess();
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

const servers = JSON.parse(run(["mcp", "list", "--json"]));
if (!Array.isArray(servers)) throw new Error("Codex returned an invalid MCP inventory; existing configuration was not changed");
const existing = servers.some((server) => server.name === serverName)
  ? JSON.parse(run(["mcp", "get", serverName, "--json"])) : null;
const registration = codexMcpRegistration({ name: serverName, existing, node: nodeBin, entry, entryArgs, env: process.env, desktopOnly: desktopTasksConfigured() });
createReleaseSnapshot(root, { cache: snapshotRoot({ ...process.env, ...registration.environment }) });
const applied = applyStdioMcpRegistration({ name: serverName, registration, existing, run, configPath: codexAccessPaths().config });

console.log(`platform: ${PLATFORM_LABEL}`);
console.log(`registered MCP server "${serverName}" with Codex (${applied.mode === "retarget" ? "existing entry retargeted in place; its other settings were kept" : "codex mcp add"}):`);
console.log(`command: ${nodeBin} ${entry} ${entryArgs.join(" ")}`);
console.log(`environment keys: ${registration.environmentKeys.join(", ")}`);
console.log("\nOne-time step: after active Codex work finishes, quit and reopen Codex Desktop once so it starts the supervisor. Later compatible installed updates reload automatically when the worker is idle. Do not create a replacement task.");
console.log("Verify claude_bridge_status from an existing task: it must report \"automatic reload: current\" with a supervisor pid, runtime state current, and the session policy of this installation. A separate diagnostic process does not verify the app's loaded MCP process.");
console.log(`remove: node scripts/install-codex-mcp.mjs --remove`);
