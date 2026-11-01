import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { protectPrivateRelayDirectory, assertPrivateRelayDirectory, assertPrivateRelayFile, assertPrivateRelayFiles, beginPrivateRelayWrite, bindPrivateRelayWrite, finishPrivateRelayWrite, abortPrivateRelayWrite } from "../src/background-relay-storage.mjs";

const readback = kind => ({ ownerTrusted: true, allowedPrincipalsOnly: true, currentUserFullControl: true, protected: true, noReparse: true, kind });

function temporary(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "relay-store-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("private storage creates only its directory and verifies files without changing content", t => {
  const root = temporary(t);
  const directory = path.join(root, "relay");
  protectPrivateRelayDirectory(directory);
  assert.ok(assertPrivateRelayDirectory(directory).isDirectory());
  assert.equal(assertPrivateRelayFile(path.join(directory, "missing.json"), { missing: true }), null);
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, "private fixture", { mode: 0o600 });
  assert.ok(assertPrivateRelayFile(file).isFile());
  assert.equal(fs.readFileSync(file, "utf8"), "private fixture");
});

test("linked files and directory links are rejected before ACL commands", t => {
  const root = temporary(t);
  const directory = path.join(root, "relay");
  protectPrivateRelayDirectory(directory);
  const original = path.join(directory, "original");
  fs.writeFileSync(original, "fixture", { mode: 0o600 });
  fs.linkSync(original, path.join(directory, "linked"));
  assert.throws(() => assertPrivateRelayFile(original), { code: "WORKER_STORAGE_UNSAFE" });
  const alias = path.join(root, "alias");
  fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => protectPrivateRelayDirectory(alias), { code: "WORKER_STORAGE_UNSAFE" });
});

test("POSIX owner-only permissions are enforced on reads and repaired only by explicit protection", { skip: process.platform === "win32" }, t => {
  const directory = temporary(t);
  protectPrivateRelayDirectory(directory);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => assertPrivateRelayDirectory(directory), { code: "WORKER_STORAGE_UNSAFE" });
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  protectPrivateRelayDirectory(directory);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const file = path.join(directory, "broad");
  fs.writeFileSync(file, "fixture", { mode: 0o644 });
  assert.throws(() => assertPrivateRelayFile(file), { code: "WORKER_STORAGE_UNSAFE" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  fs.chmodSync(file, 0o600);
  assert.ok(assertPrivateRelayFile(file).isFile());
});

test("Windows ACL helper uses literal arguments and validates every security readback field", t => {
  const root = temporary(t);
  const target = path.join(root, "relay $() & ' fixture");
  const calls = [];
  const run = (command, args, options) => { calls.push({ command, args, options }); return JSON.stringify(readback(args[args.indexOf("-Kind") + 1])); };
  protectPrivateRelayDirectory(target, { platform: "win32", run });
  assertPrivateRelayDirectory(target, { platform: "win32", run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf("-LiteralPath") + 1], target);
  assert.equal(calls[0].args.includes("-Command"), false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  for (const field of ["ownerTrusted", "allowedPrincipalsOnly", "currentUserFullControl", "protected", "noReparse"]) {
    assert.throws(() => assertPrivateRelayDirectory(target, { platform: "win32", run: () => JSON.stringify({ ...readback("directory"), [field]: false }) }), { code: "WORKER_STORAGE_UNSAFE" });
  }
  assert.throws(() => assertPrivateRelayDirectory(target, { platform: "win32", run: () => "invalid" }), { code: "WORKER_STORAGE_UNSAFE" });
  assert.throws(() => assertPrivateRelayDirectory(target, { platform: "win32", run: () => ({ status: 1, stdout: JSON.stringify(readback("directory")) }) }), { code: "WORKER_STORAGE_UNSAFE" });
  assert.throws(() => assertPrivateRelayDirectory(target, { platform: "win32", run: () => { throw new Error("sensitive diagnostic"); } }), error => error.code === "WORKER_STORAGE_UNSAFE" && !error.message.includes("sensitive"));
});

test("Windows cached validation is invalidated by replacement and metadata changes", t => {
  const directory = temporary(t);
  const file = path.join(directory, "receipt");
  fs.writeFileSync(file, "first");
  let checks = 0;
  const run = (command, args) => { checks++; return JSON.stringify(readback(args[args.indexOf("-Kind") + 1])); };
  const options = { platform: "win32", run };
  assertPrivateRelayFile(file, options);
  assert.equal(checks, 2);
  assertPrivateRelayFile(file, options);
  assert.equal(checks, 2);
  fs.writeFileSync(file, "changed contents");
  assertPrivateRelayFile(file, options);
  assert.ok(checks > 2);
  const previous = checks;
  fs.unlinkSync(file);
  fs.writeFileSync(file, "replacement");
  assertPrivateRelayFile(file, options);
  assert.ok(checks > previous);
});

test("batch privacy checks use one bounded literal helper request and populate individual caches", t => {
  const directory = temporary(t);
  const files = Array.from({ length: 100 }, (_, index) => path.join(directory, `receipt ${index} tiếng Việt $().json`));
  for (const file of files) fs.writeFileSync(file, "fixture", { mode: 0o600 });
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return JSON.stringify({ directory: readback("directory"), files: JSON.parse(options.input).files.map(name => ({ name, state: readback("file") })) });
  };
  const options = { platform: "win32", run };
  assert.equal(assertPrivateRelayFiles(files, options).length, files.length);
  for (const file of files) assertPrivateRelayFile(file, options);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf("-Mode") + 1], "batch");
  assert.equal(calls[0].args.some(value => value.includes("receipt 0")), false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.shell, false);
  assert.equal(JSON.parse(calls[0].options.input).files.length, 100);
  fs.writeFileSync(files[50], "changed fixture");
  assertPrivateRelayFiles(files, options);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].options.input).files, [path.basename(files[50])]);
});

