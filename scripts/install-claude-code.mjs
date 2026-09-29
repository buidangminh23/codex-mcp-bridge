#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { claudeDesktopConfigPath } from "../src/platform.mjs";
import { checkCodeRegistration, planCodeRegistration } from "../src/claude-code-registration.mjs";
import { readProjectPolicy } from "../src/project-scope.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";

exitForVersionRequest(import.meta.url);

const args = process.argv.slice(2);
const option = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const codeFile = option("--code-config", path.join(os.homedir(), ".claude.json"));
const desktopFile = option("--desktop-config", claudeDesktopConfigPath());
const policyFile = option("--policy", process.env.CODEX_BRIDGE_PROJECT_POLICY);
try {
  const files = [codeFile, desktopFile];
  const originals = files.map((file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  const [code, desktop] = originals.map((raw) => raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, "")));
  if (args.includes("--check")) {
    const result = checkCodeRegistration({ code, desktop });
    if (result.policyFile) { try { readProjectPolicy(result.policyFile); } catch (error) { result.issues.push(error.message); result.ready = false; } }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } else {
    if (!policyFile) throw new Error("Specify --policy <absolute shared projects.json>; initialize its authorized projects first");
    readProjectPolicy(policyFile);
    const plan = planCodeRegistration({ code, desktop, policyFile });
    console.log(JSON.stringify({ action: args.includes("--apply") ? "apply" : "plan", changes: plan.changes, policyFile }, null, 2));
    if (args.includes("--apply")) {
      if (!args.includes("--clients-stopped")) throw new Error("Exit Claude and the configuration manager first, then pass --clients-stopped to avoid their overwriting the migration");
      const contents = [plan.code, plan.desktop].map((value) => JSON.stringify(value, null, 2) + "\n");
      const suffix = randomUUID();
      const written = [];
      try {
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
          if (now !== originals[index]) throw new Error(`Configuration changed concurrently: ${file}`);
          if (now === null && index === 1 && !Object.keys(plan.desktop.mcpServers ?? {}).length) continue;
          if (now !== null) fs.copyFileSync(file, `${file}.backup-${suffix}`, fs.constants.COPYFILE_EXCL);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const temporary = `${file}.pending-${suffix}`;
          try {
            fs.writeFileSync(temporary, contents[index], { flag: "wx", mode: 0o600 });
            fs.renameSync(temporary, file);
          } finally { fs.rmSync(temporary, { force: true }); }
          written.push(index);
        }
      } catch (error) {
        for (const index of written) {
          if (fs.readFileSync(files[index], "utf8") === contents[index]) {
            if (originals[index] === null) fs.rmSync(files[index]);
            else fs.writeFileSync(files[index], originals[index]);
          }
        }
        throw error;
      }
      console.log("Reopen the original Code task and call codex_bridge_status with the intended project cwd. Update the configuration manager's matching entry to the same policy file. No new per-project MCP entry is needed.");
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
