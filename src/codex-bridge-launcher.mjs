#!/usr/bin/env node
import { runSupervisor } from "./mcp-supervisor.mjs";
import { handleTelemetryCommand } from "./telemetry.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { isMainModule } from "./install-paths.mjs";

async function applySetup(args) {
  const { runSetup, printSetup } = await import("./setup.mjs");
  const result = runSetup({ args });
  printSetup(result, { json: args.includes("--json") });
  return result;
}

export async function runLauncher({ args = process.argv.slice(2), env = process.env, platform = process.platform,
  input = process.stdin, output = process.stdout, errorOutput = process.stderr, supervise = runSupervisor,
  telemetry = handleTelemetryCommand, setup = applySetup,
  updateCli = async args => (await import("../scripts/update.mjs")).runUpdateCli(args) } = {}) {
  const terminalUpdate = args.length === 0 && env.npm_command === "exec" && input.isTTY === true && output.isTTY === true;
  if (terminalUpdate || args[0] === "update") {
    const updateArgs = terminalUpdate ? [] : args.slice(1);
    return updateCli(platform === "win32" && !updateArgs.includes("--user") ? ["--user", ...updateArgs] : updateArgs);
  }
  if (args[0] === "setup") {
    try {
      const result = await setup(args.slice(1));
      return result.configured === false && !result.dryRun ? 1 : 0;
    } catch (error) {
      errorOutput.write(`Bridge setup: ${error.message}\n`);
      return 1;
    }
  }
  if (!await telemetry(args)) return supervise("index.mjs");
}

if (isMainModule(process.argv[1], import.meta.url)) {
  exitForVersionRequest(import.meta.url);
  const exitCode = await runLauncher();
  if (Number.isInteger(exitCode)) process.exitCode = exitCode;
}
