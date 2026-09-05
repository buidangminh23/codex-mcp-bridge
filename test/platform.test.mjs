import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  IS_WINDOWS,
  PLATFORM_LABEL,
  claudeDesktopConfigPath,
  codexThreadUrl,
  isWritableDir,
  launchAgentPath,
  resolveCodexBin,
  resolveCodexDesktopNodeBin,
  resolveWorkspacePath,
  spawnEnv,
} from "../src/platform.mjs";

const realEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  CODEX_BRIDGE_REMAP: process.env.CODEX_BRIDGE_REMAP,
  CODEX_BRIDGE_WORKSPACE_ROOTS: process.env.CODEX_BRIDGE_WORKSPACE_ROOTS,
  CODEX_BRIDGE_PATH_MAP: process.env.CODEX_BRIDGE_PATH_MAP,
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
  /**
   * Windows resolves the config under APPDATA rather than the home directory,
   * and that preference is correct - a roaming profile is where the file
   * genuinely lives. Point APPDATA into the sandbox too, so the assertion
   * below means "follows the environment" on all three platforms instead of
   * silently only testing two.
   */
  process.env.APPDATA = path.join(sandbox, "AppData", "Roaming");
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

  it(
    "finds the versioned Codex Desktop binary on Windows",
    { skip: IS_WINDOWS ? false : "Windows Codex Desktop path regression" },
    () => {
      const binary = path.join(sandbox, "AppData", "Local", "OpenAI", "Codex", "bin", "version-1", "codex.exe");
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, "");
      const previous = {
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        CODEX_BIN: process.env.CODEX_BIN,
        CODEX_CLI_PATH: process.env.CODEX_CLI_PATH,
      };
      process.env.LOCALAPPDATA = path.join(sandbox, "AppData", "Local");
      delete process.env.CODEX_BIN;
      delete process.env.CODEX_CLI_PATH;
      try {
        assert.equal(resolveCodexBin(), binary);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );
});

