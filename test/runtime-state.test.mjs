import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { createRuntimeState } from "../src/runtime-state.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-runtime-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

it("detects source updates even when the package version and file timestamp are unchanged", () => {
  const directory = path.join(root, "src");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"1.0.0"}');
  const file = path.join(directory, "delivery.mjs");
  fs.writeFileSync(file, "original");
  let desktop = true;
  const runtime = createRuntimeState({ directory, configuration: () => desktop });
  assert.equal(runtime.status().current, true);
  desktop = false;
  assert.throws(() => runtime.assertCurrent(), /routing configuration changed/);
  desktop = true;
  const stat = fs.statSync(file);
  fs.writeFileSync(file, "modified");
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal(runtime.status().current, false);
  assert.notEqual(runtime.status().revision, runtime.status().diskRevision);
  assert.throws(() => runtime.assertCurrent(), /source changed.*No message was sent/);
  const reconnected = createRuntimeState({ directory });
  assert.equal(reconnected.status().current, true);
  fs.unlinkSync(file);
  assert.throws(() => reconnected.assertCurrent(), /source changed/);
});
