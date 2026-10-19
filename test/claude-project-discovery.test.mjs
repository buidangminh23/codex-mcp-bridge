import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { discoverClaudeProject } from "../src/claude-project-discovery.mjs";
import { createProjectScope, editProjectGrant, updateProjectPolicy } from "../src/project-policy.mjs";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "claude-project-discovery-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, "previous", "project");
  const current = path.join(root, "current", "project");
  fs.mkdirSync(current, { recursive: true });
  const file = path.join(root, "policy.json");
  updateProjectPolicy(file, () => {});
  const policy = createProjectScope(file);
  const edit = (action, directory) => updateProjectPolicy(file, document => editProjectGrant(document, action, directory));
  const task = { taskId: "saved-task", fileTaskId: "saved-task", isArchived: false, cwd: original };
  const calls = [];
  const resolveWorkspace = (directory, options) => {
    calls.push({ directory, options });
    return { path: current, remapped: true, writable: true };
  };
  return { root, original, current, file, policy, edit, task, calls, resolveWorkspace };
}

test("missing saved paths discover an authorized current directory with a unique resolver result", async t => {
  const f = fixture(t);
  f.edit("allow-project", f.current);
  const result = await discoverClaudeProject(f.task, f);
  assert.equal(result.cwd, f.current);
  assert.equal(result.originalCwd, f.original);
  assert.equal(result.relocated, true);
  assert.equal(f.policy.recheck(result.binding), f.current);
  assert.deepEqual(f.calls, [{ directory: f.original, options: { requireUnique: true } }]);
});

test("an existing authorized directory is used without invoking relocation", async t => {
  const f = fixture(t);
  f.edit("allow-project", f.current);
  const result = await discoverClaudeProject({ ...f.task, cwd: f.current }, f);
  assert.equal(result.cwd, f.current);
  assert.equal(result.originalCwd, f.current);
  assert.equal(result.relocated, false);
  assert.equal(f.policy.recheck(result.binding), f.current);
  assert.deepEqual(f.calls, []);
});

for (const authorization of ["missing", "revoked"]) {
  test(`a relocated destination with ${authorization} authorization is rejected`, async t => {
    const f = fixture(t);
    if (authorization === "revoked") {
      f.edit("allow-project", f.current);
      f.edit("revoke", f.current);
    }
    assert.equal(await discoverClaudeProject(f.task, f), null);
  });
}

test("relocation cannot discard a revocation attached to the original path", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.original, { recursive: true });
  f.edit("allow-project", f.original);
  f.edit("revoke", f.original);
  fs.renameSync(f.original, path.join(f.root, "revoked-directory"));
  f.edit("allow-project", f.current);
  assert.equal(await discoverClaudeProject(f.task, f), null);
  assert.deepEqual(f.calls, []);
});

test("relocation preserves source revocation when its missing ancestor is replaced by a junction", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.original, { recursive: true });
  f.edit("allow-project", f.original);
  f.edit("revoke", f.original);
  const originalParent = path.dirname(f.original);
  const preservedParent = path.join(f.root, "preserved-parent");
  const replacementParent = path.join(f.root, "replacement-parent");
  assert.equal(path.dirname(originalParent), f.root);
  assert.equal(path.dirname(preservedParent), f.root);
  fs.renameSync(originalParent, preservedParent);
  fs.mkdirSync(replacementParent);
  fs.symlinkSync(replacementParent, originalParent, process.platform === "win32" ? "junction" : "dir");
  f.edit("allow-project", f.current);
  assert.throws(() => fs.realpathSync.native(f.original), { code: "ENOENT" });
  assert.equal(await discoverClaudeProject(f.task, f), null);
  assert.deepEqual(f.calls, []);
});