describe("workspace resolution", () => {
  it("returns an absolute path for a relative workspace", () => {
    assert.equal(resolveWorkspacePath(".").path, process.cwd());
  });

  it("refuses a regular file as a workspace", () => {
    const file = path.join(sandbox, "workspace-file");
    fs.writeFileSync(file, "text");
    assert.equal(isWritableDir(file), false);
    assert.throws(() => resolveWorkspacePath(file), /No usable working directory/);
  });

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
   * The same project sits at D:\X on Windows, /Volumes/<label>/X through the
   * NTFS mount on macOS (read-only there) and a native checkout under $HOME.
   * A brief written on one machine quotes a path the other cannot use.
   */
  it(
    "remaps a Windows-share path onto the local checkout",
    { skip: IS_WINDOWS ? "the remap targets POSIX homes" : false },
    () => {
      const project = path.join(sandbox, "shared-project");
      fs.mkdirSync(project, { recursive: true });

      const workspace = resolveWorkspacePath("/Volumes/Shared/shared-project");
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
      fs.mkdirSync(path.join(sandbox, "nested-project"), { recursive: true });
      const workspace = resolveWorkspacePath("D:\\nested-project");
      assert.equal(workspace.path, path.join(sandbox, "nested-project"));
      assert.equal(workspace.remapped, true);
    },
  );

  /**
   * The bridge's own checkout tells us where this user keeps projects, so a
   * sibling of the bridge is found without anybody configuring a thing. This
   * is what replaced a hardcoded directory name in the source, and it asserts
   * against the real repo rather than a fixture: the bridge is always a
   * sibling of itself.
   */
  it(
    "finds a project sitting next to the bridge's own checkout",
    { skip: IS_WINDOWS ? "the remap targets POSIX homes" : false },
    () => {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const workspace = resolveWorkspacePath(`/Volumes/Shared/${path.basename(repoRoot)}`);
      assert.equal(workspace.path, repoRoot, "the sibling lookup should have found this repo");
      assert.equal(workspace.remapped, true);
      assert.ok(!workspace.path.startsWith(sandbox), "HOME does not contain it, so this came from the derived root");
    },
  );

  it("lets CODEX_BRIDGE_WORKSPACE_ROOTS take over the search order", () => {
    const first = path.join(sandbox, "roots", "first");
    const second = path.join(sandbox, "roots", "second");
    fs.mkdirSync(path.join(second, "only-here"), { recursive: true });
    fs.mkdirSync(path.join(first, "in-both"), { recursive: true });
    fs.mkdirSync(path.join(second, "in-both"), { recursive: true });

    process.env.CODEX_BRIDGE_WORKSPACE_ROOTS = [first, second].join(path.delimiter);
    try {
      assert.equal(resolveWorkspacePath("/Volumes/Shared/only-here").path, path.join(second, "only-here"));
      assert.equal(resolveWorkspacePath("\\\\server\\share\\only-here").path, path.join(second, "only-here"));
      assert.equal(
        resolveWorkspacePath("/Volumes/Shared/in-both").path,
        path.join(first, "in-both"),
        "the configured order decides, not the filesystem",
      );
    } finally {
      delete process.env.CODEX_BRIDGE_WORKSPACE_ROOTS;
    }
  });

  it("applies an explicit path map before trusting a stale writable alias", () => {
    const alias = path.join(sandbox, "stale-alias");
    const target = path.join(sandbox, "real-project");
    fs.mkdirSync(alias, { recursive: true });
    fs.mkdirSync(path.join(target, "src"), { recursive: true });

    process.env.CODEX_BRIDGE_PATH_MAP = JSON.stringify({ [alias]: target });
    try {
      const workspace = resolveWorkspacePath(path.join(alias, "src"));
      assert.equal(workspace.path, path.join(target, "src"));
      assert.equal(workspace.remapped, true);
      assert.match(workspace.note, /CODEX_BRIDGE_PATH_MAP/);
    } finally {
      delete process.env.CODEX_BRIDGE_PATH_MAP;
    }
  });

  /**
   * No volume label or drive letter is blessed: the shape of the path is the
   * whole signal, so a setup with any label on any of these mount roots works
   * without configuring a thing.
   */
  it(
    "recognises any drive letter and any attached volume",
    { skip: IS_WINDOWS ? "the remap targets POSIX homes" : false },
    () => {
      const project = path.join(sandbox, "any-root-project");
      fs.mkdirSync(project, { recursive: true });
      for (const quoted of [
        "D:\\any-root-project",
        "z:/any-root-project",
        "/Volumes/Whatever Label/any-root-project",
        "/mnt/data/any-root-project",
        "/media/someone/backup/any-root-project",
      ]) {
        const workspace = resolveWorkspacePath(quoted);
        assert.equal(workspace.path, project, `${quoted} was not recognised as a foreign root`);
        assert.equal(workspace.remapped, true);
      }
    },
  );

  /**
   * Rewriting a path this machine can already write to would be guessing over
   * an explicit instruction - the input wins whenever it is usable, and that
   * is what makes recognising every volume safe rather than reckless.
   */
  it(
    "keeps a usable path exactly as given",
    { skip: IS_WINDOWS ? "the remap targets POSIX homes" : false },
    () => {
      const decoy = path.join(sandbox, "both-places");
      const real = path.join(sandbox, "volumes", "Scratch", "both-places");
      fs.mkdirSync(decoy, { recursive: true });
      fs.mkdirSync(real, { recursive: true });

      process.env.CODEX_BRIDGE_WORKSPACE_ROOTS = sandbox;
      try {
        const workspace = resolveWorkspacePath(real);
        assert.equal(workspace.path, real, "a writable path must not be rewritten to a same-named sibling");
        assert.equal(workspace.remapped, false);
      } finally {
        delete process.env.CODEX_BRIDGE_WORKSPACE_ROOTS;
      }
    },
  );

  it("does not remap at all when CODEX_BRIDGE_REMAP is off", () => {
    fs.mkdirSync(path.join(sandbox, "opt-out"), { recursive: true });
    process.env.CODEX_BRIDGE_REMAP = "0";
    try {
      assert.throws(() => resolveWorkspacePath("/Volumes/Anything/opt-out"), /No usable working directory/);
    } finally {
      delete process.env.CODEX_BRIDGE_REMAP;
    }
  });

  it("leaves unrelated absolute paths alone", () => {
    const other = path.join(sandbox, "elsewhere");
    fs.mkdirSync(other, { recursive: true });
    const workspace = resolveWorkspacePath(other);
    assert.equal(workspace.path, other);
    assert.equal(workspace.remapped, false);
  });
});

