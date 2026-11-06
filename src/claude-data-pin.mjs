import os from "node:os";
import path from "node:path";

import { readClaudeAccountContext } from "./desktop-account-context.mjs";
import { readRegularConfigFile } from "./project-policy.mjs";

const PIN = "CLAUDE_DESKTOP_USER_DATA";
const PIN_VALUE = /CLAUDE_DESKTOP_USER_DATA["'\s]*[:=]\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

const hasAccountState = (account) => (account.status === "verified" || account.status === "signed_out") && Boolean(account.root);

function withoutPin(env) {
  const { [PIN]: _removed, ...rest } = env;
  return rest;
}

export function claudeDataPinUsable(env = process.env, platform = process.platform) {
  return env[PIN] !== undefined && hasAccountState(readClaudeAccountContext({ env, platform }));
}

export function activeClaudeDataRoot(env = process.env, platform = process.platform) {
  const selected = readClaudeAccountContext({ env, platform });
  if (hasAccountState(selected)) return selected.root;
  const scanned = readClaudeAccountContext({ env: withoutPin(env), platform });
  return hasAccountState(scanned) ? scanned.root : null;
}

export function relayClaudeDataPin(env = process.env, platform = process.platform) {
  if (env[PIN] === undefined) return null;
  const selected = readClaudeAccountContext({ env, platform });
  if (!hasAccountState(selected)) return null;
  const scanned = readClaudeAccountContext({ env: withoutPin(env), platform });
  return hasAccountState(scanned) && scanned.root === selected.root ? null : env[PIN];
}

function pinnedRoots(file) {
  let text;
  try { text = readRegularConfigFile(file, { missing: true, maxBytes: MAX_CONFIG_BYTES }); }
  catch { return []; }
  if (text === null) return [];
  return [...text.matchAll(PIN_VALUE)].map((match) => match[2] ?? match[1].replace(/\\(.)/g, "$1"));
}

export function repairClaudeDataPin({ env = process.env, platform = process.platform } = {}) {
  const scanned = readClaudeAccountContext({ env: withoutPin(env), platform });
  if (!hasAccountState(scanned)) return env;
  if (env[PIN] !== undefined) return claudeDataPinUsable(env, platform) ? env : { ...env, [PIN]: scanned.root };
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const files = [path.join(env.CLAUDE_CONFIG_DIR || home, ".claude.json"), path.join(env.CODEX_HOME || path.join(home, ".codex"), "config.toml"),
    path.join(scanned.root, "claude_desktop_config.json")];
  const stale = files.flatMap(pinnedRoots).some((root) => !hasAccountState(readClaudeAccountContext({ env: withoutPin(env), platform, root })));
  return stale ? { ...env, [PIN]: scanned.root } : env;
}
