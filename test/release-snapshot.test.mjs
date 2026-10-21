import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { it } from "node:test";
import { createReleaseSnapshot, pruneReleaseSnapshots, runningCommandLines, sourceRevision } from "../src/release-snapshot.mjs";

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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const keyOf = (value) => createHash("sha256").update(String(value)).digest("hex");
const digestFile = (cache, directory) => path.join(cache, `.digests-${createHash("sha256").update(directory).digest("hex")}.json`);
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
const prune = (cache, options = {}) => pruneReleaseSnapshots({ cache, retain: 0, graceMs: 0, minIntervalMs: 0, listProcesses: () => [], ...options });

function age(target, ms) {
  const time = new Date(Date.now() - ms);
  fs.utimesSync(target, time, time);
}

function fakeSnapshot(cache, name, ageMs) {
  const directory = path.join(cache, name);
  fs.mkdirSync(path.join(directory, "src"), { recursive: true });
  fs.writeFileSync(path.join(directory, "src", "index.mjs"), "export const value = 1;");
  age(directory, ageMs);
  return directory;
}

function fakeLease(cache, key, pid, ageMs) {
  fs.mkdirSync(path.join(cache, ".leases"), { recursive: true });
  const file = path.join(cache, ".leases", `${key}.${pid}.${randomUUID()}.lease`);
  fs.writeFileSync(file, "{}");
  age(file, ageMs);
  return file;
}

function realCache(t) {
  const fixture = installation(t);
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  return { fixture, snapshot, cache: path.dirname(snapshot.directory) };
}

it("prunes unused runtimes oldest first, bounded per call, and keeps the most recently used ones", async t => {
  const { snapshot, cache } = realCache(t);
  const fakes = Array.from({ length: 6 }, (_, index) => fakeSnapshot(cache, keyOf(index), (index + 2) * DAY));
  const options = { retain: 3, graceMs: DAY, maxRemovals: 2 };
  assert.deepEqual((await prune(cache, options)).removed, [keyOf(5), keyOf(4)]);
  assert.deepEqual((await prune(cache, options)).removed, [keyOf(3), keyOf(2)]);
  assert.deepEqual((await prune(cache, options)).removed, []);
  assert.deepEqual(fs.readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name)).sort(), [keyOf(0), keyOf(1), snapshot.key].sort());
  assert.equal(fs.existsSync(fakes[0]), true);
  fakeSnapshot(cache, keyOf("recent"), HOUR);
  age(snapshot.directory, 3 * DAY);
  assert.deepEqual((await prune(cache, { retain: 0, graceMs: DAY })).removed.sort(), [keyOf(0), keyOf(1), snapshot.key].sort());
  assert.equal(fs.existsSync(path.join(cache, keyOf("recent"))), true);
});

it("removes a pruned runtime's digest metadata together with the runtime", async t => {
  const fixture = installation(t, { dependencies: { leaf: "*" } });
  const leaf = dependency(fixture.modules, "leaf", "original");
  const original = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  fs.writeFileSync(path.join(leaf, "index.cjs"), "module.exports = 'modified';");
  const updated = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  const cache = path.dirname(original.directory);
  assert.equal(fs.existsSync(digestFile(cache, original.directory)), true);
  age(original.directory, 2 * DAY);
  assert.deepEqual((await prune(cache, { retain: 1 })).removed, [original.key]);
  assert.equal(fs.existsSync(original.directory), false);
  assert.equal(fs.existsSync(digestFile(cache, original.directory)), false);
  assert.equal(fs.existsSync(digestFile(cache, updated.directory)), true);
  assert.equal(runtimeRequire(updated)("leaf"), "modified");
});

