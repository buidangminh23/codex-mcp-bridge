import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function digestFiles(root, files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
  return hash.digest("hex");
}

const DIGEST_FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function safeRelativePath(file) {
  return typeof file === "string" && file.length > 0 && !file.includes("\0")
    && !path.posix.isAbsolute(file) && !path.win32.parse(file).root
    && path.normalize(file) === file && !file.split(/[\\/]/).some((part) => !part || part === "." || part === "..");
}

function digestMetadata(cache) {
  const directories = new Map();
  const dirty = new Set();
  const metadataPath = (directory) => path.join(cache, `.digests-${createHash("sha256").update(directory).digest("hex")}.json`);
  const signature = (stat) => Object.fromEntries(DIGEST_FIELDS.map((field) => [field, String(stat[field])]));
  const matches = (left, right) => left && DIGEST_FIELDS.every((field) => left[field] === right[field]);
  const load = (directory) => {
    dirty.add(directory);
    let descriptor;
    try {
      const file = metadataPath(directory);
      const info = fs.lstatSync(file, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > 32n * 1024n * 1024n) return new Map();
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !matches(signature(info), signature(opened))) return new Map();
      const metadata = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      if (metadata?.schema !== 1 || metadata.directory !== directory || !metadata.files || typeof metadata.files !== "object" || Array.isArray(metadata.files)) return new Map();
      const entries = Object.entries(metadata.files);
      if (entries.some(([file, record]) => !safeRelativePath(file) || !record || typeof record !== "object" || Array.isArray(record)
        || typeof record.hash !== "string" || !DIGEST_PATTERN.test(record.hash)
        || DIGEST_FIELDS.some((field) => typeof record[field] !== "string" || !/^-?\d+$/.test(record[field])))) return new Map();
      dirty.delete(directory);
      return new Map(entries);
    } catch {
      return new Map();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  };
  return {
    digest(directory, files) {
      const previous = directories.get(directory) ?? load(directory);
      const records = new Map();
      const hash = createHash("sha256");
      if (previous.size !== files.length) dirty.add(directory);
      for (const file of files) {
        if (!safeRelativePath(file)) throw new Error(`Unsafe release file: ${file}`);
        const fullPath = path.join(directory, file);
        const before = fs.statSync(fullPath, { bigint: true });
        if (!before.isFile()) throw new Error(`Unsupported release file: ${file}`);
        const current = signature(before);
        let record = previous.get(file);
        if (!matches(record, current)) {
          dirty.add(directory);
          const contentHash = createHash("sha256").update(fs.readFileSync(fullPath)).digest("hex");
          const after = fs.statSync(fullPath, { bigint: true });
          if (!after.isFile() || !matches(current, signature(after))) throw new Error("A release file changed during integrity verification");
          record = { ...current, hash: contentHash };
        }
        records.set(file, record);
        hash.update(file).update("\0").update(record.hash).update("\0");
      }
      directories.set(directory, records);
      return hash.digest("hex");
    },
    relocate(from, to) {
      if (directories.has(from)) {
        directories.set(to, directories.get(from));
        dirty.add(to);
      }
      directories.delete(from);
      dirty.delete(from);
    },
    forget(directory) { directories.delete(directory); dirty.delete(directory); },
    flush() {
      for (const [directory, records] of directories) {
        if (!dirty.has(directory)) continue;
        const file = metadataPath(directory);
        const temporary = path.join(cache, `.digests-${process.pid}-${randomUUID()}.tmp`);
        try {
          try {
            const info = fs.lstatSync(file);
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) continue;
          } catch (error) { if (error.code !== "ENOENT") continue; }
          fs.writeFileSync(temporary, JSON.stringify({ schema: 1, directory, files: Object.fromEntries(records) }), { flag: "wx", mode: 0o600 });
          fs.renameSync(temporary, file);
          dirty.delete(directory);
        } catch {
        } finally {
          try { fs.rmSync(temporary, { force: true }); } catch {}
        }
      }
    },
  };
}

