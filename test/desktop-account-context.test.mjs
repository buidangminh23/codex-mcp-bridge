import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { readClaudeAccountContext } from "../src/desktop-account-context.mjs";

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
let sandbox;
let root;

function writeConfig(accountId = ACCOUNT_A, signedIn = true, directory = root, extra = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify({ lastKnownAccountUuid: accountId, windowSizeWasSignedIn: signedIn, ...extra }));
  return file;
}

function resolve(options = {}) {
  return readClaudeAccountContext({ root, ...options });
}

function expectHiddenIdentity(actual, status) {
  assert.equal(actual.status, status);
  assert.equal(actual.accountId, null);
  assert.equal(actual.fingerprint, null);
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-account-context-"));
  root = path.join(sandbox, "Claude");
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Claude Desktop persisted account identity", () => {
  it("rediscovers repeated A to B to A switches without caching either account", () => {
    const fingerprints = [];
    for (const account of [ACCOUNT_A, ACCOUNT_B, ACCOUNT_A]) {
      writeConfig(account);
      const actual = resolve();
      assert.equal(actual.status, "verified");
      assert.equal(actual.accountId, account);
      assert.equal(actual.root, root);
      assert.equal(actual.fingerprint, createHash("sha256").update(`claude-desktop\0${account}`).digest("hex"));
      assert.match(actual.reason, /persisted/);
      fingerprints.push(actual.fingerprint);
    }
    assert.notEqual(fingerprints[0], fingerprints[1]);
    assert.equal(fingerprints[0], fingerprints[2]);
  });

  it("hides the retained account on signout and rediscovers it after login", () => {
    writeConfig();
    assert.equal(resolve().status, "verified");
    writeConfig(ACCOUNT_A, false);
    expectHiddenIdentity(resolve(), "signed_out");
    writeConfig(ACCOUNT_B);
    assert.equal(resolve().accountId, ACCOUNT_B);
  });

  it("projects only allowlisted identity state and never returns unrelated config values", () => {
    writeConfig(ACCOUNT_A.toUpperCase(), true, root, { token: "must-never-appear", email: "private@example.invalid", accountId: ACCOUNT_B });
    const actual = resolve({ env: { CLAUDE_ACCOUNT_ID: ACCOUNT_B } });
    assert.equal(actual.accountId, ACCOUNT_A);
    assert.deepEqual(Object.keys(actual).sort(), ["accountId", "fingerprint", "reason", "root", "status"]);
    assert.doesNotMatch(JSON.stringify(actual), /must-never-appear|private@example|22222222/);
  });

  it("fails closed for missing, partial, invalid and oversized config", () => {
    expectHiddenIdentity(resolve(), "unavailable");
    fs.mkdirSync(root);
    expectHiddenIdentity(resolve(), "unavailable");
    for (const contents of ["{", "[]", "null", "{}", '{"lastKnownAccountUuid":"' + ACCOUNT_A + '"}', '{"windowSizeWasSignedIn":true}', '{"lastKnownAccountUuid":"invalid","windowSizeWasSignedIn":true}', '{"lastKnownAccountUuid":"' + ACCOUNT_A + '","windowSizeWasSignedIn":"true"}']) {
      fs.writeFileSync(path.join(root, "config.json"), contents);
      expectHiddenIdentity(resolve(), "unavailable");
    }
    writeConfig();
    fs.truncateSync(path.join(root, "config.json"), 1024 * 1024 + 1);
    expectHiddenIdentity(resolve(), "unavailable");
  });

  it("rejects relative overrides and does not fall back around a selected invalid root", () => {
    writeConfig();
    expectHiddenIdentity(resolve({ root: "relative" }), "unavailable");
    expectHiddenIdentity(readClaudeAccountContext({ env: { CLAUDE_DESKTOP_USER_DATA: "relative", APPDATA: sandbox }, platform: "win32" }), "unavailable");
    expectHiddenIdentity(readClaudeAccountContext({ env: { CLAUDE_DESKTOP_USER_DATA: path.join(sandbox, "missing"), APPDATA: sandbox }, platform: "win32" }), "unavailable");
  });

  it("rejects a symbolic data root even when it points at a valid account", () => {
    writeConfig();
    const alias = path.join(sandbox, "alias");
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    expectHiddenIdentity(resolve({ root: alias }), "unavailable");
  });

  it("rejects a symbolic config file without reading its target", (t) => {
    fs.mkdirSync(root);
    const target = path.join(sandbox, "target.json");
    fs.writeFileSync(target, JSON.stringify({ lastKnownAccountUuid: ACCOUNT_A, windowSizeWasSignedIn: true }));
    try { fs.symlinkSync(target, path.join(root, "config.json")); }
    catch (error) {
      if (error.code === "EPERM" || error.code === "EACCES") return t.skip("this OS does not grant file symlink creation");
      throw error;
    }
    let opened = false;
    mock.method(fs, "openSync", () => { opened = true; throw new Error("config must not be opened"); });
    expectHiddenIdentity(resolve(), "unavailable");
    assert.equal(opened, false);
  });

  it("rejects account bytes changed between reads even when stat values are frozen", () => {
    const file = writeConfig();
    const originalRead = fs.readSync;
    const originalLstat = fs.lstatSync;
    const originalFstat = fs.fstatSync;
    const frozen = new Map();
    const initialFileStat = originalLstat(file);
    mock.method(fs, "lstatSync", (target, ...args) => {
      if (!frozen.has(target)) frozen.set(target, originalLstat(target, ...args));
      return frozen.get(target);
    });
    mock.method(fs, "fstatSync", (descriptor, ...args) => {
      const current = originalFstat(descriptor, ...args);
      return current.isFile() ? initialFileStat : current;
    });
    let reads = 0;
    mock.method(fs, "readSync", (...args) => {
      const count = originalRead(...args);
      if (++reads === 1) writeConfig(ACCOUNT_B);
      return count;
    });
    expectHiddenIdentity(resolve(), "unavailable");
  });

  it("rejects a regular config path replaced with a directory", () => {
    fs.mkdirSync(path.join(root, "config.json"), { recursive: true });
    expectHiddenIdentity(resolve(), "unavailable");
  });
});

