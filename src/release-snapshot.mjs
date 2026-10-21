import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

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
      const data = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < data.length) {
        const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
        if (!count) return new Map();
        offset += count;
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      const current = fs.lstatSync(file, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || !matches(signature(opened), signature(after)) || !matches(signature(after), signature(current))) return new Map();
      const metadata = JSON.parse(data.toString("utf8"));
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
    digest(directory, files, sources) {
      const previous = directories.get(directory) ?? load(directory);
      const records = new Map();
      const hash = createHash("sha256");
      if (previous.size !== files.length) dirty.add(directory);
      for (const file of files) {
        if (!safeRelativePath(file)) throw new Error(`Unsafe release file: ${file}`);
        const fullPath = sources?.get(file) ?? path.join(directory, file);
        const before = fs.statSync(fullPath, { bigint: true });
        if (!before.isFile()) throw new Error(`Unsupported release file: ${file}`);
        const current = signature(before);
        let record = previous.get(file);
        if (!matches(record, current)) {
          dirty.add(directory);
          const canonical = fs.realpathSync.native(fullPath);
          const descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          try {
            const opened = fs.fstatSync(descriptor, { bigint: true });
            if (!opened.isFile() || !matches(current, signature(opened))) throw new Error("A release file changed during integrity verification");
            const content = createHash("sha256");
            const buffer = Buffer.alloc(64 * 1024);
            let remaining = opened.size;
            while (remaining > 0n) {
              const count = fs.readSync(descriptor, buffer, 0, Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining), null);
              if (!count) throw new Error("A release file changed during integrity verification");
              content.update(buffer.subarray(0, count));
              remaining -= BigInt(count);
            }
            const after = fs.fstatSync(descriptor, { bigint: true });
            const resolved = fs.statSync(fullPath, { bigint: true });
            if (!resolved.isFile() || fs.realpathSync.native(fullPath) !== canonical || !matches(current, signature(after)) || !matches(current, signature(resolved))) throw new Error("A release file changed during integrity verification");
            record = { ...current, hash: content.digest("hex") };
          } finally { fs.closeSync(descriptor); }
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

function inventory(root, prefix = "", omitModules = false) {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.name === ".bin") continue;
    if (omitModules && !prefix && entry.name === "node_modules") continue;
    const relative = path.join(prefix, entry.name);
    const stat = entry.isSymbolicLink() ? fs.statSync(path.join(root, relative)) : entry;
    if (stat.isDirectory()) files.push(...inventory(root, relative, omitModules));
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`Unsupported release file: ${relative}`);
  }
  return files;
}

const INSTALLATION_LOCKS = ".bridge-installation-locks.json";
const dependencySearchPaths = (root, name) => createRequire(path.join(root, "package.json")).resolve.paths(name) ?? [];

function installationLocks(root) {
  const saved = path.join(root, INSTALLATION_LOCKS);
  if (fs.existsSync(saved)) return fs.readFileSync(saved, "utf8");
  const local = path.join(root, "node_modules");
  const hashes = [];
  for (const directory of dependencySearchPaths(root, "bridge-dependency-lock")) {
    if (directory === local) continue;
    const lock = path.join(directory, ".package-lock.json");
    if (fs.existsSync(lock)) hashes.push(createHash("sha256").update(fs.readFileSync(lock)).digest("hex"));
  }
  return JSON.stringify(hashes);
}

