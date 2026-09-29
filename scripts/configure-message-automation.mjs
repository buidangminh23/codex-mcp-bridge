#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { planMessageAutomation, applyMessageAutomation } from "../src/message-automation.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
exitForVersionRequest(import.meta.url);
const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); if (i < 0) return fallback; if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value: ${key}`); return args[i + 1]; };
try {
  const plan = planMessageAutomation({ claudeHome: option("--claude-home", path.join(os.homedir(), ".claude")), codeFile: option("--code-config", path.join(os.homedir(), ".claude.json")) });
  const installed = plan.files.every(item => item.before === item.after);
  console.log(JSON.stringify({ installed, policyFile: plan.policyFile, tools: plan.tools, changes: plan.files.filter(item => item.before !== item.after).map(item => item.file), limits: plan.limits }, null, 2));
  if (args.includes("--apply")) {
    if (!args.includes("--approve-message-automation")) throw new Error("Applying requires the user's opt-in: --approve-message-automation. Never invoke this to evade a peer tool refusal.");
    console.log(JSON.stringify(applyMessageAutomation(plan), null, 2));
    console.log("Verify in the actual Claude Code session that the settings and collaboration rule loaded; reload the existing client if needed. Test both directions without manual message relay.");
  } else if (args.includes("--check") && !installed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
