import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runUpdate, resolveUpdateNpm } from "../scripts/update.mjs";

const PACKAGE = "@minhspark/codex-mcp-bridge";
const VERSION = "1.26.2";

function fixture(t, previousVersion = "1.26.1", platform = "win32") {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-update-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "cached package with spaces");
  const prefix = path.join(directory, "global prefix with spaces");
  const modules = path.join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules");
  const globalRoot = path.join(modules, "@minhspark", "codex-mcp-bridge");
  const npm = path.join(directory, "npm with spaces", "bin", "npm-cli.js");
  const writePackage = (target, version) => {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: PACKAGE, version }));
  };
  writePackage(root, VERSION);
  if (previousVersion) writePackage(globalRoot, previousVersion);
  fs.mkdirSync(path.dirname(npm), { recursive: true });
  fs.writeFileSync(npm, "");
  fs.writeFileSync(path.resolve(path.dirname(npm), "..", "package.json"), JSON.stringify({ name: "npm" }));
  const env = { npm_execpath: npm, HOME: directory, USERPROFILE: directory, PATH: "caller-path", npm_config_ignore_scripts: "true" };
  const calls = [];
  let clock = 0;
  const options = {
    env, root, platform, waitMs: 3000, now: () => clock, sleep: async ms => { clock += ms; },
    readConfig: () => null,
    quiescent: () => true,
    readRuntime: () => ({ environment: { HOME: directory, PATH: "saved-path", CODEX_HOME: path.join(directory, "saved-code-home") } }),
    run: async (command, args, settings) => {
      calls.push({ kind: "command", command, args, settings });
      if (args[0] === npm && args[1] === "root") return { status: 0, stdout: modules + "\n" };
      if (args[0] === npm && args[1] === "prefix") return { status: 0, stdout: prefix + "\n" };
      if (args[0] === npm && args[1] === "install") { writePackage(globalRoot, VERSION); return { status: 0, stdout: "npm lifecycle output" }; }
      assert.deepEqual(args, [path.join(globalRoot, "scripts", "setup.mjs"), "--check", "--json"]);
      return { status: 0, stdout: JSON.stringify({ configured: true }) };
    },
    installService: async request => {
      calls.push({ kind: "service", request });
      return { configured: true, enabled: true, liveVerified: true, ready: true, version: VERSION, pid: 123 };
    },
  };
  const configured = enabled => { options.readConfig = () => ({ enabled, paths: { root: path.join(directory, "private relay") } }); };
  return { directory, root, prefix, modules, globalRoot, npm, env, calls, options, configured, writePackage,
    installCalls: () => calls.filter(item => item.kind === "command" && item.args[1] === "install") };
}

test("updates an unconfigured installation with the exact package version and verifies global settings", async t => {
  const f = fixture(t, null);
  const result = await runUpdate(f.options);
  assert.deepEqual(result, { updated: true, configured: true, version: VERSION, previousVersion: null, migrated: false,
    service: { enabled: true, ready: true, liveVerified: true, version: VERSION, pid: 123 }, opensApps: false, opensChats: false });
  const [install] = f.installCalls();
  assert.equal(install.command, process.execPath);
  assert.deepEqual(install.args, [f.npm, "install", "--global", "--prefix", f.prefix, `${PACKAGE}@${VERSION}`, "--ignore-scripts=false", `--allow-scripts=${PACKAGE}`, "--foreground-scripts"]);
  assert.equal(install.settings.env.npm_config_ignore_scripts, "true");
  for (const call of f.calls.filter(item => item.kind === "command")) {
    assert.equal(call.settings.shell, false);
    assert.equal(call.settings.windowsHide, true);
    assert.ok(!call.settings.cwd.startsWith(f.root));
    assert.ok(!call.settings.cwd.startsWith(f.globalRoot));
  }
  assert.deepEqual(f.calls.filter(item => item.kind === "service").map(item => [item.request.root, item.request.check]), [[f.globalRoot, true]]);
});

