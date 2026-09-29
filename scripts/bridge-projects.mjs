#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createProjectScope, editProjectGrant, readProjectPolicy, updateProjectPolicy } from "../src/project-scope.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { inspectBridgeProject, prepareBridgeProject } from "../src/project-onboarding.mjs";
import { registerProjectManager } from "../src/project-manager-registration.mjs";
import { syncCardSettings } from "../src/card-settings-sync.mjs";

exitForVersionRequest(import.meta.url);

const args = process.argv.slice(2);
const index = args.indexOf("--file");
// A shared home path avoids packaged Windows clients' private AppData views.
const file = index < 0 ? process.env.CODEX_BRIDGE_PROJECT_POLICY ?? path.join(os.homedir(), ".config", "GptClaudeBridge", "projects.json") : args.splice(index, 2)[1];
const [action = "list", input] = args;
try {
  if (action === "register-manager" || action === "register-card-settings") console.log(JSON.stringify(registerProjectManager({ policyFile: file }), null, 2));
  else if (action === "sync-card-settings") {
    if (!input || !path.isAbsolute(input)) throw new Error('An absolute settings snapshot file is required');
    const stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Invalid settings snapshot');
    const snapshot = JSON.parse(fs.readFileSync(input, 'utf8'));
    console.log(JSON.stringify(syncCardSettings(file, snapshot, { acknowledgeRender: snapshot.acknowledgeRender === true }), null, 2));
  }
  else if (["prepare", "inspect"].includes(action)) {
    if (!input) throw new Error("Usage: bridge-projects prepare|inspect <absolute project path> [--reauthorize] [--task-cards] [--file <policy.json>]");
    const operation = action === "prepare" ? prepareBridgeProject : inspectBridgeProject;
    console.log(JSON.stringify(operation({ cwd: input, reauthorize: args.includes("--reauthorize"), taskCards: args.includes("--task-cards") }, {
      env: { ...process.env, CODEX_BRIDGE_PROJECT_POLICY: file },
    }), null, 2));
  }
  else if (action === "list") console.log(JSON.stringify({ file, ...readProjectPolicy(file) }, null, 2));
  else if (action === "check") {
    const result = createProjectScope(file).status(input);
    console.log(JSON.stringify(result, null, 2));
    if (result.error) process.exitCode = 1;
  } else {
    if (!input) throw new Error("Usage: bridge-projects allow-project|allow-parent|revoke <absolute path> [--file <policy.json>]");
    updateProjectPolicy(file, (policy) => editProjectGrant(policy, action, input));
    console.log(JSON.stringify({ file, action, path: input, effective: "next bridge operation; no client restart needed" }, null, 2));
  }
} catch (error) { console.error(JSON.stringify({ error: error.message, ...(error.onboarding ? { onboarding: error.onboarding } : {}) })); process.exitCode = 1; }
