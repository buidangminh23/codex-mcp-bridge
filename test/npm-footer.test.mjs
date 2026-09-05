import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const wrapper = fileURLToPath(new URL("../scripts/npm-footer.sh", import.meta.url));
const packageName = "@minhspark/codex-mcp-bridge";
const fakeNpm = `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BRIDGE_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "root") { console.log(process.env.BRIDGE_ROOT); process.exit(0); }
if (args[0] === "config") {
  if (process.env.BRIDGE_CONFIG_FAILURE) process.exit(1);
  console.log(process.env.BRIDGE_DRY_RUN || "false"); process.exit(0);
}
if (process.env.BRIDGE_FAILURE) { console.error("original npm failure"); process.exit(37); }
if (args.includes("--json")) { console.log('{"ok":true}'); process.exit(0); }
let dry = process.env.BRIDGE_DRY_RUN === "true";
for (const arg of args) {
  if (["--dry-run", "--dry-run=true"].includes(arg)) dry = true;
  if (["--no-dry-run", "--dry-run=false"].includes(arg)) dry = false;
}
if (!dry && process.env.BRIDGE_AFTER) {
  fs.writeFileSync(process.env.BRIDGE_MANIFEST, process.env.BRIDGE_CORRUPT ? "broken" : JSON.stringify({name: "${packageName}", version: process.env.BRIDGE_AFTER}));
}
console.log("npm finished");
`;

