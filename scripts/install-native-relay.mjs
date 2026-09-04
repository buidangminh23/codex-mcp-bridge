#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { bootstrapRelayThread, readRelayConfig, relayConfigPath, relaySocketPath } from "../src/native-relay.mjs";
import { IS_MACOS, PLATFORM_LABEL, homeDir, resolveCodexBin, spawnEnv } from "../src/platform.mjs";

/**
 * Installs the Codex Desktop native relay: registers the companion as an MCP
 * server so Codex Desktop launches it, and bootstraps the executor thread the
 * native dispatch needs.
 *
 * The bootstrap is the one step that has to take a writer lock, and it takes it
 * on a thread that belongs to nobody: a dedicated relay thread, created through
 * an ordinary app-server which is then stopped so the lock is released. After
 * this runs, no part of the relay ever attaches a thread again.
 */

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
  for (const leftover of [relaySocketPath(), relayConfigPath()]) {
    if (fs.existsSync(leftover)) {
      fs.rmSync(leftover, { force: true });
      console.log(`removed ${leftover}`);
    }
  }
  process.exit(0);
}

/**
 * Not a hard failure: the companion is harmless on any platform - it simply
 * never gets a native tools connection to dispatch through - and refusing to
 * register it would make the install order depend on which machine runs it.
 */
if (!IS_MACOS) {
  console.log(`note: the native relay only delivers on macOS; this is ${PLATFORM_LABEL}.`);
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
    clientInfo: { name: "native-relay-install", title: "Native Relay Install", version: "1.11.3" },
    log: (msg) => console.log(`  ${msg}`),
  });
  console.log("\nbootstrapping the relay executor thread...");
  try {
    const { threadId, configPath } = await bootstrapRelayThread(client, { cwd: homeDir() });
    console.log(`relay thread: ${threadId}`);
    console.log(`written to:   ${configPath}`);
  } finally {
    /**
     * The bootstrap thread must not stay locked by this app-server: leaving it
     * held would reintroduce, for the relay's own thread, exactly the writer
     * conflict the relay exists to remove.
     */
    const stopped = await client.stopServer();
    console.log(stopped.stopped ? "released the bootstrap app-server" : `app-server not stopped: ${stopped.reason}`);
  }
}

console.log(`\nrelay socket: ${relaySocketPath()}`);
console.log("Restart Codex Desktop so it launches the companion, then check with native_relay_status.");
console.log("remove: node scripts/install-native-relay.mjs --remove");
