import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

const tracked = trackedFiles();
const notAGitCheckout = tracked === null ? "not a git checkout" : false;

describe("repository hygiene", { skip: notAGitCheckout }, () => {
  /**
   * An environment file committed once stays in the history forever, and no
   * later commit takes it back. Nothing in this repo needs one - every setting
   * is an optional variable the MCP client passes in - so the correct number
   * of tracked env files is zero, permanently.
   */
  it("tracks no environment file", () => {
    const envFiles = tracked.filter((file) => /(^|\/)\.env($|\.)|\.env$/i.test(file));
    assert.deepEqual(envFiles, [], `these must never be committed: ${envFiles.join(", ")}`);
  });

  it("ignores environment files in every directory", () => {
    const ignoreRules = fs
      .readFileSync(path.join(root, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());
    assert.ok(ignoreRules.includes(".env*"), ".gitignore must cover .env and its variants");
  });

  it("tracks no build output or dependency directory", () => {
    const junk = tracked.filter((file) => file.startsWith("node_modules/") || file.endsWith(".log"));
    assert.deepEqual(junk, []);
  });

  /**
   * `codex_bridge_status` prints this version, and a drifting one turns every
   * bug report into a guess about which build is actually running.
   */
  it("reports the same version as package.json", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const source = fs.readFileSync(path.join(root, "src", "index.mjs"), "utf8");
    const declared = source.match(/^const VERSION = "([^"]+)";$/m)?.[1];
    assert.equal(declared, pkg.version);
  });

  it("keeps every documented npm script runnable", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    for (const [name, command] of Object.entries(pkg.scripts)) {
      const scriptFile = command.match(/scripts\/[\w-]+\.mjs/)?.[0];
      if (!scriptFile) continue;
      assert.ok(fs.existsSync(path.join(root, scriptFile)), `npm run ${name} points at a missing ${scriptFile}`);
    }
  });

  it("documents the repository in English only", () => {
    const markdown = tracked.filter((file) => file.endsWith(".md"));
    const vietnamese = /[àáâãèéêìíòóôõùúýăđĩũơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
    for (const file of markdown) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const offending = text
        .split("\n")
        .map((line, index) => [index + 1, line])
        .filter(([, line]) => vietnamese.test(line));
      assert.deepEqual(
        offending.map(([line]) => line),
        [],
        `${file} is not in English (first offending line ${offending[0]?.[0]}: ${offending[0]?.[1]?.slice(0, 60)})`,
      );
    }
  });
});
