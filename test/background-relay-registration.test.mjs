import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configureBackgroundWorkerMcp } from "../src/background-relay-registration.mjs";

const TOOLS = ["worker_status", "list_workers", "send_to_worker", "read_worker_delivery"];
const ALLOW = TOOLS.map((tool) => `mcp(worker-relay/${tool})`);

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "worker-registration-")));
  const home = path.join(directory, "home");
  const root = path.join(directory, "package");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "background-relay-mcp.mjs"), "export {};\n");
  const files = { mcp: path.join(home, ".gemini", "config", "mcp_config.json"), settings: path.join(home, ".gemini", "antigravity-cli", "settings.json") };
  const options = { root, env: { USERPROFILE: home, HOME: home, AGENT_RELAY_TOKEN: "private-install-token", AGENT_RELAY_WORKER_ID: "private-worker-id" } };
  const write = (name, value) => { fs.mkdirSync(path.dirname(files[name]), { recursive: true }); fs.writeFileSync(files[name], JSON.stringify(value, null, 2) + "\n"); };
  const read = (name) => JSON.parse(fs.readFileSync(files[name], "utf8"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, home, root, files, options, write, read, configure: (overrides = {}) => configureBackgroundWorkerMcp({ ...options, ...overrides }) };
}

test("registers only the canonical stdio relay and four narrow permission grants", (t) => {
  const f = fixture(t);
  const result = f.configure();
  assert.equal(result.configured, true);
  assert.equal(result.changed, true);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.files, f.files);
  const mcp = f.read("mcp");
  assert.deepEqual(Object.keys(mcp.mcpServers), ["worker-relay"]);
  const entry = mcp.mcpServers["worker-relay"];
  assert.ok(path.isAbsolute(entry.command));
  assert.deepEqual(entry.args, [path.join(f.root, "src", "background-relay-mcp.mjs")]);
  assert.equal(entry.env, undefined);
  assert.deepEqual(f.read("settings"), { permissions: { allow: ALLOW } });
  assert.doesNotMatch(JSON.stringify(mcp) + JSON.stringify(result) + JSON.stringify(f.read("settings")), /private-install-token|private-worker-id|dangerously-skip-permissions/);
});

test("preserves native MCP entries and unrelated CLI settings and is byte-idempotent", (t) => {
  const f = fixture(t);
  const native = { command: "native-node", args: ["native-bridge.mjs"], env: { NATIVE_TOKEN: "private-native-token" } };
  f.write("mcp", { mcpServers: { "agent-bridge": native, filesystem: { command: "existing-fs" } }, custom: { value: 7 } });
  const settings = { model: "current-model", toolPermission: "request-review", enableTerminalSandbox: true, custom: { nested: true }, permissions: { allow: ["command(git)", ALLOW[0]], ask: ["command(*)"], deny: ["write_file(.git/)"] } };
  f.write("settings", settings);
  assert.equal(f.configure().changed, true);
  assert.deepEqual(f.read("mcp").mcpServers["agent-bridge"], native);
  assert.deepEqual(f.read("mcp").custom, { value: 7 });
  const next = f.read("settings");
  assert.deepEqual({ ...next, permissions: settings.permissions }, settings);
  assert.deepEqual(next.permissions, { ...settings.permissions, allow: ["command(git)", ...ALLOW] });
  const before = Object.fromEntries(Object.entries(f.files).map(([key, file]) => [key, fs.readFileSync(file, "utf8")]));
  const repeat = f.configure();
  assert.equal(repeat.changed, false);
  assert.equal(repeat.configured, true);
  assert.deepEqual(Object.fromEntries(Object.entries(f.files).map(([key, file]) => [key, fs.readFileSync(file, "utf8")])), before);
  assert.doesNotMatch(JSON.stringify(repeat), /private-native-token/);
});

test("dry-run and check are read-only even when both directories are absent", (t) => {
  const f = fixture(t);
  for (const mode of [{ dryRun: true }, { check: true }]) {
    const result = f.configure(mode);
    assert.equal(result.configured, false);
    assert.equal(result.changed, false);
    assert.equal(result.wouldChange, true);
    assert.equal(fs.existsSync(path.join(f.home, ".gemini")), false);
  }
  f.configure();
  assert.equal(f.configure({ check: true }).configured, true);
  assert.equal(f.configure({ dryRun: true }).wouldChange, false);
});

test("foreign canonical-name collisions fail before either file changes", (t) => {
  const f = fixture(t);
  for (const entry of [{ serverUrl: "https://private.example.test/mcp?token=secret" }, { command: process.execPath, args: ["foreign-script.mjs"] }, null]) {
    f.write("mcp", { mcpServers: { "worker-relay": entry } });
    const before = fs.readFileSync(f.files.mcp, "utf8");
    assert.throws(() => f.configure(), (error) => {
      assert.equal(error.code, "WORKER_MCP_COLLISION");
      assert.doesNotMatch(error.message, /private.example|token=secret|foreign-script/);
      return true;
    });
    assert.equal(fs.readFileSync(f.files.mcp, "utf8"), before);
    assert.equal(fs.existsSync(f.files.settings), false);
  }
});

