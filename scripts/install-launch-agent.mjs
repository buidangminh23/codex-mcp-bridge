import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IS_MACOS, LAUNCH_AGENT_LABEL, launchAgentPath, resolveCodexBin, spawnEnv } from "../src/platform.mjs";

if (!IS_MACOS) {
  throw new Error("install-launch-agent.mjs is macOS-only. On Windows use a Startup shortcut or a scheduled task.");
}

const plistPath = launchAgentPath();
const uninstall = process.argv.includes("--uninstall");
const domain = `gui/${process.getuid()}`;

function bootout() {
  try {
    execFileSync("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

if (uninstall) {
  const wasLoaded = bootout();
  if (fs.existsSync(plistPath)) fs.rmSync(plistPath);
  console.log(`removed ${plistPath}${wasLoaded ? " (agent unloaded)" : ""}`);
  process.exit(0);
}

const codexBin = resolveCodexBin(process.env.CODEX_EXE);
if (!path.isAbsolute(codexBin) || !fs.existsSync(codexBin)) {
  throw new Error(`codex binary not found (resolved to "${codexBin}"). Set CODEX_EXE to its absolute path.`);
}

const url = process.env.CODEX_APP_SERVER_URL ?? "ws://127.0.0.1:8791";
const logDir = path.join(os.homedir(), "Library", "Logs", "codex-mcp-bridge");
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(path.dirname(plistPath), { recursive: true });

const escapeXml = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(codexBin)}</string>
    <string>app-server</string>
    <string>--listen</string>
    <string>${escapeXml(url)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(spawnEnv().PATH)}</string>
    <key>HOME</key>
    <string>${escapeXml(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, "app-server.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, "app-server.err.log"))}</string>
</dict>
</plist>
`;

fs.writeFileSync(plistPath, plist, "utf8");
bootout();
execFileSync("launchctl", ["bootstrap", domain, plistPath], { stdio: "inherit" });
execFileSync("launchctl", ["enable", `${domain}/${LAUNCH_AGENT_LABEL}`], { stdio: "pipe" });

console.log(`installed ${plistPath}`);
console.log(`endpoint: ${url}`);
console.log(`logs:     ${logDir}`);
console.log(`status:   launchctl print ${domain}/${LAUNCH_AGENT_LABEL} | head -20`);
console.log(`remove:   node scripts/install-launch-agent.mjs --uninstall`);