it("never prunes a leased, explicitly kept, or running runtime", async t => {
  const fixture = installation(t);
  const leased = createReleaseSnapshot(fixture.root, { cache: fixture.cache, lease: true });
  t.after(() => leased.lease.release());
  const cache = path.dirname(leased.directory);
  age(leased.lease.file, 2 * DAY);
  age(leased.directory, 2 * DAY);
  const kept = fakeSnapshot(cache, keyOf("kept"), 2 * DAY);
  const running = fakeSnapshot(cache, keyOf("running"), 2 * DAY);
  const orphan = fakeSnapshot(cache, keyOf("orphan"), 2 * DAY);
  const stale = fakeSnapshot(cache, keyOf("stale"), 2 * DAY);
  const orphanLease = fakeLease(cache, keyOf("orphan"), deadPid(), 60 * 1000);
  const staleLease = fakeLease(cache, keyOf("stale"), deadPid(), HOUR);
  const report = await prune(cache, { keep: [keyOf("kept")], listProcesses: () => [`/usr/bin/node ${running.toUpperCase()}/src/index.mjs`] });
  assert.deepEqual(report.removed, [keyOf("stale")]);
  assert.equal(report.leases, 1);
  for (const directory of [leased.directory, kept, running, orphan]) assert.equal(fs.existsSync(directory), true);
  assert.equal(fs.existsSync(orphanLease), true);
  assert.equal(fs.existsSync(staleLease), false);
  assert.equal(fs.existsSync(stale), false);
  leased.lease.release();
  assert.equal(fs.existsSync(leased.lease.file), false);
  assert.deepEqual((await prune(cache, { keep: [keyOf("kept")] })).removed.sort(), [keyOf("running"), leased.key].sort());
});

it("restores a runtime that is leased between the liveness check and its removal", async t => {
  const { snapshot, cache } = realCache(t);
  age(snapshot.directory, 2 * DAY);
  let lease;
  const report = await prune(cache, { listProcesses: () => { lease = fakeLease(cache, snapshot.key, process.pid, 0); return []; } });
  assert.deepEqual(report.removed, []);
  assert.equal(fs.existsSync(lease), true);
  assert.equal(fs.readFileSync(path.join(snapshot.directory, "src", "index.mjs"), "utf8"), "export const value = 1;");
  assert.equal(sourceRevision(snapshot.directory), snapshot.revision);
  assert.equal(fs.readdirSync(cache).some((name) => name.startsWith(".retired-")), false);
});

it("keeps every runtime when running processes cannot be listed", async t => {
  const { snapshot, cache } = realCache(t);
  age(snapshot.directory, 2 * DAY);
  const report = await prune(cache, { listProcesses: () => { throw new Error("listing denied"); } });
  assert.deepEqual(report.removed, []);
  assert.match(report.skipped, /listing denied/);
  assert.equal(fs.existsSync(snapshot.directory), true);
});

it("keeps a runtime referenced by a real running process command line", { timeout: 120000 }, async t => {
  try { await runningCommandLines(); }
  catch (error) { return t.skip(`Process listing is unavailable: ${error.message}`); }
  const { snapshot, cache } = realCache(t);
  age(snapshot.directory, 2 * DAY);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(snapshot.directory, "src", "index.mjs")], { stdio: "ignore", windowsHide: true });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  const kept = await pruneReleaseSnapshots({ cache, retain: 0, graceMs: 0, minIntervalMs: 0 });
  assert.deepEqual(kept.removed, []);
  assert.equal(kept.kept.includes(snapshot.key), true);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
  assert.deepEqual((await pruneReleaseSnapshots({ cache, retain: 0, graceMs: 0, minIntervalMs: 0 })).removed, [snapshot.key]);
});

