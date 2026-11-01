import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BACKGROUND_TOOLS, relayFailure } from "./background-relay-config.mjs";
import { readRegularConfigFile } from "./project-policy.mjs";
import { stableInstallPath, stableNodeBin } from "./install-paths.mjs";

const MAX_BYTES = 1024 * 1024;
const NAME = "worker-relay";
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => relayFailure("WORKER_MCP_CONFIG_INVALID", "Antigravity worker configuration must contain valid JSON objects and permission lists.", "not_sent", "setup");
const unsafe = () => relayFailure("WORKER_MCP_CONFIG_UNSAFE", "Antigravity worker configuration must use bounded regular files and unlinked directories.", "not_sent", "setup");
const changed = () => relayFailure("WORKER_MCP_CONFIG_CHANGED", "Antigravity worker configuration changed during setup; concurrent changes were preserved.", "not_sent", "setup");
const sameFile = (left, right) => left === null || right === null ? left === right
  : ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs", "nlink"].every((field) => left[field] === right[field]);

function stat(file) {
  try { return fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === "ENOENT") return null; throw unsafe(); }
}

function directories(home, file, create = false) {
  const relative = path.relative(home, path.dirname(file));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw unsafe();
  let current = home;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    let entry = stat(current);
    if (entry === null && create) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw unsafe(); }
      entry = stat(current);
    }
    if (entry === null) return;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafe();
  }
}

function snapshot(home, file) {
  directories(home, file);
  const before = stat(file);
  let text;
  try { text = readRegularConfigFile(file, { missing: true, maxBytes: MAX_BYTES, label: "Antigravity worker configuration" }); }
  catch { throw unsafe(); }
  const after = stat(file);
  if (!sameFile(before, after)) throw changed();
  let value;
  try { value = text === null ? {} : JSON.parse(text); }
  catch { throw invalid(); }
  if (!object(value)) throw invalid();
  return { file, text, value, stat: after, mode: after ? Number(after.mode & 0o777n) : 0o600 };
}

function assertCurrent(home, expected) {
  const current = snapshot(home, expected.file);
  if (current.text !== expected.text || !sameFile(current.stat, expected.stat)) throw changed();
  return current;
}

function replace(home, original, text, mode, applied) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw unsafe();
  directories(home, original.file, true);
  assertCurrent(home, original);
  const temporary = path.join(path.dirname(original.file), `.${path.basename(original.file)}.${randomUUID()}.tmp`);
  let descriptor;
  let identity;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    identity = fs.fstatSync(descriptor, { bigint: true });
    fs.writeFileSync(descriptor, text, "utf8");
    if (process.platform !== "win32") fs.fchmodSync(descriptor, mode);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertCurrent(home, original);
    fs.renameSync(temporary, original.file);
    applied?.push({ original, text, identity });
    const current = snapshot(home, original.file);
    if (current.text !== text || current.stat?.dev !== identity.dev || current.stat?.ino !== identity.ino) throw changed();
    return current;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    const remaining = stat(temporary);
    if (remaining && identity && remaining.dev === identity.dev && remaining.ino === identity.ino) fs.unlinkSync(temporary);
  }
}

function apply(home, edits) {
  const applied = [];
  try {
    for (const edit of edits) assertCurrent(home, edit);
    for (const edit of edits) replace(home, edit, edit.next, edit.mode, applied);
  } catch (error) {
    let incomplete = false;
    for (const record of applied.reverse()) {
      try {
        const current = snapshot(home, record.original.file);
        if (current.text !== record.text || current.stat?.dev !== record.identity.dev || current.stat?.ino !== record.identity.ino) throw changed();
        if (record.original.text === null) {
          assertCurrent(home, current);
          fs.unlinkSync(current.file);
          if (snapshot(home, current.file).text !== null) throw changed();
        } else replace(home, current, record.original.text, record.original.mode);
      } catch { incomplete = true; }
    }
    if (incomplete) throw relayFailure("WORKER_MCP_REGISTRATION_INCOMPLETE", "Antigravity worker setup stopped after a partial update. Concurrent changes prevented safe rollback; inspect both configuration files.", "not_sent", "setup");
    if (/^WORKER_MCP_/.test(error?.code ?? "")) throw error;
    throw relayFailure("WORKER_MCP_WRITE_FAILED", "Antigravity worker configuration could not be saved. Previously completed updates were restored.", "not_sent", "setup");
  }
}

function samePath(left, right, platform) {
  if (typeof left !== "string" || !path.isAbsolute(left) || left.includes("\0")) return false;
  const normalize = (value) => platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(left) === normalize(right)) return true;
  try { return normalize(fs.realpathSync.native(left)) === normalize(fs.realpathSync.native(right)); }
  catch { return false; }
}

function nodeLauncher(command, expected, platform) {
  if (samePath(command, expected, platform)) return true;
  if (typeof command !== "string" || !path.isAbsolute(command) || command.includes("\0")) return false;
  if (!(platform === "win32" ? /^node\.exe$/i : /^node$/).test(path.basename(command))) return false;
  try { return fs.statSync(command).isFile(); } catch { return false; }
}

