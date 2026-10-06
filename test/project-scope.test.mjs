import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { captureProjectScope, recheckProjectScope } from "../src/project-scope.mjs";

const sourceUrl = new URL("../src/project-scope.mjs", import.meta.url).href;
const linkType = process.platform === "win32" ? "junction" : "dir";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-project-scope-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }));
  return root;
}

function directory(root, name) {
  const target = path.join(root, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function git(cwd, ...args) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(cwd, ".scope-empty-global-config"), GIT_TERMINAL_PROMPT: "0" });
  return execFileSync("git", [
    "-c", "user.name=Project Scope Tests",
    "-c", "user.email=project-scope@example.invalid",
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=",
    ...args,
  ], { cwd, env, encoding: "utf8", stdio: "pipe", timeout: 30000 }).trim();
}

function repository(root, name = "repository") {
  const target = directory(root, name);
  git(target, "init", "--quiet", "--initial-branch=main");
  fs.writeFileSync(path.join(target, "README.md"), "Project scope fixture\n");
  git(target, "add", "--", "README.md");
  git(target, "commit", "--quiet", "-m", "Create scope fixture");
  return target;
}

function worktree(root, main, name = "linked worktree") {
  const target = path.join(root, name);
  git(main, "worktree", "add", "--quiet", "--detach", target, "HEAD");
  const gitdir = path.resolve(target, git(target, "rev-parse", "--git-dir"));
  return { target, gitdir };
}

function assertMismatch(sender, recipient) {
  assert.throws(() => captureProjectScope(sender, recipient), { code: "PROJECT_SCOPE_MISMATCH" });
}

it("rejects a forged direct Git directory pointer to another project", (t) => {
  const root = fixture(t);
  const sender = directory(root, "sender");
  const recipient = repository(root, "recipient");
  fs.writeFileSync(path.join(sender, ".git"), `gitdir: ${path.join(recipient, ".git")}\n`);
  assertMismatch(sender, recipient);
});

it("rejects a Git directory symlink to another project", (t) => {
  const root = fixture(t);
  const sender = directory(root, "sender");
  const recipient = repository(root, "recipient");
  fs.symlinkSync(path.join(recipient, ".git"), path.join(sender, ".git"), linkType);
  assert.throws(() => captureProjectScope(sender, recipient), { code: "PROJECT_SCOPE_UNVERIFIED" });
});

it("preserves separate Git directories and canonical aliases", (t) => {
  const root = fixture(t);
  const project = directory(root, "project");
  git(project, "init", "--quiet", "--separate-git-dir", path.join(root, "metadata"));
  const alias = path.join(root, "alias");
  fs.symlinkSync(project, alias, linkType);
  assert.doesNotThrow(() => captureProjectScope(project, alias));
  assert.doesNotThrow(() => captureProjectScope(project, directory(project, "src")));
});

it("rejects repository metadata growing after its initial size check", (t) => {
  const root = fixture(t);
  const project = repository(root);
  const head = path.join(project, ".git", "HEAD");
  let changed = false;
  for (const name of ["statSync", "lstatSync"]) {
    const original = fs[name];
    t.mock.method(fs, name, (file, ...args) => {
      const info = original(file, ...args);
      if (file === head && !changed) {
        changed = true;
        fs.appendFileSync(head, " ".repeat(8192));
      }
      return info;
    });
  }
  assert.throws(() => captureProjectScope(project, project), { code: "PROJECT_SCOPE_UNVERIFIED" });
  assert.equal(changed, true);
});

