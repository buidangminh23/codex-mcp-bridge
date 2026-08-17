import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_LABEL, claudeDesktopConfigPath, resolveCodexBin } from "../src/platform.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = process.env.CLAUDE_DESKTOP_CONFIG ?? claudeDesktopConfigPath();

const nodeBin = process.env.NODE_EXE ?? process.execPath;
const codexBin = resolveCodexBin(process.env.CODEX_EXE);

if (!fs.existsSync(nodeBin)) throw new Error(`node executable not found: ${nodeBin}`);
if (!path.isAbsolute(codexBin) || !fs.existsSync(codexBin)) {
  throw new Error(
    `codex binary not found (resolved to "${codexBin}"). Set CODEX_EXE to the absolute path of the codex CLI.`,
  );
}

fs.mkdirSync(path.dirname(cfgPath), { recursive: true });

const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
cfg.mcpServers = cfg.mcpServers ?? {};
cfg.mcpServers["codex-bridge"] = {
  command: nodeBin,
  args: [path.join(root, "src", "index.mjs")],
  env: {
    CODEX_BIN: codexBin,
    CODEX_APP_SERVER_URL: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:8791",
  },
};

if (fs.existsSync(cfgPath)) {
  const backup = `${cfgPath}.bak-${new Date().toISOString().slice(0, 10)}-codexbridge`;
  if (!fs.existsSync(backup)) fs.copyFileSync(cfgPath, backup);
}
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

console.log(`platform: ${PLATFORM_LABEL}`);
console.log(`updated ${cfgPath}`);
console.log(JSON.stringify(cfg.mcpServers["codex-bridge"], null, 2));
console.log("\nRestart Claude Desktop to load the bridge.");