test("an owned relay entry registered with another installed Node executable is kept", (t) => {
  const f = fixture(t);
  const other = path.join(f.directory, "other-node", process.platform === "win32" ? "node.exe" : "node");
  fs.mkdirSync(path.dirname(other));
  fs.writeFileSync(other, "");
  f.write("mcp", { mcpServers: { "worker-relay": { command: other, args: [path.join(f.root, "src", "background-relay-mcp.mjs")] } } });
  const before = fs.readFileSync(f.files.mcp, "utf8");
  assert.equal(f.configure().configured, true);
  assert.equal(fs.readFileSync(f.files.mcp, "utf8"), before);
  assert.equal(f.configure({ check: true }).configured, true);
  for (const command of [path.join(f.directory, "other-node", "bun.exe"), path.join(f.directory, "missing", "node.exe"), "node"]) {
    if (command.endsWith("bun.exe")) fs.writeFileSync(command, "");
    f.write("mcp", { mcpServers: { "worker-relay": { command, args: [path.join(f.root, "src", "background-relay-mcp.mjs")] } } });
    assert.throws(() => f.configure(), { code: "WORKER_MCP_COLLISION" });
  }
});

test("an existing relay entry with an embedded capability is preserved and rejected", (t) => {
  const f = fixture(t);
  f.configure();
  const mcp = f.read("mcp");
  mcp.mcpServers["worker-relay"].env = { AGENT_RELAY_TOKEN: "old-private-capability" };
  f.write("mcp", mcp);
  const before = fs.readFileSync(f.files.mcp, "utf8");
  assert.throws(() => f.configure(), { code: "WORKER_MCP_COLLISION" });
  assert.equal(fs.readFileSync(f.files.mcp, "utf8"), before);
});

test("deny, ask, and strict policies stay intact and are reported as blocked", (t) => {
  for (const settings of [
    { permissions: { deny: ["mcp(worker-relay/send_to_worker)"] } },
    { permissions: { ask: ["mcp(worker-relay/*)"] } },
    { permissions: { deny: ["mcp(*)"] } },
    { toolPermission: "strict" },
  ]) {
    const f = fixture(t);
    f.write("settings", settings);
    const result = f.configure();
    assert.equal(result.configured, true);
    assert.equal(result.blocked, true);
    assert.equal(result.code, "WORKER_MCP_POLICY_BLOCKED");
    assert.ok(result.permissions.blockedTools.includes("send_to_worker"));
    const current = f.read("settings");
    assert.equal(current.toolPermission, settings.toolPermission);
    assert.deepEqual(current.permissions.deny, settings.permissions?.deny);
    assert.deepEqual(current.permissions.ask, settings.permissions?.ask);
    assert.deepEqual(current.permissions.allow, ALLOW);
  }
});

test("existing broad modes and unrelated MCP restrictions are not rewritten", (t) => {
  const f = fixture(t);
  f.write("settings", { toolPermission: "always-proceed", permissions: { deny: ["mcp(other-server/*)"], ask: ["command(*)"], allow: ["mcp(*)"] } });
  const result = f.configure();
  assert.equal(result.blocked, false);
  assert.equal(f.read("settings").toolPermission, "always-proceed");
  assert.deepEqual(f.read("settings").permissions.allow, ["mcp(*)", ...ALLOW]);
});

test("disabled or tool-filtered owned entries stay unchanged and report blocked tools", (t) => {
  const f = fixture(t);
  f.configure();
  for (const restriction of [{ disabled: true }, { enabledTools: ["worker_status"] }, { disabledTools: ["send_to_worker"] }]) {
    const mcp = f.read("mcp");
    const existing = mcp.mcpServers["worker-relay"];
    for (const key of ["disabled", "enabledTools", "disabledTools"]) delete existing[key];
    Object.assign(existing, restriction);
    f.write("mcp", mcp);
    const before = fs.readFileSync(f.files.mcp, "utf8");
    const result = f.configure();
    assert.equal(result.blocked, true);
    assert.equal(result.changed, false);
    assert.ok(result.permissions.blockedTools.includes("send_to_worker"));
    assert.equal(fs.readFileSync(f.files.mcp, "utf8"), before);
  }
});

test("invalid JSON and invalid permission structure are rejected before writing MCP", (t) => {
  const f = fixture(t);
  for (const invalid of ["{ private broken JSON", "[]", '{"permissions":{"allow":"mcp(*)"}}', '{"permissions":null}']) {
    fs.mkdirSync(path.dirname(f.files.settings), { recursive: true });
    fs.writeFileSync(f.files.settings, invalid);
    assert.throws(() => f.configure(), { code: "WORKER_MCP_CONFIG_INVALID" });
    assert.equal(fs.readFileSync(f.files.settings, "utf8"), invalid);
    assert.equal(fs.existsSync(f.files.mcp), false);
  }
});

