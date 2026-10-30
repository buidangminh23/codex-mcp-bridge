#!/usr/bin/env node
import { runSupervisor } from "./mcp-supervisor.mjs";
import { handleTelemetryCommand } from "./telemetry.mjs";
if (process.argv[2] === "setup") {
  const { runSetup, printSetup } = await import("./setup.mjs");
  try {
    const result = runSetup({ args: process.argv.slice(3) });
    printSetup(result, { json: process.argv.includes("--json") });
    if (result.configured === false && !result.dryRun) process.exitCode = 1;
  } catch (error) { process.stderr.write(`Bridge setup: ${error.message}\n`); process.exitCode = 1; }
} else if (!await handleTelemetryCommand(process.argv.slice(2))) await runSupervisor("index.mjs");
