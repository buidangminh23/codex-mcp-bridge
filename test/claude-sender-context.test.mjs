import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assertClaudeSenderContext, readClaudeSenderContext, readProcessAncestry, requireClaudeSenderContext } from "../src/claude-sender-context.mjs";

const accountA = { status: "verified", accountId: "account-a", fingerprint: "a".repeat(64) };
const accountB = { status: "verified", accountId: "account-b", fingerprint: "b".repeat(64) };

describe("bounded Windows native process ancestry", () => {
  const rows = [
    { pid: 200, parentPid: 100, processStart: "133100000000000000" },
    { pid: 100, parentPid: 0, processStart: "133000000000000000" },
  ];

  it("uses one hidden Toolhelp snapshot and native creation times within the existing deadline", async () => {
    const calls = [];
    const actual = await readProcessAncestry({ platform: "win32", parentPid: 200, maxDepth: 100,
      run: async (...args) => { calls.push(args); return { stdout: JSON.stringify(rows) }; },
    });
    assert.deepEqual(actual, rows);
    assert.equal(calls.length, 1);
    const [shell, args, options] = calls[0];
    assert.match(shell, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.match(script, /CreateToolhelp32Snapshot\(2, 0\)/);
    assert.match(script, /Process32FirstW/);
    assert.match(script, /GetProcessTimes/);
    assert.match(script, /OpenProcess\(0x1000, false, next\)/);
    assert.match(script, /\[ClaudeProcessAncestry\]::Read\(200,8\)/);
    assert.doesNotMatch(script, /Get-CimInstance|Get-WmiObject|Win32_Process|CommandLine|GetEnvironmentVariable/);
    assert.deepEqual(options, { timeout: 5000, maxBuffer: 16384, windowsHide: true });
  });

  it("does not execute a shell for invalid native process IDs", async () => {
    for (const parentPid of [0, -1, 1.5, NaN, Infinity, 0x100000000, "200", null]) {
      assert.deepEqual(await readProcessAncestry({ platform: "win32", parentPid, run: async () => assert.fail("Invalid PID reached execution") }), []);
    }
  });

  it("rejects malformed, excessive, reordered, replaced, or unprojected native responses", async () => {
    const invalid = ["invalid JSON", "{}", JSON.stringify([...rows, ...rows]),
      JSON.stringify([{ ...rows[0], commandLine: "unexpected" }]),
      JSON.stringify([{ ...rows[0], pid: 201 }]),
      JSON.stringify([{ ...rows[0], parentPid: -1 }]),
      JSON.stringify([{ ...rows[0], processStart: "1e17" }]),
      JSON.stringify([{ ...rows[0], processStart: 133100000000000000 }]),
      JSON.stringify([rows[0], { ...rows[1], pid: 99 }]),
      JSON.stringify([rows[0], { ...rows[1], processStart: "134000000000000000" }]),
    ];
    for (const stdout of invalid) {
      await assert.rejects(readProcessAncestry({ platform: "win32", parentPid: 200, maxDepth: 2, run: async () => ({ stdout }) }));
    }
    await assert.rejects(readProcessAncestry({ platform: "win32", parentPid: 200, maxDepth: 1, run: async () => ({ stdout: JSON.stringify(rows) }) }));
  });

  it("propagates native failures and preserves an empty inaccessible ancestry", async () => {
    const unavailable = new Error("Native snapshot unavailable");
    await assert.rejects(readProcessAncestry({ platform: "win32", parentPid: 200, run: async () => { throw unavailable; } }), (error) => error === unavailable);
    assert.deepEqual(await readProcessAncestry({ platform: "win32", parentPid: 200, run: async () => ({ stdout: "[]" }) }), []);
  });

  it("matches the live OS parent and stable FILETIME identity across fresh Windows snapshots", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
    const started = performance.now();
    const direct = await readProcessAncestry({ parentPid: process.pid, maxDepth: 1 });
    const firstMs = Math.round(performance.now() - started);
    const full = await readProcessAncestry({ parentPid: process.pid });
    assert.equal(direct.length, 1);
    assert.ok(full.length > 0 && full.length <= 8);
    assert.deepEqual(full[0], direct[0]);
    assert.equal(direct[0].pid, process.pid);
    assert.equal(direct[0].parentPid, process.ppid);
    assert.match(direct[0].processStart, /^[1-9]\d{16,18}$/);
    t.diagnostic(`Native snapshot durations: direct=${firstMs}ms, full=${Math.round(performance.now() - started) - firstMs}ms`);
  });

  it("verifies the caller under MCP's sanitized Windows environment and fresh fixture profile", { skip: process.platform !== "win32", timeout: 20000 }, async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-caller-mcp-env-"));
    try {
      const env = { ...getDefaultEnvironment(), PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
        HOME: home, USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"), XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: path.join(home, ".codex"),
      };
      const accountRoot = path.join(env.APPDATA, "Claude");
      fs.mkdirSync(accountRoot, { recursive: true });
      fs.mkdirSync(env.CODEX_HOME, { recursive: true });
      async function inspectChildCaller(moduleUrl) {
        const { readClaudeSenderContext, readProcessAncestry } = await import(moduleUrl);
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execute = promisify(execFile);
        const started = performance.now();
        let lastStage = "not_started";
        const collectStage = (stderr) => {
          const markers = [...String(stderr ?? "").matchAll(/BRIDGE_ANCESTRY_STAGE:(started|compiled|snapshot|serialized)/g)];
          lastStage = markers.at(-1)?.[1] ?? "not_started";
        };
        const sender = await readClaudeSenderContext({
          account: { status: "verified", fingerprint: "a".repeat(64) },
          listSessions: () => [{ pid: process.ppid, entrypoint: "claude-desktop", alive: true, sessionId: "fixture" }],
          readContext: () => ({ status: "matched", taskId: "fixture-task", cwd: process.cwd() }),
          readAncestry: (options) => readProcessAncestry({ ...options, run: async (shell, args, execution) => {
            let script = Buffer.from(args.at(-1), "base64").toString("utf16le");
            script = script.replace("Add-Type -TypeDefinition", "[Console]::Error.WriteLine('BRIDGE_ANCESTRY_STAGE:started'); Add-Type -TypeDefinition")
              .replace("\n'@\n", "\n'@\n[Console]::Error.WriteLine('BRIDGE_ANCESTRY_STAGE:compiled');\n")
              .replace(/ConvertTo-Json -InputObject @\((.+)\) -Compress$/, (_match, nativeRead) => `$ancestryRows=@(${nativeRead}); [Console]::Error.WriteLine('BRIDGE_ANCESTRY_STAGE:snapshot'); ConvertTo-Json -InputObject $ancestryRows -Compress; [Console]::Error.WriteLine('BRIDGE_ANCESTRY_STAGE:serialized')`);
            try {
              const result = await execute(shell, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], execution);
              collectStage(result.stderr);
              return result;
            } catch (error) {
              collectStage(error.stderr);
              throw error;
            }
          } }),
        });
        console.log(JSON.stringify({ status: sender.status, diagnostic: sender.diagnostic, lastStage,
          expectedParent: sender.pid === process.ppid, elapsedMs: Math.round(performance.now() - started) }));
      }
      const source = `(${inspectChildCaller.toString()})(${JSON.stringify(new URL("../src/claude-sender-context.mjs", import.meta.url).href)})`;
      const inspectEnvironment = async (environment) => {
        const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], { cwd: home, env: environment, windowsHide: true, timeout: 8000, maxBuffer: 16384 });
        return JSON.parse(stdout);
      };
      const result = await inspectEnvironment(env);
      t.diagnostic(`Sanitized MCP process inspection: ${JSON.stringify(result)}`);
      if (result.status !== "verified") {
        const preservedProfile = { ...getDefaultEnvironment(), PATH: env.PATH, SystemRoot: env.SystemRoot,
          HOME: home, CODEX_HOME: env.CODEX_HOME, CLAUDE_DESKTOP_USER_DATA: accountRoot, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
        };
        const comparison = await inspectEnvironment(preservedProfile);
        t.diagnostic(`Preserved OS profile comparison: ${JSON.stringify(comparison)}`);
      }
      assert.equal(result.status, "verified", JSON.stringify(result));
      assert.equal(result.expectedParent, true);
      assert.equal(result.lastStage, "serialized");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

function fixture() {
  const ancestry = [{ pid: 200, parentPid: 100, processStart: "caller-start" }, { pid: 100, parentPid: 0, processStart: "desktop-start" }];
  const session = { pid: 200, entrypoint: "claude-desktop", alive: true, sessionId: "session-a", cwd: "/project", processStart: "caller-start", ownerAccount: "account-a" };
  const sessions = [session];
  return {
    ancestry, session, sessions,
    options: {
      account: accountA, parentPid: 200, readAncestry: async () => ancestry, listSessions: () => sessions,
      readContext: (current, { account }) => current.ownerAccount === account.accountId
        ? { status: "matched", taskId: `task-${current.sessionId}`, cwd: current.cwd }
        : { status: "missing" },
    },
  };
}

describe("Claude Desktop caller account and process binding", () => {
  it("keeps an old live caller out of a switched account and permits the new account's caller", async () => {
    const f = fixture();
    const original = requireClaudeSenderContext(await readClaudeSenderContext(f.options));
    assert.equal(original.sessionId, "session-a");
    assert.equal((await readClaudeSenderContext({ ...f.options, account: accountB })).status, "unavailable");
    await assert.rejects(assertClaudeSenderContext(original, { ...f.options, account: accountB }), /currently signed-in account/);
    f.session.ownerAccount = "account-b";
    f.session.sessionId = "session-b";
    f.session.pid = 201;
    f.ancestry[0].pid = 201;
    const current = await readClaudeSenderContext({ ...f.options, account: accountB, parentPid: 201 });
    assert.equal(current.status, "verified");
    assert.equal(current.sessionId, "session-b");
    assert.equal(current.accountFingerprint, accountB.fingerprint);
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
  });

  it("requires a registered Code session and refuses generic Desktop or unrelated process callers", async () => {
    const f = fixture();
    f.sessions.length = 0;
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.sessions.push({ ...f.session, entrypoint: "cli" });
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.sessions[0] = { ...f.session, pid: 999 };
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
  });

  it("rejects ambiguous ancestors, broken lineage and ancestry beyond the read limit", async () => {
    const f = fixture();
    f.sessions.push({ ...f.session, pid: 100 });
    assert.equal((await readClaudeSenderContext(f.options)).status, "ambiguous");
    f.sessions.pop();
    f.ancestry[1].pid = 99;
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.ancestry[1].pid = 100;
    f.ancestry.push(...Array.from({ length: 7 }, () => ({ pid: 1, parentPid: 0, processStart: "x" })));
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
  });

  it("captures OS process identity when the registry omits it and catches later process replacement", async () => {
    const f = fixture();
    delete f.session.processStart;
    const original = requireClaudeSenderContext(await readClaudeSenderContext(f.options));
    assert.equal(original.processStart, "caller-start");
    f.ancestry[0].processStart = "replacement-start";
    await assert.rejects(assertClaudeSenderContext(original, f.options), /changed while this operation/);
  });

  it("rejects stale registered process identity, signout and process inspection errors", async () => {
    const f = fixture();
    f.session.processStart = "old-start";
    assert.equal((await readClaudeSenderContext(f.options)).status, "unavailable");
    f.session.processStart = "caller-start";
    assert.equal((await readClaudeSenderContext({ ...f.options, account: { status: "signed_out" } })).status, "unavailable");
    assert.equal((await readClaudeSenderContext({ ...f.options, readAncestry: async () => { throw new Error("OS unavailable"); } })).status, "unavailable");
  });

  it("reports allowlisted failure stages and codes without subprocess output or error messages", async () => {
    const f = fixture();
    for (const [fields, expected] of [
      [{ killed: true, signal: "SIGTERM", code: null }, "INSPECTION_TIMEOUT"],
      [{ code: "ETIMEDOUT" }, "INSPECTION_TIMEOUT"], [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "OUTPUT_LIMIT"],
      [{ code: "ENOENT" }, "ENOENT"], [{ code: "EPERM" }, "EPERM"], [{ code: 1 }, "NATIVE_EXIT"],
      [{ code: "PRIVATE_ERROR_TOKEN" }, "UNAVAILABLE"],
    ]) {
      const error = Object.assign(new Error("PRIVATE_ERROR_TOKEN"), fields, { stdout: "PRIVATE_STDOUT", stderr: "PRIVATE_STDERR" });
      const result = await readClaudeSenderContext({ ...f.options, readAncestry: async () => { throw error; } });
      assert.deepEqual(result.diagnostic, { stage: "process_inspection", code: expected });
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    }
    const malformed = await readClaudeSenderContext({ ...f.options, readAncestry: async () => [] });
    assert.deepEqual(malformed.diagnostic, { stage: "ancestry_validation", code: "UNAVAILABLE" });
    const badJson = await readClaudeSenderContext({ ...f.options, readAncestry: async () => JSON.parse("private-invalid-json") });
    assert.deepEqual(badJson.diagnostic, { stage: "process_inspection", code: "INVALID_JSON" });
    const metadata = await readClaudeSenderContext({ ...f.options, readContext: () => { throw new Error("PRIVATE_METADATA"); } });
    assert.deepEqual(metadata.diagnostic, { stage: "task_metadata", code: "UNAVAILABLE" });
    assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_/);
  });

  it("rechecks the exact caller task and workspace before a later dispatch", async () => {
    const f = fixture();
    const original = requireClaudeSenderContext(await readClaudeSenderContext(f.options));
    f.session.cwd = "/another-project";
    await assert.rejects(assertClaudeSenderContext(original, f.options), /changed while this operation/);
    f.session.cwd = "/project";
    f.session.sessionId = "replacement-session";
    await assert.rejects(assertClaudeSenderContext(original, f.options), /changed while this operation/);
  });
});