test("batch privacy rejects incomplete readbacks and changes during the ACL snapshot", t => {
  const directory = temporary(t);
  const files = [path.join(directory, "first.json"), path.join(directory, "second.json")];
  for (const file of files) fs.writeFileSync(file, "fixture");
  const result = () => ({ directory: readback("directory"), files: files.map(file => ({ name: path.basename(file), state: readback("file") })) });
  for (const mutate of [
    value => { value.directory.ownerTrusted = false; },
    value => { value.files.pop(); },
    value => { value.files.reverse(); },
    value => { value.files[1].state.allowedPrincipalsOnly = false; },
    () => { fs.writeFileSync(files[1], "externally changed after inspection"); },
  ]) {
    assert.throws(() => assertPrivateRelayFiles(files, { platform: "win32", run: () => { const value = result(); mutate(value); return JSON.stringify(value); } }), { code: "WORKER_STORAGE_UNSAFE" });
  }
});

test("batch privacy bounds scope and refuses linked missing or duplicate files before launch", t => {
  const directory = temporary(t);
  const other = temporary(t);
  const file = path.join(directory, "receipt.json");
  fs.writeFileSync(file, "fixture");
  let calls = 0;
  const options = { platform: "win32", run: () => { calls++; return "{}"; } };
  assert.deepEqual(assertPrivateRelayFiles([], options), []);
  for (const files of [[file, file], [file, path.join(other, "receipt.json")], [path.join(directory, "missing")], Array(1025).fill(file)]) {
    assert.throws(() => assertPrivateRelayFiles(files, options), { code: "WORKER_STORAGE_UNSAFE" });
  }
  fs.linkSync(file, path.join(directory, "linked.json"));
  assert.throws(() => assertPrivateRelayFiles([file], options), { code: "WORKER_STORAGE_UNSAFE" });
  assert.equal(calls, 0);
});

