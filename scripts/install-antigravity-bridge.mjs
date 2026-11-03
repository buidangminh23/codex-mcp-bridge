#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { applyStdioMcpRegistration, stdioMcpRegistration } from "../src/codex-mcp-registration.mjs";
import { bridgeEntrypointConflict, isBridgeSource, isMainModule, isNodeLauncher, stableInstallPath, stableNodeBin } from "../src/install-paths.mjs";
import { backupRegularConfigFile } from "../src/project-policy.mjs";
import { homeDir, resolveCodexBin, spawnEnv } from "../src/platform.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { createReleaseSnapshot, snapshotRoot } from "../src/release-snapshot.mjs";

const NAME = "antigravity-bridge";
const SIDECAR = "codex-bridge";
const OUTBOUND = "agent-bridge";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function snapshot(file, jsonLabel) {
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error.code === "ENOENT") return { file, text: null, value: {} };
    if (error.code === "ELOOP") throw new Error(`Unsafe configuration file: ${file}`);
    throw error;
  }
  const safe = (value) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1 && value.size <= 16 * 1024 * 1024;
  const matches = (left, right) => safe(right) && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
  try {
    const stat = fs.lstatSync(file);
    const opened = fs.fstatSync(descriptor);
    if (!safe(stat) || !safe(opened)) throw new Error(`Unsafe configuration file: ${file}`);
    if (!matches(stat, opened)) throw new Error(`Configuration changed while opening: ${file}`);
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length !== opened.size || !matches(opened, fs.fstatSync(descriptor)) || !matches(opened, fs.lstatSync(file))) throw new Error(`Configuration changed while reading: ${file}`);
    const text = buffer.subarray(0, length).toString("utf8");
    let value;
    try { value = object(JSON.parse(text), file); }
    catch (error) {
      if (jsonLabel) throw new Error(`Invalid ${jsonLabel}: expected a JSON object.`);
      throw error;
    }
    return { file, text, value, ...(jsonLabel ? { jsonLabel } : {}), mode: opened.mode & 0o777, dev: opened.dev, ino: opened.ino };
  } finally { fs.closeSync(descriptor); }
}

export function validateCodexExecutable(executable, { platform = process.platform } = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable) || executable.includes("\0")) throw new Error("Codex executable must be an absolute native executable path");
  const resolved = fs.realpathSync.native(executable);
  if (!fs.statSync(resolved).isFile()) throw new Error("Codex executable must be a regular file");
  if (platform === "win32" && !/\.(exe|com)$/i.test(resolved)) throw new Error("Codex executable must be a native Windows executable, not a shell script");
  return resolved;
}

function ownEntry(entry, expected, label, retarget = false, supervised = false, node = stableNodeBin()) {
  if (entry === undefined || entry === null) return;
  object(entry, label);
  const script = entry.args?.[0];
  const managed = supervised && Array.isArray(entry.args) && entry.args.length === 2
    && typeof script === "string" && path.basename(script) === "mcp-supervisor.mjs" && entry.args[1] === path.basename(expected);
  const commandArgs = supervised ? [path.join(path.dirname(expected), "mcp-supervisor.mjs"), path.basename(expected)] : [expected];
  const conflict = detail => bridgeEntrypointConflict(label, node, commandArgs, detail);
  if (!Array.isArray(entry.args) || !managed && entry.args.length !== 1 || typeof script !== "string") {
    throw conflict("a different entrypoint");
  }
  const target = managed ? path.join(path.dirname(expected), "mcp-supervisor.mjs") : expected;
  const current = path.isAbsolute(script) && path.relative(target, script) === "";
  if (!current && (!retarget || path.basename(script) !== path.basename(target)
    || !isBridgeSource(script, [], [path.basename(expected)])) || script.includes("\0")) {
    throw conflict("a different entrypoint");
  }
  if (!isNodeLauncher(entry.command)) {
    throw conflict("a different launcher");
  }
}

function changed(original, value) {
  const text = value === null ? null : JSON.stringify(value, null, 2) + "\n";
  if (text === original.text || value !== null && JSON.stringify(value) === JSON.stringify(original.value)) return null;
  return { ...original, next: text };
}