test("legacy migration waits for authenticated readiness before npm and preserves saved environment absence", async t => {
  const f = fixture(t);
  f.configured(true);
  f.env.CLAUDE_CONFIG_DIR = "caller-root-must-not-leak";
  f.env.XDG_CONFIG_HOME = "caller-config-must-not-leak";
  f.env.AGENT_RELAY_TOKEN = "never-transfer-capability";
  f.env.AGENT_RELAY_WORKER_ID = "never-transfer-worker";
  let migrations = 0;
  const ready = f.options.installService;
  f.options.installService = async request => {
    if (request.root === f.root && migrations++ < 2) {
      f.calls.push({ kind: "service", request });
      assert.equal(f.installCalls().length, 0);
      return { configured: true, enabled: true, liveVerified: false, ready: false, code: "SERVICE_UPDATE_PENDING" };
    }
    return ready(request);
  };
  const result = await runUpdate(f.options);
  assert.equal(result.migrated, true);
  const services = f.calls.filter(item => item.kind === "service");
  assert.deepEqual(services.map(item => item.request.check), [false, true, true, true]);
  for (const item of services) {
    assert.equal(item.request.env.PATH, "saved-path");
    assert.equal(item.request.env.CODEX_HOME, path.join(f.directory, "saved-code-home"));
    assert.equal(item.request.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(item.request.env.XDG_CONFIG_HOME, undefined);
    assert.equal(item.request.env.AGENT_RELAY_TOKEN, undefined);
    assert.equal(item.request.env.AGENT_RELAY_WORKER_ID, undefined);
  }
  const commands = f.calls.filter(item => item.kind === "command");
  assert.equal(commands.some(item => item.args[0] === path.join(f.root, "scripts", "setup.mjs")), false);
  assert.equal(f.installCalls()[0].settings.env.PATH, "saved-path");
  assert.equal(f.installCalls()[0].args[f.installCalls()[0].args.indexOf("--prefix") + 1], f.prefix);
});

test("a pending migration never installs globally or forces existing jobs", async t => {
  const f = fixture(t);
  f.configured(true);
  f.options.installService = async request => {
    f.calls.push({ kind: "service", request });
    return { configured: true, enabled: true, liveVerified: false, ready: false, code: "SERVICE_UPDATE_PENDING" };
  };
  await assert.rejects(runUpdate(f.options), error => error.code === "UPDATE_RELAY_PENDING" && error.pending === true && error.phase === "migration");
  assert.equal(f.installCalls().length, 0);
  assert.equal(f.calls.filter(item => item.kind === "service").length, 4);
  assert.ok(f.calls.filter(item => item.kind === "service").every(item => item.request.root === f.root));
});

test("service ownership or readiness verification failure blocks npm replacement", async t => {
  const f = fixture(t);
  f.configured(true);
  f.options.installService = async () => ({ configured: false, enabled: false, code: "SERVICE_CONFIGURATION_CONFLICT" });
  await assert.rejects(runUpdate(f.options), error => error.code === "UPDATE_SERVICE_UNVERIFIED" && error.cause.code === "SERVICE_CONFIGURATION_CONFLICT");
  assert.equal(f.installCalls().length, 0);
});

test("a matching version without authenticated live verification cannot authorize replacement", async t => {
  const f = fixture(t);
  f.configured(true);
  f.options.installService = async () => ({ configured: true, enabled: true, liveVerified: false, ready: true, version: VERSION, pid: 123 });
  await assert.rejects(runUpdate(f.options), { code: "UPDATE_RELAY_PENDING" });
  assert.equal(f.installCalls().length, 0);
});

test("disabled relay configuration stays disabled and does not start a cache runtime", async t => {
  const f = fixture(t);
  f.configured(false);
  f.options.installService = async request => {
    f.calls.push({ kind: "service", request });
    return { configured: true, enabled: false, liveVerified: false, ready: false };
  };
  const result = await runUpdate(f.options);
  assert.equal(result.migrated, false);
  assert.deepEqual(result.service, { enabled: false, ready: false, liveVerified: false });
  assert.deepEqual(f.calls.filter(item => item.kind === "service").map(item => [item.request.root, item.request.check]), [[f.globalRoot, true]]);
});

test("a disabled startup registration is preserved without waiting for readiness", async t => {
  const f = fixture(t);
  f.configured(true);
  f.options.installService = async request => {
    f.calls.push({ kind: "service", request });
    return { configured: true, enabled: false, ready: false, liveVerified: false };
  };
  const result = await runUpdate(f.options);
  assert.equal(result.migrated, false);
  assert.equal(result.service.enabled, false);
  assert.equal(f.installCalls().length, 1);
});

test("disabled legacy services must be verified quiescent before replacement", async t => {
  for (const enabled of [true, false]) {
    const f = fixture(t);
    f.configured(enabled);
    f.options.quiescent = () => false;
    f.options.installService = async () => ({ configured: true, enabled: false, liveVerified: false, ready: false });
    await assert.rejects(runUpdate(f.options), { code: "UPDATE_RELAY_PENDING", pending: true, phase: "migration" });
    assert.equal(f.installCalls().length, 0);
  }
});

test("already staged runtimes are checked without retargeting or draining them again", async t => {
  const f = fixture(t);
  f.configured(true);
  const stagedRoot = path.join(f.directory, "previous update cache");
  f.options.readRuntime = () => ({ packageRoot: stagedRoot, packageVersion: VERSION, environment: {} });
  const result = await runUpdate(f.options);
  assert.equal(result.migrated, false);
  assert.deepEqual(f.calls.filter(item => item.kind === "service").map(item => [item.request.root, item.request.check]), [[stagedRoot, true], [f.globalRoot, true]]);
});

test("newer staged runtimes are never downgraded even when the global package is older", async t => {
  const f = fixture(t);
  f.configured(true);
  f.options.readRuntime = () => ({ packageRoot: f.root, packageVersion: "1.27.0", environment: {} });
  await assert.rejects(runUpdate(f.options), { code: "UPDATE_DOWNGRADE_REFUSED" });
  assert.equal(f.installCalls().length, 0);
  assert.equal(f.calls.some(item => item.kind === "service"), false);
});

test("a newer updater resumes after a previous update staged an older safe runtime", async t => {
  const f = fixture(t);
  f.configured(true);
  const targetVersion = "1.26.3";
  const stagedRoot = path.join(f.directory, "previous update cache");
  f.writePackage(f.root, targetVersion);
  f.options.readRuntime = () => ({ packageRoot: stagedRoot, packageVersion: VERSION, environment: {} });
  const run = f.options.run;
  f.options.run = async (command, args, settings) => {
    if (args[1] === "install") {
      f.calls.push({ kind: "command", command, args, settings });
      f.writePackage(f.globalRoot, targetVersion);
      return { status: 0, stdout: "" };
    }
    return run(command, args, settings);
  };
  f.options.installService = async request => {
    f.calls.push({ kind: "service", request });
    return { configured: true, enabled: true, liveVerified: true, ready: true, pid: 123,
      version: request.root === stagedRoot ? VERSION : targetVersion };
  };
  const result = await runUpdate(f.options);
  assert.equal(result.version, targetVersion);
  assert.equal(result.service.version, targetVersion);
  assert.equal(result.migrated, false);
  assert.equal(f.installCalls().length, 1);
  assert.ok(f.installCalls()[0].args.includes(`${PACKAGE}@${targetVersion}`));
  assert.deepEqual(f.calls.filter(item => item.kind === "service").map(item => [item.request.root, item.request.check]), [[stagedRoot, true], [f.globalRoot, true]]);
});

test("npm EBUSY after a successful migration preserves that runtime and reports a safe retry", async t => {
  const f = fixture(t);
  f.configured(true);
  const run = f.options.run;
  f.options.run = async (command, args, settings) => {
    if (args[1] === "install") {
      f.calls.push({ kind: "command", command, args, settings });
      return { status: 1, stderr: "npm error code EBUSY\nsecret=never-report-this" };
    }
    return run(command, args, settings);
  };
  await assert.rejects(runUpdate(f.options), error => error.code === "UPDATE_PACKAGE_BUSY" && error.cause.code === "EBUSY"
    && !error.message.includes("never-report-this"));
  assert.equal(f.installCalls().length, 1);
  assert.deepEqual(f.calls.filter(item => item.kind === "service").map(item => item.request.root), [f.root]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.globalRoot, "package.json"))).version, "1.26.1");
});

