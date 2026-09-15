#!/usr/bin/env node
import { runSupervisor } from "./mcp-supervisor.mjs";
import { handleTelemetryCommand } from "./telemetry.mjs";
if (!await handleTelemetryCommand(process.argv.slice(2))) await runSupervisor("index.mjs");
