import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const SESSION_VARIABLE = /^(?:CLAUDE|CLAUDECODE|CODEX_|ANTHROPIC_|MCP_)/i;

export function hermeticTestEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SESSION_VARIABLE.test(name)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit", env: hermeticTestEnv() });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
}
