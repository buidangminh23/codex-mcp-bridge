import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveCodexBin, resolvePackagedCodexBin } from "./platform.mjs";
import { readRegularConfigFile } from "./project-policy.mjs";
import { stableInstallPath } from "./install-paths.mjs";
import { resolveClaudeDesktopConfigRoot } from "./desktop-account-context.mjs";
import { activeClaudeDataRoot, repairClaudeDataPin } from "./claude-data-pin.mjs";
import { writeCurrentInstall } from "./current-install.mjs";
import { CODEX_MCP_TIMEOUT_MS } from "./codex-mcp-registration.mjs";

const ROOT = stableInstallPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const CODEX_PACKAGE = "@openai/codex@0.166.0";
const MAX_CONFIG = 16 * 1024 * 1024;
export const SETUP_INSPECTION = "Inspect locally with codex-bridge-setup --check --json.";
const SETUP_COMPONENTS = new Set([
  "Setup preflight", "Claude Desktop data directory", "Codex CLI", "Codex / claude-bridge",
  "Codex / codex-native-relay", "Codex / codex-native-relay and executor", "Codex / antigravity-bridge",
  "Claude Code / codex-bridge", "Claude Desktop / codex-bridge-desktop", "Claude Code / antigravity-bridge",
  "Claude Desktop / background preference", "Antigravity / agent-bridge", "Antigravity / codex-bridge sidecar",
  "Antigravity / all components", "Native relay executor", "Claude registration names", "Independent background relay",
]);
const SETUP_FAILURES = Object.freeze({
  CLAUDE_DESKTOP_DATA_ROOT_AMBIGUOUS: "Multiple active directories; set CLAUDE_DESKTOP_USER_DATA to the active Claude data directory.",
  CLAUDE_DESKTOP_DATA_ROOT_UNAVAILABLE: "Data directory unavailable; check access and the CLAUDE_DESKTOP_USER_DATA override.",
  SETUP_ENTRYPOINT_CONFLICT: "Existing entrypoint could not be verified; review the preserved registration before migration.",
  SETUP_SIDECAR_DEFINITION_MISSING: "Sidecar settings remain without a verified definition; review both sidecar configuration files.",
  SETUP_COMPONENT_INCOMPLETE: "Configuration could not be completed or verified.",
});

function failureCode(error) {
  return typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : "SETUP_COMPONENT_INCOMPLETE";
}

function failedComponent(name, error) {
  return { name, status: "incomplete", code: failureCode(error), detail: error.message };
}

export function setupFailureResult(error) {
  const selected = failureCode(error);
  const code = Object.hasOwn(SETUP_FAILURES, selected) ? selected : "SETUP_COMPONENT_INCOMPLETE";
  const name = code === "CLAUDE_DESKTOP_DATA_ROOT_AMBIGUOUS" || code === "CLAUDE_DESKTOP_DATA_ROOT_UNAVAILABLE"
    ? "Claude Desktop data directory" : "Setup preflight";
  return { configured: false, liveVerified: false, components: [{ name, status: "incomplete", code, detail: SETUP_FAILURES[code] }], nextActions: [SETUP_INSPECTION] };
}

export function setupFailureSummary(value) {
  if (typeof value === "string") {
    if (Buffer.byteLength(value) > 128 * 1024) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.configured !== false) return null;
  const failures = new Map();
  for (const items of [value.components, value.verification]) {
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, 128)) {
      if (!item || item.status !== "incomplete" || !SETUP_COMPONENTS.has(item.name) || failures.has(item.name)) continue;
      const code = typeof item.code === "string" && Object.hasOwn(SETUP_FAILURES, item.code) ? item.code : "SETUP_COMPONENT_INCOMPLETE";
      failures.set(item.name, `${item.name}: ${SETUP_FAILURES[code]}`);
    }
  }
  if (!failures.size) return null;
  return `${SETUP_INSPECTION} ${[...failures.values()].slice(0, 6).join(" ")}${failures.size > 6 ? " Additional incomplete components are listed by that command." : ""}`;
}

