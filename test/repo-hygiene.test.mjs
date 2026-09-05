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
   * `codex_bridge_status` and `claude_bridge_status` print this version, and a
   * drifting one turns every bug report into a guess about which build is
   * actually running. Checking only one entry point is how claude-bridge sat
   * at 1.3.0 while the package shipped 1.10.0, so every file declaring the
   * constant is checked here.
   */
  it("reports the same version as package.json from every entry point", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const entries = tracked.filter((file) => /^(src|scripts)\/.+\.mjs$/.test(file));
    const declaring = entries.filter((file) =>
      /^const VERSION = "[^"]+";$/m.test(fs.readFileSync(path.join(root, file), "utf8")),
    );

    assert.ok(declaring.length >= 2, `expected both bridges to declare a version, found: ${declaring.join(", ")}`);

    for (const file of declaring) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      const declared = source.match(/^const VERSION = "([^"]+)";$/m)?.[1];
      assert.equal(declared, pkg.version, `${file} declares ${declared}, package.json says ${pkg.version}`);
    }
  });

  it("keeps every documented npm script runnable", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    for (const [name, command] of Object.entries(pkg.scripts)) {
      const scriptFile = command.match(/scripts\/[\w-]+\.mjs/)?.[0];
      if (!scriptFile) continue;
      assert.ok(fs.existsSync(path.join(root, scriptFile)), `npm run ${name} points at a missing ${scriptFile}`);
    }
  });

  /**
   * A path naming a real home directory, volume or checkout is a fact about
   * one machine, and it reads as an instruction to everyone else who clones
   * the repository. Placeholders say the same thing without pinning it to a
   * disk that only one person has.
   *
   * This file is excluded from its own scan: the patterns it forbids have to
   * appear here to be forbidden at all.
   */
  it("names no real home directory, volume or checkout", () => {
    const everywhere = [
      { pattern: /\/Users\/(?!<user>)[A-Za-z0-9._-]+/g, hint: "use /Users/<user>" },
      { pattern: /\/home\/(?!<user>)[A-Za-z0-9._-]+/g, hint: "use /home/<user>" },
    ];
    /**
     * Prose has no reason to name a volume, but a test has to hand the code
     * under test a concrete string - the invented labels in the fixtures name
     * nobody's disk.
     */
    const proseOnly = [{ pattern: /\/Volumes\/(?!<label>)[A-Za-z0-9._-]+/g, hint: "use /Volumes/<label>" }];
    const self = "test/repo-hygiene.test.mjs";
    const offences = [];

    for (const file of tracked.filter((f) => f !== self && !f.endsWith(".json"))) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      const patterns = file.endsWith(".md") ? [...everywhere, ...proseOnly] : everywhere;
      text.split("\n").forEach((line, index) => {
        for (const { pattern, hint } of patterns) {
          for (const match of line.matchAll(pattern)) {
            offences.push(`${file}:${index + 1} ${match[0]} (${hint})`);
          }
        }
      });
    }

    assert.deepEqual(offences, [], `machine-specific paths must not be committed:\n${offences.join("\n")}`);
  });

  /**
   * A public repository cannot lean on a private one. An instruction that
   * points at a repo, a rule file or a workflow only the author can open is
   * not guidance to anyone else - it is a dead end wearing the clothes of a
   * rule, and it drags one person's operating manual into a project other
   * people are meant to run.
   *
   * This file is excluded from its own scan: the names it forbids have to
   * appear here to be forbidden at all.
   */
  it("carries no instruction that only works inside one person's setup", () => {
    const forbidden = [
      { pattern: /github\.com\/[A-Za-z0-9-]+\/Windows\b/g, why: "the author's private rules repository" },
      { pattern: /\bRules\.md\b/g, why: "a personal rule file that lives outside this repo" },
      { pattern: /\bMEMORY\.md\b/g, why: "a personal memory file that lives outside this repo" },
      { pattern: /\bSkills\.md\b/g, why: "a personal skills catalogue that lives outside this repo" },
    ];
    const self = "test/repo-hygiene.test.mjs";
    const offences = [];

    for (const file of tracked.filter((f) => f !== self)) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      text.split("\n").forEach((line, index) => {
        for (const { pattern, why } of forbidden) {
          for (const match of line.matchAll(pattern)) {
            offences.push(`${file}:${index + 1} ${match[0]} - ${why}`);
          }
        }
      });
    }

    assert.deepEqual(offences, [], `this repo must stand on its own:\n${offences.join("\n")}`);
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
