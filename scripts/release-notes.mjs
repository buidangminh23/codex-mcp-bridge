#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prints one version's section of the changelog, so a GitHub release carries
 * the notes that were already written by hand rather than a generated list of
 * commit subjects. Used by the publish workflow and runnable on its own when a
 * release has to be created after the fact.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const heading = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (heading === -1) return null;

  const rest = lines.slice(heading + 1);
  const next = rest.findIndex((line) => line.startsWith("## ["));
  const body = (next === -1 ? rest : rest.slice(0, next)).join("\n").trim();
  return body === "" ? null : body;
}

/**
 * Only runs the CLI when invoked directly - importing this from a test must
 * not read argv or exit the process.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const notes = releaseNotes(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);

  if (!notes) {
    process.stderr.write(`CHANGELOG.md has no entry for ${version}\n`);
    process.exit(1);
  }
  process.stdout.write(`${notes}\n`);
}