describe("project directory binding", () => {
  it("permits the same existing directory without a repository", (t) => {
    const project = directory(fixture(t), "project");
    const scope = captureProjectScope(project, project);
    assert.equal(scope.sender.path, fs.realpathSync.native(project));
    assert.equal(scope.recipient.path, scope.sender.path);
    assert.equal(scope.sender.identity, scope.recipient.identity);
    assert.equal(scope.sender.repository, null);
    assert.equal(scope.recipient.repository, null);
    assert.deepEqual(recheckProjectScope(scope), scope);
  });

  it("canonicalizes a directory junction or symlink before comparing projects", (t) => {
    const root = fixture(t);
    const project = directory(root, "project with spaces");
    const alias = path.join(root, "project alias");
    fs.symlinkSync(project, alias, linkType);
    const scope = captureProjectScope(alias, project);
    assert.equal(scope.sender.input, alias);
    assert.equal(scope.sender.path, fs.realpathSync.native(project));
    assert.equal(scope.sender.identity, scope.recipient.identity);
    assert.deepEqual(recheckProjectScope(scope), scope);
  });

  it("does not group unrelated directories by a shared parent", (t) => {
    const root = fixture(t);
    const sender = directory(root, "sender");
    const recipient = directory(root, "recipient");
    assertMismatch(sender, recipient);
    assertMismatch(sender, root);
    assertMismatch(root, recipient);
  });

  it("refuses filesystem-root and home targets for a repository task", (t) => {
    const project = repository(fixture(t));
    for (const target of [path.parse(project).root, os.homedir()]) {
      assertMismatch(project, target);
      assertMismatch(target, project);
    }
  });

  it("fails closed for absent, non-string, blank and relative cwd values on either side", (t) => {
    const project = directory(fixture(t), "project");
    for (const invalid of [undefined, null, 23, {}, "", " ", ".", "relative/project"]) {
      assert.throws(() => captureProjectScope(invalid, project), /absolute existing directory/);
      assert.throws(() => captureProjectScope(project, invalid), /absolute existing directory/);
    }
  });

  it("fails closed for missing directories and ordinary files on either side", (t) => {
    const root = fixture(t);
    const project = directory(root, "project");
    const file = path.join(root, "ordinary-file");
    fs.writeFileSync(file, "fixture");
    for (const invalid of [path.join(root, "missing"), file]) {
      assert.throws(() => captureProjectScope(invalid, project));
      assert.throws(() => captureProjectScope(project, invalid));
    }
  });
});

describe("nearest Git repository identity", () => {
  it("permits a repository root and its descendants", (t) => {
    const main = repository(fixture(t));
    const nested = directory(main, "packages/backend/src");
    const scope = captureProjectScope(main, nested);
    assert.equal(scope.sender.repository.path, fs.realpathSync.native(path.join(main, ".git")));
    assert.deepEqual(scope.sender.repository, scope.recipient.repository);
    assert.deepEqual(recheckProjectScope(scope), scope);
  });

  it("permits separate package directories within one repository", (t) => {
    const main = repository(fixture(t));
    const sender = directory(main, "packages/backend");
    const recipient = directory(main, "packages/frontend");
    const scope = captureProjectScope(sender, recipient);
    assert.notEqual(scope.sender.path, scope.recipient.path);
    assert.equal(scope.sender.repository.identity, scope.recipient.repository.identity);
    assert.deepEqual(recheckProjectScope(scope, captureProjectScope(sender, recipient)), scope);
  });

  it("permits a real linked worktree and its common repository", (t) => {
    const root = fixture(t);
    const main = repository(root);
    const linked = worktree(root, main);
    const scope = captureProjectScope(main, linked.target);
    assert.equal(scope.sender.repository.path, fs.realpathSync.native(path.join(main, ".git")));
    assert.deepEqual(scope.sender.repository, scope.recipient.repository);
    assert.deepEqual(recheckProjectScope(scope), scope);
  });

  it("permits descendants in two registered worktrees", (t) => {
    const root = fixture(t);
    const main = repository(root);
    const first = worktree(root, main, "first worktree");
    const second = worktree(root, main, "second worktree");
    const sender = directory(first.target, "packages/backend");
    const recipient = directory(second.target, "packages/frontend");
    const scope = captureProjectScope(sender, recipient);
    assert.deepEqual(scope.sender.repository, scope.recipient.repository);
    assert.deepEqual(recheckProjectScope(scope), scope);
  });

  it("does not treat separate clones with the same remote and commit as one project", (t) => {
    const root = fixture(t);
    const origin = repository(root, "origin");
    const first = path.join(root, "first clone");
    const second = path.join(root, "second clone");
    git(root, "clone", "--quiet", "--no-hardlinks", origin, first);
    git(root, "clone", "--quiet", "--no-hardlinks", origin, second);
    assert.equal(git(first, "remote", "get-url", "origin"), git(second, "remote", "get-url", "origin"));
    assert.equal(git(first, "rev-parse", "HEAD"), git(second, "rev-parse", "HEAD"));
    assertMismatch(first, second);
    assertMismatch(directory(first, "packages/backend"), directory(second, "packages/backend"));
  });

  it("keeps a nested independent repository separate from its parent project", (t) => {
    const root = fixture(t);
    const parent = repository(root);
    const nested = repository(parent, "vendor/independent");
    assertMismatch(parent, nested);
    assertMismatch(directory(parent, "packages/backend"), directory(nested, "src"));
  });

  it("keeps a real submodule separate from its superproject", (t) => {
    const root = fixture(t);
    const dependency = repository(root, "dependency");
    const parent = repository(root, "superproject");
    git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", dependency, "vendor/dependency");
    const submodule = path.join(parent, "vendor", "dependency");
    assert.equal(fs.statSync(path.join(submodule, ".git")).isFile(), true);
    assertMismatch(parent, submodule);
    assertMismatch(directory(parent, "packages/backend"), directory(submodule, "src"));
  });

  it("does not use a home-directory Git marker to group descendant projects", (t) => {
    const home = repository(fixture(t), "temporary home");
    const sender = directory(home, "first project");
    const recipient = directory(home, "second project");
    const code = [
      `import assert from "node:assert/strict";`,
      `import os from "node:os";`,
      `import { captureProjectScope } from ${JSON.stringify(sourceUrl)};`,
      `assert.equal(os.homedir(), ${JSON.stringify(home)});`,
      `assert.throws(() => captureProjectScope(${JSON.stringify(sender)}, ${JSON.stringify(recipient)}), { code: "PROJECT_SCOPE_MISMATCH" });`,
      `assert.throws(() => captureProjectScope(${JSON.stringify(home)}, ${JSON.stringify(sender)}), { code: "PROJECT_SCOPE_MISMATCH" });`,
      `assert.equal(captureProjectScope(${JSON.stringify(sender)}, ${JSON.stringify(sender)}).sender.repository, null);`,
    ].join("\n");
    execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 30000,
    });
  });
});