it("never follows links and only sweeps abandoned temporaries and orphaned digest metadata", async t => {
  const { fixture, snapshot, cache } = realCache(t);
  const outside = path.join(fixture.directory, "outside");
  fs.mkdirSync(path.join(outside, "src"), { recursive: true });
  fs.writeFileSync(path.join(outside, "src", "index.mjs"), "kept");
  const rootDigest = digestFile(cache, fs.realpathSync.native(fixture.root));
  const linkedDigest = path.join(cache, `.digests-${keyOf("linked-digest")}.json`);
  try {
    fs.symlinkSync(outside, path.join(cache, keyOf("link")), process.platform === "win32" ? "junction" : "dir");
    fs.symlinkSync(rootDigest, linkedDigest, "file");
  } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Links are unavailable"); throw error; }
  const dead = deadPid();
  const abandoned = path.join(cache, `.preparing-${dead}-${randomUUID()}`);
  const ownPreparation = path.join(cache, `.preparing-${process.pid}-${randomUUID()}`);
  const freshRetired = path.join(cache, `.retired-${dead}-${randomUUID()}`);
  for (const directory of [abandoned, ownPreparation, freshRetired]) fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
  age(abandoned, 2 * HOUR);
  age(ownPreparation, 2 * HOUR);
  const digestTemporary = path.join(cache, `.digests-${dead}-${randomUUID()}.tmp`);
  fs.writeFileSync(digestTemporary, "{}");
  age(digestTemporary, 2 * HOUR);
  assert.equal(fs.existsSync(rootDigest), true);
  fs.rmSync(fixture.root, { recursive: true, force: true });
  const report = await prune(cache);
  assert.deepEqual(report.removed, [snapshot.key]);
  assert.equal(report.temporaries, 2);
  assert.equal(report.digests, 1);
  assert.equal(fs.readFileSync(path.join(outside, "src", "index.mjs"), "utf8"), "kept");
  assert.equal(fs.lstatSync(path.join(cache, keyOf("link"))).isSymbolicLink(), true);
  assert.equal(fs.existsSync(abandoned), false);
  assert.equal(fs.existsSync(ownPreparation), true);
  assert.equal(fs.existsSync(freshRetired), true);
  assert.equal(fs.existsSync(digestTemporary), false);
  assert.equal(fs.existsSync(rootDigest), false);
  assert.equal(fs.lstatSync(linkedDigest).isSymbolicLink(), true);
});

it("rate limits pruning and yields to a live concurrent pruner", async t => {
  const { snapshot, cache } = realCache(t);
  age(snapshot.directory, 2 * DAY);
  assert.equal((await prune(cache, { minIntervalMs: HOUR, listProcesses: () => [snapshot.directory] })).skipped, null);
  assert.match((await prune(cache, { minIntervalMs: HOUR })).skipped, /pruned recently/);
  const lock = path.join(cache, ".prune.lock");
  fs.writeFileSync(lock, `${process.ppid}\n`);
  assert.match((await prune(cache)).skipped, /Another prune is running/);
  fs.writeFileSync(lock, `${deadPid()}\n`);
  assert.deepEqual((await prune(cache)).removed, [snapshot.key]);
  assert.equal(fs.existsSync(lock), false);
});

it("clones runtime files on macOS instead of copying their data", { skip: process.platform !== "darwin" && "clonefile is macOS-only", timeout: 60000 }, async t => {
  const fixture = installation(t, { dependencies: { large: "*" } });
  const large = dependency(fixture.modules, "large", "large");
  const payload = Buffer.alloc(96 * 1024 * 1024);
  for (let offset = 0; offset < payload.length; offset += 4096) payload.writeUInt32LE(offset, offset);
  fs.writeFileSync(path.join(large, "payload.bin"), payload);
  const free = () => { execFileSync("/bin/sync"); const stats = fs.statfsSync(fixture.directory); return stats.bavail * stats.bsize; };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));
  await settle();
  const before = free();
  const snapshot = createReleaseSnapshot(fixture.root, { cache: fixture.cache });
  await settle();
  const consumed = before - free();
  assert.equal(snapshot.copy, "clonefile");
  assert.ok(consumed < 32 * 1024 * 1024, `the snapshot consumed ${Math.round(consumed / 1048576)} MB`);
  fs.writeFileSync(path.join(large, "payload.bin"), "changed");
  assert.equal(fs.statSync(path.join(snapshot.directory, "node_modules", "large", "payload.bin")).size, payload.length);
  assert.equal(createReleaseSnapshot(fixture.root, { cache: fixture.cache }).copy, "clonefile");
  assert.equal(fs.readdirSync(fixture.cache).some((name) => name.startsWith(".linking-")), false);
});
