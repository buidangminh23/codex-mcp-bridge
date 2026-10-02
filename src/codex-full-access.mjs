import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POLICY_HEADER = [
  'default_permissions = ":danger-full-access"',
  'allowed_approval_policies = ["never"]',
  'allowed_approvals_reviewers = ["user"]',
  'allowed_sandbox_modes = ["read-only", "danger-full-access"]',
];
const CONFIG_HEADER = [
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
];

export function codexAccessPaths(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    config: path.join(home, "config.toml"),
    marker: path.join(home, "bridge-full-access.enabled"),
    policy: process.platform === "win32"
      ? path.join(env.ProgramData || env.PROGRAMDATA || "C:\\ProgramData", "OpenAI", "Codex", "requirements.toml")
      : "/etc/codex/requirements.toml",
  };
}

function newlineFor(contents) {
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

function replaceTopLevel(contents, keys, header) {
  const newline = newlineFor(contents);
  const firstTable = /^[ \t]*\[[^\]\r\n]+\]/m.exec(contents);
  const splitAt = firstTable?.index ?? contents.length;
  const top = contents.slice(0, splitAt).replace(
    new RegExp(`^[ \\t]*(?:${keys.join("|")})[ \\t]*=[^\\r\\n]*(?:\\r?\\n|$)`, "gm"),
    "",
  );
  const rest = contents.slice(splitAt);
  return `${header.join(newline)}${newline}${top.trim() ? `${top.trimStart()}${top.endsWith(newline) ? "" : newline}` : newline}${rest}`;
}

export function fullAccessConfigContents(contents = "") {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const source = contents.slice(bom.length);
  const firstTable = /^[ \t]*\[[^\]\r\n]+\]/m.exec(source);
  const top = source.slice(0, firstTable?.index ?? source.length);
  if (["approval_policy", "sandbox_mode"].every((key, index) =>
    top.split(/\r?\n/).filter((entry) => new RegExp(`^[ \\t]*${key}[ \\t]*=`).test(entry)).length === 1 &&
      top.split(/\r?\n/).some((entry) => entry.trim() === CONFIG_HEADER[index]))) return contents;
  return bom + replaceTopLevel(source, ["approval_policy", "sandbox_mode"], CONFIG_HEADER);
}

export function fullAccessPolicyContents(contents = "") {
  const bom = contents.startsWith("\uFEFF") ? "\uFEFF" : "";
  const newline = newlineFor(contents);
  let updated = replaceTopLevel(
    contents.slice(bom.length),
    ["default_permissions", "allowed_approval_policies", "allowed_approvals_reviewers", "allowed_sandbox_modes"],
    POLICY_HEADER,
  );
  const table = /^[ \t]*\[allowed_permission_profiles\][ \t]*(?:#.*)?$/m.exec(updated);
  if (!table) {
    updated = `${updated.trimEnd()}${newline}${newline}[allowed_permission_profiles]${newline}":danger-full-access" = true${newline}`;
  } else {
    const bodyStart = table.index + table[0].length;
    const nextTable = /^[ \t]*\[[^\]\r\n]+\]/m.exec(updated.slice(bodyStart));
    const bodyEnd = nextTable ? bodyStart + nextTable.index : updated.length;
    const body = updated.slice(bodyStart, bodyEnd)
      .replace(/^[ \t]*["']?:danger-full-access["']?[ \t]*=[^\r\n]*(?:\r?\n|$)/gm, "")
      .replace(/^(?:\r?\n)+/, "");
    updated = `${updated.slice(0, bodyStart)}${newline}":danger-full-access" = true${newline}${body}${updated.slice(bodyEnd)}`;
  }
  return bom + updated;
}

function writeIfChanged(filePath, contents, transform) {
  const next = transform(contents);
  if (next === contents) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, { encoding: "utf8", mode: 0o600 });
  return true;
}

function withUnlockedPolicy(filePath, action) {
  if (!fs.existsSync(filePath)) return action();
  if (process.platform === "darwin") {
    const flags = execFileSync("/usr/bin/stat", ["-f", "%Sf", filePath], { encoding: "utf8" }).trim();
    if (flags.split(",").includes("uchg")) {
      execFileSync("/usr/bin/chflags", ["nouchg", filePath]);
      try { return action(); } finally { execFileSync("/usr/bin/chflags", ["uchg", filePath]); }
    }
  }
  if (process.platform === "linux") {
    let attributes = "";
    try {
      attributes = execFileSync("lsattr", ["-d", filePath], { encoding: "utf8" }).split(/\s+/)[0];
    } catch {}
    if (attributes.includes("i")) {
      execFileSync("chattr", ["-i", filePath]);
      try { return action(); } finally { execFileSync("chattr", ["+i", filePath]); }
    }
  }
  return action();
}

export function applyFullAccessPolicy(filePath = codexAccessPaths().policy) {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`Refusing to rewrite a symbolic-link managed policy: ${filePath}`);
  }
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const next = fullAccessPolicyContents(previous);
  if (next === previous) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return withUnlockedPolicy(filePath, () => writeIfChanged(filePath, previous, fullAccessPolicyContents));
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function elevatedRepair() {
  const helper = fileURLToPath(new URL("../scripts/repair-codex-access.mjs", import.meta.url));
  if (process.platform === "win32") {
    const command = `& ${powershellQuote(process.execPath)} ${powershellQuote(helper)} --elevated; exit $LASTEXITCODE`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const wrapper = `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-EncodedCommand','${encoded}') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    execFileSync("powershell.exe", ["-NoProfile", "-EncodedCommand", Buffer.from(wrapper, "utf16le").toString("base64")], { windowsHide: true, timeout: 120_000 });
    return;
  }
  if (process.platform === "darwin") {
    try {
      execFileSync("sudo", ["-n", process.execPath, helper, "--elevated"], { timeout: 120_000 });
      return;
    } catch {}
    const command = `${shellQuote(process.execPath)} ${shellQuote(helper)} --elevated`;
    const appleScript = `do shell script "${command.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" with administrator privileges`;
    execFileSync("osascript", ["-e", appleScript], { timeout: 120_000 });
    return;
  }
  try {
    execFileSync("sudo", ["-n", process.execPath, helper, "--elevated"], { timeout: 120_000 });
  } catch {
    execFileSync("pkexec", [process.execPath, helper, "--elevated"], { timeout: 120_000 });
  }
}

export function fullAccessEnabled(paths = codexAccessPaths()) {
  return fs.existsSync(paths.marker);
}

export function enableCodexFullAccess({ paths = codexAccessPaths(), allowElevation = true } = {}) {
  const config = fs.existsSync(paths.config) ? fs.readFileSync(paths.config, "utf8") : "";
  writeIfChanged(paths.config, config, fullAccessConfigContents);
  try {
    applyFullAccessPolicy(paths.policy);
  } catch (error) {
    if (!allowElevation || paths.policy !== codexAccessPaths().policy) throw error;
    elevatedRepair();
    const current = fs.readFileSync(paths.policy, "utf8");
    if (fullAccessPolicyContents(current) !== current) throw new Error("Codex managed policy remains incomplete after administrator repair");
  }
  if (!fs.existsSync(paths.marker)) fs.writeFileSync(paths.marker, "enabled\n", { mode: 0o600 });
  return paths;
}
