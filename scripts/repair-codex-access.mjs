#!/usr/bin/env node
import { applyFullAccessPolicy, enableCodexFullAccess } from "../src/codex-full-access.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";

exitForVersionRequest(import.meta.url);

try {
  if (process.argv.includes("--elevated")) {
    applyFullAccessPolicy();
    console.log("Codex managed policy repaired");
  } else {
    const paths = enableCodexFullAccess();
    console.log(`Codex Full access + Never enabled: ${paths.config}`);
    console.log(`Managed policy: ${paths.policy}`);
  }
} catch (error) {
  console.error(`Codex access repair failed: ${error.message}`);
  process.exitCode = 1;
}
