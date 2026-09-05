import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const sideEffectGuard = `
import fs from "node:fs";
import net from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const forbidden = () => { throw new Error("Version requests must not perform runtime operations"); };
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync"]) fs[name] = forbidden;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[name] = forbidden;
net.Server.prototype.listen = forbidden;
net.Socket.prototype.connect = forbidden;
syncBuiltinESMExports();
`;
const guardUrl = `data:text/javascript,${encodeURIComponent(sideEffectGuard)}`;

function runVersion(args) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cli-version-"));
  const config = path.join(sandbox, "claude.json");
  const original = "{\"unchanged\":true}\n";
  fs.writeFileSync(config, original);
  try {
    const result = spawnSync(process.execPath, ["--import", guardUrl, ...args], {
      cwd: sandbox,
      env: {
        SystemRoot: process.env.SystemRoot ?? "",
        PATH: "",
        HOME: sandbox,
        USERPROFILE: sandbox,
        APPDATA: sandbox,
        LOCALAPPDATA: sandbox,
        CODEX_HOME: sandbox,
        CLAUDE_DESKTOP_CONFIG: config,
        CODEX_EXE: path.join(sandbox, "missing-codex"),
        CODEX_BIN: path.join(sandbox, "missing-codex"),
        CODEX_APP_SERVER_URL: "invalid-app-server-url",
        CODEX_BRIDGE_APPROVAL: "invalid-approval",
        CLAUDE_BRIDGE_PERMISSION_MODE: "invalid-permission-mode",
      },
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.deepEqual(fs.readdirSync(sandbox), ["claude.json"]);
    assert.equal(fs.readFileSync(config, "utf8"), original);
    return result.stdout;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

describe("CLI version queries", () => {
  for (const [name, entry] of Object.entries(pkg.bin)) {
    for (const flag of ["--version", "-v"]) {
      it(`${name} ${flag} prints the package version without runtime effects`, () => {
        assert.equal(runVersion([path.join(root, entry), flag]), `${pkg.version}\n`);
      });
    }

    it(`${name} gives version queries precedence over mutation flags`, () => {
      const args = [path.join(root, entry), "--remove", "--reset", "--desktop-tasks", "--version"];
      assert.equal(runVersion(args), `${pkg.version}\n`);
    });
  }

  it("does not exit when the relay module is imported by another command", () => {
    const entry = pathToFileURL(path.join(root, "src/native-relay-companion.mjs")).href;
    const code = `process.argv = [process.execPath, "unrelated.mjs", "--version"]; const relay = await import(${JSON.stringify(entry)}); console.log(typeof relay.handleRelayRequest);`;
    assert.equal(runVersion(["--input-type=module", "--eval", code]), "function\n");
  });
});