function inventory(root, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === ".bin") continue;
    const relative = path.join(prefix, entry.name);
    const stat = entry.isSymbolicLink() ? fs.statSync(path.join(root, relative)) : entry;
    if (stat.isDirectory()) files.push(...inventory(root, relative));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`Unsupported release file: ${relative}`);
  }
  return files;
}

export function sourceRevision(root) {
  const files = ["package.json", ...inventory(root, "src")];
  for (const file of ["package-lock.json", "node_modules/.package-lock.json"]) {
    if (fs.existsSync(path.join(root, file))) files.push(file);
  }
  return digestFiles(root, files);
}

export function snapshotRoot(env = process.env) {
  return path.resolve(env.CODEX_BRIDGE_RUNTIME_CACHE ?? path.join(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "bridge-runtimes"));
}

function removeOwned(directory, cache) {
  const relative = path.relative(cache, directory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to remove an unowned runtime directory");
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error("Refusing to remove a linked runtime directory");
  fs.rmSync(directory, { recursive: true, force: true });
}

export function createReleaseSnapshot(root, { cache = snapshotRoot(), expectedRevision = sourceRevision(root) } = {}) {
  root = fs.realpathSync.native(root);
  if (fs.existsSync(cache) && fs.lstatSync(cache).isSymbolicLink()) throw new Error("The runtime cache cannot be a symbolic link");
  const missing = [];
  let ancestor = path.resolve(cache);
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("The runtime cache has no accessible filesystem root");
    ancestor = parent;
  }
  cache = path.join(fs.realpathSync.native(ancestor), ...missing);
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error("The runtime cache cannot be a symbolic link");
  cache = fs.realpathSync.native(cache);
  const metadata = digestMetadata(cache);
  const dependencies = inventory(root, "node_modules");
  const dependencyRevision = metadata.digest(root, dependencies);
  const key = createHash("sha256").update(expectedRevision).update(dependencyRevision).digest("hex");
  const target = path.join(cache, key);
  const validate = (directory) => {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("The release directory cannot be a symbolic link");
    return sourceRevision(directory) === expectedRevision && metadata.digest(directory, inventory(directory, "node_modules")) === dependencyRevision;
  };
  if (fs.existsSync(target)) {
    if (!validate(target)) throw new Error("An existing immutable runtime failed integrity verification");
    if (sourceRevision(root) !== expectedRevision) throw new Error("The installation changed during snapshot verification");
    metadata.flush();
    return { directory: target, revision: expectedRevision, key };
  }
  const temporary = path.join(cache, `.preparing-${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(temporary, { mode: 0o700 });
    const files = ["package.json", ...inventory(root, "src"), ...dependencies];
    if (fs.existsSync(path.join(root, "package-lock.json"))) files.push("package-lock.json");
    const directories = new Set(["src", "node_modules", ...files.map((file) => path.dirname(file))]);
    for (const directory of directories) fs.mkdirSync(path.join(temporary, directory), { recursive: true, mode: 0o700 });
    for (const file of files) {
      fs.copyFileSync(path.join(root, file), path.join(temporary, file), fs.constants.COPYFILE_FICLONE);
    }
    if (sourceRevision(root) !== expectedRevision || metadata.digest(root, inventory(root, "node_modules")) !== dependencyRevision || !validate(temporary)) {
      throw new Error("The installation changed while its immutable runtime was being prepared");
    }
    try {
      fs.renameSync(temporary, target);
      metadata.relocate(temporary, target);
    }
    catch (error) {
      if (!fs.existsSync(target) || !validate(target)) throw error;
      removeOwned(temporary, cache);
      metadata.forget(temporary);
    }
    metadata.flush();
    return { directory: target, revision: expectedRevision, key };
  } catch (error) {
    removeOwned(temporary, cache);
    throw error;
  }
}
