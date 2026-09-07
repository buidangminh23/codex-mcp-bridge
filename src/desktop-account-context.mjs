import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PACKAGE_NAME = /^Claude_[a-z0-9._-]+$/i;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PACKAGES = 512;
const MAX_ROOTS = 16;
const VERSION_FIELDS = ["size", "mtimeMs", "ctimeMs", "ino", "dev"];
const sameVersion = (left, right) => VERSION_FIELDS.every((field) => left[field] === right[field]);
const isMissing = (error) => error.code === "ENOENT";

function result(status, reason, root = null, accountId = null) {
  return {
    status,
    accountId,
    fingerprint: accountId ? createHash("sha256").update(`claude-desktop\0${accountId}`).digest("hex") : null,
    root,
    reason,
  };
}

function absoluteDirectory(value) {
  if (typeof value !== "string" || !value || !path.isAbsolute(value)) throw new Error("invalid root");
  return path.resolve(value);
}

function directoryStat(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid directory");
  return stat;
}

function candidateRoots({ platform, env, root }) {
  const selected = root !== undefined ? root : env.CLAUDE_DESKTOP_USER_DATA;
  if (selected !== undefined) return [absoluteDirectory(selected)];
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const config = platform === "darwin" ? path.join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const roots = [absoluteDirectory(path.join(config, "Claude"))];
  if (platform === "win32") {
    const packages = absoluteDirectory(path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Packages"));
    let entries;
    try {
      directoryStat(packages);
      entries = fs.readdirSync(packages, { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
      entries = [];
    }
    if (entries.length > MAX_PACKAGES) throw new Error("package scan limit");
    for (const entry of entries) {
      if (!PACKAGE_NAME.test(entry.name)) continue;
      const packageRoot = path.join(packages, entry.name);
      directoryStat(packageRoot);
      roots.push(path.join(packageRoot, "LocalCache", "Roaming", "Claude"));
    }
  }
  const unique = [...new Map(roots.map((value) => [platform === "win32" ? value.toLowerCase() : value, value])).values()].sort();
  if (unique.length > MAX_ROOTS) throw new Error("root scan limit");
  return unique;
}

function readConfig(root) {
  let rootStat;
  try { rootStat = directoryStat(root); }
  catch (error) {
    if (isMissing(error)) return { kind: "missing-root" };
    throw error;
  }
  const file = path.join(root, "config.json");
  let initial;
  try { initial = fs.lstatSync(file); }
  catch (error) {
    if (isMissing(error)) return { kind: "missing-config", rootStat };
    throw error;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_CONFIG_BYTES) throw new Error("invalid config");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  let current;
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || !sameVersion(initial, before)) throw new Error("config changed");
    bytes = Buffer.alloc(before.size);
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("short read");
    const after = fs.fstatSync(descriptor);
    current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || !sameVersion(before, after) || !sameVersion(after, current)) throw new Error("config changed");
  } finally {
    fs.closeSync(descriptor);
  }
  if (!sameVersion(rootStat, directoryStat(root))) throw new Error("root changed");
  const config = JSON.parse(bytes.toString("utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid config");
  const hasAccount = Object.hasOwn(config, "lastKnownAccountUuid");
  const hasSignedIn = Object.hasOwn(config, "windowSizeWasSignedIn");
  if (!hasAccount && !hasSignedIn) return { kind: "unrelated", rootStat, fileStat: current, bytes };
  if (!hasAccount || !hasSignedIn || typeof config.windowSizeWasSignedIn !== "boolean" ||
      typeof config.lastKnownAccountUuid !== "string" || !ACCOUNT_ID.test(config.lastKnownAccountUuid)) throw new Error("invalid account state");
  return {
    kind: config.windowSizeWasSignedIn ? "verified" : "signed_out",
    accountId: config.lastKnownAccountUuid.toLowerCase(),
    rootStat,
    fileStat: current,
    bytes,
  };
}

function sameSnapshot(left, right) {
  return left.kind === right.kind &&
    (!left.rootStat || right.rootStat && sameVersion(left.rootStat, right.rootStat)) &&
    (!left.fileStat || right.fileStat && sameVersion(left.fileStat, right.fileStat)) &&
    (!left.bytes || right.bytes && left.bytes.equals(right.bytes));
}

export function readClaudeAccountContext({ platform = process.platform, env = process.env, root } = {}) {
  let roots;
  try {
    roots = candidateRoots({ platform, env, root });
    const snapshots = roots.map((candidate) => readConfig(candidate));
    const currentRoots = candidateRoots({ platform, env, root });
    if (roots.length !== currentRoots.length || roots.some((candidate, index) => candidate !== currentRoots[index]) ||
        roots.some((candidate, index) => !sameSnapshot(snapshots[index], readConfig(candidate)))) {
      return result("unavailable", "Claude Desktop account state changed during inspection; inspect the existing session again.", roots.length === 1 ? roots[0] : null);
    }
    const credible = snapshots.map((snapshot, index) => ({ ...snapshot, root: roots[index] }))
      .filter((snapshot) => snapshot.kind === "verified" || snapshot.kind === "signed_out");
    if (credible.length > 1) return result("ambiguous", "Multiple Claude Desktop data roots contain account state; no current account or metadata root is selected.");
    if (!credible.length) return result("unavailable", "Claude Desktop account state is unavailable; no current account is confirmed.", roots.length === 1 ? roots[0] : null);
    const selected = credible[0];
    if (selected.kind === "signed_out") return result("signed_out", "Claude Desktop's persisted account state reports signed out; no destination is confirmed.", selected.root);
    return result("verified", "Claude Desktop's persisted signed-in account state identifies this account; destination session identity still requires verification.", selected.root, selected.accountId);
  } catch {
    return result("unavailable", "Claude Desktop account state could not be read completely and consistently; no current account is confirmed.", roots?.length === 1 ? roots[0] : null);
  }
}