describe("project changes before delivery", () => {
  it("refuses an alias retargeted to a different directory in the same repository", (t) => {
    const root = fixture(t);
    const main = repository(root);
    const first = directory(main, "first package");
    const second = directory(main, "second package");
    const alias = path.join(root, "sender alias");
    fs.symlinkSync(first, alias, linkType);
    const scope = captureProjectScope(alias, main);
    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias, linkType);
    assert.throws(() => recheckProjectScope(scope), { code: "PROJECT_SCOPE_CHANGED" });
  });

  it("refuses both aliases retargeted together to an unrelated project", (t) => {
    const root = fixture(t);
    const first = directory(root, "first project");
    const second = directory(root, "second project");
    const alias = path.join(root, "project alias");
    fs.symlinkSync(first, alias, linkType);
    const scope = captureProjectScope(alias, alias);
    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias, linkType);
    assert.throws(() => recheckProjectScope(scope), { code: "PROJECT_SCOPE_CHANGED" });
  });

  for (const side of ["sender", "recipient"]) {
    it(`refuses a replaced ${side} directory even when its path and common repository stay the same`, (t) => {
      const main = repository(fixture(t));
      const sender = directory(main, "sender");
      const recipient = directory(main, "recipient");
      const scope = captureProjectScope(sender, recipient);
      const replaced = side === "sender" ? sender : recipient;
      fs.renameSync(replaced, `${replaced}-previous`);
      fs.mkdirSync(replaced);
      assert.throws(() => recheckProjectScope(scope), {
        code: "PROJECT_SCOPE_CHANGED",
        message: `The ${side} project directory or repository changed before delivery. No message was sent.`,
      });
    });
  }

  it("refuses a replaced common Git directory even when the workspace directories stay the same", (t) => {
    const main = repository(fixture(t));
    const sender = directory(main, "sender");
    const recipient = directory(main, "recipient");
    const scope = captureProjectScope(sender, recipient);
    const marker = path.join(main, ".git");
    const previous = path.join(main, ".git-previous");
    fs.renameSync(marker, previous);
    fs.cpSync(previous, marker, { recursive: true });
    assert.equal(git(main, "rev-parse", "HEAD"), git(previous, "rev-parse", "HEAD"));
    assert.throws(() => recheckProjectScope(scope), { code: "PROJECT_SCOPE_CHANGED" });
  });

  it("fails closed when a bound project directory disappears", (t) => {
    const root = fixture(t);
    const project = directory(root, "project");
    const scope = captureProjectScope(project, project);
    fs.renameSync(project, path.join(root, "previous project"));
    assert.throws(() => recheckProjectScope(scope), { code: "PROJECT_SCOPE_UNVERIFIED" });
  });

  it("refuses a newly introduced independent repository within a bound workspace", (t) => {
    const main = repository(fixture(t));
    const sender = directory(main, "sender");
    const recipient = directory(main, "recipient");
    const scope = captureProjectScope(sender, recipient);
    git(recipient, "init", "--quiet", "--initial-branch=main");
    assert.throws(() => recheckProjectScope(scope), { code: "PROJECT_SCOPE_MISMATCH" });
  });
});

