import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Optional UI adapter discovery. Neither bridge startup nor policy evaluation reads
// this file. Removing the card extension or this descriptor cannot stop messaging.
export function registerProjectManager({ policyFile, env = process.env, executable = process.execPath } = {}) {
  if (!path.isAbsolute(policyFile ?? "")) throw new Error("Manager policy path must be absolute");
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const file = path.join(home, ".config", "GptClaudeBridge", "management.json");
  const value = { version: 1, node: executable,
    script: fileURLToPath(new URL("../scripts/bridge-projects.mjs", import.meta.url)),
    policyFile, configFile: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json") };
  if (!Object.values(value).filter(v => typeof v === "string").every(v => path.isAbsolute(v))) throw new Error("Manager paths must be absolute");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = JSON.stringify(value, null, 2) + "\n";
  let before = null;
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) throw new Error("Invalid manager descriptor");
    before = fs.readFileSync(file, "utf8");
  }
  if (next === before) return { file, changed: false };
  const temp = file + ".pending-" + randomUUID();
  try {
    fs.writeFileSync(temp, next, { flag: "wx", mode: 0o600 });
    if ((fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null) !== before) throw new Error("Manager descriptor changed concurrently");
    if (before !== null) fs.copyFileSync(file, file + ".backup-" + randomUUID(), fs.constants.COPYFILE_EXCL);
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return { file, changed: true };
}
