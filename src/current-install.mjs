import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { codexHome } from "./native-relay.mjs";
import { readRegularConfigFile } from "./project-policy.mjs";

const PACKAGE = "@minhspark/codex-mcp-bridge";
const MANAGED_INSTALL = /[\\/]node_modules[\\/]@minhspark[\\/]codex-mcp-bridge[\\/]?$/i;

export function newerVersion(left, right) {
  const split = (value) => {
    const [core, ...suffix] = value.split("+")[0].split("-");
    return { core: core.split(".").map(BigInt), suffix: suffix.join("-") };
  };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index];
  if (!a.suffix || !b.suffix) return !a.suffix && Boolean(b.suffix);
  const parts = [a.suffix.split("."), b.suffix.split(".")];
  for (let index = 0; index < Math.max(...parts.map((part) => part.length)); index++) {
    const [x, y] = parts.map((part) => part[index]);
    if (x === y) continue;
    if (x === undefined || y === undefined) return y === undefined;
    const numeric = [x, y].map((value) => /^\d+$/.test(value));
    return numeric.every(Boolean) ? BigInt(x) > BigInt(y) : numeric[0] !== numeric[1] ? numeric[1] : x > y;
  }
  return false;
}

export function isManagedInstall(root) {
  return typeof root === "string" && MANAGED_INSTALL.test(root);
}

export function currentInstallFile(env = process.env) {
  return path.join(codexHome(env), "bridge-current-install.json");
}

export function installedBridgeVersion(root) {
  try {
    const value = JSON.parse(readRegularConfigFile(path.join(root, "package.json"), { maxBytes: 128 * 1024 }));
    if (value?.name !== PACKAGE || typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(value.version)) return null;
    return fs.statSync(path.join(root, "src", "mcp-supervisor.mjs")).isFile() ? value.version : null;
  } catch {
    return null;
  }
}

export function writeCurrentInstall({ env = process.env, root, claudeDataRoot = null, now = () => new Date() }) {
  const version = installedBridgeVersion(root);
  if (!isManagedInstall(root) || !version) return false;
  const file = currentInstallFile(env);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, packageRoot: root, version, claudeDataRoot, updatedAt: now().toISOString() }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try { fs.renameSync(temporary, file); }
  catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  return true;
}

export function readCurrentInstall({ env = process.env, ownRoot }) {
  let value;
  try {
    const raw = readRegularConfigFile(currentInstallFile(env), { missing: true, maxBytes: 16 * 1024 });
    if (raw === null) return null;
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value?.schemaVersion !== 1 || typeof value.packageRoot !== "string" || !path.isAbsolute(value.packageRoot) || /[\u0000-\u001f\u007f]/.test(value.packageRoot)) return null;
  const version = installedBridgeVersion(value.packageRoot);
  if (!version) return null;
  const own = installedBridgeVersion(ownRoot);
  if (own && newerVersion(own, version)) return null;
  const claudeDataRoot = typeof value.claudeDataRoot === "string" && path.isAbsolute(value.claudeDataRoot) ? value.claudeDataRoot : null;
  return { packageRoot: value.packageRoot, version, claudeDataRoot };
}
