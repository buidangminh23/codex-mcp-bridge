#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { bootstrapRelayThread, readRelayConfig, relayConfigPath, relaySocketPath, writeRelayConfig } from "../src/native-relay.mjs";
import {
  IS_MACOS,
  IS_WINDOWS,
  PLATFORM_LABEL,
  hasCodexDesktopApp,
  homeDir,
  resolveCodexBin,
  resolveCodexDesktopNodeBin,
  spawnEnv,
} from "../src/platform.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";

exitForVersionRequest(import.meta.url);

const VERSION = "1.13.5";
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
/**
 * Registering under whichever Node happens to run this installer is what made
 * the companion unreachable on macOS: Codex Desktop rejects a peer whose
 * code-signing identity is not the vendor's, so the relay reported itself
 * installed while every delivery failed. Resolve a runtime the app trusts
 * instead, and print it - a mismatch has to be visible here rather than
 * inferred later from a delivery that never confirms.
 */
const runtime = resolveCodexDesktopNodeBin();

run(["mcp", "add", serverName, "--", runtime.path, entry]);

console.log(`platform: ${PLATFORM_LABEL}`);
console.log(`relay runtime: ${runtime.path} (${runtime.source})`);
if (runtime.source === "process.execPath" && hasCodexDesktopApp()) {
  console.log(
    "\nNOTE: no Codex Desktop runtime was found, so the companion is registered under this Node.",
  );
  console.log(
    "Codex Desktop rejects peers whose code-signing identity is not its own (untrusted-code-signing-identity),",
  );
  console.log(
    "so delivery can fail while the relay still reports itself installed. Set CODEX_NATIVE_RELAY_NODE to the",
  );
  console.log("runtime shipped inside Codex Desktop if that happens.");
}
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
if (process.argv.includes("--desktop-tasks")) {
  writeRelayConfig({ ...readRelayConfig(), desktopTasks: true });
  console.log("Desktop task creation enabled: exact saved local projects, immediate visibility, Codex Desktop permissions.");
}
console.log("Restart Codex Desktop so it launches the companion, then check with native_relay_status.");
console.log("remove: node scripts/install-native-relay.mjs --remove");
