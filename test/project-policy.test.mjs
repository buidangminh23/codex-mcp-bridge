import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createProjectScope, editProjectGrant, readProjectPolicy, updateProjectPolicy } from "../src/project-policy.mjs";
import { createHardenedRootPolicy } from "../src/hardened-root-policy.mjs";
import { BridgeSecurityPolicy } from "../src/security-policy.mjs";
import { bridgeReadiness } from "../src/bridge-readiness.mjs";
import { captureProjectScope } from "../src/project-scope.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-project-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "projects");
  fs.mkdirSync(parent);
  const file = path.join(root, "policy.json");
  updateProjectPolicy(file, () => {});
  const edit = (action, directory) => updateProjectPolicy(file, (policy) => editProjectGrant(policy, action, directory));
  const scope = createProjectScope(file);
  return { root, parent, file, edit, scope };
}
function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" }); }
function repo(f, name = "案例项目") {
  const main = path.join(f.parent, name);
  fs.mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "-c", "user.name=Bridge test", "-c", "user.email=bridge@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  const worktree = path.join(f.root, `outside-${name}`);
  git(main, "worktree", "add", "--detach", worktree);
  return { main, worktree };
}

test("a new project and its registered outside worktree inherit an authorized parent without per-project configuration", (t) => {
  const f = fixture(t);
  f.edit("allow-parent", f.parent);
  const { main, worktree } = repo(f);
  assert.equal(f.scope.allows(main), true);
  assert.equal(f.scope.allows(worktree), true);
  assert.equal(f.scope.capture(worktree).authorizedBy.path, fs.realpathSync.native(f.parent));
  const readiness = bridgeReadiness({ sender: { status: "verified", cwd: main }, scope: f.scope, targetCwd: worktree, verifyTargetProject: captureProjectScope });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.target.sameProject, true);
  assert.equal(readiness.target.authorizedBy.path, fs.realpathSync.native(f.parent));
  assert.equal(readiness.target.repository.path, fs.realpathSync.native(path.join(main, ".git")));
  const security = new BridgeSecurityPolicy({ CODEX_BRIDGE_PROJECT_POLICY: f.file, CODEX_BRIDGE_ALLOWED_ROOTS: "", CODEX_BRIDGE_THREAD_POLICY: "roots" });
  assert.equal(security.isThreadAuthorized("future-thread", worktree), true);
  assert.equal(security.summary().allowAllRoots, false);
});

test("an authorized destination in another repository is not ready for same-project delivery", (t) => {
  const f = fixture(t);
  const { main } = repo(f, "sender");
  const { main: other } = repo(f, "recipient");
  f.edit("allow-parent", f.parent);
  const readiness = bridgeReadiness({ sender: { status: "verified", cwd: main }, scope: f.scope, targetCwd: other, verifyTargetProject: captureProjectScope });
  assert.equal(readiness.target.authorized, true);
  assert.equal(readiness.target.sameProject, false);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues.map(issue => issue.code), ["PROJECT_SCOPE_MISMATCH"]);
});

test("granting an outside project once enables its main directory, worktree and future sessions", (t) => {
  const f = fixture(t); const { main, worktree } = repo(f);
  assert.equal(f.scope.allows(worktree), false);
  f.edit("allow-project", worktree);
  assert.equal(f.scope.allows(main), true);
  assert.equal(f.scope.allows(worktree), true);
  const reloaded = createProjectScope(f.file);
  assert.equal(reloaded.allows(main), true);
});

test("revocation applies live to all worktrees and beats parent grants until explicit project reauthorization", (t) => {
  const f = fixture(t); const { main, worktree } = repo(f);
  f.edit("allow-parent", f.parent);
  const binding = f.scope.capture(worktree);
  f.edit("revoke", worktree);
  assert.equal(f.scope.allows(main), false);
  assert.throws(() => f.scope.recheck(binding), /revoked/);
  f.edit("allow-parent", f.parent);
  assert.equal(f.scope.allows(worktree), false);
  f.edit("allow-project", main);
  assert.equal(f.scope.allows(worktree), true);
});

