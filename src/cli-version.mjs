import { readFileSync, realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function exitForVersionRequest(entrypointUrl) {
  if (!process.argv.slice(2).some((arg) => arg === "--version" || arg === "-v")) return;
  if (!process.argv[1]) return;

  let entrypoint;
  try {
    entrypoint = realpathSync(process.argv[1]);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    throw error;
  }
  if (entrypoint !== realpathSync(fileURLToPath(entrypointUrl))) return;

  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  writeSync(process.stdout.fd, `${version}\n`);
  process.exit(0);
}
