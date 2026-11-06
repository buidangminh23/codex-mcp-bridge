import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { awaitBridgeRuntimes, classifyBridgeRuntimes, discoverBridgeInstalls, installPrefix, probeNativeRelay } from "../src/bridge-installs.mjs";
import { activeClaudeDataRoot, claudeDataPinUsable, relayClaudeDataPin, repairClaudeDataPin } from "../src/claude-data-pin.mjs";
import { currentInstallFile, isManagedInstall, newerVersion, readCurrentInstall, writeCurrentInstall } from "../src/current-install.mjs";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function sandbox(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "update-freshness-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, "Roaming"), LOCALAPPDATA: path.join(directory, "Local"), CODEX_HOME: path.join(directory, ".codex"), PATH: "" };
  fs.mkdirSync(env.CODEX_HOME);
  return { directory, env };
}

function install(directory, name, version) {
  const root = path.join(directory, name, "node_modules", "@minhspark", "codex-mcp-bridge");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "mcp-supervisor.mjs"), "");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@minhspark/codex-mcp-bridge", version }));
  return root;
}

function claude(directory, name, account = ACCOUNT) {
  const root = path.join(directory, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ lastKnownAccountUuid: account, windowSizeWasSignedIn: true }));
  return root;
}

test("running supervisors follow the recorded installation only when it is at least as new", (t) => {
  const { directory, env } = sandbox(t);
  const own = install(directory, "machine", "2.2.0");
  const newer = install(directory, "user", "2.3.0");
  assert.equal(readCurrentInstall({ env, ownRoot: own }), null);
  assert.equal(writeCurrentInstall({ env, root: newer, claudeDataRoot: path.join(directory, "Claude") }), true);
  assert.deepEqual(readCurrentInstall({ env, ownRoot: own }), { packageRoot: newer, version: "2.3.0", claudeDataRoot: path.join(directory, "Claude") });
  fs.writeFileSync(path.join(own, "package.json"), JSON.stringify({ name: "@minhspark/codex-mcp-bridge", version: "2.4.0" }));
  assert.equal(readCurrentInstall({ env, ownRoot: own }), null);
});

test("a half-installed, foreign or malformed target is never followed", (t) => {
  const { directory, env } = sandbox(t);
  const own = install(directory, "machine", "2.2.0");
  const newer = install(directory, "user", "2.3.0");
  writeCurrentInstall({ env, root: newer });
  fs.rmSync(path.join(newer, "src", "mcp-supervisor.mjs"));
  assert.equal(readCurrentInstall({ env, ownRoot: own }), null);
  for (const text of ["not json", JSON.stringify({ schemaVersion: 1, packageRoot: "relative" }), JSON.stringify({ schemaVersion: 2, packageRoot: own })]) {
    fs.writeFileSync(currentInstallFile(env), text);
    assert.equal(readCurrentInstall({ env, ownRoot: own }), null);
  }
  const foreign = path.join(directory, "foreign");
  fs.mkdirSync(path.join(foreign, "src"), { recursive: true });
  fs.writeFileSync(path.join(foreign, "src", "mcp-supervisor.mjs"), "");
  fs.writeFileSync(path.join(foreign, "package.json"), JSON.stringify({ name: "someone-else", version: "9.0.0" }));
  fs.writeFileSync(currentInstallFile(env), JSON.stringify({ schemaVersion: 1, packageRoot: foreign }));
  assert.equal(readCurrentInstall({ env, ownRoot: own }), null);
});

test("a checkout is not recorded as the current installation", (t) => {
  const { directory, env } = sandbox(t);
  const checkout = path.join(directory, "checkout");
  fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
  fs.writeFileSync(path.join(checkout, "src", "mcp-supervisor.mjs"), "");
  fs.writeFileSync(path.join(checkout, "package.json"), JSON.stringify({ name: "@minhspark/codex-mcp-bridge", version: "9.0.0" }));
  assert.equal(isManagedInstall(checkout), false);
  assert.equal(writeCurrentInstall({ env, root: checkout }), false);
  assert.equal(fs.existsSync(currentInstallFile(env)), false);
  assert.equal(newerVersion("2.3.0", "2.2.9"), true);
  assert.equal(newerVersion("2.3.0-beta.1", "2.3.0"), false);
});