test("oversized, linked, and directory configurations are rejected", (t) => {
  for (const kind of ["oversized", "hardlink", "directory"]) {
    const f = fixture(t);
    fs.mkdirSync(path.dirname(f.files.mcp), { recursive: true });
    if (kind === "oversized") fs.writeFileSync(f.files.mcp, " ".repeat(1024 * 1024 + 1));
    if (kind === "directory") fs.mkdirSync(f.files.mcp);
    if (kind === "hardlink") {
      const target = path.join(f.directory, "existing-config.json");
      fs.writeFileSync(target, "{}");
      fs.linkSync(target, f.files.mcp);
    }
    assert.throws(() => f.configure(), { code: "WORKER_MCP_CONFIG_UNSAFE" });
    assert.equal(fs.existsSync(f.files.settings), false);
  }
});

test("linked configuration ancestors are rejected without touching their targets", (t) => {
  const f = fixture(t);
  const target = path.join(f.directory, "redirected-gemini");
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(f.home, ".gemini"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.configure(), { code: "WORKER_MCP_CONFIG_UNSAFE" });
  assert.deepEqual(fs.readdirSync(target), []);
});

test("a failed second atomic replacement restores the first without leaving temp files", (t) => {
  const f = fixture(t);
  f.write("mcp", { mcpServers: { "agent-bridge": { command: "existing" } } });
  f.write("settings", { custom: "keep" });
  const before = Object.fromEntries(Object.entries(f.files).map(([key, file]) => [key, fs.readFileSync(file, "utf8")]));
  const rename = fs.renameSync.bind(fs);
  let failed = false;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.files.settings && !failed) { failed = true; throw new Error("private filesystem failure"); }
    return rename(from, to);
  });
  assert.throws(() => f.configure(), (error) => {
    assert.equal(error.code, "WORKER_MCP_WRITE_FAILED");
    assert.doesNotMatch(error.message, /private filesystem failure/);
    return true;
  });
  for (const [key, file] of Object.entries(f.files)) {
    assert.equal(fs.readFileSync(file, "utf8"), before[key]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
  }
});

test("rollback removes only a newly created registration when the settings write fails", (t) => {
  const f = fixture(t);
  const rename = fs.renameSync.bind(fs);
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.files.settings) throw new Error("simulated write failure");
    return rename(from, to);
  });
  assert.throws(() => f.configure(), { code: "WORKER_MCP_WRITE_FAILED" });
  assert.equal(fs.existsSync(f.files.mcp), false);
  assert.equal(fs.existsSync(f.files.settings), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.files.mcp)), []);
  assert.deepEqual(fs.readdirSync(path.dirname(f.files.settings)), []);
});

test("concurrent configuration changes survive a rejected replacement", (t) => {
  const f = fixture(t);
  f.write("mcp", { mcpServers: {} });
  const write = fs.writeFileSync.bind(fs);
  const concurrent = JSON.stringify({ mcpServers: { "new-user-server": { command: "user-node" } } });
  let changed = false;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    const result = write(target, ...args);
    if (typeof target === "number" && !changed) { changed = true; write(f.files.mcp, concurrent); }
    return result;
  });
  assert.throws(() => f.configure(), { code: "WORKER_MCP_CONFIG_CHANGED" });
  assert.equal(fs.readFileSync(f.files.mcp, "utf8"), concurrent);
  assert.equal(fs.existsSync(f.files.settings), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.files.mcp)), ["mcp_config.json"]);
});

test("rollback preserves later user edits and reports a partial update", (t) => {
  const f = fixture(t);
  f.write("mcp", { mcpServers: {} });
  const rename = fs.renameSync.bind(fs);
  const concurrent = JSON.stringify({ mcpServers: { "new-user-server": { command: "user-node" } } });
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === f.files.settings) { fs.writeFileSync(f.files.mcp, concurrent); throw new Error("simulated write failure"); }
    return rename(from, to);
  });
  assert.throws(() => f.configure(), { code: "WORKER_MCP_REGISTRATION_INCOMPLETE" });
  assert.equal(fs.readFileSync(f.files.mcp, "utf8"), concurrent);
  assert.equal(fs.existsSync(f.files.settings), false);
});

test("uses the platform's home variable without writing to the alternate home", (t) => {
  const f = fixture(t);
  const alternate = path.join(f.directory, "alternate");
  fs.mkdirSync(alternate);
  const windows = f.configure({ platform: "win32", env: { USERPROFILE: f.home, HOME: alternate }, dryRun: true });
  const unix = f.configure({ platform: "linux", env: { USERPROFILE: alternate, HOME: f.home }, dryRun: true });
  assert.deepEqual(windows.files, f.files);
  assert.deepEqual(unix.files, f.files);
  assert.deepEqual(fs.readdirSync(alternate), []);
});
