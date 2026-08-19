import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  IS_WINDOWS,
  PLATFORM_LABEL,
  claudeDesktopConfigPath,
  codexThreadUrl,
  isWritableDir,
  launchAgentPath,
  resolveCodexBin,
  resolveWorkspacePath,
  spawnEnv,
} from "../src/platform.mjs";

const realEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-platform-"));

before(() => {
  process.env.HOME = sandbox;
  process.env.USERPROFILE = sandbox;
  /**
   * On Linux the config path is `${XDG_CONFIG_HOME:-~/.config}`, and a CI
   * runner may well export XDG_CONFIG_HOME outside the sandbox home. Clearing
   * it here is what makes the default path assertion mean the same thing on
   * every machine; the override itself is asserted separately below.
   */
  delete process.env.XDG_CONFIG_HOME;
});

after(() => {
  for (const [key, value] of Object.entries(realEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("platform facts", () => {
  it("labels the platform it is running on", () => {
    assert.ok(["macOS", "Windows", "Linux"].includes(PLATFORM_LABEL) || PLATFORM_LABEL === process.platform);
  });

  it("builds codex deep links", () => {
    assert.equal(codexThreadUrl("01a0-beef"), "codex://threads/01a0-beef");
  });

  it("points at the Claude Desktop config for this OS", () => {
    const cfg = claudeDesktopConfigPath();
    assert.ok(path.isAbsolute(cfg));
    assert.equal(path.basename(cfg), "claude_desktop_config.json");
    assert.ok(cfg.startsWith(sandbox), "the config path must follow the home directory");
  });

  it(
    "lets XDG_CONFIG_HOME override the Linux config location",
    { skip: process.platform === "linux" ? false : "XDG only applies to the Linux branch" },
    () => {
      process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg");
      try {
        assert.equal(
          claudeDesktopConfigPath(),
          path.join(sandbox, "xdg", "Claude", "claude_desktop_config.json"),
        );
      } finally {
        delete process.env.XDG_CONFIG_HOME;
      }
    },
  );

  it("names the LaunchAgent plist under the user's LaunchAgents", () => {
    assert.equal(path.basename(launchAgentPath()), "com.codex-mcp-bridge.app-server.plist");
  });

  /**
   * MCP servers are spawned with a trimmed PATH, and the macOS/Linux `codex`
   * launcher is a Node script with a `#!/usr/bin/env node` shebang - so a child
   * process without node on PATH dies at the shebang before it runs a line.
   */
  it("puts the running node directory on the PATH it hands to children", () => {
    const env = spawnEnv();
    const separator = IS_WINDOWS ? ";" : ":";
    const dirs = env.PATH.split(separator);
    assert.ok(dirs.includes(path.dirname(process.execPath)), "node's own directory is missing from PATH");
    assert.equal(new Set(dirs).size, dirs.length, "PATH contains duplicate entries");
  });

  it("keeps extra environment entries passed to it", () => {
    assert.equal(spawnEnv({ CODEX_BRIDGE_TEST: "1" }).CODEX_BRIDGE_TEST, "1");
  });

  /**
   * The probe order decides which codex build spawns the app-server, and the
   * wrong build writes the same ~/.codex sqlite state as the desktop app.
   * An explicit override has to win over every guessed location.
   */
  it("prefers an explicit codex path over the probe order", () => {
    const explicit = path.join(sandbox, "codex-explicit");
    fs.writeFileSync(explicit, "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(resolveCodexBin(explicit), explicit);
  });

  it("ignores an override that is not runnable", () => {
    const missing = path.join(sandbox, "definitely-not-here");
    assert.notEqual(resolveCodexBin(missing), missing);
  });
});

describe("workspace resolution", () => {
  it("accepts a directory that exists and is writable", () => {
    const workspace = resolveWorkspacePath(sandbox);
    assert.equal(workspace.path, sandbox);
    assert.equal(workspace.remapped, false);
    assert.equal(workspace.writable, true);
    assert.equal(workspace.note, null);
  });

  it("passes an empty path straight through", () => {
    assert.equal(resolveWorkspacePath("").path, "");
  });

  /**
   * Handing Codex a directory that does not exist opens the thread somewhere
   * wrong and only shows up much later, so this fails loudly instead.
   */
  it("fails loudly when no candidate directory exists", () => {
    assert.throws(
      () => resolveWorkspacePath(path.join(sandbox, "no", "such", "place")),
      /No usable working directory/,
    );
  });

  it("reports the checkout it could not write to", () => {
    assert.equal(isWritableDir(sandbox), true);
    assert.equal(isWritableDir(path.join(sandbox, "missing")), false);
  });

  /**
   * The same project sits at L:\X on Windows, /Volumes/Win_Dev/X through the
   * NTFS mount on macOS (read-only there) and a native checkout under $HOME.
   * A brief written on one machine quotes a path the other cannot use.
   */
  it(
    "remaps a Windows-share path onto the local checkout",
    { skip: IS_WINDOWS ? "the remap targets POSIX homes" : false },
    () => {
      const project = path.join(sandbox, "codex-mcp-bridge");
      fs.mkdirSync(project, { recursive: true });

      const workspace = resolveWorkspacePath("/Volumes/Win_Dev/codex-mcp-bridge");
      assert.equal(workspace.path, project);
      assert.equal(workspace.remapped, true);
      assert.equal(workspace.writable, true);
      assert.match(workspace.note, /cwd remapped/);
    },
  );

  it(
    "remaps a drive-letter path the same way",
    { skip: IS_WINDOWS ? "the remap targets POSIX homes" : false },
    () => {
      fs.mkdirSync(path.join(sandbox, "minhspark", "nested-project"), { recursive: true });
      const workspace = resolveWorkspacePath("L:\\nested-project");
      assert.equal(workspace.path, path.join(sandbox, "minhspark", "nested-project"));
      assert.equal(workspace.remapped, true);
    },
  );

  it("leaves unrelated absolute paths alone", () => {
    const other = path.join(sandbox, "elsewhere");
    fs.mkdirSync(other, { recursive: true });
    const workspace = resolveWorkspacePath(other);
    assert.equal(workspace.path, other);
    assert.equal(workspace.remapped, false);
  });
});
