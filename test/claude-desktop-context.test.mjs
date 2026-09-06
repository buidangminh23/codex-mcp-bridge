import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { readClaudeDesktopContext } from "../src/claude-desktop-context.mjs";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER_USER = "33333333-3333-4333-8333-333333333333";
const TASK = "local_44444444-4444-4444-8444-444444444444";
const OTHER_TASK = "local_55555555-5555-4555-8555-555555555555";
const SESSION = "abcdef01-6666-4666-8666-666666666666";
const OTHER_SESSION = "77777777-7777-4777-8777-777777777777";
const BRIDGE = "session_live";

let sandbox;
let root;
let cwd;
let session;

function writeTask(changes = {}, { taskId = TASK, account = USER, directory = root } = {}) {
  const location = path.join(directory, ORG, account);
  fs.mkdirSync(location, { recursive: true });
  const file = path.join(location, `${taskId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    sessionId: taskId,
    cliSessionId: SESSION,
    bridgeSessionIds: [BRIDGE],
    cwd,
    title: "Exact native task title",
    isArchived: false,
    ...changes,
  }));
  return file;
}

function resolve(overrides = {}, options = {}) {
  return readClaudeDesktopContext({ ...session, ...overrides }, { root, ...options });
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "claude-desktop-context-"));
  root = path.join(sandbox, "metadata");
  cwd = path.join(sandbox, "project");
  fs.mkdirSync(cwd);
  session = { sessionId: SESSION, bridgeSessionId: BRIDGE, cwd };
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("Claude Desktop task identity", () => {
  it("returns only the native identity, exact title, canonical cwd and permission mode for an exact match", () => {
    writeTask({ remoteMcpServersConfig: { token: "must-never-appear" }, permissionMode: "bypassPermissions" });
    const actual = resolve();
    assert.deepEqual(actual, {
      status: "matched", taskId: TASK, title: "Exact native task title", cwd: fs.realpathSync.native(cwd),
      permissionMode: "bypassPermissions", permissionClass: "bypass",
      reason: "Exact live CLI session identity and canonical project directory match one active native Desktop task.",
    });
    assert.doesNotMatch(JSON.stringify(actual), /must-never-appear|metadata|remoteMcpServersConfig/);
  });

  /**
   * Claude's inbound parity gate groups bypassPermissions (and plan, only when
   * bypass is available) as one class and every other mode as prompting. The
   * Desktop record's permissionMode is the only recipient-side evidence the
   * bridge has, so it is reported verbatim with the derived class, and an
   * unknown or ambiguous mode yields no class rather than a guess.
   */
  it("reports the task's permission mode and its Claude parity class", () => {
    for (const [mode, expectedClass] of [["bypassPermissions", "bypass"], ["default", "prompting"], ["acceptEdits", "prompting"], ["auto", "prompting"], ["dontAsk", "prompting"], ["plan", null], ["", null], [42, null], [undefined, null], ["bypass\u0001Permissions", null], ["x".repeat(65), null], ["mode with space", null]]) {
      writeTask(mode === undefined ? {} : { permissionMode: mode });
      const actual = resolve();
      assert.equal(actual.status, "matched", String(mode));
      assert.equal(actual.permissionMode, typeof mode === "string" && /^[A-Za-z]{1,64}$/.test(mode) ? mode : null, String(mode));
      assert.equal(actual.permissionClass, expectedClass, String(mode));
    }
    writeTask({ permissionMode: "bypassPermissions", isArchived: true });
    const unmatched = resolve();
    assert.notEqual(unmatched.status, "matched");
    assert.equal(unmatched.permissionMode, null);
    assert.equal(unmatched.permissionClass, null);
  });

  it("can map an exact CLI session before the registry advertises a bridge ID", () => {
    writeTask();
    assert.equal(resolve({ bridgeSessionId: undefined }).status, "matched");
  });

  it("does not use names, title similarity or a shared project as identity", () => {
    writeTask({ cliSessionId: OTHER_SESSION, bridgeSessionIds: [] });
    assert.equal(resolve({ name: "Exact native task title" }).status, "missing");
    writeTask();
    assert.equal(resolve({ sessionId: ` ${SESSION}`, bridgeSessionId: undefined }).status, "missing");
    assert.equal(resolve({ sessionId: SESSION.toUpperCase(), bridgeSessionId: undefined }).status, "missing");
    assert.equal(resolve({ sessionId: SESSION.slice(0, 8), bridgeSessionId: undefined }).status, "missing");
  });

  it("rejects a stale CLI ID even when the old bridge identity matches", () => {
    writeTask({ cliSessionId: OTHER_SESSION });
    const actual = resolve();
    assert.equal(actual.status, "mismatch");
    assert.match(actual.reason, /different CLI session/);
    assert.equal(actual.taskId, null);
  });

  it("rejects missing or conflicting bridge corroboration", () => {
    const file = writeTask({ bridgeSessionIds: [] });
    assert.equal(resolve().status, "mismatch");
    fs.unlinkSync(file);
    writeTask({ bridgeSessionIds: ["session_other"] });
    writeTask({ cliSessionId: OTHER_SESSION }, { taskId: OTHER_TASK });
    assert.equal(resolve().status, "mismatch");
  });

  it("rejects multiple live mappings instead of choosing the newest record", () => {
    writeTask({ lastFocusedAt: 1 });
    writeTask({ lastFocusedAt: 999999 }, { taskId: OTHER_TASK });
    assert.equal(resolve().status, "ambiguous");
  });

  it("rejects copies across accounts even when their native task IDs are identical", () => {
    writeTask();
    writeTask({}, { account: OTHER_USER });
    assert.equal(resolve().status, "ambiguous");
  });

  it("rejects a copied native ID attached to another CLI ID", () => {
    writeTask();
    writeTask({ cliSessionId: OTHER_SESSION, bridgeSessionIds: [] }, { account: OTHER_USER });
    assert.equal(resolve().status, "ambiguous");
  });

  it("rejects mismatched task IDs and metadata filenames", () => {
    writeTask({ sessionId: OTHER_TASK });
    assert.equal(resolve().status, "mismatch");
  });

  it("does not silently choose an active copy over an archived duplicate", () => {
    writeTask();
    writeTask({ isArchived: true }, { taskId: OTHER_TASK });
    assert.equal(resolve().status, "ambiguous");
  });

  it("blocks archived records and unknown archive state", () => {
    const file = writeTask({ isArchived: true });
    assert.match(resolve().reason, /archived/);
    fs.unlinkSync(file);
    writeTask({ isArchived: undefined });
    assert.equal(resolve().status, "mismatch");
  });

  it("requires an existing exact canonical directory", () => {
    writeTask();
    const elsewhere = path.join(sandbox, "other-project");
    fs.mkdirSync(elsewhere);
    assert.equal(resolve({ cwd: elsewhere }).status, "mismatch");
    assert.equal(resolve({ cwd: path.join(sandbox, "gone") }).status, "mismatch");
    assert.equal(resolve({ cwd: "project" }).status, "mismatch");
  });

  it("accepts a symlink to the same project after canonicalization", () => {
    writeTask();
    const alias = path.join(sandbox, "project-alias");
    fs.symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(resolve({ cwd: alias }).status, "matched");
  });

  it("blocks absent, invalid and unsafe display titles", () => {
    for (const title of [undefined, "", "  ", "injected\nline", "x".repeat(1025)]) {
      writeTask({ title });
      const actual = resolve();
      assert.equal(actual.status, "mismatch");
      assert.equal(actual.title, null);
    }
  });

  it("returns a clear missing result when no metadata or live ID exists", () => {
    assert.equal(resolve().status, "missing");
    assert.equal(resolve({ sessionId: undefined }).status, "missing");
    writeTask();
    assert.equal(resolve({ bridgeSessionId: 123 }).status, "mismatch");
  });

  it("fails closed when a possible duplicate record cannot be read", () => {
    writeTask();
    const file = writeTask({}, { taskId: OTHER_TASK });
    fs.writeFileSync(file, "{");
    const actual = resolve();
    assert.equal(actual.status, "mismatch");
    assert.doesNotMatch(actual.reason, new RegExp(OTHER_TASK));
  });

  it("rejects a record replaced after its contents were read", () => {
    writeTask();
    const original = fs.readdirSync;
    let rootReads = 0;
    mock.method(fs, "readdirSync", (...args) => {
      if (args[0] === root && ++rootReads === 2) writeTask({ cliSessionId: OTHER_SESSION });
      return original(...args);
    });
    assert.equal(resolve().status, "mismatch");
  });

  it("rejects a duplicate task created while the metadata snapshot is being inspected", () => {
    writeTask();
    const original = fs.readdirSync;
    let rootReads = 0;
    mock.method(fs, "readdirSync", (...args) => {
      if (args[0] === root && ++rootReads === 2) writeTask({}, { taskId: OTHER_TASK });
      return original(...args);
    });
    assert.equal(resolve().status, "mismatch");
  });

  it("bounds metadata reads and rejects symbolic metadata files", () => {
    const file = writeTask();
    fs.truncateSync(file, 4 * 1024 * 1024 + 1);
    assert.equal(resolve().status, "mismatch");
    fs.unlinkSync(file);
    const unrelated = path.join(sandbox, "unrelated.json");
    fs.writeFileSync(unrelated, "{}");
    fs.symlinkSync(unrelated, file);
    assert.equal(resolve().status, "mismatch");
  });
});

describe("Claude Desktop metadata locations", () => {
  for (const platform of ["darwin", "win32", "linux"]) {
    it(`resolves the ${platform} location without reading the real user home`, () => {
      const config = path.join(sandbox, "config");
      const env = { HOME: sandbox, USERPROFILE: sandbox, APPDATA: config, XDG_CONFIG_HOME: config };
      const directory = platform === "darwin"
        ? path.join(sandbox, "Library", "Application Support", "Claude", "claude-code-sessions")
        : path.join(config, "Claude", "claude-code-sessions");
      writeTask({}, { directory });
      assert.equal(readClaudeDesktopContext(session, { platform, env }).status, "matched");
    });
  }

  it("uses the standard Linux and Windows home fallbacks", () => {
    for (const platform of ["linux", "win32"]) {
      const config = platform === "linux" ? [".config"] : ["AppData", "Roaming"];
      const directory = path.join(sandbox, ...config, "Claude", "claude-code-sessions");
      writeTask({}, { directory });
      assert.equal(readClaudeDesktopContext(session, { platform, env: { HOME: sandbox } }).status, "matched");
    }
  });
});
