import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_SOURCE = path.dirname(fileURLToPath(import.meta.url));

function worker(entry) {
  return entry?.args?.length === 2 && path.basename(entry.args[0]) === "mcp-supervisor.mjs" && entry.args[1] === "index.mjs";
}
function bridgeSource(entry) {
  const script = entry?.args?.[0];
  if (typeof script !== "string" || !(worker(entry) || path.basename(script) === "index.mjs")) return null;
  return path.dirname(path.resolve(script));
}
function bridgeSources(source) {
  return new Set([PACKAGE_SOURCE, ...(worker(source) ? [bridgeSource(source)] : [])]);
}
function bridgeEntry(entry, sources) {
  return worker(entry) || sources.has(bridgeSource(entry));
}
const stable = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

const INITIAL_ENVIRONMENT_KEYS = [
  "CODEX_BIN", "CODEX_HOME", "CLAUDE_DESKTOP_USER_DATA", "CODEX_BRIDGE_DESKTOP_TASKS",
  "CODEX_BRIDGE_AUTOSTART", "CODEX_BRIDGE_THREAD_POLICY", "CODEX_BRIDGE_ALLOWED_ROOTS",
  "CODEX_BRIDGE_PROJECT_POLICY",
];

function configurationObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function initialBridgeEntry(entry, root, label) {
  configurationObject(entry, label);
  if (entry.type !== undefined && entry.type !== "stdio" || ["url", "serverUrl", "httpUrl"].some((key) => entry[key] !== undefined)) {
    throw new Error(`${label} has a conflicting transport; no configuration was changed`);
  }
  const args = entry.args;
  const script = args?.[0];
  const leaf = typeof script === "string" ? path.basename(script) : null;
  const supervised = args?.length === 2 && leaf === "mcp-supervisor.mjs" && args[1] === "index.mjs";
  const direct = args?.length === 1 && ["index.mjs", "codex-bridge-launcher.mjs"].includes(leaf);
  const source = typeof script === "string" && path.isAbsolute(script) ? path.dirname(path.resolve(script)) : null;
  const ownSource = source && (source === PACKAGE_SOURCE || source === path.join(root, "src")
    || path.basename(source) === "src" && path.basename(path.dirname(source)).toLowerCase() === "codex-mcp-bridge");
  if (!Array.isArray(args) || !(supervised || direct) || !ownSource) {
    throw new Error(`${label} is already configured with an unrecognized or customized entrypoint; no configuration was changed`);
  }
  if (entry.env !== undefined) {
    configurationObject(entry.env, `${label} environment`);
    if (Object.values(entry.env).some((value) => typeof value !== "string")) throw new Error(`${label} environment values must be strings`);
  }
}

export function planInitialCodeRegistration({ code, desktop, root, node, environment = {}, name = "codex-bridge" }) {
  configurationObject(code, "Claude Code configuration");
  configurationObject(desktop, "Claude Desktop configuration");
  configurationObject(environment, "Bridge environment");
  if (typeof root !== "string" || !path.isAbsolute(root) || typeof node !== "string" || !path.isAbsolute(node)) {
    throw new Error("Bridge package and Node paths must be absolute");
  }
  if (code.mcpServers !== undefined) configurationObject(code.mcpServers, "Claude Code mcpServers");
  if (desktop.mcpServers !== undefined) configurationObject(desktop.mcpServers, "Claude Desktop mcpServers");
  if (code.projects !== undefined) configurationObject(code.projects, "Claude Code projects");
  const originalCode = code.mcpServers?.[name];
  const sharedNative = desktop.mcpServers?.[name] ?? desktop.mcpServers?.[`${name}-desktop`];
  const inheritedShared = originalCode === undefined && sharedNative?.env?.CODEX_BRIDGE_DESKTOP_TASKS === "1";
  const source = inheritedShared ? sharedNative : originalCode;
  if (source !== undefined) initialBridgeEntry(source, root, `Claude Code ${name}`);
  const defaults = Object.fromEntries(INITIAL_ENVIRONMENT_KEYS.filter((key) => environment[key] !== undefined).map((key) => [key, environment[key]]));
  if (Object.values(defaults).some((value) => typeof value !== "string")) throw new Error("Bridge environment defaults must be strings");
  const scopeKeys = ["CODEX_BRIDGE_THREAD_POLICY", "CODEX_BRIDGE_ALLOWED_ROOTS", "CODEX_BRIDGE_PROJECT_POLICY", "CODEX_BRIDGE_ALLOWED_THREADS", "CODEX_BRIDGE_HARDENED"];
  if (source !== undefined) {
    for (const key of scopeKeys) delete defaults[key];
  }
  const values = { ...defaults, ...source?.env };
  if (defaults.CODEX_BIN && source?.env?.CODEX_BIN && path.isAbsolute(source.env.CODEX_BIN)) {
    try { fs.lstatSync(source.env.CODEX_BIN); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      values.CODEX_BIN = defaults.CODEX_BIN;
    }
  }
  const replacement = { ...source, type: "stdio", command: node, args: [path.join(root, "src", "mcp-supervisor.mjs"), "index.mjs"], env: values };
  const updated = structuredClone(code);
  const updatedDesktop = structuredClone(desktop);
  updated.mcpServers ??= {};
  updated.mcpServers[name] = replacement;
  const changes = [];
  const notices = [];
  if (inheritedShared) notices.push("Preserved the existing shared native bridge settings in the new user-level Code entry");
  if (JSON.stringify(originalCode) !== JSON.stringify(replacement)) changes.push({ kind: originalCode ? "update-user-code-entry" : "create-user-code-entry", name });
  const shared = updatedDesktop.mcpServers?.[name];
  if (shared !== undefined) {
    initialBridgeEntry(shared, root, `Shared Desktop ${name}`);
    const destination = `${name}-desktop`;
    if (Object.hasOwn(updatedDesktop.mcpServers, destination)) {
      throw new Error(`Shared Desktop ${destination} already exists; resolve the name collision before installation`);
    }
    updatedDesktop.mcpServers[destination] = shared;
    delete updatedDesktop.mcpServers[name];
    changes.push({ kind: "rename-shared-desktop-entry", from: name, to: destination });
  }
  const sources = bridgeSources(source);
  for (const [project, config] of Object.entries(code.projects ?? {})) {
    configurationObject(config, `Claude project ${project}`);
    if (config.mcpServers !== undefined) configurationObject(config.mcpServers, `Claude project ${project} mcpServers`);
    for (const [alias, item] of Object.entries(config.mcpServers ?? {})) {
      if (alias === name || bridgeEntry(item, sources)) notices.push(`Project ${project} has an existing ${alias} entry that may override the user registration; its settings were preserved`);
    }
  }
  return { code: updated, desktop: updatedDesktop, entry: replacement, changes, notices };
}