export function planAntigravityInstallation({ home = homeDir(), codeConfigDir = process.env.CLAUDE_CONFIG_DIR || home, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), node = stableNodeBin(), targets = ["codex", "claude", "desktop"], remove = false, setup = false, codexExisting = null, platform = process.platform, appData = process.env.APPDATA } = {}) {
  if (!path.isAbsolute(home) || !path.isAbsolute(codeConfigDir) || !path.isAbsolute(root) || !path.isAbsolute(node)) throw new Error("Installer paths must be absolute");
  if (!targets.length || targets.some((target) => !["codex", "claude", "desktop"].includes(target))) throw new Error("Unknown installation target");
  const entry = path.join(root, "src", "antigravity-bridge.mjs");
  const sidecarEntry = path.join(root, "src", "antigravity-sidecar.mjs");
  const outboundEntry = path.join(root, "src", "antigravity-outbound-bridge.mjs");
  const supervisorEntry = path.join(root, "src", "mcp-supervisor.mjs");
  const edits = [];
  const notices = [];
  const runtimeCaches = new Set();
  let backgroundPreference = null;
  const retarget = setup && !remove;
  let codex = null;
  if (targets.includes("codex")) {
    if (codexExisting && codexExisting.transport?.type !== "stdio") throw new Error("The existing Antigravity MCP transport is not stdio");
    ownEntry(codexExisting?.transport, entry, "Codex Antigravity bridge", retarget, true, node);
    const existingCaller = codexExisting?.transport?.env?.ANTIGRAVITY_BRIDGE_CALLER;
    if (existingCaller !== undefined && existingCaller !== "codex") throw new Error("The existing Codex bridge has a conflicting caller identity");
    codex = remove ? { remove: Boolean(codexExisting) } : stdioMcpRegistration({ name: NAME, existing: codexExisting, node, entry: supervisorEntry, entryArgs: [path.basename(entry)], envOverrides: { ANTIGRAVITY_BRIDGE_CALLER: "codex" } });
    if (!remove) runtimeCaches.add(snapshotRoot({ ...process.env, ...codex.environment }));
  }
  if (targets.includes("claude")) {
    const original = snapshot(path.join(codeConfigDir, ".claude.json"));
    const value = structuredClone(original.value);
    if (value.mcpServers !== undefined) object(value.mcpServers, "Claude mcpServers");
    const existing = value.mcpServers?.[NAME];
    ownEntry(existing, entry, "Claude Antigravity bridge", retarget, true, node);
    if (existing?.type !== undefined && existing.type !== "stdio") throw new Error("The existing Claude bridge transport is not stdio");
    if (existing?.env !== undefined) object(existing.env, "Claude bridge environment");
    if (existing?.env?.ANTIGRAVITY_BRIDGE_CALLER !== undefined && existing.env.ANTIGRAVITY_BRIDGE_CALLER !== "claude") throw new Error("The existing Claude bridge has a conflicting caller identity");
    if (remove) { if (existing) delete value.mcpServers[NAME]; }
    else {
      value.mcpServers ??= {};
      value.mcpServers[NAME] = { ...existing, type: "stdio", command: node, args: [supervisorEntry, path.basename(entry)], env: { ...existing?.env, ANTIGRAVITY_BRIDGE_CALLER: "claude" } };
      runtimeCaches.add(snapshotRoot({ ...process.env, ...value.mcpServers[NAME].env }));
    }
    const edit = changed(original, value);
    if (edit) edits.push(edit);
  }
  if (targets.includes("desktop")) {
    const configRoot = path.join(home, ".gemini", "config");
    const originalMcp = snapshot(path.join(configRoot, "mcp_config.json"));
    const mcp = structuredClone(originalMcp.value);
    if (mcp.mcpServers !== undefined) object(mcp.mcpServers, "Antigravity mcpServers");
    const outbound = mcp.mcpServers?.[OUTBOUND];
    ownEntry(outbound, outboundEntry, "Antigravity outbound bridge", retarget, true, node);
    if (outbound?.type !== undefined && outbound.type !== "stdio" || outbound?.url !== undefined || outbound?.serverUrl !== undefined || outbound?.httpUrl !== undefined) throw new Error("The existing Antigravity outbound bridge transport is not stdio");
    if (outbound?.env !== undefined) object(outbound.env, "Antigravity outbound bridge environment");
    if (Object.keys(outbound?.env ?? {}).some((name) => /^(?:CLAUDE|CODEX_|ANTIGRAVITY_BRIDGE_CALLER$)/i.test(name))) throw new Error("The existing Antigravity outbound bridge contains a foreign caller environment; review it before installation");
    for (const name of ["codex-bridge", "claude-bridge"]) {
      if (Object.hasOwn(mcp.mcpServers ?? {}, name)) notices.push(`Existing Antigravity MCP entry ${name} was preserved; it is separate from the native agent-bridge sender integration.`);
    }
    if (remove) { if (outbound) delete mcp.mcpServers[OUTBOUND]; }
    else {
      mcp.mcpServers ??= {};
      mcp.mcpServers[OUTBOUND] = { ...outbound, command: node, args: [supervisorEntry, path.basename(outboundEntry)] };
      runtimeCaches.add(snapshotRoot({ ...process.env, ...outbound?.env }));
    }
    const mcpEdit = changed(originalMcp, mcp);
    if (mcpEdit) edits.push(mcpEdit);
    const originalSidecar = snapshot(path.join(configRoot, "sidecars", SIDECAR, "sidecar.json"));
    if (originalSidecar.text !== null) ownEntry(originalSidecar.value, sidecarEntry, "Antigravity sidecar", retarget, false, node);
    const originalConfig = snapshot(path.join(configRoot, "config.json"));
    const config = structuredClone(originalConfig.value);
    if (config.sidecars !== undefined) object(config.sidecars, "Antigravity sidecars");
    if (config.sidecars?.[SIDECAR] !== undefined) object(config.sidecars[SIDECAR], "Antigravity bridge sidecar settings");
    if (originalSidecar.text === null && config.sidecars?.[SIDECAR] !== undefined) {
      const settings = config.sidecars[SIDECAR];
      const plain = Object.keys(settings).every(key => key === "enabled") && (settings.enabled === undefined || typeof settings.enabled === "boolean");
      if (!setup || remove || !plain) throw new Error('SETUP_SIDECAR_DEFINITION_MISSING: Antigravity config.json still contains sidecars["codex-bridge"] without sidecar.json. Restore the previous bridge definition, or back up config.json and remove only the stale sidecars["codex-bridge"] entry before rerunning setup.');
      notices.push("Restored the missing bridge sidecar definition and preserved its saved enabled preference.");
    }
    let definition = null;
    if (remove) { if (config.sidecars) delete config.sidecars[SIDECAR]; }
    else {
      definition = { ...originalSidecar.value, command: node, args: [sidecarEntry], restart_policy: originalSidecar.value.restart_policy ?? "on-failure", display_name: setup ? originalSidecar.value.display_name ?? "Codex / Claude Antigravity Bridge" : "Codex / Claude Antigravity Bridge" };
      if (definition.builtin !== undefined) throw new Error("A builtin Antigravity sidecar cannot be replaced");
      config.sidecars ??= {};
      const enabled = setup ? config.sidecars[SIDECAR]?.enabled ?? true : true;
      config.sidecars[SIDECAR] = { ...config.sidecars[SIDECAR], enabled };
      if (enabled === false) notices.push("The existing Antigravity bridge sidecar is disabled; automatic setup preserved that choice.");
    }
    const sidecarEdit = changed(originalSidecar, definition);
    const configEdit = changed(originalConfig, config);
    if (sidecarEdit) edits.push(sidecarEdit);
    if (configEdit) edits.push(configEdit);
    if (setup && !remove) {
      backgroundPreference = { setting: "runInBackground", status: "unavailable", liveVerified: false };
      if (platform !== "win32") {
        backgroundPreference.detail = "Automatic Antigravity background preferences are not verified on this platform; native settings were preserved.";
      } else if (typeof appData !== "string" || !path.isAbsolute(appData)) {
        backgroundPreference.detail = "Antigravity background preferences were not applied because an absolute APPDATA path is unavailable.";
      } else {
        const storage = snapshot(path.join(appData, "Antigravity", "app_storage.json"), "Antigravity native preferences");
        if (storage.text === null) {
          backgroundPreference.detail = "Antigravity app_storage.json was not found; no native preferences file was created and background operation is unverified.";
        } else {
          const storageEdit = changed(storage, { ...storage.value, runInBackground: "true" });
          if (storageEdit) edits.push(storageEdit);
          backgroundPreference.status = storageEdit ? "planned" : "configured";
        }
      }
      if (backgroundPreference.detail) notices.push(backgroundPreference.detail);
    }
  }
  if (!remove) notices.push("Running direct Antigravity MCP processes retain their current version until the host reconnects normally. Future supervised workers update automatically when quiescent.");
  return { name: NAME, targets: [...new Set(targets)], remove, edits, notices, codex, entry, sidecarEntry, outboundEntry, supervisorEntry, runtimeCaches: [...runtimeCaches], backgroundPreference };
}

