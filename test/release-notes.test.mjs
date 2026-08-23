import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { releaseNotes } from "../scripts/release-notes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

const SAMPLE = [
  "# Changelog",
  "",
  "## [2.0.0] - 2026-01-02",
  "",
  "### Added",
  "",
  "- the new thing",
  "",
  "## [1.0.0] - 2026-01-01",
  "",
  "- the first thing",
  "",
].join("\n");

describe("release notes", () => {
  it("takes one version and stops at the next", () => {
    assert.equal(releaseNotes(SAMPLE, "2.0.0"), "### Added\n\n- the new thing");
    assert.equal(releaseNotes(SAMPLE, "1.0.0"), "- the first thing");
  });

  it("answers null rather than guessing when the version is absent", () => {
    assert.equal(releaseNotes(SAMPLE, "3.0.0"), null);
    assert.equal(releaseNotes(SAMPLE, "1.0"), null, "a prefix is not a version");
  });

  /**
   * The publish workflow writes this straight into the release body, so an
   * empty section must fail loudly there rather than producing a release with
   * nothing in it.
   */
  it("treats an empty section as missing", () => {
    assert.equal(releaseNotes("## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-12-31\n", "1.0.0"), null);
  });

  /**
   * Releasing without writing the changelog entry first is the mistake this
   * catches - and it is caught before the tag is pushed rather than by a
   * failing release job afterwards.
   */
  it("has a section for the version this package is about to publish", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const notes = releaseNotes(changelog, version);
    assert.ok(notes, `CHANGELOG.md has no entry for ${version}, so its release would have empty notes`);
    assert.ok(notes.length > 40, `the entry for ${version} is too thin to be a release note`);
  });
});
