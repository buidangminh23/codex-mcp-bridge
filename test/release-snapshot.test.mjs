import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { it } from "node:test";
import { createReleaseSnapshot, sourceRevision } from "../src/release-snapshot.mjs";

function installation(t, manifest = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-hoisted-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modules = path.join(directory, "project", "node_modules");
  const root = path.join(modules, "@fixture", "bridge");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@fixture/bridge", type: "module", ...manifest }));
  fs.writeFileSync(path.join(root, "src", "index.mjs"), "export const value = 1;");
  return { directory, modules, root, cache: path.join(directory, "cache") };
}

function dependency(modules, name, value, manifest = {}, code) {
  const directory = path.join(modules, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.cjs", ...manifest }));
  fs.writeFileSync(path.join(directory, "index.cjs"), code ?? `module.exports = ${JSON.stringify(value)};`);
  return directory;
}

const runtimeRequire = (snapshot) => createRequire(path.join(snapshot.directory, "src", "index.mjs"));

it("snapshots hoisted scoped packages and transitive dependencies without local node_modules", t => {
  const fixture = installation(t, { dependencies: { "@fixture/entry": "*" } });
  dependency(fixture.modules, "@fixture/entry", null, {
    exports: { ".": "./index.cjs" }, dependencies: { leaf: "*" },
  }, "module.exports = require('leaf');");
  dependency(fixture.modules, "leaf", "original");
  dependency(fixture.modules, "unrelated", "must not be copied");
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  assert.equal(runtimeRequire(snapshot)("@fixture/entry"), "original");
  assert.equal(fs.existsSync(path.join(snapshot.directory, "node_modules", "unrelated")), false);
  fs.renameSync(fixture.modules, path.join(fixture.directory, "removed-installation"));
  assert.equal(runtimeRequire(snapshot)("leaf"), "original");
});

it("preserves mixed nested versions, npm aliases, and cyclic dependency resolution", t => {
  const fixture = installation(t, { dependencies: { entry: "*", leaf: "*", alias: "npm:actual@*" } });
  const entry = dependency(fixture.modules, "entry", null, { dependencies: { leaf: "*", cycle: "*" } },
    "module.exports = { leaf: require('leaf'), cycle: require('cycle').name };");
  dependency(fixture.modules, "leaf", "outer");
  dependency(path.join(entry, "node_modules"), "leaf", "inner");
  dependency(fixture.modules, "cycle", null, { dependencies: { entry: "*" } }, "exports.name = 'cycle'; exports.entry = () => require('entry');");
  dependency(fixture.modules, "alias", "alias-value", { name: "actual" });
  const local = path.join(fixture.root, "node_modules");
  dependency(local, "leaf", "bridge-local");
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  const require = runtimeRequire(snapshot);
  assert.deepEqual(require("entry"), { leaf: "inner", cycle: "cycle" });
  assert.equal(require("leaf"), "bridge-local");
  assert.equal(require("alias"), "alias-value");
  assert.deepEqual(require("cycle").entry(), require("entry"));
});

it("allows omitted optional dependencies and includes installed peer dependencies", t => {
  const fixture = installation(t, { dependencies: { entry: "*" } });
  dependency(fixture.modules, "entry", null, {
    optionalDependencies: { absent: "*" }, peerDependencies: { peer: "*", absentPeer: "*" },
    peerDependenciesMeta: { absentPeer: { optional: true } },
  }, "module.exports = require('peer');");
  dependency(fixture.modules, "peer", "peer-value");
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  assert.equal(runtimeRequire(snapshot)("entry"), "peer-value");
});

it("preserves different hoisted versions required by sibling packages", t => {
  const fixture = installation(t, { dependencies: { first: "*", second: "*" } });
  for (const [name, value] of [["first", "first-version"], ["second", "second-version"]]) {
    const directory = dependency(fixture.modules, name, null, { dependencies: { leaf: "*" } }, "module.exports = require('leaf');");
    dependency(path.join(directory, "node_modules"), "leaf", value);
  }
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  assert.equal(runtimeRequire(snapshot)("first"), "first-version");
  assert.equal(runtimeRequire(snapshot)("second"), "second-version");
});

it("materializes linked packages using their real dependency resolution", t => {
  const fixture = installation(t, { dependencies: { linked: "*" } });
  const workspace = path.join(fixture.directory, "workspace");
  const linked = dependency(workspace, "linked", null, { dependencies: { leaf: "*" } }, "module.exports = require('leaf');");
  dependency(path.join(workspace, "node_modules"), "leaf", "workspace-version");
  dependency(fixture.modules, "leaf", "project-version");
  try { fs.symlinkSync(linked, path.join(fixture.modules, "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Directory links are unavailable"); throw error; }
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  assert.equal(fs.lstatSync(path.join(snapshot.directory, "node_modules", "linked")).isSymbolicLink(), false);
  fs.renameSync(workspace, path.join(fixture.directory, "removed-workspace"));
  assert.equal(runtimeRequire(snapshot)("linked"), "workspace-version");
});

it("fails clearly when a required dependency is missing", t => {
  const fixture = installation(t, { dependencies: { absent: "*" } });
  assert.throws(() => createReleaseSnapshot(fixture.root, { cache: fixture.cache }), /Cannot resolve required dependency absent/);
});

it("invalidates hoisted dependency content and rejects cached corruption", t => {
  const fixture = installation(t, { dependencies: { leaf: "*" } });
  const leaf = dependency(fixture.modules, "leaf", "original");
  const options = { cache: fixture.cache };
  const original = createReleaseSnapshot(fixture.root, options);
  fs.writeFileSync(path.join(leaf, "index.cjs"), "module.exports = 'modified';");
  const updated = createReleaseSnapshot(fixture.root, options);
  assert.notEqual(updated.key, original.key);
  assert.equal(runtimeRequire(original)("leaf"), "original");
  assert.equal(runtimeRequire(updated)("leaf"), "modified");
  fs.writeFileSync(path.join(updated.directory, "node_modules", "leaf", "index.cjs"), "module.exports = 'tampered';");
  assert.throws(() => createReleaseSnapshot(fixture.root, options), /immutable runtime failed integrity verification/);
});

it("observes ancestor npm locks for reloads and preserves the revision in isolated runtimes", t => {
  const fixture = installation(t, { dependencies: { leaf: "*" } });
  dependency(fixture.modules, "leaf", "original");
  const lock = path.join(fixture.modules, ".package-lock.json");
  fs.writeFileSync(lock, '{"lockfileVersion":3,"packages":{"leaf":{"version":"1"}}}');
  const revision = sourceRevision(fixture.root);
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  assert.equal(sourceRevision(snapshot.directory), revision);
  fs.writeFileSync(lock, '{"lockfileVersion":3,"packages":{"leaf":{"version":"2"}}}');
  assert.notEqual(sourceRevision(fixture.root), revision);
  assert.equal(sourceRevision(snapshot.directory), revision);
});

it("snapshots a dependency-free installation without node_modules", t => {
  const fixture = installation(t);
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  assert.equal(sourceRevision(snapshot.directory), sourceRevision(fixture.root));
  assert.equal(fs.statSync(path.join(snapshot.directory, "node_modules")).isDirectory(), true);
});