function run(shell, { before, beforeMetadata, after = "1.2.3", args = ["install", "-g", `${packageName}@latest`], env = {}, strict = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge footer "));
  try {
    const bin = path.join(directory, "bin");
    const root = path.join(directory, "global packages");
    const manifest = path.join(root, packageName, "package.json");
    const callsFile = path.join(directory, "calls.jsonl");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(path.join(bin, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(bin, "npm"), fakeNpm, { mode: 0o755 });
    if (beforeMetadata !== undefined) fs.writeFileSync(manifest, beforeMetadata);
    else if (before) fs.writeFileSync(manifest, JSON.stringify({ name: packageName, version: before }));
    const options = shell === "bash" ? ["--noprofile", "--norc"] : ["-f"];
    const command = `${strict ? "set -eu; set -o pipefail; " : ""}source "$1"; shift; npm "$@"`;
    const result = spawnSync(shell, [...options, "-c", command, "footer-test", wrapper, ...args], {
      encoding: "utf8", timeout: 10000,
      env: { PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, BRIDGE_ROOT: root, BRIDGE_MANIFEST: manifest, BRIDGE_CALLS: callsFile, BRIDGE_AFTER: after, ...env },
    });
    assert.ifError(result.error);
    const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse);
    return { ...result, calls };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const shell of ["bash", "zsh"]) {
  const available = process.platform !== "win32" && spawnSync(shell, ["--version"]).status === 0;
  describe(`${shell} npm installation footer`, { skip: !available && `${shell} is not available` }, () => {
    it("reports a first installation after npm's own final output", () => {
      const result = run(shell);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, `npm finished\nSuccessfully installed: ${packageName} v1.2.3\n`);
      assert.equal(result.stderr, "");
    });
    it("reports an upgrade using measured before and after versions", () => {
      const result = run(shell, { before: "1.2.2" });
      assert.match(result.stdout, /Successfully updated: .* v1\.2\.2 -> v1\.2\.3\n$/);
    });
    it("reports an unchanged version on repeated installation", () => {
      const result = run(shell, { before: "1.2.3" });
      assert.match(result.stdout, /Already up to date: .* v1\.2\.3\n$/);
      assert.equal(result.calls.filter((args) => args[0] === "install").length, 1);
    });
    it("preserves npm failure output and the exact exit code", () => {
      const result = run(shell, { before: "1.2.3", env: { BRIDGE_FAILURE: "1" } });
      assert.equal(result.status, 37);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `original npm failure\nFailed to install: ${packageName} (exit code 37). See npm error above.\n`);
    });
    it("reports unchanged versions with nounset, errexit, and pipefail enabled", () => {
      const result = run(shell, { before: "1.2.3", strict: true });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, `npm finished\nAlready up to date: ${packageName} v1.2.3\n`);
      assert.equal(result.stderr, "");
    });
    it("preserves npm's failure status with strict shell options enabled", () => {
      const result = run(shell, { strict: true, env: { BRIDGE_FAILURE: "1" } });
      assert.equal(result.status, 37);
      assert.equal(result.stderr, `original npm failure\nFailed to install: ${packageName} (exit code 37). See npm error above.\n`);
    });
    it("passes through npm without arguments under nounset", () => {
      const result = run(shell, { args: [], strict: true });
      assert.equal(result.status, 0);
      assert.deepEqual(result.calls, [[]]);
      assert.equal(result.stdout, "npm finished\n");
      assert.equal(result.stderr, "");
    });
    for (const settings of [
      { args: ["install", "-g", `${packageName}@latest`, "--dry-run"] },
      { env: { BRIDGE_DRY_RUN: "true" } },
    ]) {
      it(`does not claim installation for dry run ${JSON.stringify(settings)}`, () => {
        const result = run(shell, { before: "1.2.2", ...settings });
        assert.equal(result.stdout, `npm finished\nDry run completed: ${packageName} (no changes applied).\n`);
      });
    }
    it("allows an explicit real install to override configured dry-run", () => {
      const result = run(shell, { before: "1.2.2", env: { BRIDGE_DRY_RUN: "true" }, args: ["install", "-g", packageName, "--dry-run=false"] });
      assert.match(result.stdout, /Successfully updated:/);
    });
    it("warns when npm succeeds but installation mode cannot be verified", () => {
      const result = run(shell, { env: { BRIDGE_CONFIG_FAILURE: "1" } });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "npm finished\n");
      assert.match(result.stderr, /installation mode could not be verified/);
    });
    it("warns when installed metadata is corrupt", () => {
      const result = run(shell, { env: { BRIDGE_CORRUPT: "1" } });
      assert.equal(result.status, 0);
      assert.equal(result.stdout, "npm finished\n");
      assert.match(result.stderr, /version could not be verified/);
    });
    for (const beforeMetadata of ["not-json", JSON.stringify({ name: "another-package", version: "1.2.3" })]) {
      it(`does not infer a fresh installation from unreadable prior metadata: ${beforeMetadata}`, () => {
        const result = run(shell, { beforeMetadata });
        assert.equal(result.status, 0);
        assert.equal(result.stdout, "npm finished\n");
        assert.match(result.stderr, /version could not be verified/);
      });
    }
    it("preserves argument boundaries and uses the requested prefix for measurements", () => {
      const args = ["i", `${packageName}@latest`, "--global", "--prefix", "/tmp/custom packages", "--no-fund", "--no-audit", "--force"];
      const result = run(shell, { args });
      assert.deepEqual(result.calls.find((call) => call[0] === "i"), args);
      for (const call of result.calls.filter((call) => ["root", "config"].includes(call[0]))) {
        assert.deepEqual(call.slice(-2), ["--prefix", "/tmp/custom packages"]);
      }
    });
    for (const args of [
      ["--version"], ["install", packageName], ["install", "-g", "unrelated-package"],
      ["install", "-g", packageName, "--json"], ["install", "-g", packageName, "--silent"],
      ["install", "-g", packageName, "another-package"], ["install", "-g", packageName, "--unknown"],
      ["install", "-g", packageName, "--prefix"], ["install", "-g", packageName, "--prefix", ""],
      ["install", "-g", packageName, "--prefix="], ["install", "-g", packageName, "--prefix", "--force"],
      ["install", "-g", packageName, "--prefix", "/tmp/one", "--prefix=/tmp/two"],
      ["install", "-g", packageName, "--prefix=/tmp/one", "--prefix", "/tmp/two"],
    ]) {
      it(`passes through without additional output: ${args.join(" ")}`, () => {
        const result = run(shell, { args });
        assert.deepEqual(result.calls, [args]);
        assert.equal(result.stdout, args.includes("--json") ? '{"ok":true}\n' : "npm finished\n");
        assert.equal(result.stderr, "");
      });
    }
  });
}
