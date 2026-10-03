import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { directoryBinding, repositoryBinding, editProjectGrant, readProjectPolicy, createProjectScope } from "./project-policy.mjs";

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const samePath = (a, b) => path.relative(a, b) === "";
const inside = (a, b) => { const r = path.relative(a, b); return r === "" || (!path.isAbsolute(r) && r !== ".." && !r.startsWith(`..${path.sep}`)); };

export function onboardingPaths(env = process.env) {
  if (env.CODEX_BRIDGE_HARDENED === "1") throw new Error("Project onboarding cannot change a hardened deployment's pinned roots");
  if (!env.CODEX_BRIDGE_PROJECT_POLICY || !path.isAbsolute(env.CODEX_BRIDGE_PROJECT_POLICY)) throw new Error("Configure the shared CODEX_BRIDGE_PROJECT_POLICY before onboarding projects");
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const configFile = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json");
  if (!path.isAbsolute(configFile)) throw new Error("Claude configuration directory must be absolute");
  if (samePath(configFile, env.CODEX_BRIDGE_PROJECT_POLICY)) throw new Error("Trust configuration and project policy must be separate files");
  return { configFile, policyFile: env.CODEX_BRIDGE_PROJECT_POLICY, home };
}

function read(file, maxBytes = MAX_CONFIG_BYTES) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error(`Refusing linked, nonregular or oversized configuration: ${file}`);
  const raw = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(raw) > maxBytes) throw new Error(`Configuration exceeds size limit: ${file}`);
  return raw;
}
function parse(raw) {
  const value = raw === null ? {} : JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (!object(value)) throw new Error("Configuration must be a JSON object");
  return value;
}

function target(cwd, options) {
  const directory = directoryBinding(cwd);
  const repo = repositoryBinding(directory.path, options);
  // A failed Git check must not accidentally trust a worktree as an unrelated folder.
  if (!repo) {
    for (let dir = directory.path;; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".git"))) throw new Error("Git metadata exists but repository identity could not be verified. Check ownership/Git availability; no trust or grants were changed.");
      if (path.dirname(dir) === dir) break;
    }
  }
  const root = repo?.primary ?? directory;
  if (samePath(root.path, path.parse(root.path).root) || samePath(root.path, directoryBinding(options.home).path)) throw new Error("Choose an exact project, not a drive root or the user home directory");
  return { directory, root, repo, key: root.path.split(path.sep).join("/") };
}

function trustEntry(config, project) {
  if (config.projects !== undefined && !object(config.projects)) throw new Error("Invalid Claude projects configuration");
  const keys = Object.keys(config.projects ?? {}).filter(k => path.isAbsolute(k) && samePath(k, project.root.path));
  if (keys.length > 1) throw new Error("Ambiguous duplicate Claude trust paths; review them before onboarding");
  const key = keys[0] ?? project.key;
  const entry = config.projects?.[key];
  if (entry !== undefined && !object(entry)) throw new Error("Invalid Claude project configuration");
  return { key, trusted: entry?.hasTrustDialogAccepted === true };
}

function denied(policy, project) {
  return policy.denies.filter(d => inside(d.path, project.directory.path) || inside(d.path, project.root.path)
    || (d.repository && project.repo && samePath(d.repository.path, project.repo.common.path)));
}

function load(cwd, options) {
  const files = onboardingPaths(options.env);
  const project = target(cwd, { ...options, home: files.home });
  const configRaw = read(files.configFile);
  const config = parse(configRaw);
  const trust = trustEntry(config, project);
  const policyRaw = read(files.policyFile, 256 * 1024);
  const policy = policyRaw === null ? { version: 1, grants: [], denies: [] } : readProjectPolicy(files.policyFile).policy;
  const denials = denied(policy, project);
  const authorized = policyRaw !== null && createProjectScope(files.policyFile, options).allows(project.directory.path);
  return { files, project, configRaw, config, trust, policyRaw, policy, denials, authorized };
}

function report(state, taskCards, extra = {}) {
  const configured = state.trust.trusted && state.authorized;
  return {
    status: configured ? "configured" : "needs_setup",
    project: { cwd: state.project.directory.path, root: state.project.root.path, kind: state.project.repo ? "git" : "directory", repository: state.project.repo?.common.path ?? null },
    workspaceTrust: { status: state.trust.trusted ? "configured" : "missing", file: state.files.configFile, key: state.trust.key },
    communicationAuthorization: { status: state.authorized ? "authorized" : state.denials.length ? "revoked" : "missing", file: state.files.policyFile },
    connection: { status: "not_tested", ready: null, detail: "Saved configuration does not prove a live sender, target, tool permission or successful round trip." },
    taskCards: { status: taskCards ? "requires_extension_check" : "not_requested", detail: "The card extension owns its authorization and connection; this tool does not edit its settings or restart it." },
    nextActions: [
      ...(!configured ? [{ tool: "prepare_bridge_project", cwd: state.project.directory.path }] : []),
      ...(taskCards ? [{ component: "Local Card Bridge Desktop", tool: "list_projects", cwd: state.project.root.path, then: "If absent, use authorize_project for this exact project under the user's onboarding request; verify desktop_bridge_info after saving. Stop on any denial or disconnected extension." }] : []),
      { tools: ["claude_bridge_status", "codex_bridge_status"], then: "Check in the actual calling sessions, then perform one authorized round trip in each direction. Do not create a new conversation without user authorization." },
    ],
    ...extra,
  };
}

