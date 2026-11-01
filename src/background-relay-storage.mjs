import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const caches = new WeakMap();
const writes = new WeakMap();
const helper = fileURLToPath(new URL("./background-relay-storage.ps1", import.meta.url));
const unsafe = () => Object.assign(new Error("Relay storage must be owned by the current user and inaccessible to other users"), { code: "WORKER_STORAGE_UNSAFE", phase: "storage", deliveryState: "not_sent", sent: false });
const changed = () => Object.assign(new Error("Relay storage kept changing during privacy verification; retry after the current update finishes"), { code: "WORKER_STORAGE_CHANGED", phase: "storage", deliveryState: "not_sent", sent: false });

function targetPath(input) {
  if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) throw unsafe();
  const target = path.resolve(input);
  if (target === path.parse(target).root || target === path.resolve(os.homedir())) throw unsafe();
  return target;
}

function inspectPath(target, kind, missing = false) {
  let stat;
  try { stat = fs.lstatSync(target, { bigint: true }); }
  catch (error) { if (missing && error.code === "ENOENT") return null; throw unsafe(); }
  if (stat.isSymbolicLink() || kind === "directory" && !stat.isDirectory() || kind === "file" && (!stat.isFile() || stat.nlink !== 1n)) throw unsafe();
  return stat;
}

const identity = stat => [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size, stat.mode, stat.nlink].join(":");
const cacheKey = (target, kind) => `${kind}:${target.toLowerCase()}`;
const sameNode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameObject = (left, right) => ["dev", "ino", "birthtimeNs", "uid", "mode"].every(key => left[key] === right[key])
  && (left.isDirectory() && right.isDirectory() || left.nlink === right.nlink);
const validReadback = (value, kind) => value?.ownerTrusted === true && value?.allowedPrincipalsOnly === true && value?.currentUserFullControl === true
  && value?.noReparse === true && (kind !== "directory" || value?.protected === true) && value?.kind === kind;

function runWindowsHelper(target, kind, mode, run, input, timeout = 15000) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  const windows = process.env.SystemRoot || "C:\\Windows";
  env.PSModulePath = path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "Modules");
  try {
    const response = run(path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-File", helper, "-LiteralPath", target, "-Kind", kind, "-Mode", mode],
      { env, windowsHide: true, shell: false, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input,
        timeout, maxBuffer: mode === "batch" ? 2 * 1024 * 1024 : 16384, encoding: "utf8" });
    if (response && typeof response === "object" && !Buffer.isBuffer(response) && (response.status ?? response.exitCode ?? 0) !== 0) throw unsafe();
    return JSON.parse(typeof response === "object" && !Buffer.isBuffer(response) ? response.stdout : String(response));
  } catch { throw unsafe(); }
}

function windowsPrivacy(target, kind, mode, stat, run) {
  let cache = caches.get(run);
  if (!cache) { cache = new Map(); caches.set(run, cache); }
  const key = cacheKey(target, kind);
  const previous = cache.get(key);
  if (previous?.identity === identity(stat)) return stat;
  const deadline = Date.now() + 15000;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw changed();
      const result = runWindowsHelper(target, kind, mode, run, undefined, remaining);
      const current = inspectPath(target, kind);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.birthtimeNs !== stat.birthtimeNs || !validReadback(result, kind)) throw unsafe();
      if (mode === "assert" && identity(current) !== identity(stat)) { stat = current; continue; }
      cache.set(key, { identity: identity(current) });
      if (cache.size > 2048) cache.delete(cache.keys().next().value);
      return current;
    }
    throw changed();
  } catch (error) { cache.delete(key); throw error; }
}

function assertPrivacy(target, kind, stat, { platform = process.platform, run = execFileSync } = {}) {
  if (platform === "win32") return windowsPrivacy(target, kind, "assert", stat, run);
  if (typeof process.getuid !== "function" || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== (kind === "directory" ? 0o700n : 0o600n)) throw unsafe();
  return stat;
}

export function assertPrivateRelayDirectory(input, options = {}) {
  const target = targetPath(input);
  return assertPrivacy(target, "directory", inspectPath(target, "directory"), options);
}

export function assertPrivateRelayFile(input, { missing = false, ...options } = {}) {
  const target = targetPath(input);
  assertPrivateRelayDirectory(path.dirname(target), options);
  const stat = inspectPath(target, "file", missing);
  return stat === null ? null : assertPrivacy(target, "file", stat, options);
}