test("a forged git pointer cannot impersonate a registered worktree outside scope", (t) => {
  const f = fixture(t); const { main, worktree } = repo(f);
  f.edit("allow-project", main);
  const fake = path.join(f.root, "forged"); fs.mkdirSync(fake);
  fs.copyFileSync(path.join(worktree, ".git"), path.join(fake, ".git"));
  assert.equal(f.scope.allows(fake), false);
  assert.equal(f.scope.allows(f.root), false);
});

test("symlink escapes and similar directory prefixes do not inherit parent authorization", (t) => {
  const f = fixture(t); f.edit("allow-parent", f.parent);
  const outside = path.join(f.root, "projects-other"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.parent, "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(f.scope.allows(outside), false);
  assert.equal(f.scope.allows(path.join(f.parent, "escape")), false);
});

test("non-Git projects use directory scope and pending operations detect replacement", (t) => {
  const f = fixture(t); f.edit("allow-project", f.parent);
  const binding = f.scope.capture(f.parent);
  fs.renameSync(f.parent, `${f.parent}-old`); fs.mkdirSync(f.parent);
  assert.equal(f.scope.allows(f.parent), false);
  assert.throws(() => f.scope.recheck(binding), /not authorized|replaced/);
});

test("malformed, missing and oversized policy fail closed instead of falling back to legacy wildcard roots", (t) => {
  const f = fixture(t); f.edit("allow-parent", f.parent);
  const security = new BridgeSecurityPolicy({ CODEX_BRIDGE_PROJECT_POLICY: f.file, CODEX_BRIDGE_ALLOWED_ROOTS: "*" });
  fs.writeFileSync(f.file, "{");
  assert.equal(security.isCwdAuthorized(f.parent), false);
  assert.throws(() => security.assertCwd(f.parent));
  assert.ok(security.summary().projectPolicy.error);
  fs.writeFileSync(f.file, " ".repeat(300000));
  assert.throws(() => readProjectPolicy(f.file), /size limit/);
  fs.rmSync(f.file);
  assert.equal(security.isCwdAuthorized(f.parent), false);
});

test("shared policy does not silently replace a hardened profile", (t) => {
  const f = fixture(t);
  assert.throws(() => createHardenedRootPolicy({ CODEX_BRIDGE_HARDENED: "1", CODEX_BRIDGE_PROJECT_POLICY: f.file }), /cannot replace/);
});

test("scope policy writes are serialized, preserve the old file on errors, and keep backups", (t) => {
  const f = fixture(t); const original = fs.readFileSync(f.file, "utf8");
  fs.writeFileSync(`${f.file}.lock`, "");
  assert.throws(() => f.edit("allow-parent", f.parent), /EEXIST/);
  fs.rmSync(`${f.file}.lock`);
  assert.throws(() => updateProjectPolicy(f.file, () => { throw new Error("abort"); }), /abort/);
  assert.equal(fs.readFileSync(f.file, "utf8"), original);
  f.edit("allow-parent", f.parent);
  assert.ok(fs.readdirSync(f.root).some((name) => name.startsWith("policy.json.backup-")));
});

test("readiness diagnoses unknown callers and out-of-scope targets before sending", (t) => {
  const f = fixture(t); f.edit("allow-parent", f.parent);
  const sender = { status: "verified", cwd: f.parent, taskId: "existing" };
  assert.equal(bridgeReadiness({ sender, scope: f.scope, targetCwd: f.parent }).ready, true);
  assert.equal(bridgeReadiness({ sender, scope: f.scope, targetCwd: f.parent }).readyScope, "transport-identity-and-project");
  const bad = bridgeReadiness({ sender: { status: "unavailable", reason: "shared entry" }, scope: f.scope, targetCwd: f.root });
  assert.deepEqual(bad.issues.map((issue) => issue.code), ["SENDER_UNVERIFIED", "TARGET_NOT_AUTHORIZED"]);
});

test("repository-bound project grants reject missing, broken and replaced Git metadata", (t) => {
  for (const change of ["missing", "broken", "replaced"]) {
    const f = fixture(t); const { main } = repo(f, change);
    f.edit("allow-project", main);
    fs.renameSync(path.join(main, ".git"), path.join(f.root, "saved-git"));
    if (change === "broken") fs.writeFileSync(path.join(main, ".git"), "gitdir: missing\n");
    if (change === "replaced") git(main, "init", "-b", "main");
    assert.equal(createProjectScope(f.file).allows(main), false, change);
  }
});

test("revocation retains registered worktree paths when their Git metadata disappears", (t) => {
  const f = fixture(t); const { main } = repo(f);
  const linked = path.join(f.parent, "linked");
  git(main, "worktree", "add", "--detach", linked);
  f.edit("allow-parent", f.parent);
  f.edit("revoke", main);
  fs.renameSync(path.join(linked, ".git"), path.join(f.root, "saved-pointer"));
  assert.equal(createProjectScope(f.file).allows(linked), false);
  f.edit("allow-project", main);
  assert.equal(f.scope.allows(linked), true);
});

test("revocation preserves saved repository evidence after missing metadata or directories", (t) => {
  for (const change of ["metadata", "directory"]) {
    const f = fixture(t); const { main, worktree } = repo(f, change);
    f.edit("allow-parent", f.parent);
    f.edit("allow-project", worktree);
    fs.renameSync(change === "metadata" ? path.join(worktree, ".git") : worktree, path.join(f.root, "removed"));
    f.edit("revoke", worktree);
    assert.equal(createProjectScope(f.file).allows(main), false, change);
  }
});

test("repository revocation survives common directory replacement under an authorized parent", (t) => {
  const f = fixture(t); const { main, worktree } = repo(f);
  f.edit("allow-parent", f.parent);
  f.edit("revoke", worktree);
  fs.renameSync(path.join(main, ".git"), path.join(f.root, "saved-common"));
  git(main, "init", "-b", "main");
  assert.equal(createProjectScope(f.file).allows(main), false);
  f.edit("allow-project", main);
  assert.equal(f.scope.allows(main), true);
});

test("broken Git metadata cannot downgrade to an authorized plain folder", (t) => {
  const f = fixture(t);
  f.edit("allow-parent", f.parent);
  const broken = path.join(f.parent, "broken"); fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, ".git"), "gitdir: missing\n");
  assert.equal(f.scope.allows(broken), false);
  assert.throws(() => f.edit("allow-project", broken), /repository|Git/);
  const plain = path.join(f.parent, "plain"); fs.mkdirSync(plain);
  assert.equal(f.scope.allows(plain), true);
});


