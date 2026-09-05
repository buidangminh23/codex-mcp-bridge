import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const footerPath = fileURLToPath(new URL("../scripts/npm-footer.ps1", import.meta.url));
const pwshProbe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" });
const missingPwsh = pwshProbe.error?.code === "ENOENT";
const packageName = "@minhspark/codex-mcp-bridge";
const target = `${packageName}@latest`;

const fakeNpm = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BRIDGE_FOOTER_CALLS, JSON.stringify(args) + "\\n");
let prefix;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--prefix") prefix = args[++index];
  else if (args[index].startsWith("--prefix=")) prefix = args[index].slice(9);
}
const root = prefix ? path.join(prefix, "npm-root") : process.env.BRIDGE_FOOTER_ROOT;
if (args[0] === "root") {
  if (process.env.BRIDGE_FOOTER_ROOT_ERROR) {
    console.error("internal root error");
    process.exit(42);
  }
  console.log(root);
  process.exit(0);
}
if (args[0] === "config") {
  if (process.env.BRIDGE_FOOTER_CONFIG_ERROR) {
    console.error("internal config error");
    process.exit(41);
  }
  console.log(process.env.BRIDGE_FOOTER_DRY_RUN || "false");
  process.exit(0);
}
console.log(process.env.BRIDGE_FOOTER_NATIVE_STDOUT || "npm native stdout");
console.error("npm native stderr");
const exitCode = Number(process.env.BRIDGE_FOOTER_EXIT || 0);
let dryRun = process.env.BRIDGE_FOOTER_DRY_RUN === "true";
for (const argument of args) {
  if (["--dry-run", "--dry-run=true"].includes(argument)) dryRun = true;
  if (["--no-dry-run", "--dry-run=false"].includes(argument)) dryRun = false;
}
if (exitCode === 0 && !dryRun && ["install", "i"].includes(args[0])) {
  const metadata = path.join(root, "@minhspark", "codex-mcp-bridge", "package.json");
  const after = process.env.BRIDGE_FOOTER_AFTER || "1.13.2";
  fs.mkdirSync(path.dirname(metadata), { recursive: true });
  if (after === "missing") fs.rmSync(metadata, { force: true });
  else if (after === "invalid") fs.writeFileSync(metadata, "{");
  else fs.writeFileSync(metadata, JSON.stringify({ name: "@minhspark/codex-mcp-bridge", version: after }));
}
process.exit(exitCode);
`;

function runFooter({ args = ["install", "-g", target], before, env = {}, application = false, prefix = false } = {}) {
  assert.equal(pwshProbe.status, 0, pwshProbe.stderr || pwshProbe.error?.message);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pwsh-footer-"));
  try {
    const binDirectory = path.join(sandbox, "bin");
    const packageRoot = path.join(sandbox, "npm-root");
    const prefixDirectory = path.join(sandbox, "prefix with spaces");
    const effectiveRoot = prefix ? path.join(prefixDirectory, "npm-root") : packageRoot;
    const callsPath = path.join(sandbox, "calls.jsonl");
    const runnerPath = path.join(sandbox, "runner.ps1");
    fs.mkdirSync(binDirectory);
    fs.writeFileSync(path.join(binDirectory, "fake-npm.mjs"), fakeNpm);
    if (application && process.platform === "win32") {
      fs.writeFileSync(path.join(binDirectory, "npm.cmd"), '@echo off\r\n"%BRIDGE_FOOTER_NODE%" "%~dp0fake-npm.mjs" %*\r\nexit /b %errorlevel%\r\n');
    } else if (application) {
      fs.writeFileSync(path.join(binDirectory, "npm"), fakeNpm, { mode: 0o755 });
    } else {
      fs.writeFileSync(path.join(binDirectory, "npm.ps1"), "& $env:BRIDGE_FOOTER_NODE (Join-Path $PSScriptRoot 'fake-npm.mjs') @args\nexit $LASTEXITCODE\n");
    }
    if (before !== undefined) {
      const metadataPath = path.join(effectiveRoot, "@minhspark", "codex-mcp-bridge", "package.json");
      fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
      fs.writeFileSync(metadataPath, before === "invalid" ? "{" : JSON.stringify({ name: packageName, version: before }));
    }
    const effectiveArgs = args.map((argument) => argument.replaceAll("{PREFIX}", prefixDirectory));
    fs.writeFileSync(runnerPath, "$resolvedNpm = Get-Command npm -CommandType Application,ExternalScript | Select-Object -First 1\nif (-not $resolvedNpm.Source.StartsWith($env:BRIDGE_FOOTER_BIN)) { throw 'Refusing to invoke a real npm during the fixture test.' }\n. $env:BRIDGE_FOOTER_SCRIPT\n. $env:BRIDGE_FOOTER_SCRIPT\n$npmArguments = @($env:BRIDGE_FOOTER_ARGS | ConvertFrom-Json)\n$global:LASTEXITCODE = 91\nnpm @npmArguments\nexit $LASTEXITCODE\n");
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", runnerPath], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        ...process.env,
        PATH: [binDirectory, path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        BRIDGE_FOOTER_SCRIPT: footerPath,
        BRIDGE_FOOTER_BIN: binDirectory,
        BRIDGE_FOOTER_NODE: process.execPath,
        BRIDGE_FOOTER_ROOT: packageRoot,
        BRIDGE_FOOTER_CALLS: callsPath,
        BRIDGE_FOOTER_ARGS: JSON.stringify(effectiveArgs),
        BRIDGE_FOOTER_DRY_RUN: "false",
        BRIDGE_FOOTER_AFTER: "1.13.2",
        BRIDGE_FOOTER_EXIT: "0",
        BRIDGE_FOOTER_ROOT_ERROR: "",
        BRIDGE_FOOTER_CONFIG_ERROR: "",
        ...env,
      },
    });
    assert.ifError(result.error);
    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse) : [];
    return { ...result, calls, effectiveArgs, prefixDirectory };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

function assertFooter(result, expected, exitCode = 0) {
  assert.equal(result.status, exitCode, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/).at(-1), expected);
  assert.match(result.stdout, /^npm native stdout\r?\n/);
  assert.match(result.stderr, /npm native stderr/);
  assert.doesNotMatch(result.stderr, /internal (root|config) error/);
  assert.deepEqual(result.calls.filter((args) => !["config", "root"].includes(args[0])), [result.effectiveArgs]);
}

describe("PowerShell npm installation footer", { skip: missingPwsh ? "pwsh is not installed" : false }, () => {
  it("reports a verified first installation after native output", () => {
    assertFooter(runFooter(), `Successfully installed: ${packageName} v1.13.2`);
  });

  it("compares before and after versions for an update", () => {
    assertFooter(runFooter({ before: "1.12.0" }), `Successfully updated: ${packageName} v1.12.0 -> v1.13.2`);
  });

  it("reports an unchanged version on a repeated installation", () => {
    assertFooter(runFooter({ before: "1.13.2" }), `Already up to date: ${packageName} v1.13.2`);
  });

  it("delegates an npm application as well as an npm.ps1 script", () => {
    assertFooter(runFooter({ application: true }), `Successfully installed: ${packageName} v1.13.2`);
  });

  it("preserves a native failure code and the original stderr", () => {
    assertFooter(runFooter({ before: "1.12.0", env: { BRIDGE_FOOTER_EXIT: "17" } }), `Failed to install: ${packageName} (exit code 17). See npm error above.`, 17);
  });

  it("recognizes supported install aliases, specs, and boolean flags", () => {
    const result = runFooter({ args: ["i", "--global=true", packageName, "--no-fund", "--no-audit", "--force", "--ignore-scripts", "--foreground-scripts"] });
    assertFooter(result, `Successfully installed: ${packageName} v1.13.2`);
  });

  for (const prefixArgs of [["--prefix", "{PREFIX}"], ["--prefix={PREFIX}"]]) {
    it(`uses the same prefix for both version probes: ${prefixArgs[0]}`, () => {
      const result = runFooter({ args: ["install", "--global", `${packageName}@1.13.2`, ...prefixArgs], prefix: true, before: "1.11.0" });
      assertFooter(result, `Successfully updated: ${packageName} v1.11.0 -> v1.13.2`);
      const actualPrefix = prefixArgs.map((argument) => argument.replaceAll("{PREFIX}", result.prefixDirectory));
      assert.deepEqual(result.calls.filter((args) => args[0] === "root"), [["root", "--global", ...actualPrefix], ["root", "--global", ...actualPrefix]]);
      assert.deepEqual(result.calls[0], ["config", "get", "dry-run", "--global", ...actualPrefix]);
    });
  }

  for (const dryRun of ["--dry-run", "--dry-run=true"]) {
    it(`does not call a dry run an installation: ${dryRun}`, () => {
      assertFooter(runFooter({ args: ["install", "-g", target, dryRun] }), `Dry run completed: ${packageName} (no changes applied).`);
    });
  }

  it("honors dry-run configuration without a command-line flag", () => {
    assertFooter(runFooter({ before: "1.13.2", env: { BRIDGE_FOOTER_DRY_RUN: "true" } }), `Dry run completed: ${packageName} (no changes applied).`);
  });

  for (const dryRun of ["--dry-run=false", "--no-dry-run"]) {
    it(`lets an explicit false flag override dry-run configuration: ${dryRun}`, () => {
      assertFooter(runFooter({ args: ["install", "-g", target, dryRun], env: { BRIDGE_FOOTER_DRY_RUN: "true" } }), `Successfully installed: ${packageName} v1.13.2`);
    });
  }

  for (const env of [{ BRIDGE_FOOTER_CONFIG_ERROR: "1" }, { BRIDGE_FOOTER_DRY_RUN: "unknown" }]) {
    it(`does not claim success when dry-run mode is unverifiable: ${Object.keys(env)[0]}`, () => {
      assertFooter(runFooter({ env }), "Warning: npm completed, but installation mode could not be verified.");
    });
  }

  for (const env of [{ BRIDGE_FOOTER_AFTER: "missing" }, { BRIDGE_FOOTER_AFTER: "invalid" }, { BRIDGE_FOOTER_AFTER: "unverified version" }, { BRIDGE_FOOTER_ROOT_ERROR: "1" }]) {
    it(`does not claim success without verifiable installed metadata: ${JSON.stringify(env)}`, () => {
      assertFooter(runFooter({ env }), `Warning: npm completed, but the installed ${packageName} version could not be verified.`);
    });
  }

  it("does not infer a first install from corrupt original metadata", () => {
    assertFooter(runFooter({ before: "invalid" }), `Warning: npm completed, but the installed ${packageName} version could not be verified.`);
  });

  it("passes an explicit root command through without running probes", () => {
    const result = runFooter({ args: ["root", "-g"] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /npm-root$/);
    assert.deepEqual(result.calls, [["root", "-g"]]);
  });

  for (const args of [
    ["--version"],
    ["install", target],
    ["install", "-g", "another-package"],
    ["install", "-g", target, "another-package"],
    ["--global", "install", target],
    ["install", "-g", target, "--json"],
    ["install", "-g", target, "--parseable"],
    ["install", "-g", target, "--silent"],
    ["install", "-g", target, "--loglevel=error"],
    ["install", "-g", target, "--unknown-option"],
    ["install", "--global=false", target],
    ["install", "-g", target, "--prefix"],
    ["install", "-g", target, "--prefix="],
    ["install", "-g", `${packageName}-other@latest`],
    ["install", "-g", target, target],
  ]) {
    it(`leaves unmatched commands and machine output untouched: ${args.join(" ")}`, () => {
      const result = runFooter({ args, env: { BRIDGE_FOOTER_EXIT: "23", BRIDGE_FOOTER_NATIVE_STDOUT: '{"native":true}' } });
      assert.equal(result.status, 23, result.stderr);
      assert.equal(result.stdout.trim(), '{"native":true}');
      assert.match(result.stderr, /npm native stderr/);
      assert.deepEqual(result.calls, [result.effectiveArgs]);
    });
  }
});
