import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homeDir } from "./platform.mjs";
import { fileIdentity, sameFileIdentity } from "./file-identity.mjs";

const sameFile = (left, right) => ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"].every(field => left[field] === right[field]);

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
        if (process.platform === "win32") this.#protectWindowsPrivate(this.#keyDirectory, true);
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const directory = fs.lstatSync(this.#keyDirectory, { bigint: true });
    const canonical = fs.realpathSync.native(this.#keyDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        process.platform !== "win32" && ((directory.mode & 0o077n) || directory.uid !== BigInt(process.getuid())) ||
        this.#keyDirectoryBoundary && (this.#keyDirectoryBoundary.path !== canonical || !sameFileIdentity(this.#keyDirectoryBoundary, fileIdentity(directory)))) {
      throw Error("Unsafe native creation authority directory");
    }
    if (process.platform === "win32" && !this.#keyDirectoryBoundary) {
      this.#assertWindowsPrivate(canonical, true);
    }
    this.#keyDirectoryBoundary ??= { path: canonical, ...fileIdentity(directory) };
    const file = path.join(canonical, "signing-key");
    if (create) {
      let created, createdBoundary;
      try {
        created = fs.openSync(file, "wx", 0o600);
        createdBoundary = fs.fstatSync(created, { bigint: true });
        if (process.platform === "win32") this.#protectWindowsPrivate(file, false);
        fs.writeFileSync(created, randomBytes(32));
        fs.fsyncSync(created);
      }
      catch (error) {
        if (created !== undefined) {
          fs.closeSync(created);
          created = undefined;
          const failed = fs.lstatSync(file, { bigint: true });
          if (sameFileIdentity(fileIdentity(failed), fileIdentity(createdBoundary)) && !failed.isSymbolicLink()) fs.unlinkSync(file);
        }
        if (error.code !== "EEXIST") throw error;
      }
      finally { if (created !== undefined) fs.closeSync(created); }
    }
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== 32n ||
        process.platform !== "win32" && ((before.mode & 0o077n) || before.uid !== BigInt(process.getuid()))) throw Error("Unsafe native creation signing key");
    if (process.platform === "win32" && !this.#keyBoundary) this.#assertWindowsPrivate(file, false);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    let key;
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameFile(before, opened)) throw Error("Native creation signing key changed");
      const bytes = Buffer.alloc(33);
      let count = 0, read;
      while (count < bytes.length && (read = fs.readSync(fd, bytes, count, bytes.length - count, count))) count += read;
      key = bytes.subarray(0, count);
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(file, { bigint: true });
      if (key.length !== 32 || current.isSymbolicLink() || !sameFile(opened, after) || !sameFile(after, current)) throw Error("Native creation signing key changed");
    } finally { fs.closeSync(fd); }
    if (this.#keyBoundary && (!sameFileIdentity(this.#keyBoundary, fileIdentity(before)) || !timingSafeEqual(this.#key, key))) throw Error("Native creation signing key changed");
    this.#keyBoundary ??= fileIdentity(before);
    this.#key ??= key;
    return this.#key;
  }
  #protectWindowsPrivate(file, directory) {
    const encodedPath = Buffer.from(file, "utf8").toString("base64");
    const securityType = directory ? "DirectorySecurity" : "FileSecurity";
    const inheritance = directory ? "ContainerInherit,ObjectInherit" : "None";
    const script = `$ErrorActionPreference='Stop';$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.${securityType};$a.SetOwner($s);$a.SetAccessRuleProtection($true,$false);$r=New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','${inheritance}','None','Allow');$a.AddAccessRule($r);Set-Acl -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))) -AclObject $a`;
    this.#runWindowsAclScript(script);
  }
  #assertWindowsPrivate(file, directory) {
    const encodedPath = Buffer.from(file, "utf8").toString("base64");
    const script = `$ErrorActionPreference='Stop';$a=Get-Acl -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')));$s=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;if(${directory ? "$true" : "$false"} -and !$a.AreAccessRulesProtected){throw 'Unprotected native authority'};if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s){throw 'Unexpected native authority owner'};foreach($r in $a.Access){if($r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $s -or $r.AccessControlType -ne 'Allow'){throw 'Unexpected native authority access'}};if($a.Access.Count -ne 1){throw 'Ambiguous native authority access'}`;
    this.#runWindowsAclScript(script);
  }
  #runWindowsAclScript(script) {
    const shellDirectory = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
    env.PSModulePath = path.win32.join(shellDirectory, "Modules");
    execFileSync(path.win32.join(shellDirectory, "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env, stdio: "pipe", windowsHide: true, timeout: 10000 });
  }
  #signature(row, create = false) {
    const { signature, ...payload } = row;
    return createHmac("sha256", this.#signingKey(create)).update("native-creation-receipt-v1\0").update(creationRequestHash(payload)).digest("hex");
  }
  file(id) {
    if (!creationIdValid(id)) throw Error("Invalid native creation receipt id");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(this.directory, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Unsafe native creation receipt directory");
    const canonical = fs.realpathSync.native(this.directory);
    if (this.boundary && (this.boundary.path !== canonical || !sameFileIdentity(this.boundary, fileIdentity(st)))) throw Error("Native creation receipt directory changed");
    this.boundary ??= { path: canonical, ...fileIdentity(st) };
    this.directory = canonical;
    return path.join(canonical, id + ".json");
  }
  read(id, accounts, hash) {
    const file = this.file(id);
    let fd, receiptFound = false;
    try {
      const before = fs.lstatSync(file, { bigint: true });
      receiptFound = true;
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n * 1024n) throw Error("Unsafe native creation receipt");
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameFile(before, opened)) throw Error("Native creation receipt changed");
      const bytes = Buffer.alloc(1024 * 1024 + 1);
      let count = 0, n;
      while ((n = fs.readSync(fd, bytes, count, bytes.length - count, count))) { count += n; if (count > 1024 * 1024) throw Error("Oversized native creation receipt"); }
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(this.file(id), { bigint: true });
      if (current.isSymbolicLink() || !sameFile(opened, after) || !sameFile(after, current) || BigInt(count) !== opened.size) throw Error("Native creation receipt changed");
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