export function setupArguments(args) {
  const allowed = new Set(["--postinstall", "--check", "--dry-run", "--json", "--no-download", "--progress", "--help"]);
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
  const desktop = env.CLAUDE_DESKTOP_CONFIG || path.join(resolveClaudeDesktopConfigRoot({ env, platform }), "claude_desktop_config.json");
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
    throw setupProcessFailure(command, args, result);
  }
  return result.stdout || "";
}

export function setupProcessFailure(command, args, result) {
  let structured;
  try { structured = JSON.parse(String(result.stdout || "")); } catch {}
  const validCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
  const codes = [structured?.code, structured?.service?.code, structured?.permissions?.code, structured?.diagnostic?.code,
    ...String(result.stderr || "").split(/\r?\n/).map(line => /^(?:Error: )?([A-Z][A-Z0-9_]{0,79}):/.exec(line)?.[1]).filter(code => Object.hasOwn(SETUP_FAILURES, code ?? "")),
    ...String(result.stderr || "").split(/\r?\n/).map(line => /^([A-Z][A-Z0-9_]{0,79}) \| /.exec(line)?.[1])].filter(validCode);
  const lines = String(result.stderr || "").split(/\r?\n/).filter(line => /^Error:|^(?:Expected|Refusing|Invalid|Unknown|Shared|Claude|Codex|Configuration|The existing|Missing|Unsafe)/.test(line)
    && !/Command failed|--env|password|secret|token|authorization/i.test(line));
  const detail = [...new Set(codes)].join(", ") || lines.slice(0, 3).join(" ") || result.error?.code || `exit ${result.status}`;
  return Object.assign(new Error(`${path.basename(command)} ${path.basename(args[0] ?? "")}: ${detail}`), codes[0] ? { code: codes[0] } : {});
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
  const result = Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:CODEX_BRIDGE_|CLAUDE_BRIDGE_|CODEX_NATIVE_RELAY_|CODEX_RELAY_ID$|CODEX_THREAD_ID$|CODEX_APP_TOOLS_PIPE_PATH$|AGENT_RELAY_(?:TOKEN|WORKER_ID|REQUEST_ID|ENDPOINT)$)/.test(name)));
  return { ...result, HOME: paths.home, USERPROFILE: paths.home, CODEX_HOME: paths.codex,
    CLAUDE_DESKTOP_CONFIG: paths.desktop, CODEX_EXE: codex, CODEX_BIN: codex };
}

function codexInventoryFailure(error) {
  const detail = error?.message?.includes("ETIMEDOUT") || error?.code === "ETIMEDOUT"
    ? `Codex CLI did not list its MCP servers within ${CODEX_MCP_TIMEOUT_MS / 1000} seconds; the computer may be busy. Rerun the check when it is idle`
    : error?.message ?? String(error);
  return Object.assign(new Error(detail), error?.code ? { code: error.code } : {});
}

function configurationCheck(label, check, components) {
  try { const details = check(); components.push({ name: label, status: "configured", ...details }); }
  catch (error) { components.push(failedComponent(label, error)); }
}

function assertEntry(entry, worker, root, { caller } = {}) {
  if (!entry || typeof entry.command !== "string" || !fs.existsSync(entry.command)) throw new Error("MCP command is missing or unavailable");
  const args = entry.args ?? [];
  const expected = ["index.mjs", "claude-bridge.mjs", "native-relay-companion.mjs", "antigravity-bridge.mjs", "antigravity-outbound-bridge.mjs"].includes(worker)
    ? [path.join(root, "src", "mcp-supervisor.mjs"), worker] : [path.join(root, "src", worker)];
  if (JSON.stringify(args) !== JSON.stringify(expected)) throw Object.assign(new Error("MCP entry points to a different installation or unsupported launcher"), { code: "SETUP_ENTRYPOINT_CONFLICT" });
  if (caller && entry.env?.ANTIGRAVITY_BRIDGE_CALLER !== caller) throw new Error("Antigravity caller registration is missing or conflicting");
  if (entry.enabled === false || entry.disabled === true) return { deliveryEnabled: false,
    notices: ["This MCP registration is intentionally disabled. Its saved choice was preserved; delivery through this connector is disabled."] };
}