export function inspectBridgeProject({ cwd, taskCards = false }, options = {}) {
  return report(load(cwd, options), taskCards);
}

// Two small configuration files, not a fake 'connected' flag. Preserve full backups,
// compare before replacement, and roll back only bytes this transaction still owns.
export function prepareBridgeProject({ cwd, reauthorize = false, taskCards = false }, options = {}) {
  const files = onboardingPaths(options.env);
  const locks = [], changed = [], backups = [];
  const suffix = randomUUID();
  const pending = [];
  try {
    for (const file of [files.configFile + ".bridge-setup.lock", files.policyFile + ".lock"].sort()) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, "wx", 0o600);
      locks.push({ file, fd });
    }
    const state = load(cwd, options);
    if (state.denials.length && !reauthorize) throw new Error("Project access was revoked. Re-onboarding does not clear a revocation; reauthorize=true requires the user's explicit request.");
    const nextConfig = structuredClone(state.config);
    nextConfig.projects ??= {};
    nextConfig.projects[state.trust.key] = { ...nextConfig.projects[state.trust.key], hasTrustDialogAccepted: true };
    const nextPolicy = structuredClone(state.policy);
    if (!state.authorized) editProjectGrant(nextPolicy, "allow-project", state.project.root.path, options);
    if (denied(nextPolicy, state.project).length) throw new Error("An enclosing directory is revoked. Project onboarding cannot remove a parent-directory revocation.");
    const changes = [
      { file: files.configFile, before: state.configRaw, after: state.trust.trusted ? state.configRaw : JSON.stringify(nextConfig, null, 2) + "\n" },
      { file: files.policyFile, before: state.policyRaw, after: state.authorized ? state.policyRaw : JSON.stringify(nextPolicy, null, 2) + "\n" },
    ].filter(item => item.before !== item.after);
    const checkTarget = () => {
      const now = target(cwd, { ...options, home: files.home });
      if (JSON.stringify(now) !== JSON.stringify(state.project)) throw new Error("Project directory or repository changed during onboarding");
    };
    for (const item of changes) {
      if (read(item.file) !== item.before) throw new Error("Configuration changed concurrently; retry inspection before applying");
      if (item.before !== null) {
        const backup = `${item.file}.backup-${suffix}`;
        fs.copyFileSync(item.file, backup, fs.constants.COPYFILE_EXCL);
        backups.push(backup);
      }
      item.temp = `${item.file}.pending-${suffix}`;
      pending.push(item.temp);
      const fd = fs.openSync(item.temp, "wx", 0o600);
      try { fs.writeFileSync(fd, item.after); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (item.file === files.policyFile) readProjectPolicy(item.temp);
    }
    options.beforeCommit?.(); // Deterministic fault/race injection in isolated tests.
    checkTarget();
    for (const item of changes) {
      if (read(item.file) !== item.before) throw new Error("Configuration changed concurrently; no overwrite attempted");
    }
    for (const item of changes) {
      checkTarget();
      if (read(item.file) !== item.before) throw new Error("Configuration changed concurrently; no overwrite attempted");
      fs.renameSync(item.temp, item.file);
      changed.push(item);
      options.afterWrite?.(item.file);
    }
    const verified = load(cwd, options);
    if (!verified.trust.trusted || !verified.authorized) throw new Error("Saved configuration failed readback verification");
    return report(verified, taskCards, { changedFiles: changed.map(i => i.file), backups, idempotent: changed.length === 0 });
  } catch (error) {
    const remaining = [];
    for (const item of changed.reverse()) {
      try {
        if (read(item.file) !== item.after) { remaining.push(item.file); continue; }
        if (item.before === null) fs.unlinkSync(item.file);
        else {
          const temp = `${item.file}.rollback-${suffix}`;
          pending.push(temp);
          fs.writeFileSync(temp, item.before, { flag: "wx", mode: 0o600 });
          fs.renameSync(temp, item.file);
        }
      } catch { remaining.push(item.file); }
    }
    error.onboarding = { status: remaining.length ? "partial_needs_review" : "failed", remainingFiles: remaining, backups, connection: { status: "not_tested", ready: null } };
    throw error;
  } finally {
    for (const file of pending) { try { fs.rmSync(file, { force: true }); } catch {} }
    for (const lock of locks.reverse()) { fs.closeSync(lock.fd); fs.rmSync(lock.file); }
  }
}
