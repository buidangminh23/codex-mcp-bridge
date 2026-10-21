import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { it } from "node:test";
import { findRolloutSegments, assertRolloutSetStable, retryRolloutRead, isTransientRolloutRead } from "../src/rollout-segments.mjs";
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

it("describes a missing rollout discovery without disclosing paths or unrelated task IDs", (t) => {
  const f = fixture(t);
  f.write(`rollout-private-unrelated-${SEGMENT}.jsonl`);
  assert.throws(() => findRolloutSegments(f.root, ID), (error) => {
    assert.match(error.message, /No rollout file \(plain \.jsonl or compressed \.jsonl\.zst\) matches the Codex task \[check=rollout_discovery; directoriesScanned=4; entriesScanned=4/);
    assert.match(error.message, /layout=sessions\/YYYY\/MM\/DD\/rollout-\*-taskId\[_continuationId\]\.jsonl\[\.zst\]/);
    assert.doesNotMatch(error.message, /calling/);
    for (const secret of [f.root, ID, SEGMENT, "private-unrelated"]) assert.ok(!error.message.includes(secret));
    return true;
  });
});

it("bounds segment discovery and refuses matching directories", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.date, `${f.base}.jsonl`));
  assert.throws(() => findRolloutSegments(f.root, ID), /not a regular file/);
  fs.rmdirSync(path.join(f.date, `${f.base}.jsonl`));
  for (let i = 0; i < 65; i++) f.write(`${f.base}_${i.toString(16).padStart(8, "0")}-e6b3-71a3-8793-76394a9c2138.jsonl`);
  assert.throws(() => findRolloutSegments(f.root, ID), /64-segment/);
});

it("retries only transient rollout reads, within a fixed bound", () => {
  let calls = 0;
  assert.equal(retryRolloutRead(() => { if (++calls < 3) throw new Error("The rollout changed while reading"); return "stable"; }), "stable");
  assert.equal(calls, 3);
  calls = 0;
  assert.throws(() => retryRolloutRead(() => { calls++; throw new Error("A rollout segment changed while reading"); }), /segment changed while reading/);
  assert.equal(calls, 3);
  for (const message of ["The selected native task rollout identity changed after dispatch", "The pre-send Codex rollout history changed after dispatch", "The Codex task identity is invalid"]) {
    calls = 0;
    assert.throws(() => retryRolloutRead(() => { calls++; throw new Error(message); }), (error) => error.message === message);
    assert.equal(calls, 1, message);
    assert.equal(isTransientRolloutRead(message), false, message);
  }
  for (const message of ["The rollout segment set changed while reading", "The Codex rollout changed while opening", "The rollout has an incomplete final record"]) {
    assert.equal(isTransientRolloutRead(new Error(message)), true, message);
  }
  assert.equal(isTransientRolloutRead(undefined), false);
});

it("discovers compressed segments and prefers the plain file of a segment that exists in both forms", (t) => {
  const f = fixture(t);
  const compressed = f.write(`${f.base}.jsonl.zst`);
  const continued = f.write(`${f.base}_${SEGMENT}.jsonl`);
  f.write(`${f.base}.jsonl.zst.tmp`);
  assert.deepEqual(findRolloutSegments(f.root, ID), [compressed, continued]);
  const plain = f.write(`${f.base}.jsonl`);
  assert.deepEqual(findRolloutSegments(f.root, ID), [plain, continued]);
  const continuedCompressed = f.write(`${f.base}_${SEGMENT}.jsonl.zst`);
  fs.unlinkSync(continued);
  assert.deepEqual(findRolloutSegments(f.root, ID), [plain, continuedCompressed]);
});

it("treats a compressed segment rematerialized as plain JSONL as a transient set change", (t) => {
  const f = fixture(t);
  const bytes = Buffer.from(JSON.stringify({ type: "session_meta", payload: { id: ID } }) + "\n");
  const compressed = path.join(f.date, `${f.base}.jsonl.zst`);
  fs.writeFileSync(compressed, zlib.zstdCompressSync(bytes));
  const file = fs.realpathSync.native(compressed);
  const snapshots = [{ file, ...scanRollout(file, { maxRecordBytes: 1024, onRecord() {} }) }];
  assertRolloutSetStable(f.root, ID, snapshots);
  fs.writeFileSync(path.join(f.date, `${f.base}.jsonl`), bytes);
  fs.unlinkSync(file);
  assert.throws(() => assertRolloutSetStable(f.root, ID, snapshots), (error) => isTransientRolloutRead(error) && /set changed/.test(error.message));
});
