#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Both status tools report a version constant that lives in the source, and
 * `npm version` only ever rewrites package.json. Left to a human the two
 * drift, and a drifting version turns every bug report into a guess about
 * which build is actually running - so this runs from the `version` lifecycle
 * script, between the bump and the commit npm makes for it.
 *
 * Every entry point carrying its own constant belongs in this list. One that
 * is missing here is not bumped by any release, which is exactly how
 * claude-bridge sat at 1.3.0 while the package shipped 1.10.0.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  path.join("src", "index.mjs"),
  path.join("src", "claude-bridge.mjs"),
  path.join("src", "native-relay-companion.mjs"),
  path.join("scripts", "install-native-relay.mjs"),
];
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

for (const entry of entries) {
  const file = path.join(root, entry);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(/^const VERSION = "[^"]+";$/m, `const VERSION = "${version}";`);

  if (!after.includes(`const VERSION = "${version}";`)) {
    throw new Error(`could not find the VERSION constant in ${entry}`);
  }

  if (before !== after) fs.writeFileSync(file, after);
  console.log(`${entry.split(path.sep).join("/")} VERSION -> ${version}`);
}
