import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ACCOUNT_ID = new RegExp(`^${UUID}$`, "i");
const TASK_FILE = new RegExp(`^(local_${UUID})\\.json$`, "i");
const MAX_ENTRIES = 8192;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const VERSION_FIELDS = ["size", "mtimeMs", "ctimeMs", "ino", "dev"];

const sameVersion = (left, right) => VERSION_FIELDS.every((field) => left[field] === right[field]);

/**
 * Claude's inbound parity gate groups bypassPermissions as one class and
 * default, acceptEdits, auto and dontAsk as the prompting class. Plan counts
 * as bypass only when bypass is available to that session, which the record
 * does not say, so it and any unknown value yield no class rather than a guess.
 */
const PERMISSION_CLASSES = { bypassPermissions: "bypass", default: "prompting", acceptEdits: "prompting", auto: "prompting", dontAsk: "prompting" };

const PERMISSION_MODE = /^[A-Za-z]{1,64}$/;

const permissionModeOf = (mode) => typeof mode === "string" && PERMISSION_MODE.test(mode) ? mode : null;

const permissionClassOf = (mode) => typeof mode === "string" && Object.hasOwn(PERMISSION_CLASSES, mode) ? PERMISSION_CLASSES[mode] : null;

function result(status, reason, task = {}) {
  return { status, taskId: task.taskId ?? null, title: task.title ?? null, cwd: task.cwd ?? null, permissionMode: task.permissionMode ?? null, permissionClass: task.permissionClass ?? null, ...(task.accountFingerprint ? { accountFingerprint: task.accountFingerprint } : {}), reason };
}

function sessionsRoot(platform, env) {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const config = platform === "darwin"
    ? path.join(home, "Library", "Application Support")
    : platform === "win32"
      ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(config, "Claude", "claude-code-sessions");
}

function metadataFiles(root, accountId) {
  if (!path.isAbsolute(root) || !fs.lstatSync(root).isDirectory()) throw new Error("invalid root");
  const files = [];
  let entryCount = 0;
  const visit = (directory, depth) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    entryCount += entries.length;
    if (entryCount > MAX_ENTRIES) throw new Error("scan limit");
    for (const entry of entries) {
      if (depth === 0 && accountId && entry.name.toLowerCase() !== accountId.toLowerCase()) continue;
      const location = path.join(directory, entry.name);
      if (depth < 2 && ACCOUNT_ID.test(entry.name)) {
        if (!entry.isDirectory()) throw new Error("invalid account directory");
        visit(location, depth + 1);
      } else if (depth === 2 && TASK_FILE.test(entry.name)) {
        if (!entry.isFile()) throw new Error("invalid metadata file");
        files.push(location);
      }
    }
  };
  visit(root, 0);
  return files.sort();
}

