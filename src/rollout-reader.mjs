import fs from "node:fs";

const CHUNK_BYTES = 256 * 1024;
const VERSION_FIELDS = ["size", "mtimeMs", "ctimeMs", "ino", "dev"];
const sameVersion = (a, b) => VERSION_FIELDS.every((key) => a[key] === b[key]);

// Scan the complete history, but retain at most one bounded JSONL record.
// Skipping the middle of a rollout would miss duplicate identities or corruption.
export function scanRollout(file, { maxRecordBytes, onRecord, onChunk = () => {} }) {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new Error("The rollout record read limit is invalid");
  const named = fs.lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink()) throw new Error("The rollout is not a regular file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error("The opened rollout is not a regular file");
    if (!sameVersion(named, before)) throw new Error("The rollout changed while opening");
    if (before.size === 0) throw new Error("The rollout is empty (0 bytes)");
    let parts = [], length = 0, start = 0, position = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (position < before.size) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, before.size - position));
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (!count) throw new Error("The rollout changed while reading");
      const chunk = buffer.subarray(0, count);
      onChunk(chunk, position);
      let offset = 0;
      while (offset < count) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline < 0 ? count : newline;
        length += end - offset;
        if (length > maxRecordBytes) throw new Error(`The rollout record at byte ${start} exceeds the ${maxRecordBytes}-byte per-record read limit (file: ${before.size} bytes)`);
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
      position += count;
    }
    if (start !== before.size) throw new Error("The rollout has an incomplete final record");
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || !sameVersion(before, after) || !sameVersion(after, current)) {
      throw new Error("The rollout changed while reading");
    }
    return { size: before.size, identity: { dev: before.dev, ino: before.ino },
      version: Object.fromEntries(VERSION_FIELDS.map((key) => [key, before[key]])) };
  } finally {
    fs.closeSync(descriptor);
  }
}
