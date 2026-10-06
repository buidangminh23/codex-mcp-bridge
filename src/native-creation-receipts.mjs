import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  #key;
  #keyBoundary;
  #keyDirectoryBoundary;
  #keyDirectory;
  constructor({ directory = path.join(process.env.CODEX_HOME ?? path.join(homeDir(), ".codex"), "bridge-native-creations") } = {}) {
    this.directory = path.resolve(directory);
    this.#keyDirectory = path.join(path.dirname(this.directory), "bridge-native-creation-authority");
  }
  #signingKey(create = false) {
    if (create) {
      try {
        fs.mkdirSync(this.#keyDirectory, { mode: 0o700 });
        if (process.platform === "win32") {
          const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
          const sid = identity.match(/S-1-5-[0-9-]+/)?.[0];
          if (!sid) throw Error("Native creation authority owner could not be verified");
          execFileSync("icacls.exe", [this.#keyDirectory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)(F)`], { stdio: "pipe", windowsHide: true });
        }
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const directory = fs.lstatSync(this.#keyDirectory);
    const canonical = fs.realpathSync.native(this.#keyDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        process.platform !== "win32" && ((directory.mode & 0o077) || directory.uid !== process.getuid()) ||
        this.#keyDirectoryBoundary && (this.#keyDirectoryBoundary.path !== canonical || this.#keyDirectoryBoundary.dev !== directory.dev || this.#keyDirectoryBoundary.ino !== directory.ino)) {
      throw Error("Unsafe native creation authority directory");
    }
    if (process.platform === "win32" && !this.#keyDirectoryBoundary) {
      this.#assertWindowsPrivate(canonical, true);
    }
    this.#keyDirectoryBoundary ??= { path: canonical, dev: directory.dev, ino: directory.ino };
    const file = path.join(canonical, "signing-key");
    if (create) {
      let created;
      try { created = fs.openSync(file, "wx", 0o600); fs.writeFileSync(created, randomBytes(32)); fs.fsyncSync(created); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      finally { if (created !== undefined) fs.closeSync(created); }
    }
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== 32 ||
        process.platform !== "win32" && ((before.mode & 0o077) || before.uid !== process.getuid())) throw Error("Unsafe native creation signing key");
    if (process.platform === "win32" && !this.#keyBoundary) this.#assertWindowsPrivate(file, false);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let key;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== before.dev || opened.ino !== before.ino) throw Error("Native creation signing key changed");
      const bytes = Buffer.alloc(33);
      let count = 0, read;
      while (count < bytes.length && (read = fs.readSync(fd, bytes, count, bytes.length - count, count))) count += read;
      key = bytes.subarray(0, count);
      const after = fs.fstatSync(fd);
      if (key.length !== 32 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Error("Native creation signing key changed");
    } finally { fs.closeSync(fd); }
    if (this.#keyBoundary && (this.#keyBoundary.dev !== before.dev || this.#keyBoundary.ino !== before.ino || !timingSafeEqual(this.#key, key))) throw Error("Native creation signing key changed");
    this.#keyBoundary ??= { dev: before.dev, ino: before.ino };
    this.#key ??= key;
    return this.#key;
  }
  #assertWindowsPrivate(file, directory) {
    const quoted = file.replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath '${quoted}';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;if(${directory ? "$true" : "$false"} -and !$a.AreAccessRulesProtected){throw 'Unprotected native authority'};if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s){throw 'Unexpected native authority owner'};foreach($r in $a.Access){if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $s -or $r.AccessControlType -ne 'Allow'){throw 'Unexpected native authority access'}};if($a.Access.Count -ne 1){throw 'Ambiguous native authority access'}`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "pipe", windowsHide: true, timeout: 10000 });
  }
  #signature(row, create = false) {
    const { signature, ...payload } = row;
    return createHmac("sha256", this.#signingKey(create)).update("native-creation-receipt-v1\0").update(creationRequestHash(payload)).digest("hex");
  }
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
    let fd, receiptFound = false;
    try {
      const before = fs.lstatSync(file);
      receiptFound = true;
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
      if (typeof row.signature !== "string" || !/^[a-f0-9]{64}$/.test(row.signature) ||
          !timingSafeEqual(Buffer.from(row.signature, "hex"), Buffer.from(this.#signature(row), "hex"))) throw Error("Native creation receipt signature is invalid; ownership recovery is blocked");
      return row;
    } catch (e) { if (e.code === "ENOENT" && !receiptFound) return null; throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  reserve(id, args, accounts, executorThreadId) {
    const row = { version: 1, id, hash: creationRequestHash(args), args, accounts, executorThreadId, state: "pending" };
    this.write(row, true); return row;
  }
  write(row, exclusive = false) {
    const file = this.file(row.id), tmp = exclusive ? file : file + "." + randomUUID() + ".pending";
    const bytes = JSON.stringify({ ...row, signature: this.#signature(row, exclusive) });
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw Error("Oversized native creation receipt");
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!exclusive) fs.renameSync(tmp, file);
  }
}
