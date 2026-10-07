#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { claudeDesktopConfigPath } from "../src/platform.mjs";
import { checkCodeRegistration, planCodeRegistration } from "../src/claude-code-registration.mjs";
import { readProjectPolicy, readRegularConfigFile, backupRegularConfigFile } from "../src/project-policy.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";

exitForVersionRequest(import.meta.url);

const args = process.argv.slice(2);
const option = (key, fallback) => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
const codeFile = option("--code-config", path.join(os.homedir(), ".claude.json"));
const desktopFile = option("--desktop-config", claudeDesktopConfigPath());
const policyFile = option("--policy", process.env.CODEX_BRIDGE_PROJECT_POLICY);
const maxConfigBytes = 8 * 1024 * 1024;
const read = (file) => readRegularConfigFile(file, { maxBytes: maxConfigBytes, missing: true });
try {
  const files = [codeFile, desktopFile];
  const originals = files.map(read);
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
          const now = read(file);
          if (now !== originals[index]) throw new Error(`Configuration changed concurrently: ${file}`);
          if (now === null && index === 1 && !Object.keys(plan.desktop.mcpServers ?? {}).length) continue;
          if (now !== null) backupRegularConfigFile(file, `${file}.backup-${suffix}`, now, maxConfigBytes);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const temporary = `${file}.pending-${suffix}`;
          try {
            fs.writeFileSync(temporary, contents[index], { flag: "wx", mode: 0o600 });
            if (read(file) !== now) throw new Error(`Configuration changed concurrently: ${file}`);
            fs.renameSync(temporary, file);
          } finally { fs.rmSync(temporary, { force: true }); }
          written.push(index);
        }
      } catch (error) {
        const remaining = [];
        for (const index of written.reverse()) {
          const file = files[index];
          const temporary = `${file}.rollback-${suffix}`;
          try {
            if (read(file) !== contents[index]) { remaining.push(file); continue; }
            if (originals[index] === null) fs.unlinkSync(file);
            else {
              fs.writeFileSync(temporary, originals[index], { flag: "wx", mode: 0o600 });
              if (read(file) !== contents[index]) { remaining.push(file); continue; }
              fs.renameSync(temporary, file);
            }
          } catch { remaining.push(file); }
          finally { fs.rmSync(temporary, { force: true }); }
        }
        if (remaining.length) error.message += `; rollback requires review: ${remaining.join(", ")}`;
        throw error;
      }
      console.log("Reopen the original Code task and call codex_bridge_status with the intended project cwd. Update the configuration manager's matching entry to the same policy file. No new per-project MCP entry is needed.");
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
