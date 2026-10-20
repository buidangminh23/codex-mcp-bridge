import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supervisor = path.join(repository, "src", "mcp-supervisor.mjs");
const nativePipe = process.platform === "darwin" || process.platform === "win32";
const skip = process.platform === "win32" && "the fake codex executable is a POSIX script";

const FAKE_CODEX = `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
const config = path.join(process.env.CODEX_HOME, "config.toml");
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const read = () => fs.existsSync(config) ? fs.readFileSync(config, "utf8") : "";
function servers(text) {
  const result = {};
  let target = null;
  for (const line of text.split("\\n")) {
    const header = /^\\[mcp_servers\\.([A-Za-z0-9_-]+)(\\.env)?\\]$/.exec(line.trim());
    if (header) { result[header[1]] ??= { env: null }; target = header[2] ? (result[header[1]].env ??= {}) : result[header[1]]; continue; }
    if (/^\\[/.test(line.trim())) { target = null; continue; }
    const pair = /^([A-Za-z0-9_-]+)\\s*=\\s*(.*?)\\s*(#[^"]*)?$/.exec(line);
    if (pair && target) target[pair[1]] = JSON.parse(pair[2]);
  }
  return result;
}
const [command, sub, name, ...rest] = process.argv.slice(2);
if (command !== "mcp") process.exit(2);
const all = servers(read());
if (sub === "list") { process.stdout.write(JSON.stringify(Object.keys(all).map((entry) => ({ name: entry })))); process.exit(0); }
if (sub === "get") {
  const entry = process.env.FAKE_CODEX_STALE_GET ? servers(fs.readFileSync(process.env.FAKE_CODEX_STALE_GET, "utf8"))[name] : all[name];
  if (!entry) { process.stderr.write("not found"); process.exit(1); }
  const json = { name, enabled: entry.enabled ?? true, disabled_reason: null, transport: { type: "stdio", command: entry.command, args: entry.args ?? [], env: entry.env, env_vars: entry.env_vars ?? null, cwd: entry.cwd ?? null },
    enabled_tools: entry.enabled_tools ?? null, disabled_tools: null, startup_timeout_sec: entry.startup_timeout_sec ?? null, tool_timeout_sec: null };
  process.stdout.write(rest.includes("--json") ? JSON.stringify(json) : name + "\\n  command: " + entry.command + "\\n  args: " + (entry.args ?? []).join(" ") + "\\n");
  process.exit(0);
}
if (sub === "add") {
  const separator = rest.indexOf("--");
  const env = {};
  for (let index = 0; index < separator; index += 2) { const [key, ...value] = rest[index + 1].split("="); env[key] = value.join("="); }
  const [launch, ...args] = rest.slice(separator + 1);
  const kept = [];
  let skipping = false;
  for (const line of read().split("\\n")) {
    const header = /^\\[([^\\]]+)\\]$/.exec(line.trim());
    if (header) skipping = header[1] === "mcp_servers." + name || header[1] === "mcp_servers." + name + ".env";
    if (!skipping && !/^\\s*#/.test(line)) kept.push(line.replace(/\\s+#[^"]*$/, ""));
  }
  let text = kept.join("\\n").trimEnd() + "\\n\\n[mcp_servers." + name + "]\\ncommand = " + JSON.stringify(launch) + "\\nargs = " + JSON.stringify(args).replaceAll('","', '", "') + "\\n";
  if (Object.keys(env).length) text += "\\n[mcp_servers." + name + ".env]\\n" + Object.entries(env).map(([key, value]) => key + " = " + JSON.stringify(value)).join("\\n") + "\\n";
  fs.writeFileSync(config, text.replace(/^\\n+/, ""));
  process.exit(0);
}
process.exit(2);
`;

const LIVE = `model = "gpt"
# keep this comment

[mcp_servers.claude-bridge]
command = "/runtime/node"
args = ["/old/src/claude-bridge.mjs"]

[mcp_servers.claude-bridge.env]
CODEX_BRIDGE_AUTOSTART = "0"
CODEX_BRIDGE_DESKTOP_TASKS = "1"

[mcp_servers.codex-native-relay]
command = "/old/relay/node"
args = ["/old/src/native-relay-companion.mjs"] # relay
env_vars = ["CODEX_APP_TOOLS_PIPE_PATH"]

[mcp_servers.onenotch]
command = "/x/onenotch-mcp"
`;

