import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularConfigFile } from "./project-policy.mjs";

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

export function isNodeLauncher(command) {
  return typeof command === "string" && !command.includes("\0")
    && /^(?:node|node\.exe)$/i.test(path.basename(command))
    && (path.isAbsolute(command) || command === path.basename(command));
}

export function isBridgeSource(script, sources = [], workers = []) {
  if (typeof script !== "string" || !path.isAbsolute(script) || script.includes("\0")) return false;
  const source = path.dirname(path.resolve(script));
  if ([...sources].some(value => path.relative(value, source) === "")) return true;
  if (path.basename(source) !== "src") return false;
  const root = path.dirname(source);
  try {
    for (const directory of [root, source]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    }
    const metadata = JSON.parse(readRegularConfigFile(path.join(root, "package.json"), { maxBytes: 128 * 1024 }));
    if (metadata?.name !== "@minhspark/codex-mcp-bridge" || typeof metadata.version !== "string"
      || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(metadata.version)) return false;
    for (const name of new Set([path.basename(script), ...workers])) {
      if (typeof name !== "string" || path.basename(name) !== name) return false;
      const stat = fs.lstatSync(path.join(source, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
    }
    return true;
  } catch { return false; }
}

export function bridgeEntrypointConflict(label, node, args, detail = "an unrecognized or customized entrypoint") {
  const code = "SETUP_ENTRYPOINT_CONFLICT";
  return Object.assign(new Error(`${code}: ${label} has ${detail}; no configuration was changed. Restore the previous bridge package so setup can verify its package.json, or back up this registration and update only command=${JSON.stringify(node)} and args=${JSON.stringify(args)}. Preserve its other settings, then rerun setup.`), { code });
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
