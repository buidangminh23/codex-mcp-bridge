import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { findRolloutSegments, assertRolloutSetStable } from "../src/rollout-segments.mjs";
import { scanRollout } from "../src/rollout-reader.mjs";

const ID = "01a079a8-eba3-7480-b626-32cae9ec26a9";
const SEGMENT = "01a0a2f9-e6b3-71a3-8793-76394a9c2138";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-segments-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const date = path.join(root, "2026", "09", "29");
  fs.mkdirSync(date, { recursive: true });
  const base = `rollout-2026-09-29T00-00-00-${ID}`;
  const write = (name) => {
    const file = path.join(date, name);
    fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: ID } }) + "\n");
    return fs.realpathSync.native(file);
  };
  return { root, date, base, write };
}

it("discovers only exact original and valid continuation names", (t) => {
  const f = fixture(t);
  const original = f.write(`${f.base}.jsonl`);
  const continued = f.write(`${f.base}_${SEGMENT}.jsonl`);
  for (const name of [`${f.base}_unknown.jsonl`, `${f.base}extra.jsonl`, `${f.base}.jsonl.bak`, `unrelated-${ID}.jsonl`]) f.write(name);
  assert.deepEqual(findRolloutSegments(f.root, ID), [original, continued].sort());
  assert.throws(() => findRolloutSegments(f.root, "../../outside"), /identity is invalid/);
});

it("rejects segment changes and new continuations after the stable snapshot", (t) => {
  const f = fixture(t);
  const file = f.write(`${f.base}.jsonl`);
  const snapshots = [{ file, ...scanRollout(file, { maxRecordBytes: 1024, onRecord() {} }) }];
  assertRolloutSetStable(f.root, ID, snapshots);
  const continued = f.write(`${f.base}_${SEGMENT}.jsonl`);
  assert.throws(() => assertRolloutSetStable(f.root, ID, snapshots), /set changed/);
  fs.unlinkSync(continued);
  fs.appendFileSync(file, "\n");
  assert.throws(() => assertRolloutSetStable(f.root, ID, snapshots), /segment changed/);
});

it("bounds segment discovery and refuses matching directories", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.date, `${f.base}.jsonl`));
  assert.throws(() => findRolloutSegments(f.root, ID), /not a regular file/);
  fs.rmdirSync(path.join(f.date, `${f.base}.jsonl`));
  for (let i = 0; i < 65; i++) f.write(`${f.base}_${i.toString(16).padStart(8, "0")}-e6b3-71a3-8793-76394a9c2138.jsonl`);
  assert.throws(() => findRolloutSegments(f.root, ID), /64-segment/);
});
