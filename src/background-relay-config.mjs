import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readRegularConfigFile } from "./project-policy.mjs";

export const BACKGROUND_AGENTS = Object.freeze(["codex", "claude", "antigravity"]);
export const BACKGROUND_TOOLS = Object.freeze(["worker_status", "list_workers", "send_to_worker", "read_worker_delivery"]);
export const RELAY_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function relayFailure(code, message, deliveryState = "not_sent", phase = "preflight") {
  return Object.assign(new Error(message), { code, phase, deliveryState, sent: deliveryState === "not_sent" ? false : deliveryState === "sent" ? true : null });
}

export function relayPaths(env = process.env, platform = process.platform) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const directory = env.AGENT_RELAY_DIRECTORY || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "GptClaudeBridge", "agent-relay");
  if (!path.isAbsolute(directory)) throw relayFailure("WORKER_CONFIG_INVALID", "The background relay directory must be absolute");
  const root = path.resolve(directory);
  const hash = createHash("sha256").update(platform === "win32" ? root.toLowerCase() : root).digest("hex").slice(0, 24);
  return { root, config: path.join(root, "config.json"), jobs: path.join(root, "jobs"),
    endpoint: platform === "win32" ? `\\\\.\\pipe\\minhspark-agent-relay-${hash}` : path.join(root, "relay.sock"),
    defaultPolicy: env.CODEX_BRIDGE_PROJECT_POLICY || path.join(home, ".config", "GptClaudeBridge", "projects.json") };
}

export function privateRelayDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw relayFailure("WORKER_STORAGE_UNSAFE", "Relay storage must be a regular private directory");
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw relayFailure("WORKER_STORAGE_UNSAFE", "Relay storage belongs to another user");
    fs.chmodSync(directory, 0o700);
  }
}

export function writeRelayJson(file, value) {
  const directory = path.dirname(file);
  privateRelayDirectory(directory);
  const existing = readRegularConfigFile(file, { missing: true, maxBytes: 4 * 1024 * 1024, label: "Relay state" });
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const encoded = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw relayFailure("WORKER_STORAGE_LIMIT", "Relay state exceeds its storage limit");
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, encoded);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (readRegularConfigFile(file, { missing: true, maxBytes: 4 * 1024 * 1024, label: "Relay state" }) !== existing) throw relayFailure("WORKER_CONFIG_CHANGED", "Relay state changed concurrently");
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function readRelayConfiguration({ env = process.env, platform = process.platform, missing = false } = {}) {
  const paths = relayPaths(env, platform);
  const raw = readRegularConfigFile(paths.config, { missing, maxBytes: 64 * 1024, label: "Relay configuration" });
  if (raw === null) return null;
  let config;
  try { config = JSON.parse(raw); } catch { throw relayFailure("WORKER_CONFIG_INVALID", "Relay configuration is not valid JSON"); }
  if (!config || config.schemaVersion !== 1 || typeof config.enabled !== "boolean" || config.endpoint !== paths.endpoint
      || typeof config.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(config.token)
      || typeof config.projectPolicy !== "string" || !path.isAbsolute(config.projectPolicy)
      || !config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)) {
    throw relayFailure("WORKER_CONFIG_INVALID", "Relay configuration has an unsupported schema");
  }
  for (const name of BACKGROUND_AGENTS) {
    const provider = config.providers[name];
    if (!provider || typeof provider.enabled !== "boolean" || provider.executable !== null && (typeof provider.executable !== "string" || !path.isAbsolute(provider.executable))) {
      throw relayFailure("WORKER_CONFIG_INVALID", "Worker executable configuration is invalid");
    }
  }
  return { ...config, paths };
}

export function configureRelay({ env = process.env, platform = process.platform, providers = {}, projectPolicy } = {}) {
  const paths = relayPaths(env, platform);
  const previous = readRelayConfiguration({ env, platform, missing: true });
  const config = { schemaVersion: 1, enabled: previous?.enabled ?? true, endpoint: paths.endpoint,
    token: previous?.token ?? randomBytes(32).toString("base64url"),
    projectPolicy: projectPolicy ?? previous?.projectPolicy ?? paths.defaultPolicy,
    providers: Object.fromEntries(BACKGROUND_AGENTS.map(name => [name, { enabled: previous?.providers[name]?.enabled ?? true,
      executable: providers[name]?.executable ?? previous?.providers[name]?.executable ?? null }])) };
  if (!path.isAbsolute(config.projectPolicy)) throw relayFailure("WORKER_CONFIG_INVALID", "Project policy must use an absolute path");
  writeRelayJson(paths.config, config);
  return readRelayConfiguration({ env, platform });
}
