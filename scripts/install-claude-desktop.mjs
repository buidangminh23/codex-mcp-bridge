import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = path.join(process.env.APPDATA ?? "", "Claude", "claude_desktop_config.json");
if (!fs.existsSync(cfgPath)) throw new Error(`Claude Desktop config not found: ${cfgPath}`);

const nodeExe = process.env.NODE_EXE ?? process.execPath;
const codexExe =
  process.env.CODEX_EXE ??
  path.join(
    process.env.LOCALAPPDATA ?? "",
    "Programs",
    "OpenAI",
    "Codex",
    "bin",
    "codex.exe",
  );

if (!fs.existsSync(nodeExe)) throw new Error(`node.exe not found: ${nodeExe}`);
if (!fs.existsSync(codexExe)) throw new Error(`codex.exe not found: ${codexExe}`);

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
cfg.mcpServers = cfg.mcpServers ?? {};
cfg.mcpServers["codex-bridge"] = {
  command: nodeExe,
  args: [path.join(root, "src", "index.mjs")],
  env: {
    CODEX_BIN: codexExe,
    CODEX_APP_SERVER_URL: process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:8791",
  },
};

const backup = `${cfgPath}.bak-${new Date().toISOString().slice(0, 10)}-codexbridge`;
if (!fs.existsSync(backup)) fs.copyFileSync(cfgPath, backup);
fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

console.log(`updated ${cfgPath}`);
console.log(JSON.stringify(cfg.mcpServers["codex-bridge"], null, 2));