function dependencyFiles(root) {
  const files = new Map();
  if (fs.existsSync(path.join(root, "node_modules"))) {
    for (const file of inventory(root, "node_modules")) files.set(file, path.join(root, file));
  }
  const queue = [{ source: root, destination: "" }];
  const visited = new Set();
  const packageSources = new Map();
  const packageAt = (directory) => {
    if (packageSources.has(directory)) return packageSources.get(directory);
    const manifest = files.get(path.join(directory, "package.json"));
    if (!manifest) return null;
    const source = fs.realpathSync.native(path.dirname(manifest));
    packageSources.set(directory, source);
    return source;
  };
  for (let index = 0; index < queue.length; index++) {
    const { source, destination } = queue[index];
    if (visited.has(destination)) continue;
    visited.add(destination);
    const manifest = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    for (const name of [...names].sort()) {
      if (!/^(?:@[a-zA-Z0-9._~-]+\/)?[a-zA-Z0-9._~-]+$/.test(name) || name === "." || name === "..") throw new Error(`Unsafe dependency name: ${name}`);
      let resolved;
      for (const modules of dependencySearchPaths(source, name)) {
        const candidate = path.join(modules, name);
        if (fs.existsSync(path.join(candidate, "package.json"))) { resolved = fs.realpathSync.native(candidate); break; }
      }
      if (!resolved) {
        if (Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional) continue;
        throw new Error(`Cannot resolve required dependency ${name} from ${source}`);
      }
      let placement;
      let current = destination;
      while (true) {
        if (path.basename(current) !== "node_modules") {
          const candidate = path.join(current, "node_modules", name);
          const installed = packageAt(candidate);
          if (installed) { if (installed === resolved) placement = candidate; break; }
        }
        if (!current) break;
        const parent = path.dirname(current);
        current = parent === "." ? "" : parent;
      }
      if (!placement) {
        const hoisted = path.join("node_modules", name);
        placement = packageAt(hoisted) ? path.join(destination, "node_modules", name) : hoisted;
        const occupied = packageAt(placement);
        if (occupied && occupied !== resolved) throw new Error(`Conflicting dependency resolution for ${name}`);
        for (const file of inventory(resolved, "", true)) files.set(path.join(placement, file), path.join(resolved, file));
        packageSources.set(placement, resolved);
      }
      queue.push({ source: resolved, destination: placement });
    }
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right, "en")));
}

export function sourceRevision(root) {
  const files = ["package.json", ...inventory(root, "src")];
  for (const file of ["package-lock.json", "node_modules/.package-lock.json"]) {
    if (fs.existsSync(path.join(root, file))) files.push(file);
  }
  return createHash("sha256").update(digestFiles(root, files)).update(installationLocks(root)).digest("hex");
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

const LEASES = ".leases";
const LEASE_PATTERN = /^([a-f0-9]{64})\.(\d+)\.[0-9a-f-]{36}\.lease$/;
const OWNED_TEMPORARY_PATTERN = /^\.(?:preparing|retired|linking)-(\d+)-[0-9a-f-]{36}$/;
const DIGEST_TEMPORARY_PATTERN = /^\.(?:digests|prune-lock)-(\d+)-[0-9a-f-]{36}\.tmp$/;
const DIGEST_FILE_PATTERN = /^\.digests-[a-f0-9]{64}\.json$/;
const DIGEST_HEADER = /^\{"schema":1,"directory":("(?:[^"\\]|\\.)*")/;
const PRUNE_LOCK = ".prune.lock";
const PRUNE_STAMP = ".prune-stamp";
const LEASE_HEARTBEAT_MS = 5 * 60 * 1000;
const LEASE_FRESH_MS = 3 * LEASE_HEARTBEAT_MS;
const LEASE_OWNER_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_LOCK_STALE_MS = 10 * 60 * 1000;
const TEMPORARY_GRACE_MS = 60 * 60 * 1000;
const CLONE_TIMEOUT_MS = 120000;
const PROCESS_LIST_TIMEOUT_MS = 60000;
const MAX_DIGEST_HEADERS = 256;
const RUNTIME_RETENTION = Object.freeze({ retain: 3, graceMs: 24 * 60 * 60 * 1000, minIntervalMs: 60 * 60 * 1000, maxRemovals: 8 });

const execFileAsync = promisify(execFile);
const activeLeases = new Set();

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function touch(target, now = new Date()) {
  try { fs.utimesSync(target, now, now); return true; } catch { return false; }
}

function isDirectory(target) {
  try { const info = fs.lstatSync(target); return info.isDirectory() && !info.isSymbolicLink(); } catch { return false; }
}

function removeIfFile(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch { return false; }
}

function releaseActiveLeases() {
  for (const lease of activeLeases) lease.release();
}

function leaseSnapshot(cache, key, target) {
  const directory = path.join(cache, LEASES);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!isDirectory(directory)) throw new Error("The runtime lease directory is not a directory");
  const file = path.join(directory, `${key}.${process.pid}.${randomUUID()}.lease`);
  const write = () => fs.writeFileSync(file, `${JSON.stringify({ schema: 1, key, pid: process.pid })}\n`, { flag: "wx", mode: 0o600 });
  write();
  if (!activeLeases.size) process.once("exit", releaseActiveLeases);
  const timer = setInterval(() => {
    if (touch(file)) return;
    try { write(); } catch {}
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  const lease = {
    file,
    released: false,
    release() {
      if (lease.released) return;
      lease.released = true;
      clearInterval(timer);
      activeLeases.delete(lease);
      if (!activeLeases.size) process.removeListener("exit", releaseActiveLeases);
      try { fs.rmSync(file, { force: true }); } catch {}
      touch(target);
    },
  };
  activeLeases.add(lease);
  return lease;
}

function readLeases(cache, now) {
  const directory = path.join(cache, LEASES);
  if (!isDirectory(directory)) return [];
  const leases = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const match = LEASE_PATTERN.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    let info;
    try { info = fs.lstatSync(file); } catch { continue; }
    const age = now - info.mtimeMs;
    const pid = Number(match[2]);
    leases.push({ file, key: match[1], usedAt: info.mtimeMs, live: age < LEASE_FRESH_MS || (age < LEASE_OWNER_MAX_MS && processAlive(pid)) });
  }
  return leases;
}

export async function runningCommandLines() {
  const options = { timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true };
  let stdout;
  if (process.platform === "win32") {
    const shell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    ({ stdout } = await execFileAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], options));
  } else {
    const ps = ["/bin/ps", "/usr/bin/ps"].find((candidate) => fs.existsSync(candidate));
    if (!ps) throw new Error("No process listing tool is available");
    ({ stdout } = await execFileAsync(ps, ["-A", "-ww", "-o", "args="], { ...options, env: { ...process.env, LC_ALL: "C" } }));
  }
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (!lines.length) throw new Error("The process listing is empty");
  return lines;
}