test("Windows cold receipt checks validate one hundred real files in one ACL process", { skip: process.platform !== "win32" }, t => {
  const directory = temporary(t);
  protectPrivateRelayDirectory(directory);
  const files = Array.from({ length: 100 }, (_, index) => path.join(directory, `receipt ${index} tiếng Việt.json`));
  for (const file of files) fs.writeFileSync(file, "fixture", { mode: 0o600 });
  let checks = 0;
  const run = (...args) => { checks++; return execFileSync(...args); };
  const options = { platform: "win32", run };
  const started = performance.now();
  assert.equal(assertPrivateRelayFiles(files, options).length, 100);
  for (const file of files) assertPrivateRelayFile(file, options);
  assert.equal(checks, 1);
  t.diagnostic(`Cold privacy checks for 100 receipts: ${Math.round(performance.now() - started)} ms; ACL processes: ${checks}`);
  fs.writeFileSync(path.join(directory, "unrelated.json"), "fixture", { mode: 0o600 });
  assertPrivateRelayFiles(files, options);
  assert.equal(checks, 2);
  const windows = process.env.SystemRoot || "C:\\Windows";
  const script = "$ErrorActionPreference='Stop'; $p=$env:RELAY_TEST_PATH; $a=[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access); $s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object Security.AccessControl.FileSystemAccessRule($s,'ReadAndExecute','Allow'); $a.AddAccessRule($r); [IO.File]::SetAccessControl($p,$a)";
  execFileSync(path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, RELAY_TEST_PATH: files[99] }, windowsHide: true, stdio: "pipe", timeout: 15000 });
  assert.throws(() => assertPrivateRelayFiles(files, options), { code: "WORKER_STORAGE_UNSAFE" });
  assert.equal(checks, 3);
});

test("owned atomic writes refresh only the verified directory and exact new file identity", t => {
  const directory = temporary(t);
  const file = path.join(directory, "receipt.json");
  const other = path.join(directory, "other.json");
  let checks = 0;
  const run = (command, args) => { checks++; return JSON.stringify(readback(args[args.indexOf("-Kind") + 1])); };
  const options = { platform: "win32", run };
  protectPrivateRelayDirectory(directory, options);
  fs.writeFileSync(other, "other");
  assertPrivateRelayFile(other, options);
  const baseline = checks;
  for (let index = 0; index < 3; index++) {
    const ticket = beginPrivateRelayWrite(file, options);
    const temporary = path.join(directory, `.receipt.json.${index}.tmp`);
    const descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `receipt ${index}`);
    fs.fsyncSync(descriptor);
    bindPrivateRelayWrite(ticket, temporary, descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(temporary, file);
    finishPrivateRelayWrite(ticket);
    assertPrivateRelayFile(file, options);
  }
  assert.equal(checks, baseline);
  fs.writeFileSync(other, "externally changed");
  assertPrivateRelayFile(other, options);
  assert.equal(checks, baseline + 1);
});

test("an aborted or mismatched owned write cannot bless a foreign replacement", t => {
  const directory = temporary(t);
  const file = path.join(directory, "receipt.json");
  const pendingFile = path.join(directory, ".receipt.json.fixture.tmp");
  let checks = 0;
  const run = (command, args) => { checks++; return JSON.stringify(readback(args[args.indexOf("-Kind") + 1])); };
  const options = { platform: "win32", run };
  const ticket = beginPrivateRelayWrite(file, options);
  const descriptor = fs.openSync(pendingFile, "wx", 0o600);
  fs.writeFileSync(descriptor, "intended");
  bindPrivateRelayWrite(ticket, pendingFile, descriptor);
  fs.closeSync(descriptor);
  fs.unlinkSync(pendingFile);
  fs.writeFileSync(file, "foreign");
  assert.throws(() => finishPrivateRelayWrite(ticket), { code: "WORKER_STORAGE_UNSAFE" });
  const before = checks;
  assertPrivateRelayFile(file, options);
  assert.ok(checks > before);
  const abandoned = beginPrivateRelayWrite(file, options);
  abortPrivateRelayWrite(abandoned);
  assert.throws(() => finishPrivateRelayWrite(abandoned), { code: "WORKER_STORAGE_UNSAFE" });
});

