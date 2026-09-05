import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "scripts", "install-claude-desktop.mjs");

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-installer-"));

/**
 * resolveCodexBin only asks whether the path exists and, off Windows, whether
 * it is executable - so a stub file is enough to get past the guard without a
 * real codex on the machine. CI runners have none.
 */
const codexStub = path.join(sandbox, process.platform === "win32" ? "codex.exe" : "codex");
fs.writeFileSync(codexStub, "#!/bin/sh\nexit 0\n");
fs.chmodSync(codexStub, 0o755);

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let configCounter = 0;

/**
 * A deliberately bare environment. Inheriting the real one would let a
 * CODEX_BRIDGE_* variable set on the developer's machine decide what the
 * installer writes, and the test would pass or fail according to whose
 * machine it ran on.
 */
function install({ config, env = {}, args = [] }) {
  execFileSync(process.execPath, [installer, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      CLAUDE_DESKTOP_CONFIG: config,
      CODEX_HOME: sandbox,
      CODEX_EXE: codexStub,
      ...env,
    },
    encoding: "utf8",
    stdio: "pipe",
  });
  return JSON.parse(fs.readFileSync(config, "utf8"));
}

function configWith(entry) {
  const file = path.join(sandbox, `config-${++configCounter}.json`);
  if (entry) fs.writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  return file;
}