test("revocation refreshes late worktrees through the saved common directory after its grant path disappears", (t) => {
  const f = fixture(t); const { main, worktree } = repo(f);
  f.edit("allow-parent", f.parent);
  f.edit("allow-project", worktree);
  const late = path.join(f.parent, "late");
  git(main, "worktree", "add", "--detach", late);
  fs.renameSync(worktree, path.join(f.root, "removed-grant"));
  f.edit("revoke", worktree);
  assert.equal(f.scope.allows(late), false);
  fs.renameSync(path.join(late, ".git"), path.join(f.root, "late-pointer"));
  assert.equal(createProjectScope(f.file).allows(late), false);
});


test("revocation retains saved denials when the common Git directory is corrupt", (t) => {
  const f = fixture(t); const { main, worktree } = repo(f);
  f.edit("allow-parent", f.parent);
  f.edit("allow-project", worktree);
  fs.renameSync(path.join(main, ".git", "HEAD"), path.join(f.root, "saved-head"));
  f.edit("revoke", worktree);
  const policy = readProjectPolicy(f.file).policy;
  assert.equal(policy.grants.some(entry => entry.kind === "project"), false);
  assert.equal(policy.denies.length, 1);
  assert.match(f.scope.status().warnings.join(" "), /discovery failed/);
  fs.renameSync(path.join(worktree, ".git"), path.join(f.root, "saved-worktree-pointer"));
  assert.equal(f.scope.allows(worktree), false);
});
