#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitForVersionRequest } from "../src/cli-version.mjs";

exitForVersionRequest(import.meta.url);

const begin = "# codex-mcp-bridge npm footer: begin";
const end = "# codex-mcp-bridge npm footer: end";
const args = process.argv.slice(2);
let shell = process.platform === "win32" ? "powershell" : path.basename(process.env.SHELL || "/bin/bash");
const profiles = [];
let remove = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--remove") remove = true;
  else if (["--shell", "--profile"].includes(arg) && args[index + 1]) {
    const value = args[++index];
    if (arg === "--shell") shell = value;
    else profiles.push(path.resolve(value));
  } else throw new Error(`Unsupported argument: ${arg}`);
}
if (!["bash", "zsh", "powershell"].includes(shell)) throw new Error("Choose --shell bash, zsh, or powershell.");
const footerDirectory = path.join(os.homedir(), ".config", "codex-mcp-bridge");
const footerName = shell === "powershell" ? "npm-footer.ps1" : "npm-footer.sh";
const footerPath = path.join(footerDirectory, footerName);
if (!profiles.length) {
  if (shell === "powershell") {
    profiles.push(execFileSync("pwsh", ["-NoProfile", "-Command", "$PROFILE.CurrentUserAllHosts"], { encoding: "utf8" }).trim());
  } else if (shell === "zsh") {
    const directory = process.env.ZDOTDIR || os.homedir();
    profiles.push(path.join(directory, ".zshrc"), path.join(directory, ".zprofile"));
  } else {
    profiles.push(path.join(os.homedir(), ".bashrc"));
    profiles.push([".bash_profile", ".bash_login", ".profile"].map((name) => path.join(os.homedir(), name)).find((file) => fs.existsSync(file)) || path.join(os.homedir(), ".profile"));
  }
}
const quote = (value) => shell === "powershell" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'\\''`)}'`;
const loader = shell === "powershell"
  ? `if (Test-Path -LiteralPath ${quote(footerPath)}) { . ${quote(footerPath)} }`
  : `if [ -n "\${BASH_VERSION:-}\${ZSH_VERSION:-}" ] && [ -r ${quote(footerPath)} ]; then . ${quote(footerPath)}; fi`;
const edits = [...new Set(profiles)].map((file) => {
  if (!path.isAbsolute(file)) throw new Error(`Profile path must be absolute: ${file}`);
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error(`Refusing to replace a non-regular profile: ${file}`);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const newline = before.includes("\r\n") || shell === "powershell" ? "\r\n" : "\n";
  const normalized = before.replaceAll("\r\n", "\n");
  const begins = normalized.split(begin).length - 1;
  const ends = normalized.split(end).length - 1;
  if (begins !== ends || begins > 1) throw new Error(`Ambiguous managed footer block: ${file}`);
  let unmanaged = normalized;
  if (begins) {
    const start = normalized.indexOf(begin);
    const finish = normalized.indexOf(end, start);
    if (finish < start) throw new Error(`Malformed managed footer block: ${file}`);
    unmanaged = normalized.slice(0, start) + normalized.slice(finish + end.length).replace(/^\n/, "");
  }
  if (!remove && /^\s*(?:function\s+(?:global:)?)?npm\s*(?:\(\s*\))?\s*\{/im.test(unmanaged)) {
    throw new Error(`An existing npm wrapper must be reviewed before installing the footer: ${file}`);
  }
  const after = (remove ? unmanaged : `${begin}\n${loader}\n${end}\n${unmanaged}`).replaceAll("\n", newline);
  return { file, before, after };
});

if (!remove) {
  const source = fs.readFileSync(fileURLToPath(new URL(`./${footerName}`, import.meta.url)), "utf8");
  fs.mkdirSync(footerDirectory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(footerPath) && (!fs.lstatSync(footerPath).isFile() || fs.lstatSync(footerPath).isSymbolicLink())) throw new Error(`Unsafe footer destination: ${footerPath}`);
  if (!fs.existsSync(footerPath) || fs.readFileSync(footerPath, "utf8") !== source) {
    fs.writeFileSync(footerPath, source, { mode: 0o600 });
  }
}
for (const { file, before, after } of edits) {
  if (before === after) { console.log(`Unchanged: ${file}`); continue; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (current !== before) throw new Error(`Profile changed during installation; rerun after reviewing it: ${file}`);
  if (fs.existsSync(file)) {
    const backup = `${file}.bak-npm-footer-${Date.now()}-${process.pid}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    console.log(`Backup: ${backup}`);
  }
  const temporary = `${file}.tmp-npm-footer-${process.pid}`;
  let temporaryCreated = false;
  try {
    fs.writeFileSync(temporary, after, { mode: 0o600, flag: "wx" });
    temporaryCreated = true;
    fs.renameSync(temporary, file);
  } finally {
    if (temporaryCreated && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  console.log(`${remove ? "Removed" : "Installed"}: ${file}`);
}
console.log(remove
  ? "Open a new shell to use npm without the footer."
  : `Reload the current shell with: . ${quote(footerPath)}`);
