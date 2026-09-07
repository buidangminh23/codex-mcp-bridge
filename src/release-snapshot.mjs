import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function digestFiles(root, files) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(fs.readFileSync(path.join(root, file))).update("\0");
  return hash.digest("hex");
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
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(cache).isSymbolicLink()) throw new Error("The runtime cache cannot be a symbolic link");
  const dependencies = inventory(root, "node_modules");
  const dependencyRevision = digestFiles(root, dependencies);
  const key = createHash("sha256").update(expectedRevision).update(dependencyRevision).digest("hex");
  const target = path.join(cache, key);
  const validate = (directory) => {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("The release directory cannot be a symbolic link");
    return sourceRevision(directory) === expectedRevision && digestFiles(directory, inventory(directory, "node_modules")) === dependencyRevision;
  };
  if (fs.existsSync(target)) {
    if (!validate(target)) throw new Error("An existing immutable runtime failed integrity verification");
    if (sourceRevision(root) !== expectedRevision) throw new Error("The installation changed during snapshot verification");
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
    if (sourceRevision(root) !== expectedRevision || digestFiles(root, inventory(root, "node_modules")) !== dependencyRevision || !validate(temporary)) {
      throw new Error("The installation changed while its immutable runtime was being prepared");
    }
    try { fs.renameSync(temporary, target); }
    catch (error) {
      if (!fs.existsSync(target) || !validate(target)) throw error;
      removeOwned(temporary, cache);
    }
    return { directory: target, revision: expectedRevision, key };
  } catch (error) {
    removeOwned(temporary, cache);
    throw error;
  }
}
