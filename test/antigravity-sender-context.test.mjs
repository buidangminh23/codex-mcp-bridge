import assert from "node:assert/strict";
import { test } from "node:test";
import { constants } from "node:fs";
import { readAntigravityConfigurationJson, resolveAntigravitySenderContext } from "../src/antigravity-sender-context.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const prefix = "antigravity.google/";

function fixture() {
  const meta = { [prefix + "conversation_id"]: id, [prefix + "workspace_paths"]: ["C:\\Work\\Project"], [prefix + "root_conversation_id"]: id };
  const ancestry = [{ pid: 200, parentPid: 100, processStart: "2000" }, { pid: 100, parentPid: 50, processStart: "1000" }];
  const images = [{ pid: 200, executable: "C:\\Apps\\Antigravity\\resources\\bin\\language_server.exe" }, { pid: 100, executable: "C:\\Apps\\Antigravity\\Antigravity.exe" }];
  const global = { userSettings: { autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER", enableTerminalSandbox: false, nonWorkspaceFileAccessPolicy: "AGENT_SETTING_POLICY_ALLOW", artifactReviewMode: "ARTIFACT_REVIEW_MODE_TURBO", browserJsExecutionPolicy: "BROWSER_JS_EXECUTION_POLICY_TURBO", permissionGrantsV2Migrated: true, globalPermissionGrants: { allow: ["mcp(*)"] } } };
  const project = { id: projectId, projectResources: { resources: [{ gitFolder: { folderUri: "file:///C:/Work/Project" } }] }, settings: {}, permissionGrants: { v2Migrated: true } };
  const native = { conversationId: id, cwd: "C:\\Work\\Project", projectId, surface: "desktop" };
  const deps = { home: "C:\\Home", platform: "win32", parentPid: 200, readAncestry: async () => ancestry, readExecutables: async () => images, realpath: async (value) => value, readNative: async (requested) => { assert.equal(requested, id); return native; }, readJson: async (file) => structuredClone(file.endsWith("config.json") ? global : project) };
  return { meta, ancestry, images, global, project, native, deps, resolve: () => resolveAntigravitySenderContext(meta, deps) };
}

test("verifies exact native caller and complete legacy unrestricted policy without an account claim", async () => {
  const f = fixture();
  const result = await f.resolve();
  assert.equal(result.status, "verified");
  assert.equal(result.mode, "bypass");
  assert.equal(result.id, id);
  assert.equal(result.conversationId, id);
  assert.equal(result.cwd, "c:\\work\\project");
  assert.equal(result.projectId, projectId);
  assert.equal(result.surface, "desktop");
  assert.match(result.permissionFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.accountId, undefined);
});

test("rejects absent, ambiguous, forged-shaped, and nested caller metadata before native reads", async () => {
  const cases = [null, {}, { [prefix + "conversation_id"]: "invalid" }, { [prefix + "workspace_paths"]: [] }, { [prefix + "workspace_paths"]: ["C:\\Work\\Project", "C:\\Other"] }, { [prefix + "workspace_paths"]: "C:\\Work\\Project" }, { [prefix + "parent_conversation_id"]: projectId }, { [prefix + "root_conversation_id"]: projectId }];
  for (const patch of cases) {
    const f = fixture();
    f.deps.readNative = async () => assert.fail("Invalid metadata reached native API");
    const result = await resolveAntigravitySenderContext(patch === null ? null : Object.keys(patch).length ? { ...f.meta, ...patch } : {}, f.deps);
    assert.equal(result.status, "unverified");
  }
});

test("derives absent workspace metadata from exact native Desktop conversation and project", async () => {
  const f = fixture();
  delete f.meta[prefix + "workspace_paths"];
  f.meta[prefix + "artifacts_dir"] = "C:\\Home\\.gemini\\antigravity\\brain\\" + id;
  const result = await f.resolve();
  assert.equal(result.status, "verified");
  assert.equal(result.conversationId, id);
  assert.equal(result.cwd, "c:\\work\\project");
  assert.equal(result.projectId, projectId);
  f.native.cwd = "C:\\Other";
  assert.equal((await f.resolve()).status, "unverified");
  f.native.cwd = undefined;
  assert.equal((await f.resolve()).status, "unverified");
});

test("rejects inconsistent or null workspace metadata instead of silently using native fallback", async () => {
  for (const workspaces of [null, ["C:\\Other"], ["relative"]]) {
    const f = fixture();
    f.meta[prefix + "workspace_paths"] = workspaces;
    assert.equal((await f.resolve()).status, "unverified");
  }
});

test("rejects CLI, IDE, unrelated app installation, broken ancestry and PID reuse", async () => {
  for (const change of [
    (f) => { f.images[0].executable = "C:\\agy\\agy.exe"; },
    (f) => { f.images[1].executable = "C:\\Apps\\Antigravity IDE\\Antigravity IDE.exe"; },
    (f) => { f.images[1].executable = "C:\\Other\\Antigravity.exe"; },
    (f) => { f.ancestry[0].parentPid = 99; },
    (f) => { f.images.push(f.images[0]); },
    (f) => { let calls = 0; f.deps.readAncestry = async () => ++calls === 1 ? f.ancestry : [{ ...f.ancestry[0], processStart: "new" }, f.ancestry[1]]; },
  ]) {
    const f = fixture(); change(f);
    assert.equal((await f.resolve()).status, "unverified");
  }
});

test("requires exact native conversation, Desktop surface, cwd and project resources", async () => {
  for (const change of [
    (f) => { f.native.conversationId = projectId; },
    (f) => { f.native.surface = "cli"; },
    (f) => { f.native.cwd = "C:\\Other"; },
    (f) => { f.native.projectId = "../../secrets"; },
    (f) => { f.project.id = id; },
    (f) => { f.project.projectResources.resources[0].gitFolder.folderUri = "file:///C:/Other"; },
    (f) => { f.project.projectResources.resources.push(f.project.projectResources.resources[0]); },
  ]) {
    const f = fixture(); change(f);
    assert.equal((await f.resolve()).status, "unverified");
  }
});

test("project settings override global settings and denial or ask always prevents bypass", async () => {
  const changes = [
    (f) => { f.project.settings.permissionPreset = "AGENT_PERMISSION_PRESET_DEFAULT"; },
    (f) => { f.project.settings.permissionPreset = "AGENT_PERMISSION_PRESET_REQUEST_REVIEW"; },
    (f) => { f.project.settings.permissionPreset = "AGENT_PERMISSION_PRESET_AUTO"; },
    (f) => { f.project.settings.sandboxMode = true; },
    (f) => { f.project.settings.autoExecutionPolicy = "CASCADE_COMMANDS_AUTO_EXECUTION_OFF"; },
    (f) => { f.project.settings.fileAccessPolicy = "AGENT_SETTING_POLICY_ASK"; },
    (f) => { f.project.settings.artifactReviewMode = "ARTIFACT_REVIEW_MODE_ALWAYS"; },
    (f) => { f.global.userSettings.browserJsExecutionPolicy = "BROWSER_JS_EXECUTION_POLICY_ALWAYS_ASK"; },
    (f) => { f.global.userSettings.globalPermissionGrants.deny = ["shell(*)"]; },
    (f) => { f.project.permissionGrants.permissionGrants = { ask: ["mcp(*)"] }; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    const result = await f.resolve();
    assert.equal(result.status, "verified");
    assert.equal(result.mode, "prompting");
  }
  const f = fixture();
  f.global.userSettings.enableTerminalSandbox = true;
  f.project.settings = { permissionPreset: "AGENT_PERMISSION_PRESET_TURBO", sandboxMode: false };
  assert.equal((await f.resolve()).mode, "bypass");
});

test("blocks missing, unmigrated, future or malformed permission schemas", async () => {
  for (const change of [
    (f) => { delete f.global.userSettings.enableTerminalSandbox; },
    (f) => { delete f.global.userSettings.permissionGrantsV2Migrated; },
    (f) => { f.project.permissionGrants.v2Migrated = false; },
    (f) => { f.project.settings.permissionPreset = "AGENT_PERMISSION_PRESET_FUTURE"; },
    (f) => { f.global.userSettings.autoExecutionPolicy = "unknown"; },
    (f) => { f.global.userSettings.globalPermissionGrants = { deny: "shell(*)" }; },
    (f) => { f.global.userSettings.globalPermissionGrants = { allow: [{ value: "shell(*)" }] }; },
    (f) => { f.project.permissionGrants = { future: true }; },
  ]) {
    const f = fixture(); change(f);
    assert.equal((await f.resolve()).status, "unverified");
  }
});

test("detects configuration changes during validation and binds permission fingerprint to overrides", async () => {
  const f = fixture();
  const before = await f.resolve();
  f.project.permissionGrants.permissionGrants = { allow: ["mcp(other/*)"] };
  assert.notEqual((await f.resolve()).permissionFingerprint, before.permissionFingerprint);
  let calls = 0;
  f.deps.readJson = async (file) => {
    const value = structuredClone(file.endsWith("config.json") ? f.global : f.project);
    if (++calls > 2 && value.userSettings) value.userSettings.enableTerminalSandbox = true;
    return value;
  };
  assert.equal((await f.resolve()).status, "unverified");
});

test("never leaks native transport errors or reads a fallback conversation", async () => {
  const f = fixture();
  f.deps.readNative = async () => { throw new Error("Native sensitive stderr csrf_token=secret"); };
  const result = await f.resolve();
  assert.equal(result.status, "unverified");
  assert.doesNotMatch(JSON.stringify(result), /secret|csrf/);
});

test("ignores inaccessible ancestors above the verified app and requires canonical workspace equality", async () => {
  const f = fixture();
  f.ancestry.push({ pid: 50, parentPid: 0, processStart: "500" });
  f.images.push({ pid: 50, executable: null });
  f.meta[prefix + "workspace_paths"] = ["C:\\Alias"];
  f.deps.realpath = async (value) => value === "C:\\Alias" ? "C:\\Work\\Project" : value;
  assert.equal((await f.resolve()).status, "verified");
  f.deps.realpath = async (value) => value;
  assert.equal((await f.resolve()).status, "unverified");
});

function configurationReader() {
  const state = { data: Buffer.from('{"safe":true}'), closed: false, reads: 0, opened: false };
  state.stat = { dev: 1n, ino: 2n, nlink: 1n, size: BigInt(state.data.length), mtimeNs: 3n, ctimeNs: 4n, isFile: () => true };
  const handle = {
    stat: async () => ({ ...state.stat }),
    read: async (buffer, offset, length, position) => {
      state.reads++;
      assert.ok(buffer.length <= 1048577);
      const bytesRead = state.data.copy(buffer, offset, position, position + Math.min(length, 4));
      return { bytesRead };
    },
    close: async () => { state.closed = true; },
  };
  const filesystem = {
    lstat: async () => ({ ...state.stat }),
    open: async (_file, flags) => {
      state.opened = true;
      if (constants.O_NOFOLLOW) assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
      if (constants.O_NONBLOCK) assert.equal(flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
      return handle;
    },
  };
  return { state, filesystem, handle, read: () => readAntigravityConfigurationJson("config.json", { filesystem }) };
}

test("reads configuration through a bounded descriptor and closes it", async () => {
  const f = configurationReader();
  assert.deepEqual(await f.read(), { safe: true });
  assert.ok(f.state.reads > 1);
  assert.equal(f.state.closed, true);
});

test("rejects FIFO, symlink, hardlink and oversized configuration before opening", async () => {
  for (const patch of [{ isFile: () => false }, { nlink: 2n }, { size: 1048577n }]) {
    const f = configurationReader();
    Object.assign(f.state.stat, patch);
    await assert.rejects(f.read(), /bounded regular file/);
    assert.equal(f.state.opened, false);
  }
});

test("rejects configuration replacement, growth and same-size mutation while always closing", async () => {
  for (const scenario of ["open-race", "path-race", "growth", "timestamp", "short-read"]) {
    const f = configurationReader();
    if (scenario === "open-race") f.handle.stat = async () => ({ ...f.state.stat, ino: 9n });
    if (scenario === "path-race") {
      let calls = 0;
      f.filesystem.lstat = async () => ({ ...f.state.stat, ino: ++calls > 2 ? 9n : 2n });
    }
    if (scenario === "growth") f.state.data = Buffer.concat([f.state.data, Buffer.from("x")]);
    if (scenario === "timestamp") {
      let calls = 0;
      f.handle.stat = async () => ({ ...f.state.stat, mtimeNs: ++calls > 1 ? 99n : 3n });
    }
    if (scenario === "short-read") f.state.data = f.state.data.subarray(0, 2);
    await assert.rejects(f.read(), /changed while/);
    assert.equal(f.state.closed, true);
    if (scenario === "open-race") assert.equal(f.state.reads, 0);
  }
});