test("global setup verification failure does not claim the update completed", async t => {
  const f = fixture(t);
  const run = f.options.run;
  f.options.run = async (command, args, settings) => args[0].endsWith("setup.mjs")
    ? { status: 0, stdout: JSON.stringify({ configured: false }) } : run(command, args, settings);
  await assert.rejects(runUpdate(f.options), { code: "UPDATE_SETUP_INCOMPLETE", phase: "verification" });
  assert.equal(f.installCalls().length, 1);
});

test("postinstall service activation must complete before update success", async t => {
  const f = fixture(t, VERSION);
  f.options.installService = async () => ({ configured: true, enabled: true, liveVerified: false, ready: false });
  await assert.rejects(runUpdate(f.options), { code: "UPDATE_RELAY_PENDING", phase: "verification" });
  assert.equal(f.installCalls().length, 1);
});

test("setup opt-out and invalid arguments fail before invoking npm or services", async t => {
  const f = fixture(t);
  await assert.rejects(runUpdate({ ...f.options, env: { ...f.env, CODEX_BRIDGE_SKIP_SETUP: "1" } }), { code: "UPDATE_SETUP_DISABLED" });
  await assert.rejects(runUpdate({ ...f.options, args: ["--force"] }), { code: "UPDATE_ARGUMENT_INVALID" });
  assert.equal(f.calls.length, 0);
  assert.match((await runUpdate({ ...f.options, args: ["--help"] })).help, /codex-bridge-update/);
  assert.equal(f.calls.length, 0);
});