test("Windows real owned writes avoid repeated PowerShell launches", { skip: process.platform !== "win32" }, t => {
  const directory = temporary(t);
  const file = path.join(directory, "receipt.json");
  let checks = 0;
  const run = (...args) => { checks++; return execFileSync(...args); };
  const options = { platform: "win32", run };
  protectPrivateRelayDirectory(directory, options);
  const baseline = checks;
  const started = performance.now();
  for (let index = 0; index < 3; index++) {
    const pendingFile = path.join(directory, `.receipt.json.${index}.tmp`);
    const ticket = beginPrivateRelayWrite(file, options);
    const descriptor = fs.openSync(pendingFile, "wx", 0o600);
    fs.writeFileSync(descriptor, `receipt ${index}`);
    fs.fsyncSync(descriptor);
    bindPrivateRelayWrite(ticket, pendingFile, descriptor);
    fs.closeSync(descriptor);
    fs.renameSync(pendingFile, file);
    finishPrivateRelayWrite(ticket);
    assertPrivateRelayFile(file, options);
  }
  assert.equal(checks, baseline);
  t.diagnostic(`Three real atomic writes: ${Math.round(performance.now() - started)} ms; additional ACL processes: ${checks - baseline}`);
});

test("Windows real ACL checks reject newly broadened permissions even after a cached check", { skip: process.platform !== "win32" }, t => {
  const directory = temporary(t);
  protectPrivateRelayDirectory(directory);
  assertPrivateRelayDirectory(directory);
  const script = "$ErrorActionPreference='Stop'; $p=$env:RELAY_TEST_PATH; $a=[IO.Directory]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access); $s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $r=New-Object Security.AccessControl.FileSystemAccessRule($s,'ReadAndExecute','Allow'); $a.AddAccessRule($r); [IO.Directory]::SetAccessControl($p,$a)";
  const windows = process.env.SystemRoot || "C:\\Windows";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  env.RELAY_TEST_PATH = directory;
  env.PSModulePath = path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "Modules");
  execFileSync(path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env, windowsHide: true, stdio: "pipe", timeout: 15000 });
  assert.throws(() => assertPrivateRelayDirectory(directory), { code: "WORKER_STORAGE_UNSAFE" });
  protectPrivateRelayDirectory(directory);
  assert.ok(assertPrivateRelayDirectory(directory).isDirectory());
  const file = path.join(directory, "receipt.json");
  const pendingFile = path.join(directory, ".receipt.json.fixture.tmp");
  const ticket = beginPrivateRelayWrite(file);
  const descriptor = fs.openSync(pendingFile, "wx", 0o600);
  fs.writeFileSync(descriptor, "owned receipt");
  fs.fsyncSync(descriptor);
  bindPrivateRelayWrite(ticket, pendingFile, descriptor);
  fs.closeSync(descriptor);
  fs.renameSync(pendingFile, file);
  finishPrivateRelayWrite(ticket);
  assert.ok(assertPrivateRelayFile(file).isFile());
  const fileScript = script.replaceAll("[IO.Directory]", "[IO.File]");
  execFileSync(path.win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(fileScript, "utf16le").toString("base64")], { env: { ...env, RELAY_TEST_PATH: file }, windowsHide: true, stdio: "pipe", timeout: 15000 });
  assert.throws(() => assertPrivateRelayFile(file), { code: "WORKER_STORAGE_UNSAFE" });
});

test("storage helpers refuse drive roots home directories and relative paths", () => {
  for (const target of [path.parse(process.cwd()).root, os.homedir(), "relative"]) assert.throws(() => protectPrivateRelayDirectory(target), { code: "WORKER_STORAGE_UNSAFE" });
});