describe("malformed nearest repository metadata", () => {
  for (const contents of ["not a Git marker", "gitdir: \n", "gitdir: missing-directory\n", "gitdir: ../one\ngitdir: ../two\n", "x".repeat(4097)]) {
    it(`fails closed for a malformed nearest Git file of ${contents.length} bytes`, (t) => {
      const main = repository(fixture(t));
      const nested = directory(main, "nested project");
      fs.writeFileSync(path.join(nested, ".git"), contents);
      assert.throws(() => captureProjectScope(main, nested));
      assert.throws(() => captureProjectScope(nested, main));
      assert.throws(() => captureProjectScope(nested, nested));
    });
  }

  it("fails closed for a nearest Git directory without repository metadata", (t) => {
    const main = repository(fixture(t));
    const malformed = directory(main, "malformed project");
    directory(malformed, ".git");
    const sender = directory(malformed, "sender");
    const recipient = directory(malformed, "recipient");
    assert.throws(() => captureProjectScope(sender, recipient));
  });

  it("fails closed when a Git file points to an ordinary directory", (t) => {
    const root = fixture(t);
    const ordinary = directory(root, "ordinary metadata");
    const sender = directory(root, "sender");
    const recipient = directory(root, "recipient");
    for (const project of [sender, recipient]) fs.writeFileSync(path.join(project, ".git"), `gitdir: ${ordinary}\n`);
    assert.throws(() => captureProjectScope(sender, recipient));
  });

  it("refuses a registered worktree whose backlink points at the main repository marker", (t) => {
    const root = fixture(t);
    const main = repository(root);
    const linked = worktree(root, main);
    fs.writeFileSync(path.join(linked.gitdir, "gitdir"), `${path.join(main, ".git")}\n`);
    assert.throws(() => captureProjectScope(main, linked.target), /backlink does not match/);
  });

  it("refuses a copied worktree marker whose registered backlink belongs to another directory", (t) => {
    const root = fixture(t);
    const main = repository(root);
    const linked = worktree(root, main);
    const copied = directory(root, "copied worktree");
    fs.copyFileSync(path.join(linked.target, ".git"), path.join(copied, ".git"));
    assert.throws(() => captureProjectScope(main, copied), /backlink does not match/);
  });

  it("refuses a forged commondir from outside the common repository worktrees directory", (t) => {
    const root = fixture(t);
    const main = repository(root);
    const rogue = repository(root, "rogue repository");
    fs.writeFileSync(path.join(rogue, ".git", "commondir"), `${path.join(main, ".git")}\n`);
    const forged = directory(root, "forged worktree");
    fs.writeFileSync(path.join(forged, ".git"), `gitdir: ${path.join(rogue, ".git")}\n`);
    assert.throws(() => captureProjectScope(main, forged), /not registered/);
  });

  it("fails closed when a registered worktree backlink disappears before delivery", (t) => {
    const root = fixture(t);
    const main = repository(root);
    const linked = worktree(root, main);
    const scope = captureProjectScope(main, linked.target);
    fs.renameSync(path.join(linked.gitdir, "gitdir"), path.join(linked.gitdir, "gitdir-previous"));
    assert.throws(() => recheckProjectScope(scope), { code: "PROJECT_SCOPE_UNVERIFIED" });
  });
});
