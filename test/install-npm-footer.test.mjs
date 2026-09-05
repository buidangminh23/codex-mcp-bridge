import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const script = fileURLToPath(new URL("../scripts/install-npm-footer.mjs", import.meta.url));

function withHome(check) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-profile-"));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8", timeout: 10000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: directory, USERPROFILE: directory, SHELL: "/bin/zsh" },
  });
  try { check(directory, run); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe("npm footer shell setup", () => {
  it("preserves profiles, loads before early returns, and is idempotent", () => withHome((directory, run) => {
    const profile = path.join(directory, ".zshrc");
    const original = 'if [[ ! -t 1 ]]; then return; fi\nexport EXAMPLE=value\n';
    fs.writeFileSync(profile, original);
    assert.equal(run("--shell", "zsh").status, 0);
    const installed = fs.readFileSync(profile, "utf8");
    assert.ok(installed.endsWith(original));
    assert.ok(installed.startsWith("# codex-mcp-bridge npm footer: begin\n"));
    assert.ok(fs.existsSync(path.join(directory, ".zprofile")));
    const backup = fs.readdirSync(directory).find((name) => name.startsWith(".zshrc.bak-npm-footer-"));
    assert.equal(fs.readFileSync(path.join(directory, backup), "utf8"), original);
    assert.equal(run("--shell", "zsh").status, 0);
    assert.equal(fs.readFileSync(profile, "utf8"), installed);
    assert.equal(run("--shell", "zsh", "--remove").status, 0);
    assert.equal(fs.readFileSync(profile, "utf8"), original);
  }));
  it("refuses an unowned npm wrapper without making any changes", () => withHome((directory, run) => {
    const profile = path.join(directory, ".zshrc");
    const original = 'function npm { echo existing; }\n';
    fs.writeFileSync(profile, original);
    const result = run("--shell", "zsh");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /existing npm wrapper/);
    assert.equal(fs.readFileSync(profile, "utf8"), original);
    assert.deepEqual(fs.readdirSync(directory), [".zshrc"]);
  }));
  it("rejects malformed managed blocks", () => withHome((directory, run) => {
    const profile = path.join(directory, ".zshrc");
    fs.writeFileSync(profile, '# codex-mcp-bridge npm footer: begin\n');
    assert.notEqual(run("--shell", "zsh").status, 0);
  }));
  it("uses the existing Bash login profile and preserves CRLF", () => withHome((directory, run) => {
    const profile = path.join(directory, ".bash_profile");
    fs.writeFileSync(profile, 'export EXAMPLE=value\r\n');
    assert.equal(run("--shell", "bash").status, 0);
    assert.ok(!fs.existsSync(path.join(directory, ".profile")));
    assert.ok(fs.existsSync(path.join(directory, ".bashrc")));
    assert.ok(!/(?<!\r)\n/.test(fs.readFileSync(profile, "utf8")));
  }));
  it("can install PowerShell integration into an explicit profile", () => withHome((directory, run) => {
    const profile = path.join(directory, "PowerShell", "profile.ps1");
    const result = run("--shell", "powershell", "--profile", profile);
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(profile, "utf8"), /Test-Path -LiteralPath/);
    assert.ok(fs.existsSync(path.join(directory, ".config", "codex-mcp-bridge", "npm-footer.ps1")));
  }));
  it("keeps a shared POSIX profile usable outside Bash and Zsh", { skip: process.platform === "win32" }, () => withHome((directory, run) => {
    const profile = path.join(directory, ".profile");
    fs.writeFileSync(profile, 'export EXAMPLE=preserved\n');
    assert.equal(run("--shell", "bash").status, 0);
    const result = spawnSync("sh", ["-c", 'unset BASH_VERSION ZSH_VERSION; set -eu; . "$1"; printf "%s" "$EXAMPLE"', "profile-check", profile], {
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "preserved");
  }));
});
