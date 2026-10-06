import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function directory(value) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error("Project directory must be an absolute existing directory");
  const resolved = fs.realpathSync.native(value);
  const stat = fs.statSync(resolved, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Project path is not a directory");
  return { input: value, path: resolved, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs ?? stat.birthtimeMs}` };
}

function samePath(left, right) {
  return path.relative(left, right) === "";
}

function metadata(file) {
  const entry = fs.lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 4096) throw new Error("Invalid project repository metadata");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    const fields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];
    const matches = (left, right) => fields.every((field) => left[field] === right[field]);
    if (!before.isFile() || !matches(entry, before)) throw new Error("Project repository metadata changed during access");
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw new Error("Project repository metadata changed during access");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || !matches(before, after) || !matches(after, current)) throw new Error("Project repository metadata changed during access");
    return data.toString("utf8").trim();
  } finally {
    fs.closeSync(descriptor);
  }
}

function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function gitRepository(gitdir, common = gitdir) {
  const head = metadata(path.join(gitdir.path, "HEAD"));
  if (!/^(?:ref: refs\/[^\s]+|[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(head)) throw new Error("Invalid project repository HEAD metadata");
  directory(path.join(common.path, "objects"));
  return common;
}

function repository(cwd) {
  const home = fs.realpathSync.native(os.homedir());
  for (let root = cwd; ; root = path.dirname(root)) {
    if (samePath(root, path.parse(root).root) || samePath(root, home)) return null;
    const marker = path.join(root, ".git");
    if (exists(marker)) {
      const entry = fs.lstatSync(marker);
      if (entry.isSymbolicLink()) throw new Error("Project repository marker cannot be a symbolic link");
      if (entry.isDirectory()) {
        const gitdir = directory(marker);
        if (!samePath(gitdir.path, marker)) throw new Error("Project repository marker changed during access");
        return gitRepository(gitdir);
      }
      const match = metadata(marker).match(/^gitdir: ([^\r\n]+)$/);
      if (!match) throw new Error("Invalid project gitdir metadata");
      const gitdir = directory(path.resolve(root, match[1]));
      const commonFile = path.join(gitdir.path, "commondir");
      if (!exists(commonFile)) {
        const separate = gitRepository(gitdir);
        return { ...separate, identity: `${separate.identity}:${root}` };
      }
      const common = gitRepository(directory(path.resolve(gitdir.path, metadata(commonFile))));
      const registered = path.relative(path.join(common.path, "worktrees"), gitdir.path);
      if (!registered || registered === ".." || registered.startsWith(`..${path.sep}`) || path.isAbsolute(registered) || registered.includes(path.sep)) throw new Error("Project worktree is not registered in its common repository");
      const backlink = path.resolve(gitdir.path, metadata(path.join(gitdir.path, "gitdir")));
      if (!samePath(fs.realpathSync.native(backlink), fs.realpathSync.native(marker))) throw new Error("Project worktree backlink does not match its directory");
      return gitRepository(gitdir, common);
    }
    if (path.dirname(root) === root) return null;
  }
}

function project(value) {
  const current = directory(value);
  return { ...current, repository: repository(current.path) };
}

function sameBinding(left, right) {
  return Boolean(left && right && samePath(left.path, right.path) && left.identity === right.identity);
}

function sameProject(left, right) {
  return sameBinding(left, right) || sameBinding(left.repository, right.repository);
}

export function captureProjectScope(senderCwd, recipientCwd) {
  let sender;
  let recipient;
  try {
    sender = project(senderCwd);
    recipient = project(recipientCwd);
  } catch (cause) {
    const error = new Error(`Project scope could not be verified: ${cause.message}. No message was sent.`, { cause });
    error.code = "PROJECT_SCOPE_UNVERIFIED";
    throw error;
  }
  if (!sameProject(sender, recipient)) {
    const error = new Error(`Project mismatch: the calling Claude task works in "${sender.path}", but the Codex destination works in "${recipient.path}". Select a task in the sender's project. No message was sent.`);
    error.code = "PROJECT_SCOPE_MISMATCH";
    throw error;
  }
  return { sender, recipient };
}

export function recheckProjectScope(expected, current = captureProjectScope(expected.sender.input, expected.recipient.input)) {
  for (const side of ["sender", "recipient"]) {
    if (!sameBinding(expected[side], current[side]) ||
        Boolean(expected[side].repository) !== Boolean(current[side].repository) ||
        (expected[side].repository && !sameBinding(expected[side].repository, current[side].repository))) {
      const error = new Error(`The ${side} project directory or repository changed before delivery. No message was sent.`);
      error.code = "PROJECT_SCOPE_CHANGED";
      throw error;
    }
  }
  return current;
}
