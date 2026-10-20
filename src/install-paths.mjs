import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEG_PATH = /^(\/.*?)\/Cellar\/([^/]+)\/[^/]+(\/.*)?$/;

function resolved(target) {
  try { return fs.realpathSync.native(target); } catch { return null; }
}

/**
 * Homebrew installs every version of a formula into its own Cellar keg and
 * deletes the old keg on upgrade, while <prefix>/opt/<formula> is retargeted to
 * the current one. A path that outlives this process - written into a client
 * configuration, or watched for an upgrade - therefore has to name the opt
 * alias. A keg path is rewritten only when the alias resolves to the same file
 * right now; every other path is returned unchanged.
 */
export function stableInstallPath(target, env = process.env) {
  if (process.platform === "win32" || typeof target !== "string") return target;
  const match = KEG_PATH.exec(target);
  if (!match) return target;
  const real = resolved(target);
  if (!real) return target;
  const [, base, formula, rest = ""] = match;
  const prefixes = [...new Set([env.HOMEBREW_PREFIX, base].filter((prefix) => prefix && path.isAbsolute(prefix)))];
  for (const prefix of prefixes) {
    const alias = path.join(prefix, "opt", formula) + rest;
    if (resolved(alias) === real) return alias;
  }
  return target;
}

/** The node binary to record for later launches. */
export function stableNodeBin(env = process.env) {
  return stableInstallPath(process.execPath, env);
}

/**
 * True when `entry` names the running main module, however it was reached.
 * Node resolves the main module with the JavaScript realpath, which follows
 * symlinks but keeps the spelling of the path as typed (case, 8.3 names,
 * substituted drives), so that is the form compared first.
 */
export function isMainModule(entry, moduleUrl) {
  if (!entry) return false;
  const file = path.resolve(entry);
  const module = fileURLToPath(moduleUrl);
  let typed;
  try { typed = fs.realpathSync(file); } catch { typed = file; }
  if (typed === module) return true;
  const canonical = resolved(file);
  return canonical !== null && canonical === resolved(module);
}
