#!/usr/bin/env node
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { printSetup, runSetup } from "../src/setup.mjs";

exitForVersionRequest(import.meta.url);
try {
  const result = runSetup({ args: process.argv.slice(2) });
  printSetup(result, { json: process.argv.includes("--json") });
  if (result.configured === false && !result.dryRun && !process.argv.includes("--postinstall")) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Bridge setup: ${error.message}\n`);
  process.stderr.write("Run codex-bridge-setup to retry configuration; the installed package is retained.\n");
  if (!process.argv.includes("--postinstall")) process.exitCode = 1;
}