export function checkSetup({ env = process.env, platform = process.platform, root = ROOT, run = execute, resolve = resolveCodexBin } = {}) {
  const paths = setupPaths(env, platform);
  const components = [];
  let codex;
  let inventory;
  configurationCheck("Codex CLI", () => {
    codex = ensureSetupCodex({ env, paths, platform, download: false, run, resolve }).binary;
    try { inventory = JSON.parse(run(codex, ["mcp", "list", "--json"], setupEnvironment(env, paths, codex), CODEX_MCP_TIMEOUT_MS)); }
    catch (error) { throw codexInventoryFailure(error); }
    if (!Array.isArray(inventory)) { inventory = undefined; throw new Error("Codex returned an invalid MCP inventory"); }
  }, components);
  const native = platform === "win32" || platform === "darwin";
  for (const [name, worker] of [["claude-bridge", "claude-bridge.mjs"], ...(native ? [["codex-native-relay", "native-relay-companion.mjs"]] : []), ["antigravity-bridge", "antigravity-bridge.mjs"]]) {
    configurationCheck(`Codex / ${name}`, () => {
      if (!inventory) throw new Error("Not checked because Codex CLI did not report its MCP servers; the registration may still be present");
      const entry = inventory.find((server) => server?.name === name);
      if (!entry) throw new Error("MCP registration is missing");
      const details = assertEntry({ ...entry.transport, enabled: entry.enabled }, worker, root, name === "antigravity-bridge" ? { caller: "codex" } : {});
      if (name === "codex-native-relay" && !entry.transport.env_vars?.includes("CODEX_APP_TOOLS_PIPE_PATH")) throw new Error("Native pipe forwarding is missing");
      return details;
    }, components);
  }
  for (const [label, file, name, worker, caller] of [
    ["Claude Code / codex-bridge", paths.code, "codex-bridge", "index.mjs"],
    ["Claude Desktop / codex-bridge-desktop", paths.desktop, "codex-bridge-desktop", "index.mjs"],
    ["Claude Code / antigravity-bridge", paths.code, "antigravity-bridge", "antigravity-bridge.mjs", "claude"],
    ["Antigravity / agent-bridge", path.join(paths.gemini, "mcp_config.json"), "agent-bridge", "antigravity-outbound-bridge.mjs"],
  ]) configurationCheck(label, () => {
    const entry = readJson(file)?.mcpServers?.[name];
    const details = assertEntry(entry, worker, root, { caller });
    if (worker === "index.mjs" && entry.env?.CODEX_BRIDGE_OPEN_IN_APP === "1") {
      throw new Error("Managed bridge settings still allow opening Codex Desktop. Run codex-bridge-setup to apply the current silent configuration.");
    }
    if (name === "codex-bridge-desktop" && entry.env?.CODEX_BRIDGE_DESKTOP_TASKS === "1") {
      return { ...details, nativeCodeOnly: true, sharedChatDelivery: "unsupported",
        notices: [...(details?.notices ?? []), "The saved native Code-only policy was preserved. Ordinary Claude Desktop Chat cannot deliver through this connector; native delivery uses the registered Claude Desktop Code connector and remains unverified by setup."] };
    }
    return details;
  }, components);
  configurationCheck("Claude Desktop / background preference", () => {
    if (readJson(paths.desktop)?.preferences?.menuBarEnabled !== true) throw new Error("The managed Claude background preference is not enabled. Run codex-bridge-setup to apply it; live activation is verified separately.");
  }, components);
  configurationCheck("Antigravity / codex-bridge sidecar", () => {
    const details = assertEntry(readJson(path.join(paths.gemini, "sidecars", "codex-bridge", "sidecar.json")), "antigravity-sidecar.mjs", root);
    const enabled = readJson(path.join(paths.gemini, "config.json"))?.sidecars?.["codex-bridge"]?.enabled;
    if (typeof enabled !== "boolean") throw new Error("Antigravity sidecar enabled setting is missing or invalid");
    if (!enabled) return { deliveryEnabled: false,
      notices: [...(details?.notices ?? []), "The Antigravity bridge sidecar is intentionally disabled. Its saved choice was preserved; native Desktop delivery through this sidecar is disabled."] };
    return details;
  }, components);
  if (native) configurationCheck("Native relay executor", () => {
    const relay = readJson(path.join(paths.codex, "native-relay.json"));
    if (!relay?.relayThreadId) throw new Error("Native relay executor has not been initialized");
  }, components);
  configurationCheck("Claude registration names", () => {
    if (readJson(paths.desktop)?.mcpServers?.["codex-bridge"]) throw new Error("Shared codex-bridge shadows the Claude Code registration");
  }, components);
  configurationCheck("Independent background relay", () => {
    const details = JSON.parse(run(process.execPath, [path.join(root, "scripts", "setup-background-relay.mjs"), "--check", "--json"], setupEnvironment(env, paths, codex), 90000));
    if (details.configured !== true) throw new Error("Independent worker relay configuration is incomplete");
    return { liveVerified: details.liveVerified === true, transportReady: details.transportReady === true, notices: details.notices ?? [] };
  }, components);
  return { configured: components.every((item) => item.status === "configured"), liveVerified: false, components };
}