function ownedEntry(entry, expected, platform) {
  if (entry === undefined) return;
  if (!object(entry) || !nodeLauncher(entry.command, expected.command, platform)
      || !Array.isArray(entry.args) || entry.args.length !== 1 || !samePath(entry.args[0], expected.args[0], platform)
      || entry.type !== undefined && entry.type !== "stdio"
      || ["url", "serverUrl", "serverURL", "httpUrl", "headers", "oauth", "authProviderType"].some((key) => Object.hasOwn(entry, key))
      || entry.env !== undefined && (!object(entry.env) || Object.keys(entry.env).length !== 0)) {
    throw relayFailure("WORKER_MCP_COLLISION", "The canonical worker-relay MCP name is already used by a different configuration. It was not overwritten.", "not_sent", "setup");
  }
  if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") throw invalid();
  for (const key of ["enabledTools", "disabledTools"]) {
    if (entry[key] !== undefined && (!Array.isArray(entry[key]) || entry[key].length > 4096 || entry[key].some((value) => typeof value !== "string" || value.length > 1024))) throw invalid();
  }
}

function permissionState(settings, entry) {
  if (settings.permissions !== undefined && !object(settings.permissions)) throw invalid();
  const permissions = settings.permissions ?? {};
  for (const key of ["allow", "ask", "deny"]) {
    if (permissions[key] !== undefined && (!Array.isArray(permissions[key]) || permissions[key].length > 4096 || permissions[key].some((rule) => typeof rule !== "string" || rule.length > 1024))) throw invalid();
  }
  if (settings.toolPermission !== undefined && typeof settings.toolPermission !== "string") throw invalid();
  const policyVerified = settings.toolPermission === undefined || ["request-review", "proceed-in-sandbox", "always-proceed", "strict"].includes(settings.toolPermission);
  const matches = (rule, tool) => {
    const match = /^mcp\((.*)\)$/.exec(rule.trim());
    return match && ["*", `${NAME}/*`, `${NAME}/${tool}`].includes(match[1].trim());
  };
  const blockedTools = BACKGROUND_TOOLS.filter((tool) => !policyVerified || settings.toolPermission === "strict" || entry.disabled === true
    || entry.enabledTools !== undefined && !entry.enabledTools.includes(tool)
    || entry.disabledTools?.includes(tool)
    || [...(permissions.deny ?? []), ...(permissions.ask ?? [])].some((rule) => matches(rule, tool)));
  return { blockedTools, policyVerified };
}

export function configureBackgroundWorkerMcp({ env = process.env, platform = process.platform, root = DEFAULT_ROOT, dryRun = false, check = false } = {}) {
  const selectedHome = platform === "win32" ? env.USERPROFILE || env.HOME || os.homedir() : env.HOME || env.USERPROFILE || os.homedir();
  if (typeof selectedHome !== "string" || !path.isAbsolute(selectedHome) || typeof root !== "string" || !path.isAbsolute(root)) throw invalid();
  let home;
  let entry;
  try {
    home = fs.realpathSync.native(selectedHome);
    if (!fs.statSync(home).isDirectory()) throw unsafe();
    entry = path.join(stableInstallPath(fs.realpathSync.native(root), env), "src", "background-relay-mcp.mjs");
    if (!fs.statSync(entry).isFile()) throw invalid();
  } catch { throw relayFailure("WORKER_MCP_PATH_INVALID", "The user home or installed background relay entrypoint is unavailable.", "not_sent", "setup"); }
  const files = { mcp: path.join(home, ".gemini", "config", "mcp_config.json"), settings: path.join(home, ".gemini", "antigravity-cli", "settings.json") };
  const originals = { mcp: snapshot(home, files.mcp), settings: snapshot(home, files.settings) };
  const mcp = structuredClone(originals.mcp.value);
  const settings = structuredClone(originals.settings.value);
  if (mcp.mcpServers !== undefined && !object(mcp.mcpServers)) throw invalid();
  const expected = { command: stableNodeBin(env), args: [entry] };
  const existing = mcp.mcpServers?.[NAME];
  ownedEntry(existing, expected, platform);
  const policy = permissionState(settings, existing ?? expected);
  mcp.mcpServers ??= {};
  if (existing === undefined) mcp.mcpServers[NAME] = expected;
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  const grants = BACKGROUND_TOOLS.map((tool) => `mcp(${NAME}/${tool})`);
  const added = grants.filter((rule) => !settings.permissions.allow.includes(rule));
  settings.permissions.allow.push(...added);
  const edits = Object.entries({ mcp, settings }).flatMap(([key, value]) => {
    const original = originals[key];
    if (JSON.stringify(value) === JSON.stringify(original.value)) return [];
    const next = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(next) > MAX_BYTES) throw unsafe();
    return [{ ...original, next }];
  });
  if (!dryRun && !check) apply(home, edits);
  const configured = !edits.length || !dryRun && !check;
  const blocked = policy.blockedTools.length > 0;
  return { configured, changed: Boolean(edits.length && !dryRun && !check), wouldChange: edits.length > 0, blocked, files,
    permissions: { ...policy, required: grants, added }, isolatedMcpInventory: false, nativeFallback: false,
    ...(blocked ? { code: policy.policyVerified ? "WORKER_MCP_POLICY_BLOCKED" : "WORKER_MCP_POLICY_UNVERIFIED", reason: "Existing Antigravity permissions or MCP tool restrictions prevent unattended relay access. Those restrictions were preserved." }
      : !configured ? { code: "WORKER_MCP_NOT_CONFIGURED", reason: "The Antigravity worker MCP registration or scoped permission grants require configuration." } : {}) };
}