test("setup replaces a stale pin and keeps one that still has account state", (t) => {
  const { directory, env } = sandbox(t);
  const active = claude(directory, path.join("Roaming", "Claude"));
  const stale = path.join(directory, "moved-away");
  fs.mkdirSync(stale);
  const explicit = claude(directory, "explicit", OTHER);
  assert.equal(repairClaudeDataPin({ env: { ...env, CLAUDE_DESKTOP_USER_DATA: stale }, platform: "win32" }).CLAUDE_DESKTOP_USER_DATA, active);
  assert.equal(repairClaudeDataPin({ env: { ...env, CLAUDE_DESKTOP_USER_DATA: explicit }, platform: "win32" }).CLAUDE_DESKTOP_USER_DATA, explicit);
  assert.equal(repairClaudeDataPin({ env, platform: "win32" }).CLAUDE_DESKTOP_USER_DATA, undefined);
  assert.equal(claudeDataPinUsable({ ...env, CLAUDE_DESKTOP_USER_DATA: stale }, "win32"), false);
  assert.equal(activeClaudeDataRoot({ ...env, CLAUDE_DESKTOP_USER_DATA: stale }, "win32"), active);
});

test("setup repairs a stale pin saved in a client entry even when the shell has none", (t) => {
  const { directory, env } = sandbox(t);
  const active = claude(directory, path.join("Roaming", "Claude"));
  const stale = path.join(directory, "moved-away");
  fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `[mcp_servers.claude-bridge.env]\nCLAUDE_DESKTOP_USER_DATA = '${stale}'\n`);
  assert.equal(repairClaudeDataPin({ env, platform: "win32" }).CLAUDE_DESKTOP_USER_DATA, active);
  fs.writeFileSync(path.join(directory, ".claude.json"), JSON.stringify({ mcpServers: { "codex-bridge": { env: { CLAUDE_DESKTOP_USER_DATA: active } } } }));
  fs.writeFileSync(path.join(env.CODEX_HOME, "config.toml"), `CLAUDE_DESKTOP_USER_DATA = "${active.replace(/\\/g, "\\\\")}"\n`);
  assert.equal(repairClaudeDataPin({ env, platform: "win32" }).CLAUDE_DESKTOP_USER_DATA, undefined);
});

test("nothing is repaired when no Claude data root can be identified", (t) => {
  const { directory, env } = sandbox(t);
  const stale = path.join(directory, "moved-away");
  const pinned = { ...env, CLAUDE_DESKTOP_USER_DATA: stale };
  assert.equal(repairClaudeDataPin({ env: pinned, platform: "win32" }), pinned);
  assert.equal(relayClaudeDataPin(pinned, "win32"), null);
  assert.equal(activeClaudeDataRoot(pinned, "win32"), null);
});

test("other installations come from PATH and client entries, once each, without the updater's own", (t) => {
  const { directory, env } = sandbox(t);
  const machine = install(directory, "machine", "2.2.0");
  const user = install(path.join(directory, "Roaming"), "npm", "2.2.0");
  const referenced = install(directory, "referenced", "2.1.0");
  const own = install(directory, "own", "2.3.0");
  fs.writeFileSync(path.join(directory, ".claude.json"), JSON.stringify({ mcpServers: { a: { args: [path.join(referenced, "src", "mcp-supervisor.mjs")] }, b: { args: [path.join(machine, "src", "index.mjs")] } } }));
  const found = discoverBridgeInstalls({ env: { ...env, PATH: [path.join(directory, "machine"), path.join(directory, "own"), path.join(directory, "empty"), "%NVM_HOME%"].join(path.delimiter) }, platform: "win32", exclude: [own] });
  assert.deepEqual(found.sort(), [machine, referenced, user].sort());
});

test("installation prefixes match each platform's npm layout", () => {
  assert.equal(installPrefix(path.join("P", "node_modules", "@minhspark", "codex-mcp-bridge"), "win32"), "P");
  assert.equal(installPrefix(path.join("P", "lib", "node_modules", "@minhspark", "codex-mcp-bridge"), "darwin"), "P");
});