export function assertPrivateRelayFiles(inputs, { platform = process.platform, run = execFileSync } = {}) {
  if (!Array.isArray(inputs) || inputs.length > 1024) throw unsafe();
  if (!inputs.length) return [];
  const files = inputs.map(targetPath);
  const directory = path.dirname(files[0]);
  const names = files.map(file => path.basename(file));
  if (files.some(file => path.dirname(file) !== directory) || names.some(name => /[\\/:]/.test(name))
    || new Set(files.map(file => platform === "win32" ? file.toLowerCase() : file)).size !== files.length) throw unsafe();
  const input = JSON.stringify({ files: names });
  if (Buffer.byteLength(input) > 1024 * 1024) throw unsafe();
  const before = inspectPath(directory, "directory");
  const states = files.map(file => inspectPath(file, "file"));
  if (platform !== "win32") {
    assertPrivacy(directory, "directory", before, { platform, run });
    return states.map((stat, index) => assertPrivacy(files[index], "file", stat, { platform, run }));
  }
  let cache = caches.get(run);
  if (!cache) { cache = new Map(); caches.set(run, cache); }
  const pending = files.flatMap((file, index) => cache.get(cacheKey(file, "file"))?.identity === identity(states[index]) ? [] : [index]);
  if (!pending.length && cache.get(cacheKey(directory, "directory"))?.identity === identity(before)) return states;
  try {
    const result = runWindowsHelper(directory, "directory", "batch", run, JSON.stringify({ files: pending.map(index => names[index]) }));
    if (!validReadback(result?.directory, "directory") || !Array.isArray(result?.files) || result.files.length !== pending.length) throw unsafe();
    for (let index = 0; index < pending.length; index++) {
      if (result.files[index]?.name !== names[pending[index]] || !validReadback(result.files[index]?.state, "file")) throw unsafe();
    }
    const currentDirectory = inspectPath(directory, "directory");
    const current = files.map(file => inspectPath(file, "file"));
    if (identity(before) !== identity(currentDirectory) || current.some((stat, index) => identity(stat) !== identity(states[index]))) throw unsafe();
    cache.set(cacheKey(directory, "directory"), { identity: identity(currentDirectory) });
    for (const index of pending) cache.set(cacheKey(files[index], "file"), { identity: identity(current[index]) });
    while (cache.size > 2048) cache.delete(cache.keys().next().value);
    return current;
  } catch {
    cache.delete(cacheKey(directory, "directory"));
    for (const file of files) cache.delete(cacheKey(file, "file"));
    throw unsafe();
  }
}

export function protectPrivateRelayDirectory(input, { platform = process.platform, run = execFileSync } = {}) {
  const target = targetPath(input);
  try { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); } catch { throw unsafe(); }
  const before = inspectPath(target, "directory");
  if (platform === "win32") return windowsPrivacy(target, "directory", "protect", before, run);
  if (typeof process.getuid !== "function" || before.uid !== BigInt(process.getuid())) throw unsafe();
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino || opened.uid !== before.uid) throw unsafe();
    if ((opened.mode & 0o7777n) !== 0o700n) fs.fchmodSync(descriptor, 0o700);
  } catch { throw unsafe(); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  const after = inspectPath(target, "directory");
  if (before.dev !== after.dev || before.ino !== after.ino) throw unsafe();
  return assertPrivacy(target, "directory", after, { platform, run });
}

export function beginPrivateRelayWrite(input, { platform = process.platform, run = execFileSync } = {}) {
  const file = targetPath(input);
  const directory = path.dirname(file);
  protectPrivateRelayDirectory(directory, { platform, run });
  assertPrivateRelayFile(file, { missing: true, platform, run });
  const before = assertPrivateRelayDirectory(directory, { platform, run });
  const ticket = Object.freeze({});
  writes.set(ticket, { file, directory, before, platform, run });
  return ticket;
}

export function bindPrivateRelayWrite(ticket, temporary, descriptor) {
  const pending = writes.get(ticket);
  if (!pending || pending.temporary || typeof temporary !== "string" || path.dirname(temporary) !== pending.directory
    || !path.basename(temporary).startsWith(`.${path.basename(pending.file)}.`) || !temporary.endsWith(".tmp") || !Number.isInteger(descriptor)) throw unsafe();
  const opened = fs.fstatSync(descriptor, { bigint: true });
  const current = inspectPath(temporary, "file");
  if (!opened.isFile() || opened.nlink !== 1n || identity(opened) !== identity(current)) throw unsafe();
  if (pending.platform !== "win32") assertPrivacy(temporary, "file", current, pending);
  pending.temporary = temporary;
  pending.created = opened;
}

export function abortPrivateRelayWrite(ticket) {
  const pending = writes.get(ticket);
  if (!pending) return;
  writes.delete(ticket);
  const cache = caches.get(pending.run);
  cache?.delete(cacheKey(pending.directory, "directory"));
  cache?.delete(cacheKey(pending.file, "file"));
}

export function finishPrivateRelayWrite(ticket) {
  const pending = writes.get(ticket);
  if (!pending?.created) throw unsafe();
  try {
    const directory = inspectPath(pending.directory, "directory");
    const file = inspectPath(pending.file, "file");
    if (pending.created.size !== file.size || fs.existsSync(pending.temporary)) throw unsafe();
    if (pending.platform === "win32") {
      if (!sameObject(pending.before, directory) || !sameObject(pending.created, file) || pending.created.mtimeNs !== file.mtimeNs) throw unsafe();
      const cache = caches.get(pending.run);
      if (cache?.get(cacheKey(pending.directory, "directory"))?.identity !== identity(pending.before)) throw unsafe();
      cache.set(cacheKey(pending.directory, "directory"), { identity: identity(directory) });
      cache.set(cacheKey(pending.file, "file"), { identity: identity(file) });
      if (cache.size > 2048) cache.delete(cache.keys().next().value);
    } else {
      if (!sameNode(pending.before, directory) || !sameNode(pending.created, file)) throw unsafe();
      assertPrivacy(pending.directory, "directory", directory, pending);
      assertPrivacy(pending.file, "file", file, pending);
    }
    writes.delete(ticket);
  } catch (error) { abortPrivateRelayWrite(ticket); throw error; }
}