describe("resolveCodexDesktopNodeBin", () => {
  const runtimeDir = path.join(sandbox, "runtimes");

  const stub = (name) => {
    const target = path.join(runtimeDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(target, 0o755);
    return target;
  };

  /**
   * The resolver names the binary from the platform it is told about, not the
   * one running the suite, so a bundle written for the host would miss on
   * every cross-platform case. Writing both names keeps each assertion about
   * the rung that was chosen rather than about the runner's file extension.
   */
  const bundle = (label, platform = "darwin") => {
    const resourcesDir = path.join(runtimeDir, label, "Contents", "Resources");
    const binDir = path.join(resourcesDir, "cua_node", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    let target = "";
    for (const name of ["node", "node.exe"]) {
      const candidate = path.join(binDir, name);
      fs.writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(candidate, 0o755);
      if (name === (platform === "win32" ? "node.exe" : "node")) target = candidate;
    }
    return { resourcesDir, target };
  };

  it("prefers the explicit runtime over every discovered one", () => {
    const explicit = stub("explicit-node");
    const { resourcesDir } = bundle("explicit-case");
    const runtime = resolveCodexDesktopNodeBin(explicit, {
      env: { CODEX_NATIVE_RELAY_NODE: stub("env-node") },
      platform: "darwin",
      resourcesDir,
    });
    assert.equal(runtime.path, explicit);
    assert.equal(runtime.source, "explicit");
  });

  it("honours CODEX_NATIVE_RELAY_NODE on every platform", () => {
    const override = stub("override-node");
    for (const platform of ["darwin", "win32", "linux"]) {
      const runtime = resolveCodexDesktopNodeBin(undefined, {
        env: { CODEX_NATIVE_RELAY_NODE: override },
        platform,
        resourcesDir: path.join(runtimeDir, "absent"),
      });
      assert.equal(runtime.path, override, platform);
      assert.equal(runtime.source, "CODEX_NATIVE_RELAY_NODE", platform);
    }
  });

  it("falls back to the Codex Desktop bundle on macOS", () => {
    const { resourcesDir, target } = bundle("bundle-case");
    const runtime = resolveCodexDesktopNodeBin(undefined, { env: {}, platform: "darwin", resourcesDir });
    assert.equal(runtime.path, target);
    assert.equal(runtime.source, "Codex Desktop bundle");
  });

  it("prefers the runtime the app itself declares over the default bundle path", () => {
    const declared = stub("declared-node");
    const { resourcesDir } = bundle("declared-case");
    const runtime = resolveCodexDesktopNodeBin(undefined, {
      env: { CODEX_MCP_NODE_PATH: declared },
      platform: "darwin",
      resourcesDir,
    });
    assert.equal(runtime.path, declared);
    assert.equal(runtime.source, "CODEX_MCP_NODE_PATH");
  });

  it("resolves the bundle relative to CODEX_ELECTRON_RESOURCES_PATH before the default location", () => {
    const relocated = bundle("relocated-case");
    const fallback = bundle("default-case");
    const runtime = resolveCodexDesktopNodeBin(undefined, {
      env: { CODEX_ELECTRON_RESOURCES_PATH: relocated.resourcesDir },
      platform: "darwin",
      resourcesDir: fallback.resourcesDir,
    });
    assert.equal(runtime.path, relocated.target);
    assert.equal(runtime.source, "CODEX_ELECTRON_RESOURCES_PATH");
  });

  /**
   * The vendor rungs exist because macOS rejects a foreign code-signing
   * identity on its native tools pipe. No other platform was measured to do
   * that, and Windows already runs the relay under the user's own Node, so
   * this asserts the patch cannot quietly move a working install onto a
   * binary nobody has tested there.
   */
  it("ignores the vendor runtimes off macOS even when the app variables are set", () => {
    const declared = stub("windows-declared-node");
    const { resourcesDir } = bundle("off-macos-case", "win32");
    for (const platform of ["win32", "linux"]) {
      const runtime = resolveCodexDesktopNodeBin(undefined, {
        env: {
          CODEX_MCP_NODE_PATH: declared,
          CODEX_BROWSER_USE_NODE_PATH: declared,
          CODEX_ELECTRON_RESOURCES_PATH: resourcesDir,
        },
        platform,
        resourcesDir,
      });
      assert.equal(runtime.path, process.execPath, platform);
      assert.equal(runtime.source, "process.execPath", platform);
    }
  });

  it("skips candidates that do not exist and reports the running runtime last", () => {
    const runtime = resolveCodexDesktopNodeBin(path.join(runtimeDir, "missing-explicit"), {
      env: { CODEX_NATIVE_RELAY_NODE: path.join(runtimeDir, "missing-env") },
      platform: "darwin",
      resourcesDir: path.join(runtimeDir, "missing-bundle"),
    });
    assert.equal(runtime.path, process.execPath);
    assert.equal(runtime.source, "process.execPath");
  });
});
