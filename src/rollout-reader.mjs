import fs from "node:fs";
import zlib from "node:zlib";
import { fileIdentity } from "./file-identity.mjs";

const CHUNK_BYTES = 256 * 1024;
const COMPRESSED_SUFFIX = ".zst";
const VERSION_FIELDS = ["size", "mtimeNs", "ctimeNs", "ino", "dev"];
const sameVersion = (a, b) => VERSION_FIELDS.every((key) => a[key] === b[key]);
const versionKey = (version) => VERSION_FIELDS.map((key) => String(version[key])).join(":");
const VANISHED_CODES = new Set(["ENOENT", "ENOTDIR"]);
const COMPRESSED_SCAN_CACHE_ENTRIES = 16;
const compressedScans = new Map();

export const MAX_DECOMPRESSED_ROLLOUT_BYTES = 256 * 1024 * 1024;

export function isCompressedRollout(file) {
  return typeof file === "string" && file.endsWith(`.jsonl${COMPRESSED_SUFFIX}`);
}

export function rolloutBasePath(file) {
  return isCompressedRollout(file) ? file.slice(0, -COMPRESSED_SUFFIX.length) : file;
}

export function asRolloutChange(error, message = "The rollout changed while reading") {
  return VANISHED_CODES.has(error?.code) ? new Error(message) : error;
}

function zstdUnsupported() {
  return new Error(`Reading a compressed Codex rollout (.jsonl.zst) requires Node.js with zstd support (22.15+ or 23.8+); this runtime is ${process.version} [check=rollout_zstd_unsupported]`);
}

function recordParser(size, { maxRecordBytes, onRecord, onChunk }) {
  let parts = [], length = 0, start = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return {
    push(chunk, position) {
      const count = chunk.length;
      onChunk(chunk, position);
      let offset = 0;
      while (offset < count) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? count : newline;
        length += end - offset;
        if (length > maxRecordBytes) throw new Error(`The rollout record at byte ${start} exceeds the ${maxRecordBytes}-byte per-record read limit (file: ${size} bytes)`);
        parts.push(chunk.subarray(offset, end));
        if (newline < 0) break;
        if (length) {
          const record = JSON.parse(decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts, length)));
          if (!record || typeof record !== "object" || Array.isArray(record) || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
            throw new Error("The rollout contains an invalid record");
          }
          onRecord(record, start, position + newline + 1 - start);
        }
        parts = []; length = 0;
        offset = newline + 1;
        start = position + offset;
      }
    },
    finish() {
      if (start !== size) throw new Error("The rollout has an incomplete final record");
    },
  };
}

function readExactly(descriptor, size) {
  const buffer = Buffer.allocUnsafe(size);
  for (let position = 0; position < size;) {
    const count = fs.readSync(descriptor, buffer, position, size - position, position);
    if (!count) throw new Error("The rollout changed while reading");
    position += count;
  }
  return buffer;
}

function decompressRollout(descriptor, storedSize, { zstdDecompress, maxDecompressedBytes }) {
  if (storedSize > maxDecompressedBytes) throw new Error(`The compressed rollout exceeds the ${maxDecompressedBytes}-byte decompression limit [check=rollout_zstd_limit]`);
  const stored = readExactly(descriptor, storedSize);
  try {
    return zstdDecompress(stored, { maxOutputLength: maxDecompressedBytes });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") throw new Error(`The compressed rollout expands beyond the ${maxDecompressedBytes}-byte decompression limit [check=rollout_zstd_limit]`);
    throw new Error(`The compressed rollout could not be decompressed (${error?.code ?? "invalid data"}) [check=rollout_zstd_invalid]`);
  }
}

function scanContent(descriptor, size, parser) {
  for (let position = 0; position < size;) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - position));
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (!count) throw new Error("The rollout changed while reading");
    parser.push(buffer.subarray(0, count), position);
    position += count;
  }
}

