#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { bootstrapRelayThread, readRelayConfig, relayConfigPath, relaySocketPath } from "../src/native-relay.mjs";
import { IS_MACOS, IS_WINDOWS, PLATFORM_LABEL, homeDir, resolveCodexBin, spawnEnv } from "../src/platform.mjs";

const VERSION = "1.12.5";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "native-relay-companion.mjs");
const serverName = process.env.CODEX_NATIVE_RELAY_NAME ?? "codex-native-relay";
const remove = process.argv.includes("--remove");
const skipBootstrap = process.argv.includes("--no-bootstrap");

const codexBin = resolveCodexBin(process.env.CODEX_EXE);
const run = (args) => execFileSync(codexBin, args, { env: spawnEnv(), stdio: "pipe" }).toString().trim();

if (!fs.existsSync(entry)) throw new Error(`companion entry point missing: ${entry}`);
if (!path.isAbsolute(codexBin) || !fs.existsSync(codexBin)) {
  throw new Error(`codex binary not found (resolved to "${codexBin}"). Set CODEX_EXE to its absolute path.`);
}

if (remove) {
  try {
    console.log(run(["mcp", "remove", serverName]) || `removed ${serverName}`);
  } catch (err) {
    console.log(`${serverName} was not registered (${err.message.trim().split("\n").at(-1)})`);
  }
  for (const leftover of [relayConfigPath(), ...(IS_WINDOWS ? [] : [relaySocketPath()])]) {
    if (fs.existsSync(leftover)) {
      fs.rmSync(leftover, { force: true });
      console.log(`removed ${leftover}`);
    }
  }
  process.exit(0);
}

/**
 * Not a hard failure on an unsupported platform: the companion is harmless and
 * refusing to register it would make the install order depend on which machine
 * runs it.
 */
if (!IS_MACOS && !IS_WINDOWS) {
  console.log(`note: the native relay is unavailable on ${PLATFORM_LABEL}.`);
  console.log("claude-bridge will keep using the app-server path here.");
}

try {
  run(["mcp", "remove", serverName]);
} catch {
  // not registered yet
}
run(["mcp", "add", serverName, "--", process.execPath, entry]);

console.log(`platform: ${PLATFORM_LABEL}`);
console.log(`registered MCP server "${serverName}" with Codex:`);
console.log(run(["mcp", "get", serverName]));

const existing = readRelayConfig()?.relayThreadId;
if (existing) {
  console.log(`\nrelay thread already bootstrapped: ${existing} (${relayConfigPath()})`);
} else if (skipBootstrap) {
  console.log(`\nskipped the relay thread bootstrap; set CODEX_RELAY_ID or rerun without --no-bootstrap.`);
} else {
  const client = new CodexAppServerClient({
    clientInfo: { name: "native-relay-install", title: "Native Relay Install", version: VERSION },
    log: (msg) => console.log(`  ${msg}`),
  });
  console.log("\nbootstrapping the relay executor thread...");
  try {
    const { threadId, configPath, release } = await bootstrapRelayThread(client, { cwd: homeDir() });
    console.log(`relay thread: ${threadId}`);
    console.log(`written to:   ${configPath}`);
    console.log(release.released ? "released the bootstrap thread" : `bootstrap thread release pending: ${release.reason ?? release.status}`);
  } finally {
    await client.close();
  }
}

console.log(`\nrelay socket: ${relaySocketPath()}`);
console.log("Restart Codex Desktop so it launches the companion, then check with native_relay_status.");
console.log("remove: node scripts/install-native-relay.mjs --remove");
