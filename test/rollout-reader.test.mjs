import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { it } from "node:test";
import { scanRollout, readRolloutFirstRecord, memoizeCompressedScan, MAX_DECOMPRESSED_ROLLOUT_BYTES } from "../src/rollout-reader.mjs";

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

function compressedFixture(t, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-reader-zst-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plain = path.join(root, "rollout.jsonl");
  const file = `${plain}.zst`;
  fs.writeFileSync(plain, text);
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text)));
  return { plain, file };
}

function collect(file, options = {}) {
  const records = [], digest = crypto.createHash("sha256");
  const result = scanRollout(file, { maxRecordBytes: 1024 * 1024, onRecord: (record, start, bytes) => records.push({ record, start, bytes }),
    onChunk: (chunk) => digest.update(chunk), ...options });
  return { result, records, sha256: digest.digest("hex") };
}

it("scans a .jsonl.zst rollout with the offsets, size and bytes of its decompressed JSONL", (t) => {
  const row = (index) => JSON.stringify({ type: "response_item", payload: { index, text: "\u6d4b".repeat(50000) } }) + "\n";
  const text = Array.from({ length: 12 }, (_, index) => row(index)).join("");
  const f = compressedFixture(t, text);
  const plain = collect(f.plain);
  const compressed = collect(f.file, { maxRecordBytes: 200000 });
  assert.deepEqual(compressed.records, plain.records);
  assert.equal(compressed.sha256, plain.sha256);
  assert.equal(compressed.result.size, Buffer.byteLength(text));
  assert.ok(compressed.result.size > 200000 * 8);
  assert.equal(compressed.result.compressed, true);
  assert.equal(compressed.result.storedSize, fs.statSync(f.file).size);
  assert.equal(plain.result.compressed, false);
});

it("explains compressed rollout failures with distinct check codes", (t) => {
  const f = compressedFixture(t, JSON.stringify({ type: "session_meta", payload: { id: "test", text: "x".repeat(4000) } }) + "\n");
  assert.throws(() => collect(f.file, { zstdDecompress: null }), /requires Node\.js with zstd support.*check=rollout_zstd_unsupported/);
  assert.throws(() => collect(f.file, { maxDecompressedBytes: 1000 }), /expands beyond the 1000-byte decompression limit \[check=rollout_zstd_limit\]/);
  assert.throws(() => collect(f.file, { maxDecompressedBytes: 4 }), /exceeds the 4-byte decompression limit \[check=rollout_zstd_limit\]/);
  fs.writeFileSync(f.file, "not a zstd frame");
  assert.throws(() => collect(f.file), /could not be decompressed.*check=rollout_zstd_invalid/);
  fs.writeFileSync(f.file, zlib.zstdCompressSync(Buffer.from('{"type":"event_msg","payload":{}}')));
  assert.throws(() => collect(f.file), /incomplete final record/);
  assert.equal(MAX_DECOMPRESSED_ROLLOUT_BYTES, 256 * 1024 * 1024);
});

it("reads only the first record of plain and compressed rollouts", async (t) => {
  const first = { type: "session_meta", payload: { id: "test", originator: "codex_vscode" } };
  const text = JSON.stringify(first) + "\n" + (JSON.stringify({ type: "response_item", payload: { text: "x".repeat(4096) } }) + "\n").repeat(512);
  const f = compressedFixture(t, text);
  assert.deepEqual(await readRolloutFirstRecord(f.plain), first);
  assert.deepEqual(await readRolloutFirstRecord(f.file), first);
  await assert.rejects(readRolloutFirstRecord(f.file, { createZstdDecompress: null }), /check=rollout_zstd_unsupported/);
  await assert.rejects(readRolloutFirstRecord(f.file, { maxBytes: 16 }), /first record is incomplete/);
});

it("reports a compressed rollout removed during the scan as a pathless transient change", (t) => {
  const f = compressedFixture(t, JSON.stringify({ type: "session_meta", payload: { id: "test" } }) + "\n");
  assert.throws(() => collect(f.file, { zstdDecompress: (stored, options) => {
    fs.unlinkSync(f.file);
    return zlib.zstdDecompressSync(stored, options);
  } }), (error) => {
    assert.equal(error.message, "The rollout changed while reading");
    assert.ok(!error.message.includes(f.file));
    return true;
  });
  assert.throws(() => collect(f.file), /^Error: The rollout changed while reading$/);
});

it("rejects without an uncaught exception when the compressed rollout disappears before it is opened", { timeout: 5000 }, async (t) => {
  const f = compressedFixture(t, JSON.stringify({ type: "session_meta", payload: { id: "test" } }) + "\n");
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (file, ...rest) => {
    const status = lstat.call(fs, file, ...rest);
    if (file === f.file) fs.unlinkSync(f.file);
    return status;
  });
  const uncaught = [];
  const record = (error) => uncaught.push(error);
  process.on("uncaughtException", record);
  t.after(() => process.off("uncaughtException", record));
  await assert.rejects(readRolloutFirstRecord(f.file), { code: "ENOENT" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
});

it("reuses the scan of an unchanged compressed rollout and rescans after it changes", (t) => {
  const f = compressedFixture(t, JSON.stringify({ type: "session_meta", payload: { id: "test" } }) + "\n");
  let scans = 0;
  const scan = () => { scans++; return collect(f.file).result; };
  const first = memoizeCompressedScan(f.file, "test", scan);
  assert.equal(memoizeCompressedScan(f.file, "test", scan), first);
  assert.equal(scans, 1);
  memoizeCompressedScan(f.file, "other", scan);
  assert.equal(scans, 2);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f.file, later, later);
  assert.notEqual(memoizeCompressedScan(f.file, "test", scan), first);
  assert.equal(scans, 3);
  memoizeCompressedScan(f.file, "skip", scan, { keep: () => false });
  memoizeCompressedScan(f.file, "skip", scan, { keep: () => false });
  assert.equal(scans, 5);
  memoizeCompressedScan(f.plain, "plain", () => { scans++; return collect(f.plain).result; });
  memoizeCompressedScan(f.plain, "plain", () => { scans++; return collect(f.plain).result; });
  assert.equal(scans, 7);
  fs.unlinkSync(f.file);
  assert.throws(() => memoizeCompressedScan(f.file, "test", scan), /^Error: The rollout changed while reading$/);
});

it("does not leak a descriptor or crash when the zstd decompressor cannot be created", async (t) => {
  if (process.platform === "win32" || !fs.existsSync("/dev/fd")) return t.skip("needs /dev/fd");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-head-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "rollout-2026-09-06T19-17-57-00000000-0000-0000-0000-000000000000.jsonl.zst");
  fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "session_meta" })}\n`)));
  const before = fs.readdirSync("/dev/fd").length;
  for (let attempt = 0; attempt < 20; attempt++) {
    await assert.rejects(readRolloutFirstRecord(file, { createZstdDecompress: () => { fs.rmSync(file, { force: true }); throw new Error("init failed"); } }), /init failed/);
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: "session_meta" })}\n`)));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.readdirSync("/dev/fd").length <= before + 1);
});
