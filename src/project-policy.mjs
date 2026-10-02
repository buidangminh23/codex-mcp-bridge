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

export function directoryBinding(input) {
  if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("Project paths must be absolute directories");
  const resolved = fs.realpathSync.native(input);
  const stat = fs.statSync(resolved, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Project path is not a directory");
  return { path: resolved, identity: `${stat.dev}:${stat.ino}:${stat.birthtimeNs ?? stat.birthtimeMs}` };
}

// Git reports membership; comparing a .git pointer alone would accept a forged checkout.
export function repositoryBinding(cwd, { git = "git", env = process.env } = {}) {
  const gitEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
  const run = (args) => execFileSync(git, ["--no-optional-locks", "-C", cwd, ...args], {
    env: gitEnv, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const top = directoryBinding(run(["rev-parse", "--show-toplevel"]).trim());
    const common = directoryBinding(run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
    const worktrees = run(["worktree", "list", "--porcelain", "-z"]).split("\0")
      .filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
    if (!worktrees.some((root) => { try { return equal(directoryBinding(root).path, top.path); } catch { return false; } })) return null;
    const primary = directoryBinding(worktrees[0]);
    return { common, primary, top };
  } catch { return null; }
}

export function scopeEntry(input, kind, options) {
  if (!["project", "parent"].includes(kind)) throw new Error("Scope kind must be project or parent");
  const directory = directoryBinding(input);
  if (path.parse(directory.path).root === directory.path) throw new Error("Authorize a project or parent folder, not an entire drive");
  const repo = kind === "project" ? repositoryBinding(directory.path, options) : null;
  return { kind, ...directory, ...(repo ? { repository: repo.common } : {}) };
}

function validateBinding(binding) {
  if (!binding || typeof binding.path !== "string" || !path.isAbsolute(binding.path) || typeof binding.identity !== "string" || !binding.identity) throw new Error("Invalid stored directory identity");
}

export function readProjectPolicy(file) {
  if (!path.isAbsolute(file)) throw new Error("CODEX_BRIDGE_PROJECT_POLICY must be an absolute file path");
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Project policy exceeds its file size limit");
  const raw = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Project policy exceeds its file size limit");
  const policy = JSON.parse(raw);
  if (policy.version !== 1 || !Array.isArray(policy.grants) || !Array.isArray(policy.denies) || policy.grants.length + policy.denies.length > 512) throw new Error("Invalid project policy schema");
  for (const entry of [...policy.grants, ...policy.denies]) {
    if (!["project", "parent"].includes(entry.kind)) throw new Error("Invalid project policy entry kind");
    validateBinding(entry);
    if (entry.repository) validateBinding(entry.repository);
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
    const repository = () => repo === undefined ? (repo = repositoryBinding(directory.path, options)) : repo;
    const matches = (entry, deny = false) => {
      // Denials keep blocking their path even if that directory has been replaced.
      if ((deny || current(entry)) && inside(entry.path, directory.path)) return true;
      const actual = repository();
      if (!actual) return false;
      if (entry.repository && (deny || current(entry.repository)) && sameRepository(entry.repository, actual.common)) return true;
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
          warnings: stale.map((entry) => `Authorization path is missing or replaced: ${entry.path}`),
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
    const exists = fs.existsSync(file);
    const policy = exists ? readProjectPolicy(file).policy : { version: 1, grants: [], denies: [] };
    const before = JSON.stringify(policy);
    edit(policy);
    if (exists && JSON.stringify(policy) === before) return policy;
    fs.writeFileSync(temporary, `${JSON.stringify(policy, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    readProjectPolicy(temporary);
    if (exists) fs.copyFileSync(file, `${file}.backup-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temporary, file);
    return policy;
  } finally {
    fs.closeSync(handle);
    fs.rmSync(temporary, { force: true });
    fs.rmSync(lock);
  }
}

export function editProjectGrant(policy, action, input, options) {
  const entry = scopeEntry(input, action === "allow-parent" ? "parent" : "project", options);
  const same = (other) => equal(other.path, entry.path) || sameRepository(other.repository, entry.repository);
  if (action === "revoke") {
    policy.grants = policy.grants.filter((other) => !same(other));
    policy.denies = [...policy.denies.filter((other) => !same(other)), entry];
  } else if (["allow-project", "allow-parent"].includes(action)) {
    // Authorizing a parent never clears its children's explicit revocations.
    policy.denies = policy.denies.filter((other) => !same(other));
    policy.grants = [...policy.grants.filter((other) => !same(other)), entry];
  } else throw new Error(`Unknown authorization action: ${action}`);
}
