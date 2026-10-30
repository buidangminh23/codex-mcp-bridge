import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCodexBin, resolvePackagedCodexBin } from "./platform.mjs";
import { readRegularConfigFile } from "./project-policy.mjs";
import { stableInstallPath } from "./install-paths.mjs";

const ROOT = stableInstallPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const CODEX_PACKAGE = "@openai/codex@0.166.0";
const MAX_CONFIG = 16 * 1024 * 1024;

export function setupArguments(args) {
  const allowed = new Set(["--postinstall", "--check", "--dry-run", "--json", "--no-download", "--help"]);
  if (args.some((arg) => !allowed.has(arg))) throw new Error("Unknown setup option; use codex-bridge-setup --help");
  if (args.includes("--check") && args.includes("--dry-run")) throw new Error("Use --check or --dry-run, not both");
  return Object.fromEntries([...allowed].map((arg) => [arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), args.includes(arg)]));
}

export function automaticSetupEnabled(env = process.env) {
  return env.npm_config_global === "true" && env.CODEX_BRIDGE_SKIP_SETUP !== "1";
}

export function setupPaths(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const codeDirectory = env.CLAUDE_CONFIG_DIR || home;
  const configRoot = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const desktop = env.CLAUDE_DESKTOP_CONFIG || (platform === "win32"
    ? path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : path.join(configRoot, "Claude", "claude_desktop_config.json"));
  return { home, code: path.join(codeDirectory, ".claude.json"), desktop,
    codex: env.CODEX_HOME || path.join(home, ".codex"),
    gemini: path.join(home, ".gemini", "config"), tools: path.join(configRoot, "GptClaudeBridge", "tools") };
}