export function runSetup({ args = [], env = process.env, platform = process.platform, root = ROOT, run = execute, resolve = resolveCodexBin, onProgress = () => {} } = {}) {
  const options = setupArguments(args);
  if (options.help) return { help: `Usage: codex-bridge-setup [--check|--dry-run] [--json] [--no-download]\nUpdate the package and apply managed settings in an interactive terminal with: ${platform === "win32" ? "npx.cmd" : "npx"} -y @minhspark/codex-mcp-bridge@latest\nThe updater installs the package with lifecycle scripts disabled, then directly configures Claude Desktop, Claude Code, Codex, Antigravity and the independent worker relay. CODEX_BRIDGE_SKIP_SETUP=1 opts out. Saved configuration, background relay health and loaded native app connections are verified separately.` };
  if (options.postinstall && !automaticSetupEnabled(env)) return { skipped: true, reason: "Automatic configuration runs only for a global npm install; use codex-bridge-setup for manual setup." };
  env = repairClaudeDataPin({ env, platform });
  if (options.check) return checkSetup({ env, platform, root, run, resolve });
  const native = platform === "win32" || platform === "darwin";
  const paths = setupPaths(env, platform);
  const planned = ["Claude Code / codex-bridge", "Claude Desktop / codex-bridge-desktop", ...(native ? ["Codex / codex-native-relay and executor"] : []), "Codex / claude-bridge", "Antigravity / all components", "Independent background relay"];
  if (options.dryRun) return { dryRun: true, configured: false, liveVerified: false, components: planned.map((name) => ({ name, status: "planned" })), files: [paths.code, paths.desktop, path.join(paths.codex, "config.toml"), paths.gemini] };
  if (env.SUDO_USER && env.SUDO_USER !== "root" && typeof process.getuid === "function" && process.getuid() === 0) throw new Error("Run the global install without sudo in the account that runs the apps; setup will not write another account's configuration.");
  const runtime = ensureSetupCodex({ env, paths, platform, download: !options.noDownload, run, resolve });
  fs.mkdirSync(paths.codex, { recursive: true, mode: 0o700 });
  writeCurrentInstall({ env: { ...env, CODEX_HOME: paths.codex }, root, claudeDataRoot: activeClaudeDataRoot(env, platform) });
  const base = setupEnvironment(env, paths, runtime.binary);
  const components = [];
  const install = (name, script, arguments_, environment = base) => {
    onProgress(name);
    try {
      const output = run(process.execPath, [path.join(root, "scripts", script), ...arguments_], environment, 180000);
      let details = {};
      try { details = JSON.parse(output); } catch {}
      const notices = details.notices ?? [];
      components.push({ name, status: "configured", ...(notices.length ? { notices } : {}),
        ...(typeof details.liveVerified === "boolean" ? { liveVerified: details.liveVerified, transportReady: details.transportReady === true } : {}),
        ...(details.backgroundPreference ? { backgroundPreference: details.backgroundPreference } : {}) });
      return true;
    } catch (error) { components.push(failedComponent(name, error)); return false; }
  };
  const code = install(planned[0], "install-claude-code.mjs", ["--install", "--setup", "--desktop-config", paths.desktop], {
    ...base, CODEX_BRIDGE_DESKTOP_TASKS: native ? "1" : "0", CODEX_BRIDGE_AUTOSTART: native ? "0" : "1", CODEX_BRIDGE_THREAD_POLICY: "roots",
  });
  if (code) install(planned[1], "install-claude-desktop.mjs", ["--entry-name", "codex-bridge-desktop", "--quiet", "--setup"]);
  if (native) {
    const relay = readJson(path.join(paths.codex, "native-relay.json"));
    install("Codex / codex-native-relay and executor", "install-native-relay.mjs", ["--setup", ...(relay?.desktopTasks === undefined ? ["--desktop-tasks"] : [])]);
  }
  install("Codex / claude-bridge", "install-codex-mcp.mjs", ["--setup"]);
  if (code) install("Antigravity / all components", "install-antigravity-bridge.mjs", ["--all", "--setup"]);
  install("Independent background relay", "setup-background-relay.mjs", ["--json"]);
  onProgress("Verifying saved settings");
  const inspection = checkSetup({ env: base, platform, root, run, resolve: () => runtime.binary });
  return { configured: components.every((item) => item.status === "configured") && inspection.configured, liveVerified: false,
    cliInstalled: runtime.installed, components, verification: inspection.components,
    nextActions: ["Running MCP processes may still hold earlier settings. Setup does not start apps or open conversations.",
      "Existing compatible supervisors reload installed source when idle; configuration changes are not proof of loaded-process readiness.",
      "Native delivery uses the same saved project and signed-in accounts in Claude Desktop Code and Codex Desktop.",
      "codex_bridge_status, native_relay_status and agent_bridge_status report native readiness separately from this configuration check.",
      "worker_status or worker-relay status reports the independent service and CLI workers, which do not require a responsive Desktop host."] };
}

export function printSetup(result, { json = false, output = console.log } = {}) {
  if (json) { output(JSON.stringify(result, null, 2)); return; }
  if (result.help) { output(result.help); return; }
  if (result.skipped) { output(result.reason); return; }
  output(result.dryRun ? "Bridge setup preview (no changes)" : result.configured ? "Bridge configuration verified. Running app connections have not been verified." : "Bridge setup is incomplete. Fix the items below, then run codex-bridge-setup again.");
  for (const item of result.components ?? []) {
    output(`[${item.status}] ${item.name}${item.detail ? `: ${item.detail}` : ""}`);
    for (const notice of item.notices ?? []) output(`  ${notice}`);
  }
  for (const item of result.verification ?? []) {
    if (item.status !== "configured") output(`[${item.status}] ${item.name}: ${item.detail}`);
    for (const notice of item.notices ?? []) output(`${item.name}: ${notice}`);
  }
  for (const action of result.nextActions ?? []) output(action);
}