describe("Claude Desktop account data discovery", () => {
  it("finds macOS and Linux data roots using supplied homes and config roots", () => {
    const macRoot = path.join(sandbox, "Library", "Application Support", "Claude");
    const linuxRoot = path.join(sandbox, "config", "Claude");
    writeConfig(ACCOUNT_A, true, macRoot);
    writeConfig(ACCOUNT_B, true, linuxRoot);
    assert.equal(readClaudeAccountContext({ platform: "darwin", env: { HOME: sandbox } }).root, macRoot);
    assert.equal(readClaudeAccountContext({ platform: "linux", env: { HOME: sandbox, XDG_CONFIG_HOME: path.join(sandbox, "config") } }).accountId, ACCOUNT_B);
  });

  it("finds the Windows MSIX root while ignoring an unrelated ordinary config", () => {
    const local = path.join(sandbox, "Local");
    const packaged = path.join(local, "Packages", "Claude_test", "LocalCache", "Roaming", "Claude");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "config.json"), '{"theme":"dark"}');
    writeConfig(ACCOUNT_B, true, packaged);
    const actual = readClaudeAccountContext({ platform: "win32", env: { HOME: sandbox, APPDATA: sandbox, LOCALAPPDATA: local } });
    assert.equal(actual.status, "verified");
    assert.equal(actual.root, packaged);
    assert.equal(actual.accountId, ACCOUNT_B);
  });

  it("does not choose a newer conflicting root or guess between duplicate roots", () => {
    const local = path.join(sandbox, "Local");
    const packaged = path.join(local, "Packages", "Claude_test", "LocalCache", "Roaming", "Claude");
    const env = { HOME: sandbox, APPDATA: sandbox, LOCALAPPDATA: local };
    writeConfig(ACCOUNT_A);
    for (const [account, signedIn] of [[ACCOUNT_B, true], [ACCOUNT_A, true], [ACCOUNT_A, false]]) {
      const file = writeConfig(account, signedIn, packaged);
      fs.utimesSync(file, new Date(), new Date(Date.now() + 60000));
      const actual = readClaudeAccountContext({ platform: "win32", env });
      expectHiddenIdentity(actual, "ambiguous");
      assert.equal(actual.root, null);
    }
    assert.equal(readClaudeAccountContext({ platform: "win32", env: { ...env, CLAUDE_DESKTOP_USER_DATA: root } }).accountId, ACCOUNT_A);
  });

  it("rejects a newly appearing packaged root during discovery", () => {
    const local = path.join(sandbox, "Local");
    const packages = path.join(local, "Packages");
    fs.mkdirSync(packages, { recursive: true });
    writeConfig();
    const originalRead = fs.readSync;
    let created = false;
    mock.method(fs, "readSync", (...args) => {
      const count = originalRead(...args);
      if (!created) {
        created = true;
        writeConfig(ACCOUNT_B, true, path.join(packages, "Claude_new", "LocalCache", "Roaming", "Claude"));
      }
      return count;
    });
    expectHiddenIdentity(readClaudeAccountContext({ platform: "win32", env: { HOME: sandbox, APPDATA: sandbox, LOCALAPPDATA: local } }), "unavailable");
  });

  it("does not traverse a symbolic Windows package directory", () => {
    const local = path.join(sandbox, "Local");
    const packages = path.join(local, "Packages");
    fs.mkdirSync(packages, { recursive: true });
    const destination = path.join(sandbox, "package-target");
    writeConfig(ACCOUNT_A, true, path.join(destination, "LocalCache", "Roaming", "Claude"));
    fs.symlinkSync(destination, path.join(packages, "Claude_link"), process.platform === "win32" ? "junction" : "dir");
    expectHiddenIdentity(readClaudeAccountContext({ platform: "win32", env: { HOME: sandbox, APPDATA: sandbox, LOCALAPPDATA: local } }), "unavailable");
  });
});