export function planCodeRegistration({ code, desktop, policyFile, name = "codex-bridge" }) {
  if (!path.isAbsolute(policyFile)) throw new Error("Shared project policy path must be absolute");
  const source = code.mcpServers?.[name];
  if (!worker(source)) throw new Error(`Expected an existing supervised ${name} Code registration; no configuration was changed`);
  if (source.env?.CODEX_BRIDGE_HARDENED === "1") throw new Error("Keep the hardened installation's pinned roots; automatic policy migration is not supported");
  const updated = structuredClone(code);
  const updatedDesktop = structuredClone(desktop);
  const replacement = { ...source, env: { ...source.env, CODEX_BRIDGE_PROJECT_POLICY: policyFile } };
  // The explicitly selected shared policy becomes the scope authority. Keep legacy
  // roots intact for rollback, and preserve every other setting and restriction.
  updated.mcpServers[name] = replacement;
  const changes = [{ kind: "user-code-entry", name }];
  const comparable = (entry) => {
    const normalized = structuredClone(entry);
    if (worker(entry) || entry.args.length === 1) normalized.args = [path.join(bridgeSource(entry), "mcp-supervisor.mjs"), "index.mjs"];
    delete normalized.env?.CODEX_BRIDGE_ALLOWED_ROOTS;
    delete normalized.env?.CODEX_BRIDGE_PROJECT_POLICY;
    return JSON.stringify({ ...normalized, env: stable(normalized.env) });
  };
  const sources = bridgeSources(source);
  const sameBridge = (entry, location) => {
    if (bridgeSource(entry) === bridgeSource(source)) return true;
    if (bridgeEntry(entry, sources)) throw new Error(`${location} runs another bridge installation from ${bridgeSource(entry)}; update or remove it before migration`);
    return false;
  };
  for (const [project, config] of Object.entries(updated.projects ?? {})) {
    for (const [alias, entry] of Object.entries(config.mcpServers ?? {})) {
      if (!sameBridge(entry, `Project ${project} entry ${alias}`)) continue;
      if (comparable(entry) !== comparable(source)) throw new Error(`Project ${project} has a customized ${alias} entry; review its settings instead of replacing it`);
      delete config.mcpServers[alias];
      changes.push({ kind: "remove-duplicate-project-entry", project, name: alias });
    }
  }
  for (const [alias, entry] of Object.entries(updatedDesktop.mcpServers ?? {})) {
    if (!sameBridge(entry, `Shared Desktop entry ${alias}`)) continue;
    if (comparable(entry) !== comparable(source)) throw new Error(`Shared Desktop entry ${alias} has customized settings; review it before migration`);
    delete updatedDesktop.mcpServers[alias];
    changes.push({ kind: "remove-shared-desktop-entry", name: alias });
  }
  return { code: updated, desktop: updatedDesktop, entry: replacement, changes };
}

export function checkCodeRegistration({ code, desktop, name = "codex-bridge" }) {
  const entry = code.mcpServers?.[name];
  const issues = [];
  if (!worker(entry)) issues.push("User-level Claude Code bridge is missing or does not use the supervisor");
  const sources = bridgeSources(entry);
  const shared = Object.keys(desktop.mcpServers ?? {}).filter((key) => bridgeEntry(desktop.mcpServers[key], sources));
  if (shared.length) issues.push(`Shared Desktop bridge entries can hide the Code caller identity: ${shared.join(", ")}`);
  const unsupervised = shared.filter((key) => !worker(desktop.mcpServers[key]));
  if (unsupervised.length) issues.push(`Shared Desktop bridge entries run without the supervisor and keep stale code loaded: ${unsupervised.join(", ")}`);
  const overrides = Object.entries(code.projects ?? {}).flatMap(([project, config]) => Object.entries(config.mcpServers ?? {})
    .filter(([, item]) => bridgeEntry(item, sources)).map(([alias]) => ({ project, alias })));
  if (overrides.length) issues.push("Project-specific bridge entries override or duplicate the user-level registration");
  if (!entry?.env?.CODEX_BRIDGE_PROJECT_POLICY) issues.push("No shared live project policy configured");
  return { ready: issues.length === 0, issues, shared, overrides, policyFile: entry?.env?.CODEX_BRIDGE_PROJECT_POLICY ?? null };
}