function sandbox(t, config) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "install-entries-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(codexHome);
  if (config !== null) fs.writeFileSync(path.join(codexHome, "config.toml"), config);
  const fake = path.join(root, "codex-fake");
  fs.writeFileSync(fake, FAKE_CODEX, { mode: 0o755 });
  const log = path.join(root, "codex.log");
  fs.writeFileSync(log, "");
  const env = { ...process.env, HOME: root, CODEX_HOME: codexHome, CODEX_EXE: fake, FAKE_CODEX_LOG: log, NODE_EXE: "/runtime/node",
    CODEX_NATIVE_RELAY_NODE: "/signed/relay/node", CODEX_BRIDGE_RUNTIME_CACHE: path.join(root, "cache") };
  for (const key of ["CODEX_BRIDGE_DESKTOP_TASKS", "CLAUDE_BRIDGE_PEER_NAME", "CLAUDE_BRIDGE_PERMISSION_MODE", "CLAUDE_DESKTOP_USER_DATA", "CODEX_BRIDGE_PROJECT_POLICY", "CODEX_NATIVE_RELAY_NAME", "CLAUDE_BRIDGE_NAME"]) delete env[key];
  return {
    root, env,
    config: () => fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"),
    calls: () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    run: (script, args = [], extra = {}) => new Promise((resolve) => execFile(process.execPath, [path.join(repository, "scripts", script), ...args],
      { env: { ...env, ...extra }, timeout: 120000 }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }))),
  };
}

function section(text, name) {
  const start = text.indexOf(`[mcp_servers.${name}]`);
  const next = text.indexOf("\n[", start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

it("retargets a directly registered native relay to the supervisor without dropping env_vars or other config", { skip, timeout: 180000 }, async (t) => {
  const box = sandbox(t, LIVE);
  const result = await box.run("install-native-relay.mjs", ["--no-bootstrap"]);
  assert.equal(result.code, 0, result.stderr);
  const after = box.config();
  const relay = section(after, "codex-native-relay");
  assert.ok(relay.includes(`\nargs = [${JSON.stringify(supervisor)}, "native-relay-companion.mjs"] # relay\n`), relay);
  assert.match(relay, /^env_vars = \["CODEX_APP_TOOLS_PIPE_PATH"\]$/m);
  assert.equal(after.replace(relay, ""), LIVE.replace(section(LIVE, "codex-native-relay"), ""));
  assert.equal(box.calls().some((call) => call[1] === "add"), false);
  assert.match(result.stdout, /retargeted in place/);
  assert.match(result.stdout, /quit and reopen Codex Desktop once/);
});

it("retargets a directly registered claude-bridge to the supervisor and keeps its environment and comments", { skip, timeout: 180000 }, async (t) => {
  const box = sandbox(t, LIVE);
  const result = await box.run("install-codex-mcp.mjs");
  assert.equal(result.code, 0, result.stderr);
  const after = box.config();
  assert.equal(after, LIVE.replace('args = ["/old/src/claude-bridge.mjs"]', `args = [${JSON.stringify(supervisor)}, "claude-bridge.mjs"]`));
  assert.equal(box.calls().some((call) => call[1] === "add"), false);
  assert.match(result.stdout, /claude_bridge_status/);
});

it("registers a fresh native relay through the supervisor", { skip, timeout: 180000 }, async (t) => {
  const box = sandbox(t, 'model = "gpt"\n');
  const result = await box.run("install-native-relay.mjs", ["--no-bootstrap"]);
  assert.equal(result.code, 0, result.stderr);
  const relay = section(box.config(), "codex-native-relay");
  assert.ok(relay.includes(`args = [${JSON.stringify(supervisor)}, "native-relay-companion.mjs"]`), relay);
  assert.equal(/env_vars = \["CODEX_APP_TOOLS_PIPE_PATH"\]/.test(relay), nativePipe);
  assert.equal(box.calls().filter((call) => call[1] === "add").length, 1);
  const rerun = await box.run("install-native-relay.mjs", ["--no-bootstrap"]);
  assert.equal(rerun.code, 0, rerun.stderr);
  assert.equal(section(box.config(), "codex-native-relay"), relay);
});

it("restores the previous configuration when Codex does not read back the supervisor entry", { skip, timeout: 180000 }, async (t) => {
  const box = sandbox(t, LIVE);
  const stale = path.join(box.root, "stale.toml");
  fs.writeFileSync(stale, LIVE);
  const result = await box.run("install-native-relay.mjs", ["--no-bootstrap"], { FAKE_CODEX_STALE_GET: stale });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /did not read back the expected codex-native-relay entry.*previous Codex configuration was restored/s);
  assert.equal(box.config(), LIVE);
});