function assertCurrent(edit) {
  const current = snapshot(edit.file, edit.jsonLabel);
  if (current.text !== edit.text || current.dev !== edit.dev || current.ino !== edit.ino) throw new Error(`Configuration changed while preparing installation: ${edit.file}`);
}

export function applyJsonEdits(edits) {
  for (const edit of edits) assertCurrent(edit);
  const completed = [];
  const suffix = randomUUID();
  try {
    for (const edit of edits) {
      assertCurrent(edit);
      if (edit.text !== null) backupRegularConfigFile(edit.file, `${edit.file}.backup-${suffix}`, edit.text, 16 * 1024 * 1024);
      assertCurrent(edit);
      if (edit.next === null) fs.unlinkSync(edit.file);
      else {
        fs.mkdirSync(path.dirname(edit.file), { recursive: true, mode: 0o700 });
        const temporary = `${edit.file}.${process.pid}.bridge.tmp`;
        try {
          fs.writeFileSync(temporary, edit.next, { mode: edit.mode ?? 0o600, flag: "wx" });
          assertCurrent(edit);
          fs.renameSync(temporary, edit.file);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      completed.push(edit);
      if (snapshot(edit.file, edit.jsonLabel).text !== edit.next) throw new Error(`Configuration readback did not match the saved update: ${edit.file}`);
    }
  } catch (error) {
    for (const edit of completed.reverse()) {
      if (snapshot(edit.file, edit.jsonLabel).text !== edit.next) continue;
      if (edit.text === null) fs.unlinkSync(edit.file);
      else fs.writeFileSync(edit.file, edit.text, { mode: edit.mode ?? 0o600 });
    }
    throw error;
  }
}

export function installerArguments(args) {
  const allowed = new Set(["--codex", "--claude", "--desktop", "--all", "--remove", "--dry-run", "--setup", "--help"]);
  if (args.some((arg) => !allowed.has(arg))) throw new Error("Unknown option; use --help");
  const selected = ["codex", "claude", "desktop"].filter((target) => args.includes(`--${target}`));
  return { targets: args.includes("--all") || !selected.length ? ["codex", "claude", "desktop"] : selected, remove: args.includes("--remove"), dryRun: args.includes("--dry-run"), setup: args.includes("--setup"), help: args.includes("--help") };
}

export function runAntigravityInstaller(args = process.argv.slice(2), { prepareRuntime = createReleaseSnapshot } = {}) {
  const options = installerArguments(args);
  if (options.help) {
    console.log("Usage: antigravity-mcp-bridge-install [--all|--codex|--claude|--desktop] [--remove] [--dry-run] [--setup]");
    return;
  }
  const home = homeDir();
  const root = stableInstallPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const node = stableNodeBin();
  let run;
  let codexExisting = null;
  if (options.targets.includes("codex")) {
    const codexBin = validateCodexExecutable(resolveCodexBin(process.env.CODEX_EXE));
    run = (command) => execFileSync(codexBin, command, { encoding: "utf8", env: spawnEnv(), windowsHide: true, shell: false, timeout: 30000, stdio: "pipe" });
    const inventory = JSON.parse(run(["mcp", "list", "--json"]));
    if (!Array.isArray(inventory)) throw new Error("Codex returned an invalid MCP inventory");
    if (inventory.some((item) => item.name === NAME)) codexExisting = JSON.parse(run(["mcp", "get", NAME, "--json"]));
  }
  const plan = planAntigravityInstallation({ ...options, home, root, node, codexExisting });
  if (!options.remove) {
    for (const entry of [plan.supervisorEntry, plan.entry, ...(options.targets.includes("desktop") ? [plan.sidecarEntry, plan.outboundEntry] : [])]) {
      if (!fs.existsSync(entry)) throw new Error(`Missing bridge entrypoint: ${entry}`);
    }
  }
  if (options.dryRun) {
    console.log(JSON.stringify({ dryRun: true, remove: plan.remove, targets: plan.targets, files: plan.edits.map((edit) => ({ path: edit.file, action: edit.next === null ? "remove" : "write" })), notices: plan.notices, backgroundPreference: plan.backgroundPreference, codex: plan.codex ? { name: NAME, action: options.remove ? "remove" : "register" } : null }, null, 2));
    return plan;
  }
  for (const cache of plan.runtimeCaches) prepareRuntime(root, { cache });
  for (const edit of plan.edits) assertCurrent(edit);
  if (plan.codex) {
    if (options.remove) { if (plan.codex.remove) run(["mcp", "remove", NAME]); }
    else applyStdioMcpRegistration({ name: NAME, registration: plan.codex, existing: codexExisting, run, configPath: path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml") });
  }
  applyJsonEdits(plan.edits);
  if (plan.backgroundPreference?.status === "planned") plan.backgroundPreference.status = "configured";
  if (options.setup) {
    console.log(JSON.stringify({ action: options.remove ? "remove" : "install", targets: plan.targets, configured: true, liveVerified: false,
      changedFiles: plan.edits.length, notices: plan.notices, backgroundPreference: plan.backgroundPreference }));
    return plan;
  }
  console.log(`${options.remove ? "Removed" : "Installed"} Antigravity bridge: ${plan.targets.join(", ")}.`);
  for (const notice of plan.notices) console.log(notice);
  if (!options.remove) console.log("Bridge configuration saved; running clients and native permissions were preserved. Installation does not prove a live connection or load new settings into existing processes. This installer does not start apps or open conversations.");
  return plan;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  exitForVersionRequest(import.meta.url);
  try { runAntigravityInstaller(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
