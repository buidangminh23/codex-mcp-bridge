#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `codex_bridge_status` reports a version constant that lives in the source,
 * and `npm version` only ever rewrites package.json. Left to a human the two
 * drift, and a drifting version turns every bug report into a guess about
 * which build is actually running - so this runs from the `version` lifecycle
 * script, between the bump and the commit npm makes for it.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "src", "index.mjs");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const before = fs.readFileSync(entry, "utf8");
const after = before.replace(/^const VERSION = "[^"]+";$/m, `const VERSION = "${version}";`);

if (!after.includes(`const VERSION = "${version}";`)) {
  throw new Error(`could not find the VERSION constant in ${entry}`);
}

if (before !== after) fs.writeFileSync(entry, after);
console.log(`src/index.mjs VERSION -> ${version}`);