function readMetadata(file, budget) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("file limit");
    budget.bytes += before.size;
    if (budget.bytes > MAX_TOTAL_BYTES) throw new Error("total limit");
    const bytes = Buffer.alloc(before.size);
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("short read");
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!sameVersion(before, after) || current.isSymbolicLink() || !sameVersion(current, after)) throw new Error("metadata changed");
    budget.versions.set(file, current);
    budget.contents.set(file, bytes);
    const data = JSON.parse(bytes.toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid metadata");
    return {
      taskId: data.sessionId,
      fileTaskId: TASK_FILE.exec(path.basename(file))[1],
      cliSessionId: data.cliSessionId,
      bridgeSessionIds: data.bridgeSessionIds,
      cwd: data.cwd,
      title: data.title,
      isArchived: data.isArchived,
      permissionMode: data.permissionMode,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Stat fields cannot prove a record is unchanged: a same-size rewrite inside
 * one filesystem timestamp tick (about 16 ms on Windows) keeps size, times
 * and inode identical. The final consistency pass therefore compares the
 * bytes themselves; the records are small JSON files, so the extra read is
 * cheap and the check is deterministic on every platform.
 */
function rereadMetadata(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("file limit");
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("short read");
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function canonicalDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error("invalid cwd");
  const canonical = fs.realpathSync.native(directory);
  if (!fs.statSync(canonical).isDirectory()) throw new Error("invalid cwd");
  return canonical;
}

export function readClaudeDesktopContext(session, { platform = process.platform, env = process.env, root, account } = {}) {
  if (account !== undefined && (account.status !== "verified" || !ACCOUNT_ID.test(account.accountId ?? "") || !account.root)) {
    return result("missing", "Claude Desktop has no verified signed-in account; wait for sign-in to finish and discover its sessions again.");
  }
  if (typeof session?.sessionId !== "string" || !session.sessionId.trim()) {
    return result("missing", "A live Claude sessionId is required to identify its Desktop task.");
  }
  if (session.bridgeSessionId !== undefined && session.bridgeSessionId !== null &&
      (typeof session.bridgeSessionId !== "string" || !session.bridgeSessionId.trim())) {
    return result("mismatch", "The live Claude bridge session identity is invalid.");
  }
  const directory = root ?? (account ? path.join(account.root, "claude-code-sessions") : sessionsRoot(platform, env));
  let records;
  try {
    if (!fs.existsSync(directory)) return result("missing", "Claude Desktop task metadata is not available on this host.");
    const files = metadataFiles(directory, account?.accountId);
    const budget = { bytes: 0, versions: new Map(), contents: new Map() };
    records = files.map((file) => readMetadata(file, budget));
    const currentFiles = metadataFiles(directory, account?.accountId);
    if (files.length !== currentFiles.length || files.some((file, index) => file !== currentFiles[index])) {
      return result("mismatch", "Claude Desktop task metadata changed during inspection; inspect the existing task again.");
    }
    for (const file of files) {
      const current = fs.lstatSync(file);
      if (!current.isFile() || !sameVersion(current, budget.versions.get(file))) throw new Error("metadata changed");
      if (!rereadMetadata(file).equals(budget.contents.get(file))) throw new Error("metadata changed");
    }
  } catch {
    return result("mismatch", "Claude Desktop task metadata could not be read completely and consistently; no task identity is confirmed.");
  }

  const primary = records.filter((record) => record.cliSessionId === session.sessionId);
  const bridge = session.bridgeSessionId
    ? records.filter((record) => Array.isArray(record.bridgeSessionIds) && record.bridgeSessionIds.includes(session.bridgeSessionId))
    : [];
  if (primary.length > 1 || bridge.length > 1) {
    return result("ambiguous", "Multiple Claude Desktop records claim this live session; no task identity is confirmed.");
  }
  if (!primary.length) {
    return bridge.length
      ? result("mismatch", "A Desktop record names this bridge identity but a different CLI session; it may be stale.")
      : result("missing", "No Claude Desktop task has the exact live CLI sessionId; project names and peer names are not task identities.");
  }
  const record = primary[0];
  if (records.filter((candidate) => candidate.taskId === record.taskId).length !== 1) {
    return result("ambiguous", "The native Claude Desktop task ID appears in multiple records; no task identity is confirmed.");
  }
  if (record.taskId !== record.fileTaskId) {
    return result("mismatch", "The native Claude Desktop task ID does not match its metadata record.");
  }
  if (record.isArchived !== false) {
    return result("mismatch", "The matching Claude Desktop task is archived or its archive state is unknown; open an existing active task.");
  }
  if (session.bridgeSessionId && (bridge.length !== 1 || bridge[0] !== record)) {
    return result("mismatch", "The live CLI and bridge session identities do not identify the same Claude Desktop task.");
  }
  let actualCwd;
  let taskCwd;
  try {
    actualCwd = canonicalDirectory(session.cwd);
    taskCwd = canonicalDirectory(record.cwd);
  } catch {
    return result("mismatch", "The live Claude session or Desktop task directory is missing or invalid.");
  }
  const normalize = (value) => platform === "win32" ? value.toLowerCase() : value;
  if (normalize(actualCwd) !== normalize(taskCwd)) {
    return result("mismatch", "The native Claude Desktop task directory differs from the live Claude session directory.");
  }
  if (typeof record.title !== "string" || !record.title.trim() || record.title.length > 1024 || /[\u0000-\u001f\u007f]/u.test(record.title)) {
    return result("mismatch", "The matching Claude Desktop task has no usable native title; inspect the existing task in the app.");
  }
  return result("matched", "Exact live CLI session identity and canonical project directory match one active native Desktop task.", {
    taskId: record.taskId,
    title: record.title,
    cwd: taskCwd,
    permissionMode: permissionModeOf(record.permissionMode),
    permissionClass: permissionClassOf(permissionModeOf(record.permissionMode)),
    accountFingerprint: account?.fingerprint,
  });
}
