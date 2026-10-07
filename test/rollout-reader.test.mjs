import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it } from "node:test";
import { scanRollout } from "../src/rollout-reader.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-reader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout.jsonl");
  return { file, scan: (options = {}) => scanRollout(file, { maxRecordBytes: 1024 * 1024, onRecord: () => {}, ...options }) };
}

it("preserves multibyte UTF-8 and byte offsets across read chunks", (t) => {
  const f = fixture(t);
  const prefix = '{"type":"response_item","payload":{"text":"';
  const first = prefix + "x".repeat(256 * 1024 - Buffer.byteLength(prefix) - 1) + "\u6d4b\u8bd5" + '"}}\n';
  const second = JSON.stringify({ type: "turn_context", payload: { cwd: "project" } }) + "\n";
  fs.writeFileSync(f.file, first + "\n" + second);
  const seen = [];
  const result = f.scan({ onRecord: (record, start, bytes) => seen.push({ record, start, bytes }) });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].record.payload.text.endsWith("\u6d4b\u8bd5"));
  assert.equal(seen[1].start, Buffer.byteLength(first) + 1);
  assert.equal(seen[1].bytes, Buffer.byteLength(second));
  assert.equal(result.size, Buffer.byteLength(first + "\n" + second));
});

it("rejects file growth, truncation, and replacement during a scan", (t) => {
  for (const mutate of [
    file => fs.appendFileSync(file, "\n"),
    file => fs.truncateSync(file, 0),
    file => { const bytes = fs.readFileSync(file); fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, bytes); },
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.file, JSON.stringify({ type: "session_meta", payload: { id: "test" } }) + "\n");
    assert.throws(() => f.scan({ onRecord: () => mutate(f.file) }), /changed while reading/);
  }
});

it("distinguishes empty files, incomplete records, invalid UTF-8 and record-size limits", (t) => {
  const f = fixture(t);
  for (const [bytes, pattern] of [
    ["", /empty \(0 bytes\)/],
    ['{"type":"event_msg","payload":{}}', /incomplete final record/],
    [Buffer.from([0xff, 0x0a]), /encoded data/],
    ['{"type":"event_msg","payload":[]}\n', /invalid record/],
  ]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => f.scan(), pattern);
  }
  fs.writeFileSync(f.file, JSON.stringify({ type: "response_item", payload: { text: "x".repeat(300000) } }) + "\n");
  assert.throws(() => f.scan({ maxRecordBytes: 270000 }), /byte 0 exceeds the 270000-byte per-record read limit/);
});

it("rejects a rollout replaced by a FIFO without blocking", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{"type":"event_msg","payload":{}}\n');
  const source = `
    import fs from "node:fs";
    import { execFileSync } from "node:child_process";
    import { scanRollout } from ${JSON.stringify(new URL("../src/rollout-reader.mjs", import.meta.url).href)};
    const file = process.argv[1];
    const original = fs.openSync;
    fs.openSync = (candidate, ...args) => {
      if (candidate === file) {
        fs.unlinkSync(file);
        execFileSync("mkfifo", [file]);
      }
      return original(candidate, ...args);
    };
    try {
      scanRollout(file, { maxRecordBytes: 1024, onRecord() {} });
      process.exitCode = 2;
    } catch (error) {
      if (!/regular file/.test(error.message)) throw error;
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source, f.file], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

it("rejects a nonregular opened descriptor before reading any records", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{"type":"event_msg","payload":{}}\n');
  const original = fs.fstatSync;
  let records = 0;
  fs.fstatSync = (...args) => {
    const stat = original(...args);
    stat.isFile = () => false;
    return stat;
  };
  try {
    assert.throws(() => f.scan({ onRecord: () => records++ }), /regular file/);
    assert.equal(records, 0);
  } finally { fs.fstatSync = original; }
});
