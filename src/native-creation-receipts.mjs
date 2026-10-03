import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homeDir } from "./platform.mjs";

export const creationIdValid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function creationRequestHash(args) {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
}

// Stores only exact native creation requests and their results. A missing or
// pending receipt never permits dispatch again, including after a restart.
export class NativeCreationReceipts {
  constructor({ directory = path.join(process.env.CODEX_HOME ?? path.join(homeDir(), ".codex"), "bridge-native-creations") } = {}) { this.directory = path.resolve(directory); }
  file(id) {
    if (!creationIdValid(id)) throw Error("Invalid native creation receipt id");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(this.directory);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Unsafe native creation receipt directory");
    const canonical = fs.realpathSync.native(this.directory);
    if (this.boundary && (this.boundary.path !== canonical || this.boundary.dev !== st.dev || this.boundary.ino !== st.ino)) throw Error("Native creation receipt directory changed");
    this.boundary ??= { path: canonical, dev: st.dev, ino: st.ino };
    this.directory = canonical;
    return path.join(canonical, id + ".json");
  }
  read(id, accounts, hash) {
    const file = this.file(id);
    let fd;
    try {
      const before = fs.lstatSync(file);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) throw Error("Unsafe native creation receipt");
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(fd);
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw Error("Native creation receipt changed");
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let count = 0, n;
      while ((n = fs.readSync(fd, bytes, count, bytes.length - count, count))) { count += n; if (count > 1024 * 1024) throw Error("Oversized native creation receipt"); }
      const after = fs.fstatSync(fd);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || count !== opened.size) throw Error("Native creation receipt changed");
      const row = JSON.parse(bytes.subarray(0, count).toString());
      if (row.version !== 1 || row.id !== id || row.hash !== hash || creationRequestHash(row.args) !== hash ||
          !accounts || ["claude", "codex"].some(k => !accounts[k] || row.accounts?.[k] !== accounts[k]) ||
          typeof row.executorThreadId !== "string" || !["pending", "completed", "failed"].includes(row.state)) throw Error("Native creation receipt binding mismatch");
      return row;
    } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  reserve(id, args, accounts, executorThreadId) {
    const row = { version: 1, id, hash: creationRequestHash(args), args, accounts, executorThreadId, state: "pending" };
    this.write(row, true); return row;
  }
  write(row, exclusive = false) {
    const file = this.file(row.id), tmp = exclusive ? file : file + "." + randomUUID() + ".pending";
    const bytes = JSON.stringify(row);
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error("Oversized native creation receipt");
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!exclusive) fs.renameSync(tmp, file);
  }
}
