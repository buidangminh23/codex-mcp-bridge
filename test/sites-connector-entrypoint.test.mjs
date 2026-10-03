import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Sites connector executes through a directory junction or symbolic installation path", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "sites-entrypoint-"));
  const installation = path.join(sandbox, "installed");
  try {
    fs.symlinkSync(root, installation, process.platform === "win32" ? "junction" : "dir");
    const command = spawnSync(process.execPath, [path.join(installation, "src/sites-connector.mjs"), "--unsupported-option"], {
      encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(command.error, undefined);
    assert.equal(command.status, 1);
    assert.match(command.stderr, /^Usage: node src\/sites-connector\.mjs/);
    assert.equal(command.stdout, "");
  } finally {
    if (fs.existsSync(installation)) fs.unlinkSync(installation);
    fs.rmdirSync(sandbox);
  }
});