function createPruneLock(cache, lock) {
  const staged = path.join(cache, `.prune-lock-${process.pid}-${randomUUID()}.tmp`);
  fs.writeFileSync(staged, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  try { fs.linkSync(staged, lock); }
  catch (error) {
    if (error.code === "EEXIST") throw error;
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } finally { fs.rmSync(staged, { force: true }); }
}

function takeOverStalePruneLock(cache, lock, now) {
  const info = fs.lstatSync(lock, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) return false;
  const text = fs.readFileSync(lock, "utf8").trim();
  const owner = /^\d+$/.test(text) ? Number(text) : null;
  if (now - Number(info.mtimeMs) < PRUNE_LOCK_STALE_MS && (owner === null || processAlive(owner))) return false;
  const moved = path.join(cache, `.prune-lock-${process.pid}-${randomUUID()}.tmp`);
  fs.renameSync(lock, moved);
  let reclaimed = false;
  try {
    const descriptor = fs.openSync(moved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const examined = fs.fstatSync(descriptor, { bigint: true });
      reclaimed = examined.isFile() && examined.dev === info.dev && examined.ino === info.ino && examined.mtimeNs === info.mtimeNs && examined.size === info.size
        && fs.readFileSync(descriptor, "utf8").trim() === text;
    } finally { fs.closeSync(descriptor); }
  } catch { reclaimed = false; }
  if (!reclaimed) { try { fs.linkSync(moved, lock); } catch {} }
  fs.rmSync(moved, { force: true });
  return reclaimed;
}

function acquirePruneLock(cache, now) {
  const lock = path.join(cache, PRUNE_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createPruneLock(cache, lock);
      return () => {
        try { if (fs.readFileSync(lock, "utf8").trim() === String(process.pid)) fs.rmSync(lock, { force: true }); } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST" || attempt) return null;
      try { if (!takeOverStalePruneLock(cache, lock, now)) return null; } catch { return null; }
    }
  }
  return null;
}

function claimPruneInterval(stamp, now, minIntervalMs) {
  let info = null;
  try { info = fs.lstatSync(stamp); } catch (error) { if (error.code !== "ENOENT") return "The prune stamp could not be read"; }
  if (info && (!info.isFile() || info.isSymbolicLink())) return "The prune stamp is not a regular file";
  if (info && now - info.mtimeMs < minIntervalMs) return "The runtime cache was pruned recently";
  let descriptor;
  try {
    descriptor = fs.openSync(stamp, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    if (!fs.fstatSync(descriptor).isFile()) return "The prune stamp is not a regular file";
    const time = new Date(now);
    fs.futimesSync(descriptor, time, time);
    return null;
  } catch { return "The prune stamp could not be updated"; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function digestDirectory(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const buffer = Buffer.alloc(8192);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const match = DIGEST_HEADER.exec(buffer.subarray(0, count).toString("utf8"));
    return match ? JSON.parse(match[1]) : null;
  } catch { return null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function sweepCacheFiles(cache, entries, now, report) {
  let headers = 0;
  for (const entry of entries) {
    const target = path.join(cache, entry.name);
    const temporary = OWNED_TEMPORARY_PATTERN.exec(entry.name) ?? DIGEST_TEMPORARY_PATTERN.exec(entry.name);
    if (temporary) {
      let info;
      try { info = fs.lstatSync(target); } catch { continue; }
      if (info.isSymbolicLink() || now - info.mtimeMs < TEMPORARY_GRACE_MS || processAlive(Number(temporary[1]))) continue;
      if (info.isDirectory()) { try { removeOwned(target, cache); report.temporaries++; } catch {} }
      else if (removeIfFile(target)) report.temporaries++;
      continue;
    }
    if (!DIGEST_FILE_PATTERN.test(entry.name) || !entry.isFile() || headers >= MAX_DIGEST_HEADERS) continue;
    headers++;
    const directory = digestDirectory(target);
    if (typeof directory === "string" && !isDirectory(directory) && removeIfFile(target)) report.digests++;
  }
}

async function retireSnapshot(cache, key, usedAt) {
  const target = path.join(cache, key);
  const leased = () => readLeases(cache, Date.now()).some((lease) => lease.key === key && lease.live);
  let info;
  try { info = fs.lstatSync(target); } catch { return "kept"; }
  if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs > usedAt || leased()) return "kept";
  const retired = path.join(cache, `.retired-${process.pid}-${randomUUID()}`);
  try { fs.renameSync(target, retired); } catch { return "kept"; }
  if (leased()) {
    try { fs.renameSync(retired, target); }
    catch { if (isDirectory(target) && isDirectory(retired)) removeOwned(retired, cache); }
    return "kept";
  }
  if (!isDirectory(retired)) return "kept";
  removeIfFile(path.join(cache, `.digests-${createHash("sha256").update(target).digest("hex")}.json`));
  try { await fs.promises.rm(retired, { recursive: true, force: true }); } catch { return "incomplete"; }
  return isDirectory(retired) ? "incomplete" : "removed";
}

function pruneCandidates(cache, entries, leases, { keep, retain, graceMs }, now) {
  const live = new Set(leases.filter((lease) => lease.live).map((lease) => lease.key));
  const snapshots = [];
  for (const entry of entries) {
    if (!DIGEST_PATTERN.test(entry.name) || !entry.isDirectory()) continue;
    let info;
    try { info = fs.lstatSync(path.join(cache, entry.name)); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const usedAt = Math.max(info.mtimeMs, ...leases.filter((lease) => lease.key === entry.name).map((lease) => lease.usedAt));
    snapshots.push({ key: entry.name, usedAt });
  }
  snapshots.sort((left, right) => right.usedAt - left.usedAt || left.key.localeCompare(right.key, "en"));
  const protectedKeys = new Set(keep);
  const candidates = snapshots.filter((snapshot, index) => index >= retain && !protectedKeys.has(snapshot.key)
    && !live.has(snapshot.key) && now - snapshot.usedAt >= graceMs).reverse();
  return { snapshots, candidates };
}

export async function pruneReleaseSnapshots({ cache = snapshotRoot(), keep = [], retain = RUNTIME_RETENTION.retain, graceMs = RUNTIME_RETENTION.graceMs,
  minIntervalMs = RUNTIME_RETENTION.minIntervalMs, maxRemovals = RUNTIME_RETENTION.maxRemovals, listProcesses = runningCommandLines } = {}) {
  const report = { removed: [], kept: [], incomplete: [], leases: 0, temporaries: 0, digests: 0, skipped: null };
  if (!isDirectory(cache)) { report.skipped = "The runtime cache is not a directory"; return report; }
  cache = fs.realpathSync.native(cache);
  const now = Date.now();
  const unlock = acquirePruneLock(cache, now);
  if (!unlock) { report.skipped = "Another prune is running"; return report; }
  try {
    const stamp = path.join(cache, PRUNE_STAMP);
    report.skipped = claimPruneInterval(stamp, now, minIntervalMs);
    if (report.skipped) return report;
    const leases = readLeases(cache, now);
    for (const lease of leases) if (!lease.live && removeIfFile(lease.file)) report.leases++;
    const entries = fs.readdirSync(cache, { withFileTypes: true });
    sweepCacheFiles(cache, entries, now, report);
    const { snapshots, candidates } = pruneCandidates(cache, entries, leases, { keep, retain, graceMs }, now);
    const bounded = candidates.slice(0, Math.max(0, maxRemovals));
    report.kept = snapshots.filter((snapshot) => !bounded.includes(snapshot)).map((snapshot) => snapshot.key);
    if (!bounded.length) return report;
    let commandLines;
    try { commandLines = (await listProcesses()).map((line) => String(line).toLowerCase()); }
    catch (error) {
      report.kept.push(...bounded.map((snapshot) => snapshot.key));
      report.skipped = `Running processes could not be listed: ${error.message}`;
      return report;
    }
    for (const { key, usedAt } of bounded) {
      const outcome = commandLines.some((line) => line.includes(key)) ? "kept" : await retireSnapshot(cache, key, usedAt);
      report[outcome].push(key);
    }
    return report;
  } finally { unlock(); }
}

const cloneSupported = () => process.platform === "darwin" && fs.existsSync("/bin/cp");

function cloneRelease(entries, temporary, cache) {
  const farm = path.join(cache, `.linking-${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(farm, { mode: 0o700 });
    const created = new Set();
    for (const [file, source] of entries) {
      const link = path.join(farm, file);
      const parent = path.dirname(link);
      if (!created.has(parent)) { fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); created.add(parent); }
      fs.symlinkSync(source, link);
    }
    execFileSync("/bin/cp", ["-c", "-R", "-L", "--", `${farm}${path.sep}`, temporary], { stdio: "ignore", timeout: CLONE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  } finally {
    try { removeOwned(farm, cache); } catch {}
  }
}

export function createReleaseSnapshot(root, { cache = snapshotRoot(), expectedRevision = sourceRevision(root), lease = false } = {}) {
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
  const dependencies = dependencyFiles(root);
  const dependencyRevision = metadata.digest(root, [...dependencies.keys()], dependencies);
  const key = createHash("sha256").update(expectedRevision).update(dependencyRevision).digest("hex");
  const target = path.join(cache, key);
  const validate = (directory) => {
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("The release directory cannot be a symbolic link");
    return sourceRevision(directory) === expectedRevision && metadata.digest(directory, inventory(directory, "node_modules").sort((left, right) => left.localeCompare(right, "en"))) === dependencyRevision;
  };
  const prepare = () => {
    const temporary = path.join(cache, `.preparing-${process.pid}-${randomUUID()}`);
    try {
      const files = ["package.json", ...inventory(root, "src"), ...dependencies.keys()];
      if (fs.existsSync(path.join(root, "package-lock.json"))) files.push("package-lock.json");
      const sources = files.map((file) => [file, dependencies.get(file) ?? path.join(root, file)]);
      const directories = new Set(["src", "node_modules", ...files.map((file) => path.dirname(file))]);
      const layout = () => {
        fs.mkdirSync(temporary, { mode: 0o700 });
        for (const directory of directories) fs.mkdirSync(path.join(temporary, directory), { recursive: true, mode: 0o700 });
      };
      layout();
      let copy = "clonefile";
      if (!cloneSupported() || !cloneRelease(sources, temporary, cache)) {
        copy = "copyfile";
        if (cloneSupported()) { removeOwned(temporary, cache); layout(); }
        for (const [file, source] of sources) fs.copyFileSync(source, path.join(temporary, file), fs.constants.COPYFILE_FICLONE);
      }
      fs.writeFileSync(path.join(temporary, INSTALLATION_LOCKS), installationLocks(root), { flag: "wx", mode: 0o600 });
      const currentDependencies = dependencyFiles(root);
      if (sourceRevision(root) !== expectedRevision || metadata.digest(root, [...currentDependencies.keys()], currentDependencies) !== dependencyRevision || !validate(temporary)) {
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
      return copy;
    } catch (error) {
      removeOwned(temporary, cache);
      throw error;
    }
  };
  const held = lease ? leaseSnapshot(cache, key, target) : null;
  const finish = (copy) => {
    metadata.flush();
    touch(target);
    return { directory: target, revision: expectedRevision, key, copy, ...(held ? { lease: held } : {}) };
  };
  try {
    for (let attempt = 0; fs.existsSync(target); attempt++) {
      try {
        if (!validate(target)) throw new Error("An existing immutable runtime failed integrity verification");
        const currentDependencies = dependencyFiles(root);
        if (sourceRevision(root) !== expectedRevision || metadata.digest(root, [...currentDependencies.keys()], currentDependencies) !== dependencyRevision) {
          throw new Error("The installation changed during snapshot verification");
        }
        return finish("reused");
      } catch (error) {
        if (error?.code !== "ENOENT" || attempt >= 2) throw error;
      }
    }
    return finish(prepare());
  } catch (error) {
    held?.release();
    throw error;
  }
}
