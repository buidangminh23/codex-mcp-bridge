#!/usr/bin/env node
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { printSetup, runSetup } from "../src/setup.mjs";

exitForVersionRequest(import.meta.url);
try {
  const result = runSetup({ args: process.argv.slice(2) });
  printSetup(result, { json: process.argv.includes("--json") });
  if (result.configured === false && !result.dryRun) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Bridge setup: ${error.message}\n`);
  process.stderr.write("Bridge configuration was not completed. Run codex-bridge-setup to retry after resolving the reported error.\n");
  process.exitCode = 1;
}