test("running workers and the daemon are read from their command lines, spaces included", (t) => {
  const { directory } = sandbox(t);
  const hash = "a".repeat(64);
  const runtime = path.join(directory, "home dir", ".codex", "bridge-runtimes", hash);
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ version: "2.2.0" }));
  const daemon = install(path.join(directory, "home dir"), "npm", "2.3.0");
  const runtimes = classifyBridgeRuntimes([
    `"node" "${path.join(runtime, "src", "index.mjs")}"`,
    `"node" "${path.join(daemon, "src", "background-relay-daemon.mjs")}"`,
    `"node" "${path.join(daemon, "src", "mcp-supervisor.mjs")}" index.mjs`,
    "node something-else.mjs",
  ]);
  assert.deepEqual(runtimes, [{ entry: "index.mjs", version: "2.2.0" }, { entry: "background-relay-daemon.mjs", version: "2.3.0" }]);
});

test("the update waits for running workers and names the ones that stay behind", async (t) => {
  const { directory } = sandbox(t);
  const write = (name, version) => {
    const hash = name.repeat(64);
    const runtime = path.join(directory, "bridge-runtimes", hash);
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "package.json"), JSON.stringify({ version }));
    return `"node" "${path.join(runtime, "src", "index.mjs")}"`;
  };
  const old = write("a", "2.2.0");
  const fresh = write("b", "2.3.0");
  let clock = 0;
  const views = [[old, fresh], [fresh, fresh]];
  const settled = await awaitBridgeRuntimes({ version: "2.3.0", list: async () => views.shift(), now: () => clock, sleep: async (ms) => { clock += ms; }, waitMs: 10000 });
  assert.deepEqual(settled, { inspected: true, current: 2, pending: [] });
  clock = 0;
  const stuck = await awaitBridgeRuntimes({ version: "2.3.0", list: async () => [old], now: () => clock, sleep: async (ms) => { clock += ms; }, waitMs: 4000 });
  assert.deepEqual(stuck.pending, [{ entry: "index.mjs", version: "2.2.0" }]);
  assert.deepEqual(await awaitBridgeRuntimes({ version: "2.3.0", list: async () => null }), { inspected: false, current: 0, pending: [] });
});

test("the relay test separates a working, closed and failing relay and retries while it starts", async () => {
  const accounts = { claude: { status: "verified", fingerprint: "c" }, codex: { status: "verified", fingerprint: "x" } };
  const fail = (code) => Object.assign(new Error(code), { code });
  let clock = 0;
  const options = { platform: "win32", readAccounts: () => accounts, now: () => clock, sleep: async (ms) => { clock += ms; }, waitMs: 4000, pollMs: 1000 };
  const answers = [fail("RELAY_UNREACHABLE"), null];
  const requests = [];
  const ready = await probeNativeRelay({ ...options, relay: { requestDesktop: async (...args) => { requests.push(args); const answer = answers.shift(); if (answer) throw answer; } } });
  assert.deepEqual(ready, { state: "ready" });
  assert.equal(requests[0][0], "list_projects");
  assert.deepEqual(requests[0][2].accountContext, { claude: "c", codex: "x" });
  clock = 0;
  assert.deepEqual(await probeNativeRelay({ ...options, relay: { requestDesktop: async () => { throw fail("RELAY_UNREACHABLE"); } } }), { state: "not_listening", code: "RELAY_UNREACHABLE" });
  clock = 0;
  assert.deepEqual(await probeNativeRelay({ ...options, relay: { requestDesktop: async () => { throw fail("BRIDGE_ACCOUNT_CHANGED"); } } }), { state: "failed", code: "BRIDGE_ACCOUNT_CHANGED" });
  clock = 0;
  assert.equal((await probeNativeRelay({ ...options, readAccounts: () => ({ ...accounts, claude: { status: "unavailable" } }), relay: {} })).state, "account_unverified");
  assert.deepEqual(await probeNativeRelay({ ...options, platform: "linux", relay: {} }), { state: "not_applicable" });
});