function readJson(file) {
  const text = readRegularConfigFile(file, { missing: true, maxBytes: MAX_CONFIG });
  if (text === null) return null;
  const value = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a JSON object: ${file}`);
  return value;
}

function execute(command, args, env, timeout = 120000) {
  const result = spawnSync(command, args, { env, encoding: "utf8", windowsHide: true, shell: false, timeout,
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) {
    const lines = String(result.stderr || "").split(/\r?\n/).filter((line) => /^Error:|^(?:Expected|Refusing|Invalid|Unknown|Shared|Claude|Codex|Configuration|The existing|Missing|Unsafe)/.test(line)
      && !/Command failed|--env|password|secret|token|authorization/i.test(line));
    const detail = lines.slice(0, 3).join(" ") || result.error?.code || `exit ${result.status}`;
    throw new Error(`${path.basename(command)} ${path.basename(args[0] ?? "")}: ${detail}`);
  }
  return result.stdout || "";
}

function usableBinary(binary, platform) {
  return typeof binary === "string" && path.isAbsolute(binary) && fs.existsSync(binary)
    && fs.statSync(binary).isFile() && (platform !== "win32" || /\.(exe|com)$/i.test(binary));
}

function managedBinary(paths, platform) {
  return resolvePackagedCodexBin({ platform, resolvePackage: (specifier, from) => createRequire(
    specifier === "@openai/codex/package.json" ? path.join(paths.tools, "package.json") : from,
  ).resolve(specifier) });
}

export function ensureSetupCodex({ env, paths, platform, download = true, run = execute, resolve = resolveCodexBin }) {
  const existing = resolve(env.CODEX_EXE, { env, platform });
  if (usableBinary(existing, platform)) return { binary: existing, installed: false };
  const managed = managedBinary(paths, platform);
  if (usableBinary(managed, platform)) return { binary: managed, installed: false };
  if (!download) throw new Error("Codex CLI was not found. Rerun setup without --no-download to install it automatically.");
  const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
  const npm = candidates.find((file) => file && path.isAbsolute(file) && fs.existsSync(file) && /(?:npm-cli|npm)\.js$/i.test(file));
  if (!npm) throw new Error("Codex CLI is missing and npm could not be located. Rerun the global npm install command to finish setup.");
  fs.mkdirSync(paths.tools, { recursive: true, mode: 0o700 });
  run(process.execPath, [npm, "install", "--global=false", "--prefix", paths.tools, "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--no-save", CODEX_PACKAGE],
    { ...env, npm_config_global: "false", CODEX_BRIDGE_SKIP_SETUP: "1" }, 180000);
  const binary = managedBinary(paths, platform);
  if (!usableBinary(binary, platform)) throw new Error("The Codex CLI download did not provide a supported native executable. Check npm optional dependencies and rerun setup.");
  return { binary, installed: true };
}

export function setupEnvironment(env, paths, codex) {
  const result = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:CODEX_BRIDGE_|CLAUDE_BRIDGE_|CODEX_NATIVE_RELAY_|CODEX_RELAY_ID$|CODEX_THREAD_ID$|CODEX_APP_TOOLS_PIPE_PATH$)/.test(name)));
  return { ...result, HOME: paths.home, USERPROFILE: paths.home, CODEX_HOME: paths.codex,
    CLAUDE_DESKTOP_CONFIG: paths.desktop, CODEX_EXE: codex, CODEX_BIN: codex };
}

function configurationCheck(label, check, components) {
  try { check(); components.push({ name: label, status: "configured" }); }
  catch (error) { components.push({ name: label, status: "incomplete", detail: error.message }); }
}

function assertEntry(entry, worker, root, { caller } = {}) {
  if (!entry || typeof entry.command !== "string" || !fs.existsSync(entry.command)) throw new Error("MCP command is missing or unavailable");
  const args = entry.args ?? [];
  const expected = worker === "index.mjs" || worker === "claude-bridge.mjs" || worker === "native-relay-companion.mjs"
    ? [path.join(root, "src", "mcp-supervisor.mjs"), worker] : [path.join(root, "src", worker)];
  if (JSON.stringify(args) !== JSON.stringify(expected)) throw new Error("MCP entry points to a different installation or unsupported launcher");
  if (entry.enabled === false || entry.disabled === true) throw new Error("MCP entry is disabled; the saved choice was preserved");
  if (caller && entry.env?.ANTIGRAVITY_BRIDGE_CALLER !== caller) throw new Error("Antigravity caller registration is missing or conflicting");
}

export function checkSetup({ env = process.env, platform = process.platform, root = ROOT, run = execute, resolve = resolveCodexBin } = {}) {
  const paths = setupPaths(env, platform);
  const components = [];
  let codex;
  let inventory;
  configurationCheck("Codex CLI", () => {
    codex = ensureSetupCodex({ env, paths, platform, download: false, run, resolve }).binary;
    inventory = JSON.parse(run(codex, ["mcp", "list", "--json"], setupEnvironment(env, paths, codex), 30000));
    if (!Array.isArray(inventory)) throw new Error("Codex returned an invalid MCP inventory");
  }, components);
  const native = platform === "win32" || platform === "darwin";
  for (const [name, worker] of [["claude-bridge", "claude-bridge.mjs"], ...(native ? [["codex-native-relay", "native-relay-companion.mjs"]] : []), ["antigravity-bridge", "antigravity-bridge.mjs"]]) {
    configurationCheck(`Codex / ${name}`, () => {
      const item = inventory?.find((server) => server.name === name);
      if (!item) throw new Error("MCP registration is missing");
      const entry = JSON.parse(run(codex, ["mcp", "get", name, "--json"], setupEnvironment(env, paths, codex), 30000));
      assertEntry({ ...entry.transport, enabled: entry.enabled }, worker, root, name === "antigravity-bridge" ? { caller: "codex" } : {});
      if (name === "codex-native-relay" && !entry.transport.env_vars?.includes("CODEX_APP_TOOLS_PIPE_PATH")) throw new Error("Native pipe forwarding is missing");
    }, components);
  }
  for (const [label, file, name, worker, caller] of [
    ["Claude Code / codex-bridge", paths.code, "codex-bridge", "index.mjs"],
    ["Claude Desktop / codex-bridge-desktop", paths.desktop, "codex-bridge-desktop", "index.mjs"],
    ["Claude Code / antigravity-bridge", paths.code, "antigravity-bridge", "antigravity-bridge.mjs", "claude"],
    ["Antigravity / agent-bridge", path.join(paths.gemini, "mcp_config.json"), "agent-bridge", "antigravity-outbound-bridge.mjs"],
  ]) configurationCheck(label, () => assertEntry(readJson(file)?.mcpServers?.[name], worker, root, { caller }), components);
  configurationCheck("Antigravity / codex-bridge sidecar", () => {
    assertEntry(readJson(path.join(paths.gemini, "sidecars", "codex-bridge", "sidecar.json")), "antigravity-sidecar.mjs", root);
    if (readJson(path.join(paths.gemini, "config.json"))?.sidecars?.["codex-bridge"]?.enabled !== true) throw new Error("Antigravity sidecar is not enabled");
  }, components);
  if (native) configurationCheck("Native relay executor", () => {
    const relay = readJson(path.join(paths.codex, "native-relay.json"));
    if (!relay?.relayThreadId) throw new Error("Native relay executor has not been initialized");
  }, components);
  configurationCheck("Claude registration names", () => {
    if (readJson(paths.desktop)?.mcpServers?.["codex-bridge"]) throw new Error("Shared codex-bridge shadows the Claude Code registration");
  }, components);
  return { configured: components.every((item) => item.status === "configured"), liveVerified: false, components };
}

export function runSetup({ args = [], env = process.env, platform = process.platform, root = ROOT, run = execute, resolve = resolveCodexBin } = {}) {
  const options = setupArguments(args);
  if (options.help) return { help: "Usage: codex-bridge-setup [--check|--dry-run] [--json] [--no-download]\nGlobal npm installation configures Claude Desktop, Claude Code, Codex and Antigravity automatically. CODEX_BRIDGE_SKIP_SETUP=1 opts out." };
  if (options.postinstall && !automaticSetupEnabled(env)) return { skipped: true, reason: "Automatic configuration runs only for a global npm install; use codex-bridge-setup for manual setup." };
  if (options.check) return checkSetup({ env, platform, root, run, resolve });
  const native = platform === "win32" || platform === "darwin";
  const paths = setupPaths(env, platform);
  const planned = ["Claude Code / codex-bridge", "Claude Desktop / codex-bridge-desktop", ...(native ? ["Codex / codex-native-relay and executor"] : []), "Codex / claude-bridge", "Antigravity / all components"];
  if (options.dryRun) return { dryRun: true, configured: false, liveVerified: false, components: planned.map((name) => ({ name, status: "planned" })), files: [paths.code, paths.desktop, path.join(paths.codex, "config.toml"), paths.gemini] };
  if (env.SUDO_USER && env.SUDO_USER !== "root" && typeof process.getuid === "function" && process.getuid() === 0) throw new Error("Run the global install without sudo in the account that runs the apps; setup will not write another account's configuration.");
  const runtime = ensureSetupCodex({ env, paths, platform, download: !options.noDownload, run, resolve });
  fs.mkdirSync(paths.codex, { recursive: true, mode: 0o700 });
  const base = setupEnvironment(env, paths, runtime.binary);
  const components = [];
  const install = (name, script, arguments_, environment = base) => {
    try {
      const output = run(process.execPath, [path.join(root, "scripts", script), ...arguments_], environment, 180000);
      let notices = [];
      try { notices = JSON.parse(output).notices ?? []; } catch {}
      components.push({ name, status: "configured", ...(notices.length ? { notices } : {}) });
      return true;
    } catch (error) { components.push({ name, status: "incomplete", detail: error.message }); return false; }
  };
  const code = install(planned[0], "install-claude-code.mjs", ["--install", "--desktop-config", paths.desktop], {
    ...base, CODEX_BRIDGE_DESKTOP_TASKS: native ? "1" : "0", CODEX_BRIDGE_AUTOSTART: native ? "0" : "1", CODEX_BRIDGE_THREAD_POLICY: "roots",
  });
  if (code) install(planned[1], "install-claude-desktop.mjs", ["--entry-name", "codex-bridge-desktop", "--quiet"]);
  if (native) {
    const relay = readJson(path.join(paths.codex, "native-relay.json"));
    install("Codex / codex-native-relay and executor", "install-native-relay.mjs", ["--setup", ...(relay?.desktopTasks === undefined ? ["--desktop-tasks"] : [])]);
  }
  install("Codex / claude-bridge", "install-codex-mcp.mjs", ["--setup"]);
  if (code) install("Antigravity / all components", "install-antigravity-bridge.mjs", ["--all", "--setup"]);
  const inspection = checkSetup({ env: base, platform, root, run, resolve: () => runtime.binary });
  return { configured: components.every((item) => item.status === "configured") && inspection.configured, liveVerified: false,
    cliInstalled: runtime.installed, components, verification: inspection.components,
    nextActions: ["Open or reconnect Claude, Codex and Antigravity after active work finishes so they load the new entries.",
      "Use the same saved project in Claude Desktop Code and Codex Desktop. Keep the apps signed in.",
      "Verify codex_bridge_status in Claude Code, native_relay_status in Codex, and agent_bridge_status in Antigravity. Shared Claude Desktop chat uses the local app-server route."] };
}

export function printSetup(result, { json = false, output = console.log } = {}) {
  if (json) { output(JSON.stringify(result, null, 2)); return; }
  if (result.help) { output(result.help); return; }
  if (result.skipped) { output(result.reason); return; }
  output(result.dryRun ? "Bridge setup preview (no changes)" : result.configured ? "Bridge configuration verified. Live connections still require the apps to load it." : "Bridge setup is incomplete. Fix the items below, then run codex-bridge-setup again.");
  for (const item of result.components ?? []) {
    output(`[${item.status}] ${item.name}${item.detail ? `: ${item.detail}` : ""}`);
    for (const notice of item.notices ?? []) output(`  ${notice}`);
  }
  for (const item of result.verification ?? []) if (item.status !== "configured") output(`[${item.status}] ${item.name}: ${item.detail}`);
  for (const action of result.nextActions ?? []) output(action);
}