for (const [label, task] of [["null task", null], ["empty task", {}], ["archived task", { isArchived: true }], ["unknown archive state", { isArchived: undefined }], ["mismatched identity", { taskId: "different-task" }], ["missing file identity", { fileTaskId: undefined }], ["relative directory", { cwd: "relative/project" }], ["missing directory", { cwd: "" }]]) {
  test(`invalid saved metadata fails before relocation: ${label}`, async t => {
    const f = fixture(t);
    f.edit("allow-project", f.current);
    const candidate = task === null ? null : Object.keys(task).length ? { ...f.task, ...task } : {};
    assert.equal(await discoverClaudeProject(candidate, f), null);
    assert.deepEqual(f.calls, []);
  });
}

test("an existing denied original directory cannot fall back to an authorized destination", async t => {
  const f = fixture(t);
  fs.mkdirSync(f.original, { recursive: true });
  f.edit("allow-project", f.original);
  f.edit("revoke", f.original);
  f.edit("allow-project", f.current);
  assert.equal(await discoverClaudeProject(f.task, f), null);
  assert.deepEqual(f.calls, []);
});

test("an existing original file cannot trigger directory relocation", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.original), { recursive: true });
  fs.writeFileSync(f.original, "occupied");
  f.edit("allow-project", f.current);
  assert.equal(await discoverClaudeProject(f.task, f), null);
  assert.deepEqual(f.calls, []);
});

test("a dangling original symlink cannot trigger relocation", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.original), { recursive: true });
  fs.symlinkSync(path.join(f.root, "missing-target"), f.original, process.platform === "win32" ? "junction" : "dir");
  f.edit("allow-project", f.current);
  assert.equal(await discoverClaudeProject(f.task, f), null);
  assert.deepEqual(f.calls, []);
});

test("legacy authorization cannot relocate a saved project", async t => {
  const f = fixture(t);
  f.edit("allow-project", f.current);
  const policy = { ...f.policy, mode: "legacy", assertDiscoverySource: () => {} };
  assert.equal(await discoverClaudeProject(f.task, { ...f, policy }), null);
  assert.deepEqual(f.calls, []);
});

test("ambiguous resolver failures fail closed", async t => {
  const f = fixture(t);
  f.edit("allow-project", f.current);
  const resolveWorkspace = () => { throw new Error("Ambiguous workspace candidates"); };
  assert.equal(await discoverClaudeProject(f.task, { ...f, resolveWorkspace }), null);
});

test("a remapped symlink cannot escape an authorized parent directory", async t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  const alias = path.join(path.dirname(f.current), "escape");
  fs.symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  f.edit("allow-parent", path.dirname(f.current));
  const resolveWorkspace = () => ({ path: alias, remapped: true, writable: true });
  assert.equal(await discoverClaudeProject(f.task, { ...f, resolveWorkspace }), null);
});

for (const result of [{ remapped: false, writable: true }, { remapped: true, writable: false }]) {
  test(`relocation requires both remapped and writable flags: ${JSON.stringify(result)}`, async t => {
    const f = fixture(t);
    f.edit("allow-project", f.current);
    const resolveWorkspace = () => ({ path: f.current, ...result });
    assert.equal(await discoverClaudeProject(f.task, { ...f, resolveWorkspace }), null);
  });
}

for (const replacement of ["directory", "repository", "revocation"]) {
  test(`the discovered binding rejects subsequent ${replacement} changes`, async t => {
    const f = fixture(t);
    if (replacement === "repository") execFileSync("git", ["-C", f.current, "init", "-b", "main"], { stdio: "pipe", windowsHide: true });
    f.edit("allow-parent", path.dirname(f.current));
    const result = await discoverClaudeProject(f.task, f);
    assert.ok(result?.binding);
    if (replacement === "directory") {
      fs.renameSync(f.current, `${f.current}-previous`);
      fs.mkdirSync(f.current);
    } else if (replacement === "repository") {
      fs.renameSync(path.join(f.current, ".git"), path.join(f.current, ".git-previous"));
      execFileSync("git", ["-C", f.current, "init", "-b", "main"], { stdio: "pipe", windowsHide: true });
    } else {
      f.edit("revoke", f.current);
    }
    assert.throws(() => f.policy.recheck(result.binding), /replaced|revoked|not authorized/);
  });
}