test("an older updater cannot downgrade a newer global installation", async t => {
  for (const installed of ["1.26.3", "1.27.0", "2.0.0"]) {
    const f = fixture(t, installed);
    await assert.rejects(runUpdate(f.options), { code: "UPDATE_DOWNGRADE_REFUSED" });
    assert.equal(f.installCalls().length, 0);
  }
});

test("npm resolution validates package metadata and accepts paths with spaces", t => {
  const f = fixture(t);
  assert.equal(resolveUpdateNpm(f.env), fs.realpathSync.native(f.npm));
  fs.writeFileSync(path.resolve(path.dirname(f.npm), "..", "package.json"), JSON.stringify({ name: "unrelated" }));
  try { assert.notEqual(resolveUpdateNpm(f.env), fs.realpathSync.native(f.npm)); }
  catch (error) { assert.equal(error.code, "UPDATE_NPM_NOT_FOUND"); }
});

test("malformed npm global roots and unexpected installed versions fail closed", async t => {
  const f = fixture(t);
  await assert.rejects(runUpdate({ ...f.options, run: async () => ({ status: 0, stdout: "relative/path\n" }) }), { code: "UPDATE_GLOBAL_ROOT_INVALID" });
  const run = f.options.run;
  f.options.run = async (command, args, settings) => args[1] === "install" ? { status: 0, stdout: "" } : run(command, args, settings);
  await assert.rejects(runUpdate(f.options), { code: "UPDATE_VERSION_MISMATCH" });
});

test("POSIX global prefixes update without applying the Windows legacy migration", async t => {
  for (const platform of ["linux", "darwin"]) {
    const f = fixture(t, "1.26.1", platform);
    f.configured(true);
    const result = await runUpdate(f.options);
    assert.equal(result.migrated, false);
    assert.deepEqual(f.calls.filter(item => item.kind === "service").map(item => item.request.root), [f.globalRoot]);
    assert.equal(f.installCalls()[0].args[f.installCalls()[0].args.indexOf("--prefix") + 1], f.prefix);
  }
});

test("a global prefix change between npm inspection commands is rejected", async t => {
  const f = fixture(t);
  const run = f.options.run;
  f.options.run = async (command, args, settings) => args[1] === "prefix"
    ? { status: 0, stdout: path.join(f.directory, "another prefix") } : run(command, args, settings);
  await assert.rejects(runUpdate(f.options), { code: "UPDATE_GLOBAL_ROOT_INVALID" });
  assert.equal(f.installCalls().length, 0);
});

test("CLI JSON failures stay parseable and contain safe typed diagnostics", () => {
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/update.mjs"), "--json"], {
    encoding: "utf8", windowsHide: true, shell: false, timeout: 10000,
    env: { ...process.env, CODEX_BRIDGE_SKIP_SETUP: "1", AGENT_RELAY_TOKEN: "never-report-cli-secret" },
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.updated, false);
  assert.equal(parsed.diagnostic.code, "UPDATE_SETUP_DISABLED");
  assert.match(parsed.diagnostic.reportId, /^[a-f0-9-]+$/);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /never-report-cli-secret/);
});
