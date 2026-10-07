import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
const equal = (a, b) => path.relative(a, b) === "";

export function readRegularConfigFile(file, { maxBytes = MAX_BYTES, missing = false, encoding = "utf8", label = "Configuration" } = {}) {
  let entry;
  try { entry = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (missing && error.code === "ENOENT") return null; throw error; }
  const valid = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size <= BigInt(maxBytes);
  const matches = (left, right) => ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every(field => left[field] === right[field]);
  if (!valid(entry)) throw new Error(`${label}: refusing linked or nonregular file, or exceeded size limit`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!valid(before) || !matches(entry, before)) throw new Error(`${label} changed during access`);
    const data = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    if (offset !== Number(before.size) || !valid(after) || !valid(current) || !matches(before, after) || !matches(after, current)) throw new Error(`${label} changed during access`);
    const bytes = data.subarray(0, offset);
    return encoding === null ? bytes : bytes.toString(encoding);
  } finally { fs.closeSync(fd); }
}

export function backupRegularConfigFile(file, backup, expected, maxBytes = MAX_BYTES) {
  const bytes = readRegularConfigFile(file, { maxBytes, encoding: null });
  if (bytes.toString("utf8") !== expected) throw new Error("Configuration changed concurrently before backup");
  fs.writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
}

export function directoryBinding(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("Project paths must be absolute directories");
  const resolved = fs.realpathSync.native(input);
  const stat = fs.statSync(resolved, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Project path is not a directory");
  return { path: resolved, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs ?? stat.birthtimeMs}` };
}

// Git reports membership; comparing a .git pointer alone would accept a forged checkout.
export function repositoryBinding(cwd, { git = "git", env = process.env, strict = false } = {}) {
  let marker = false;
  for (let root = cwd; ; root = path.dirname(root)) {
    try { fs.lstatSync(path.join(root, ".git")); marker = true; break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (path.dirname(root) === root) break;
  }
  if (!marker) return null;
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
  const run = (args) => execFileSync(git, ["--no-optional-locks", "-C", cwd, ...args], {
    env: gitEnv, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const top = directoryBinding(run(["rev-parse", "--show-toplevel"]).trim());
    const common = directoryBinding(run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
    const worktrees = run(["worktree", "list", "--porcelain", "-z"]).split("\0")
      .filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
    if (!worktrees.some((root) => { try { return equal(directoryBinding(root).path, top.path); } catch { return false; } })) throw new Error("Git worktree is not registered");
    const primary = directoryBinding(worktrees[0]);
    return { common, primary, top, worktrees: worktrees.flatMap((root) => { try { return [directoryBinding(root)]; } catch { return []; } }) };
  } catch (cause) {
    if (strict) throw new Error("Git repository identity could not be verified", { cause });
    return null;
  }
}

export function scopeEntry(input, kind, options) {
  if (!["project", "parent"].includes(kind)) throw new Error("Scope kind must be project or parent");
  const directory = directoryBinding(input);
  if (path.parse(directory.path).root === directory.path) throw new Error("Authorize a project or parent folder, not an entire drive");
  const repo = kind === "project" ? repositoryBinding(directory.path, { ...options, strict: true }) : null;
  return { kind, ...directory, ...(repo ? { repository: repo.common, worktrees: repo.worktrees } : {}) };
}

function validateBinding(binding) {
  if (!binding || typeof binding.path !== "string" || !path.isAbsolute(binding.path) || typeof binding.identity !== "string" || !binding.identity) throw new Error("Invalid stored directory identity");
}

export function readProjectPolicy(file) {
  if (!path.isAbsolute(file)) throw new Error("CODEX_BRIDGE_PROJECT_POLICY must be an absolute file path");
  const raw = readRegularConfigFile(file, { label: "Project policy" });
  return parseProjectPolicy(raw);
}

export function parseProjectPolicy(raw) {
  const policy = JSON.parse(raw);
  if (policy.version !== 1 || !Array.isArray(policy.grants) || !Array.isArray(policy.denies) || policy.grants.length + policy.denies.length > 512) throw new Error("Invalid project policy schema");
  for (const entry of [...policy.grants, ...policy.denies]) {
    if (!["project", "parent"].includes(entry.kind)) throw new Error("Invalid project policy entry kind");
    validateBinding(entry);
    if (entry.repository) validateBinding(entry.repository);
    if (entry.worktrees !== undefined) {
      if (!entry.repository || !Array.isArray(entry.worktrees) || entry.worktrees.length > 512) throw new Error("Invalid stored worktree identities");
      entry.worktrees.forEach(validateBinding);
    }
  }
  return { policy, revision: createHash("sha256").update(raw).digest("hex") };
}

function current(binding) {
  try { const now = directoryBinding(binding.path); return equal(now.path, binding.path) && now.identity === binding.identity; } catch { return false; }
}
const sameRepository = (a, b) => a && b && equal(a.path, b.path) && a.identity === b.identity;

export function createProjectScope(file, options = {}) {
  const inspect = (candidate) => {
    const { policy, revision } = readProjectPolicy(file);
    const directory = directoryBinding(candidate);
    let repo;
    const repository = () => repo === undefined ? (repo = repositoryBinding(directory.path, { ...options, strict: true })) : repo;
    const matches = (entry, deny = false) => {
      // Denials keep blocking their path even if that directory has been replaced.
      if (deny && (inside(entry.path, directory.path) || entry.worktrees?.some((root) => inside(root.path, directory.path)))) return true;
      if (!deny && current(entry) && inside(entry.path, directory.path) &&
          (!entry.repository || sameRepository(entry.repository, repository()?.common))) return true;
      const actual = repository();
      if (!actual) return false;
      if (entry.repository && (deny ? equal(entry.repository.path, actual.common.path) : current(entry.repository) && sameRepository(entry.repository, actual.common))) return true;
      return entry.kind === "parent" && (deny || current(entry)) && inside(entry.path, actual.primary.path);
    };
    if (policy.denies.some((entry) => matches(entry, true))) throw new Error(`Project access was revoked: ${directory.path}. Explicitly reauthorize this project before sending.`);
    const grant = policy.grants.find((entry) => matches(entry));
    if (!grant) throw new Error(`Project is not authorized: ${directory.path}. Authorize this project once with bridge-projects allow-project, or authorize its parent folder.`);
    // Bind repository identity as well as cwd, including when a direct path grant matched.
    const actual = repository();
    return { ...directory, repository: actual?.common ?? null, revision, authorizedBy: { kind: grant.kind, path: grant.path } };
  };
  const capture = (candidate, label = "Working directory") => {
    try { return Object.freeze(inspect(candidate)); }
    catch (error) { throw new Error(`${label}: ${error.message}`, { cause: error }); }
  };
  return Object.freeze({
    enabled: true,
    mode: "project-policy",
    file,
    get roots() { return readProjectPolicy(file).policy.grants.map((entry) => entry.path); },
    assert: (candidate, label) => capture(candidate, label).path,
    allows(candidate) { try { capture(candidate); return true; } catch { return false; } },
    capture,
    recheck(binding, label = "Working directory") {
      if (!binding?.identity) throw new Error(`${label} has no original directory identity`);
      const now = capture(binding.path, label);
      if (now.identity !== binding.identity || !equal(now.path, binding.path) ||
          Boolean(now.repository) !== Boolean(binding.repository) ||
          (now.repository && !sameRepository(now.repository, binding.repository))) throw new Error(`${label} directory or repository was replaced`);
      return now.path;
    },
    same(a, b) { try { return equal(capture(a).path, capture(b).path); } catch { return false; } },
    status(candidate) {
      try {
        const { policy, revision } = readProjectPolicy(file);
        const stale = policy.grants.filter((entry) => !current(entry) || (entry.repository && !current(entry.repository)));
        return { mode: "project-policy", file, revision, grants: policy.grants.length, denies: policy.denies.length,
          warnings: [...stale.map((entry) => `Authorization path is missing or replaced: ${entry.path}`), ...policy.denies.filter(entry => entry.revocationWarning).map(entry => `${entry.path}: ${entry.revocationWarning}`)],
          ...(candidate ? { workspace: inspect(candidate) } : {}) };
      } catch (error) { return { mode: "project-policy", file, error: error.message }; }
    },
  });
}

export function updateProjectPolicy(file, edit) {
  if (!path.isAbsolute(file)) throw new Error("Policy file path must be absolute");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const handle = fs.openSync(lock, "wx", 0o600);
  const temporary = `${file}.pending-${randomUUID()}`;
  try {
    const original = readRegularConfigFile(file, { missing: true, label: "Project policy" });
    const exists = original !== null;
    const policy = exists ? parseProjectPolicy(original).policy : { version: 1, grants: [], denies: [] };
    const before = JSON.stringify(policy);
    edit(policy);
    if (exists && JSON.stringify(policy) === before) return policy;
    fs.writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    readProjectPolicy(temporary);
    if (readRegularConfigFile(file, { missing: true }) !== original) throw new Error("Project policy changed concurrently");
    if (exists) backupRegularConfigFile(file, `${file}.backup-${randomUUID()}`, original);
    fs.renameSync(temporary, file);
    return policy;
  } finally {
    fs.closeSync(handle);
    fs.rmSync(temporary, { force: true });
    fs.rmSync(lock);
  }
}

function canonicalPolicyPath(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("Project paths must be absolute directories");
  let root = path.resolve(input);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(root), ...suffix); }
    catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code) || path.dirname(root) === root) throw error;
      suffix.unshift(path.basename(root));
      root = path.dirname(root);
    }
  }
}

export function projectRevocationEntry(entry, options) {
  let actual;
  try { actual = repositoryBinding(entry.path, options); }
  catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  let registered = [];
  let revocationWarning;
  try {
  if (entry.repository && current(entry.repository)) {
    const { git = "git", env = process.env } = options ?? {};
    const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
    const output = execFileSync(git, ["--no-optional-locks", `--git-dir=${entry.repository.path}`, "worktree", "list", "--porcelain", "-z"], {
      env: gitEnv, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    if (!current(entry.repository)) throw new Error("Repository changed while revoking project access");
    registered = output.split("\0").filter(field => field.startsWith("worktree ")).flatMap(field => {
      try { return [directoryBinding(field.slice(9))]; }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
    });
  }
  } catch { revocationWarning = "Git worktree discovery failed during revocation; saved repository and path denials were retained"; }
  const worktrees = [...(entry.worktrees ?? []), ...registered, ...(sameRepository(entry.repository, actual?.common) ? actual.worktrees : [])];
  return { ...entry, ...(revocationWarning ? { revocationWarning } : {}), ...(entry.repository ? { worktrees: [...new Map(worktrees.map(root => [root.path, root])).values()] } : {}) };
}

export function editProjectGrant(policy, action, input, options) {
  const saved = action === "revoke" ? [...policy.grants, ...policy.denies].find(other => equal(other.path, canonicalPolicyPath(input))) : null;
  const entry = action === "revoke"
    ? projectRevocationEntry(saved ?? scopeEntry(input, "project", options), options)
    : scopeEntry(input, action === "allow-parent" ? "parent" : "project", options);
  const same = (other) => equal(other.path, entry.path) ||
    other.repository && entry.repository && equal(other.repository.path, entry.repository.path) ||
    action === "allow-project" && other.worktrees?.some(root => equal(root.path, entry.path));
  if (action === "revoke") {
    policy.grants = policy.grants.filter((other) => !same(other));
    policy.denies = [...policy.denies.filter((other) => !same(other)), entry];
  } else if (["allow-project", "allow-parent"].includes(action)) {
    // Authorizing a parent never clears its children's explicit revocations.
    policy.denies = policy.denies.filter((other) => !same(other));
    policy.grants = [...policy.grants.filter((other) => !same(other)), entry];
  } else throw new Error(`Unknown authorization action: ${action}`);
}