async function readHead(file, maxBytes, createZstdDecompress) {
  if (!isCompressedRollout(file)) {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const buffer = Buffer.alloc(maxBytes);
      return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, maxBytes, 0));
    } finally { fs.closeSync(descriptor); }
  }
  if (typeof createZstdDecompress !== "function") throw zstdUnsupported();
  const source = fs.createReadStream(file, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0) });
  const stream = source.pipe(createZstdDecompress());
  source.on("error", (error) => stream.destroy(error));
  const parts = [];
  let length = 0;
  try {
    for await (const chunk of stream) {
      parts.push(chunk);
      length += chunk.length;
      if (length >= maxBytes || chunk.includes(0x0a)) break;
    }
  } finally {
    source.destroy();
    stream.destroy();
  }
  return Buffer.concat(parts, length).subarray(0, maxBytes);
}

export async function readRolloutFirstRecord(file, { maxBytes = 64 * 1024, createZstdDecompress = zlib.createZstdDecompress } = {}) {
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink()) throw new Error("The rollout is not a regular file");
  const head = await readHead(file, maxBytes, createZstdDecompress);
  const newline = head.indexOf(0x0a);
  if (newline < 0) throw new Error("The rollout's first record is incomplete or exceeds its read limit");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, newline)));
}

// Scan the complete history, but retain at most one bounded JSONL record.
// Skipping the middle of a rollout would miss duplicate identities or corruption.
export function scanRollout(file, options) {
  try {
    return scanRolloutOnce(file, options);
  } catch (error) {
    throw asRolloutChange(error);
  }
}

export function memoizeCompressedScan(file, key, scan, { keep = () => true } = {}) {
  if (!isCompressedRollout(file)) return scan();
  let named;
  try { named = fs.lstatSync(file, { bigint: true }); }
  catch (error) { throw asRolloutChange(error); }
  const entry = `${file}\0${key}`;
  const cached = compressedScans.get(entry);
  compressedScans.delete(entry);
  if (cached?.version === versionKey(named)) {
    compressedScans.set(entry, cached);
    return cached.value;
  }
  const value = scan();
  if (versionKey(value.version) === versionKey(named) && keep(value)) {
    compressedScans.set(entry, { version: versionKey(named), value });
    if (compressedScans.size > COMPRESSED_SCAN_CACHE_ENTRIES) compressedScans.delete(compressedScans.keys().next().value);
  }
  return value;
}

function scanRolloutOnce(file, { maxRecordBytes, onRecord, onChunk = () => {}, zstdDecompress = zlib.zstdDecompressSync, maxDecompressedBytes = MAX_DECOMPRESSED_ROLLOUT_BYTES }) {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new Error("The rollout record read limit is invalid");
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes < 1) throw new Error("The rollout decompression limit is invalid");
  const compressed = isCompressedRollout(file);
  if (compressed && typeof zstdDecompress !== "function") throw zstdUnsupported();
  const named = fs.lstatSync(file, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink()) throw new Error("The rollout is not a regular file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("The opened rollout is not a regular file");
    if (!sameVersion(named, before)) throw new Error("The rollout changed while opening");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("The rollout exceeds the safe size range");
    const storedSize = Number(before.size);
    if (storedSize === 0) throw new Error("The rollout is empty (0 bytes)");
    const content = compressed ? decompressRollout(descriptor, storedSize, { zstdDecompress, maxDecompressedBytes }) : null;
    const size = content ? content.length : storedSize;
    if (size === 0) throw new Error("The rollout is empty (0 bytes)");
    const parser = recordParser(size, { maxRecordBytes, onRecord, onChunk });
    if (content) {
      for (let position = 0; position < size; position += CHUNK_BYTES) parser.push(content.subarray(position, Math.min(size, position + CHUNK_BYTES)), position);
    } else {
      scanContent(descriptor, size, parser);
    }
    parser.finish();
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameVersion(before, after) || !sameVersion(after, current)) {
      throw new Error("The rollout changed while reading");
    }
    return { size, storedSize, compressed, identity: fileIdentity(before),
      version: Object.fromEntries(VERSION_FIELDS.map((key) => [key, String(before[key])])) };
  } finally {
    fs.closeSync(descriptor);
  }
}
