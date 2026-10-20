import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";

import { isMainModule, stableInstallPath } from "../src/install-paths.mjs";

const posixOnly = { skip: process.platform === "win32" && "Homebrew kegs and opt aliases are POSIX-only" };

function prefix(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "install-paths-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keg = (formula, version, file) => {
    const target = path.join(root, "Cellar", formula, version, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, version);
    return target;
  };
  const link = (formula, version) => {
    fs.mkdirSync(path.join(root, "opt"), { recursive: true });
    fs.rmSync(path.join(root, "opt", formula), { force: true });
    fs.symlinkSync(path.join("..", "Cellar", formula, version), path.join(root, "opt", formula));
  };
  return { root, keg, link };
}

it("rewrites a keg path to the opt alias that resolves to it", posixOnly, (t) => {
  const brew = prefix(t);
  const entry = brew.keg("codex-mcp-bridge", "1.22.6", "libexec/lib/node_modules/@minhspark/codex-mcp-bridge/src/mcp-supervisor.mjs");
  const node = brew.keg("node", "26.12.0", "bin/node");
  brew.link("codex-mcp-bridge", "1.22.6");
  brew.link("node", "26.12.0");
  assert.equal(stableInstallPath(entry, {}), path.join(brew.root, "opt/codex-mcp-bridge/libexec/lib/node_modules/@minhspark/codex-mcp-bridge/src/mcp-supervisor.mjs"));
  assert.equal(stableInstallPath(node, {}), path.join(brew.root, "opt/node/bin/node"));
  assert.equal(stableInstallPath(path.join(brew.root, "Cellar/node/26.12.0"), {}), path.join(brew.root, "opt/node"));
});

it("keeps a keg path whose opt alias is missing or names another version", posixOnly, (t) => {
  const brew = prefix(t);
  const old = brew.keg("codex-mcp-bridge", "1.22.5", "package.json");
  assert.equal(stableInstallPath(old, {}), old);
  brew.keg("codex-mcp-bridge", "1.22.6", "package.json");
  brew.link("codex-mcp-bridge", "1.22.6");
  assert.equal(stableInstallPath(old, {}), old);
});

it("uses HOMEBREW_PREFIX when the Cellar lives outside the prefix", posixOnly, (t) => {
  const cellar = prefix(t);
  const home = prefix(t);
  const entry = cellar.keg("codex-mcp-bridge", "2.0.0", "package.json");
  fs.mkdirSync(path.join(home.root, "opt"));
  fs.symlinkSync(path.join(cellar.root, "Cellar", "codex-mcp-bridge", "2.0.0"), path.join(home.root, "opt", "codex-mcp-bridge"));
  assert.equal(stableInstallPath(entry, { HOMEBREW_PREFIX: home.root }), path.join(home.root, "opt/codex-mcp-bridge/package.json"));
  assert.equal(stableInstallPath(entry, {}), entry);
});

it("leaves paths outside a Cellar keg untouched", (t) => {
  const brew = prefix(t);
  const checkout = path.join(brew.root, "codex-mcp-bridge", "src", "index.mjs");
  assert.equal(stableInstallPath(checkout, {}), checkout);
  assert.equal(stableInstallPath(path.join(brew.root, "Cellar", "missing", "1", "x"), {}), path.join(brew.root, "Cellar", "missing", "1", "x"));
  assert.equal(stableInstallPath(undefined, {}), undefined);
});

it("recognises the main module through a symlinked directory", posixOnly, (t) => {
  const brew = prefix(t);
  const real = brew.keg("pkg", "1", "src/main.mjs");
  brew.link("pkg", "1");
  const viaAlias = path.join(brew.root, "opt", "pkg", "src", "main.mjs");
  assert.equal(isMainModule(viaAlias, pathToFileURL(real).href), true);
  assert.equal(isMainModule(real, pathToFileURL(real).href), true);
  assert.equal(isMainModule(path.join(brew.root, "other.mjs"), pathToFileURL(real).href), false);
  assert.equal(isMainModule(undefined, pathToFileURL(real).href), false);
});