describe("claude desktop installer", () => {
  it("disables legacy autostart in Desktop mode while preserving permission settings", () => {
    const config = configWith({ mcpServers: { "codex-bridge": { env: {
      CODEX_BRIDGE_AUTOSTART: "1", CODEX_BRIDGE_APPROVAL: "deny", CODEX_BRIDGE_SANDBOX: "read-only", CODEX_BRIDGE_ALLOWED_THREADS: "preserved",
    } } } });
    const env = install({ config, env: { CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "1" } }).mcpServers["codex-bridge"].env;
    assert.equal(env.CODEX_BRIDGE_AUTOSTART, "0");
    assert.equal(env.CODEX_BRIDGE_APPROVAL, "deny");
    assert.equal(env.CODEX_BRIDGE_SANDBOX, "read-only");
    assert.equal(env.CODEX_BRIDGE_ALLOWED_THREADS, "preserved");
  });

  it("keeps autostart available with an explicit Desktop opt-out", () => {
    const env = install({ config: configWith(null), env: { CODEX_BRIDGE_DESKTOP_TASKS: "0" } }).mcpServers["codex-bridge"].env;
    assert.equal(env.CODEX_BRIDGE_AUTOSTART, "1");
    const disabled = install({ config: configWith(null), env: { CODEX_BRIDGE_DESKTOP_TASKS: "0", CODEX_BRIDGE_AUTOSTART: "0" } }).mcpServers["codex-bridge"].env;
    assert.equal(disabled.CODEX_BRIDGE_AUTOSTART, "0");
  });

  it("persists an explicit auto-approval acknowledgement on a fresh install", () => {
    const cfg = install({ config: configWith(null), env: {
      CODEX_BRIDGE_APPROVAL: "approve", CODEX_BRIDGE_AUTO_APPROVE_ACK: "1",
    } });
    assert.equal(cfg.mcpServers["codex-bridge"].env.CODEX_BRIDGE_AUTO_APPROVE_ACK, "1");
  });

  it("lets the operator revoke an existing auto-approval acknowledgement", () => {
    const config = configWith({ mcpServers: { "codex-bridge": { env: {
      CODEX_BRIDGE_APPROVAL: "approve", CODEX_BRIDGE_AUTO_APPROVE_ACK: "1",
    } } } });
    const cfg = install({ config, env: { CODEX_BRIDGE_AUTO_APPROVE_ACK: "0" } });
    assert.equal(cfg.mcpServers["codex-bridge"].env.CODEX_BRIDGE_AUTO_APPROVE_ACK, "0");
  });

  it("writes the thread policy explicitly on a fresh install", () => {
    const cfg = install({ config: configWith(null) });
    const env = cfg.mcpServers["codex-bridge"].env;

    assert.equal(
      env.CODEX_BRIDGE_THREAD_POLICY,
      "roots",
      "the installer must make human-opened threads reachable by workspace, not by a stale pre-authorized id",
    );
    assert.equal(env.CODEX_BRIDGE_ALLOWED_ROOTS, "*");
    assert.equal(env.CODEX_BRIDGE_SANDBOX, "workspace-write");
    assert.equal(env.CODEX_BRIDGE_OPEN_IN_APP, process.platform === "win32" ? "1" : "0");
    assert.equal(env.CODEX_BRIDGE_RELEASE_AFTER_TURN, process.platform === "win32" ? "1" : "0");
    assert.equal(env.CODEX_BIN, codexStub);
  });

  /**
   * The regression this file exists for. Re-running the installer is what
   * people do after upgrading, and it used to assign a fresh entry over the
   * old one - deleting every setting the installer does not write, and
   * resetting the allowed roots to the install directory. The command you
   * reach for to keep the bridge current was the command that broke it.
   */
  it("keeps settings it does not manage when re-run", () => {
    const config = configWith({
      mcpServers: {
        "codex-bridge": {
          command: "stale-node",
          args: ["/old/path/index.mjs"],
          env: {
            CODEX_BIN: "/old/codex",
            CODEX_BRIDGE_ALLOWED_ROOTS: ["/work/a", "/work/b"].join(path.delimiter),
            CODEX_BRIDGE_THREAD_POLICY: "roots",
            CODEX_BRIDGE_ALLOWED_THREADS: "keep-me",
            CODEX_BRIDGE_MODEL: "some-model",
            CODEX_BRIDGE_SOMETHING_NEWER: "from-a-later-version",
          },
        },
        "other-server": { command: "echo", args: ["untouched"] },
      },
    });

    const env = install({ config }).mcpServers["codex-bridge"].env;

    assert.equal(env.CODEX_BRIDGE_THREAD_POLICY, "roots");
    assert.equal(env.CODEX_BRIDGE_ALLOWED_THREADS, "keep-me");
    assert.equal(env.CODEX_BRIDGE_MODEL, "some-model");
    assert.equal(env.CODEX_BRIDGE_ALLOWED_ROOTS, ["/work/a", "/work/b"].join(path.delimiter));
    assert.equal(
      env.CODEX_BRIDGE_SOMETHING_NEWER,
      "from-a-later-version",
      "a key this installer knows nothing about is not its to discard",
    );
  });

  /**
   * Preserving must not turn into refusing to update. The whole reason to
   * re-run after an upgrade is to point the entry at the code that is
   * installed now.
   */
  it("still refreshes the paths that are the reason for re-running", () => {
    const config = configWith({
      mcpServers: {
        "codex-bridge": {
          command: "stale-node",
          args: ["/old/path/index.mjs"],
          env: { CODEX_BIN: "/old/codex", CODEX_BRIDGE_THREAD_POLICY: "roots" },
        },
      },
    });

    const entry = install({ config }).mcpServers["codex-bridge"];

    assert.equal(entry.command, process.execPath);
    assert.deepEqual(entry.args, [path.join(root, "src", "index.mjs")]);
    assert.equal(entry.env.CODEX_BIN, codexStub, "a stale codex path is exactly what re-running should fix");
  });

  it("lets an explicit variable win over what the config already says", () => {
    const config = configWith({
      mcpServers: {
        "codex-bridge": { env: { CODEX_BRIDGE_THREAD_POLICY: "roots", CODEX_BRIDGE_SANDBOX: "read-only" } },
      },
    });

    const env = install({ config, env: { CODEX_BRIDGE_THREAD_POLICY: "owned" } }).mcpServers["codex-bridge"].env;

    assert.equal(env.CODEX_BRIDGE_THREAD_POLICY, "owned");
    assert.equal(env.CODEX_BRIDGE_SANDBOX, "read-only", "overriding one setting must not reset the others");
  });

  it("drops inherited values on --reset, so the defaults are reachable again", () => {
    const config = configWith({
      mcpServers: {
        "codex-bridge": {
          env: {
            CODEX_BRIDGE_THREAD_POLICY: "roots",
            CODEX_BRIDGE_ALLOWED_THREADS: "forget-me",
            CODEX_BRIDGE_ALLOWED_ROOTS: "/somewhere/else",
          },
        },
      },
    });

    const env = install({ config, args: ["--reset"] }).mcpServers["codex-bridge"].env;

    assert.equal(env.CODEX_BRIDGE_THREAD_POLICY, "roots");
    assert.equal(env.CODEX_BRIDGE_ALLOWED_THREADS, undefined);
    assert.equal(env.CODEX_BRIDGE_ALLOWED_ROOTS, "*");
  });

  it("never touches another MCP server in the same file", () => {
    const config = configWith({
      mcpServers: {
        "codex-bridge": { env: {} },
        "other-server": { command: "echo", args: ["untouched"], env: { KEEP: "yes" } },
      },
    });

    const cfg = install({ config });

    assert.deepEqual(cfg.mcpServers["other-server"], {
      command: "echo",
      args: ["untouched"],
      env: { KEEP: "yes" },
    });
  });

  it("uses cross-machine defaults instead of a machine-specific install root", () => {
    const output = execFileSync(process.execPath, [installer], {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        CLAUDE_DESKTOP_CONFIG: configWith(null),
        CODEX_EXE: codexStub,
      },
      encoding: "utf8",
    });

    assert.match(output, /CODEX_BRIDGE_ALLOWED_ROOTS\"\s*:\s*\"\*\"/);
    assert.match(output, /CODEX_BRIDGE_THREAD_POLICY\"\s*:\s*\"roots\"/);
  });
});
