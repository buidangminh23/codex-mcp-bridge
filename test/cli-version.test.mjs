import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLauncher } from "../src/codex-bridge-launcher.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createReleaseSnapshot } from "../src/release-snapshot.mjs";
import { createProcessReaper } from "./helpers/process-reaper.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const sideEffectGuard = `
import fs from "node:fs";
import net from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const forbidden = () => { throw new Error("Version requests must not perform runtime operations"); };
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync"]) fs[name] = forbidden;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = forbidden;
net.Server.prototype.listen = forbidden;
net.Socket.prototype.connect = forbidden;
syncBuiltinESMExports();
`;
const guardUrl = `data:text/javascript,${encodeURIComponent(sideEffectGuard)}`;

function runVersion(args) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cli-version-"));
  const config = path.join(sandbox, "claude.json");
  const original = "{\"unchanged\":true}\n";
  fs.writeFileSync(config, original);
  try {
    const result = spawnSync(process.execPath, ["--import", guardUrl, ...args], {
      cwd: sandbox,
      env: {
        SystemRoot: process.env.SystemRoot ?? "",
        PATH: "",
        HOME: sandbox,
        USERPROFILE: sandbox,
        APPDATA: sandbox,
        LOCALAPPDATA: sandbox,
        CODEX_HOME: sandbox,
        CLAUDE_DESKTOP_CONFIG: config,
        CODEX_EXE: path.join(sandbox, "missing-codex"),
        CODEX_BIN: path.join(sandbox, "missing-codex"),
        CODEX_APP_SERVER_URL: "invalid-app-server-url",
        CODEX_BRIDGE_APPROVAL: "invalid-approval",
        CLAUDE_BRIDGE_PERMISSION_MODE: "invalid-permission-mode",
      },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.deepEqual(fs.readdirSync(sandbox), ["claude.json"]);
    assert.equal(fs.readFileSync(config, "utf8"), original);
    return result.stdout;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("CLI version queries", () => {
  for (const [name, entry] of Object.entries(pkg.bin)) {
    for (const flag of ["--version", "-v"]) {
      it(`${name} ${flag} prints the package version without runtime effects`, () => {
        assert.equal(runVersion([path.join(root, entry), flag]), `${pkg.version}\n`);
      });
    }

    it(`${name} gives version queries precedence over mutation flags`, () => {
      const args = [path.join(root, entry), "--remove", "--reset", "--desktop-tasks", "--version"];
      assert.equal(runVersion(args), `${pkg.version}\n`);
    });
  }

  it("does not exit when the relay module is imported by another command", () => {
    const entry = pathToFileURL(path.join(root, "src/native-relay-companion.mjs")).href;
    const code = `process.argv = [process.execPath, "unrelated.mjs", "--version"]; const relay = await import(${JSON.stringify(entry)}); console.log(typeof relay.handleRelayRequest);`;
    assert.equal(runVersion(["--input-type=module", "--eval", code]), "function\n");
  });
});

describe("package launcher routing", () => {
  function fixture(overrides = {}) {
    const calls = [];
    return {
      calls,
      options: {
        args: [], env: { npm_command: "exec" }, platform: "win32", input: { isTTY: true }, output: { isTTY: true },
        updateCli: async args => { calls.push(["update", args]); return 0; },
        supervise: async entry => { calls.push(["mcp", entry]); },
        telemetry: async args => { calls.push(["telemetry", args]); return false; },
        setup: async args => { calls.push(["setup", args]); return { configured: true }; },
        ...overrides,
      },
    };
  }

  it("runs the complete per-user updater for the bare npm package command in a Windows terminal", async () => {
    const f = fixture();
    assert.equal(await runLauncher(f.options), 0);
    assert.deepEqual(f.calls, [["update", ["--user"]]]);
  });

  it("uses the existing global update policy for macOS and Linux terminals", async () => {
    for (const platform of ["darwin", "linux"]) {
      const f = fixture({ platform });
      await runLauncher(f.options);
      assert.deepEqual(f.calls, [["update", []]]);
    }
  });

  it("preserves MCP startup for piped, redirected, noninteractive and direct global launches", async () => {
    for (const overrides of [
      { input: { isTTY: false } }, { output: { isTTY: false } },
      { input: {}, output: {} }, { env: {} }, { env: { npm_command: "run-script" } },
      { args: ["--stdio"] }, { args: ["--version"] },
    ]) {
      const f = fixture(overrides);
      await runLauncher(f.options);
      assert.deepEqual(f.calls, [["telemetry", overrides.args ?? []], ["mcp", "index.mjs"]]);
    }
  });

  it("provides an explicit update subcommand for noninteractive scripts", async () => {
    const f = fixture({ args: ["update", "--json"], input: {}, output: {}, env: {} });
    await runLauncher(f.options);
    assert.deepEqual(f.calls, [["update", ["--user", "--json"]]]);
    const explicit = fixture({ args: ["update", "--user", "--help"] });
    await runLauncher(explicit.options);
    assert.deepEqual(explicit.calls, [["update", ["--user", "--help"]]]);
    const posix = fixture({ platform: "linux", args: ["update", "--json"] });
    await runLauncher(posix.options);
    assert.deepEqual(posix.calls, [["update", ["--json"]]]);
  });

  it("preserves setup results and errors without invoking the updater", async () => {
    const f = fixture({ args: ["setup", "--check", "--json"] });
    assert.equal(await runLauncher(f.options), 0);
    assert.deepEqual(f.calls, [["setup", ["--check", "--json"]]]);
    assert.equal(await runLauncher(fixture({ args: ["setup"], setup: async () => ({ configured: false }) }).options), 1);
    assert.equal(await runLauncher(fixture({ args: ["setup"], setup: async () => ({ configured: false, dryRun: true }) }).options), 0);
    const errors = [];
    const failed = fixture({ args: ["setup"], setup: async () => { throw new Error("configuration conflict"); }, errorOutput: { write: value => errors.push(value) } });
    assert.equal(await runLauncher(failed.options), 1);
    assert.deepEqual(errors, ["Bridge setup: configuration conflict\n"]);
    assert.deepEqual(failed.calls, []);
  });

  it("keeps telemetry commands separate from terminal installation", async () => {
    const f = fixture({ args: ["telemetry", "status"], telemetry: async args => { assert.deepEqual(args, ["telemetry", "status"]); return true; } });
    await runLauncher(f.options);
    assert.deepEqual(f.calls, []);
  });

  it("does not perform runtime work when the launcher is imported", () => {
    const entry = pathToFileURL(path.join(root, "src/codex-bridge-launcher.mjs")).href;
    assert.equal(runVersion(["--input-type=module", "--eval", `const launcher = await import(${JSON.stringify(entry)}); console.log(typeof launcher.runLauncher);`]), "function\n");
  });

  it("initializes the real piped MCP launcher under npm exec without running setup", { timeout: 120000 }, async t => {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-piped-launcher-")));
    const installation = path.join(home, "installation");
    const cache = path.join(home, "runtime-cache");
    const reaper = createProcessReaper();
    let client;
    let transport;
    let stderr = "";
    t.after(async () => {
      reaper.track(transport?.pid);
      try {
        await client?.close();
        await transport?.close();
      } finally {
        const leaked = await reaper.reap();
        fs.rmSync(home, { recursive: true, force: true });
        assert.deepEqual(leaked, [], stderr);
      }
    });
    await fs.promises.cp(path.join(root, "src"), path.join(installation, "src"), { recursive: true });
    fs.copyFileSync(path.join(root, "package.json"), path.join(installation, "package.json"));
    await fs.promises.cp(path.join(root, "node_modules"), path.join(installation, "node_modules"), { recursive: true });
    createReleaseSnapshot(installation, { cache });
    client = new Client({ name: "piped-package-launcher-test", version: "1" });
    transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(installation, "src", "codex-bridge-launcher.mjs")], cwd: home, stderr: "pipe",
      env: {
        npm_command: "exec", PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
        HOME: home, USERPROFILE: home, APPDATA: path.join(home, "Roaming"), LOCALAPPDATA: path.join(home, "Local"),
        XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"),
        AGENT_RELAY_DIRECTORY: path.join(home, "background-relay"), CODEX_BRIDGE_RUNTIME_CACHE: cache,
        CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_DESKTOP_TASKS: "0", CODEX_BRIDGE_OPEN_IN_APP: "0",
        CODEX_BRIDGE_RELEASE_AFTER_TURN: "0", CODEX_BRIDGE_RELAY_KEEPER: "0", CODEX_BRIDGE_ENFORCE_FULL_ACCESS: "0",
        CODEX_BRIDGE_RELOAD_POLL_MS: "60000", CODEX_BRIDGE_ALLOWED_ROOTS: home, CODEX_BRIDGE_THREAD_POLICY: "roots",
        CODEX_EXE: process.execPath, CODEX_BIN: process.execPath, CODEX_APP_SERVER_URL: "ws://127.0.0.1:9",
        CLAUDE_BIN: path.join(home, "never-launch-claude"), ANTIGRAVITY_CLI_BIN: path.join(home, "never-launch-agy"),
        CODEX_BRIDGE_SKIP_SETUP: "1", DO_NOT_TRACK: "1", CODEX_BRIDGE_TELEMETRY: "0",
      },
    });
    transport.stderr.on("data", data => { stderr += data; });
    await client.connect(transport, { timeout: 60000 });
    reaper.track(transport.pid);
    const catalog = await client.listTools(undefined, { timeout: 10000 });
    assert.ok(catalog.tools.some(tool => tool.name === "codex_bridge_status"));
    assert.match(stderr, /MCP initialized/);
    assert.doesNotMatch(stderr, /Installing bridge|Applying managed settings|UPDATE_/);
  });
});
