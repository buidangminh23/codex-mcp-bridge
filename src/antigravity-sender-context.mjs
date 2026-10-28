import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessAncestry, runProcessInspector } from "./claude-sender-context.mjs";
import { antigravityBridgeDirectory, callAntigravityDesktop } from "./antigravity-ipc.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = "antigravity.google/";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
class ContextError extends Error {}
const fail = (reason) => { throw new ContextError(reason); };
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function readAntigravityConfigurationJson(file, { filesystem = fs } = {}) {
  const valid = (stat) => stat.isFile() && stat.nlink === 1n && stat.size >= 0n && stat.size <= 1048576n;
  const same = (left, right) => ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].every((key) => left[key] === right[key]);
  const before = await filesystem.lstat(file, { bigint: true });
  if (!valid(before)) fail("Native configuration must be a bounded regular file with one link");
  const handle = await filesystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const linked = await filesystem.lstat(file, { bigint: true });
    if (!valid(opened) || !valid(linked) || !same(before, opened) || !same(opened, linked)) fail("Native configuration changed while opening");
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await filesystem.lstat(file, { bigint: true });
    if (length !== Number(opened.size) || !valid(after) || !valid(current) || !same(opened, after) || !same(after, current)) fail("Native configuration changed while reading");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { await handle.close(); }
}

async function readExecutables(rows, { platform }) {
  if (platform === "win32") {
    const ids = rows.map((row) => row.pid);
    const script = `$ErrorActionPreference='Stop'; @(${ids.join(",")}) | ForEach-Object { $processId=$_; $p=Get-Process -Id $processId -ErrorAction SilentlyContinue; [PSCustomObject]@{pid=$processId;executable=$p.Path} } | ConvertTo-Json -Compress`;
    const shell = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await runProcessInspector(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 10000, maxBuffer: 16384, windowsHide: true });
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (platform === "darwin") return Promise.all(rows.map(async ({ pid }) => {
    const result = await runProcessInspector("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 5000, maxBuffer: 4096 });
    return { pid, executable: result.stdout.trim() };
  }));
  fail("Antigravity Desktop host verification is unsupported on this platform");
}

function validAncestry(rows, parentPid) {
  return Array.isArray(rows) && rows.length > 0 && rows.length <= 8 && rows[0].pid === parentPid
    && new Set(rows.map((row) => row.pid)).size === rows.length
    && rows.every((row, index) => Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 0xffffffff
      && Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && row.parentPid <= 0xffffffff
      && typeof row.processStart === "string" && row.processStart.length > 0
      && (!index || rows[index - 1].parentPid === row.pid));
}

function grants(value) {
  if (value === undefined) return { allow: [], ask: [], deny: [] };
  if (!object(value) || Object.keys(value).some((key) => !["allow", "ask", "deny"].includes(key))) fail("Native permission grants have an unsupported schema");
  const result = {};
  for (const key of ["allow", "ask", "deny"]) {
    const items = value[key] ?? [];
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string" || !item.trim())) fail("Native permission grants have an unsupported schema");
    result[key] = items;
  }
  return result;
}

function permissions(global, project) {
  const settings = global?.userSettings;
  if (!object(settings) || !object(project.settings ?? {})) fail("Native permission settings are unavailable");
  const local = project.settings ?? {};
  const wrapper = project.permissionGrants ?? {};
  if (!object(wrapper) || Object.keys(wrapper).some((key) => !["permissionGrants", "v2Migrated"].includes(key))) fail("Native project permission grants have an unsupported schema");
  if (settings.permissionGrantsV2Migrated !== true || (wrapper.v2Migrated !== undefined && wrapper.v2Migrated !== true)) fail("Native permission migration state is unsupported");
  const globalGrants = grants(settings.globalPermissionGrants);
  const projectGrants = grants(wrapper.permissionGrants);
  const preset = local.permissionPreset ?? settings.permissionPreset;
  const execution = local.autoExecutionPolicy ?? settings.autoExecutionPolicy;
  const sandbox = local.sandboxMode ?? settings.enableTerminalSandbox;
  const fileAccess = local.fileAccessPolicy ?? settings.nonWorkspaceFileAccessPolicy;
  const artifact = local.artifactReviewMode ?? settings.artifactReviewMode;
  const browser = local.browserJsExecutionPolicy ?? settings.browserJsExecutionPolicy;
  const knownPresets = ["AGENT_PERMISSION_PRESET_TURBO", "AGENT_PERMISSION_PRESET_REQUEST_REVIEW", "AGENT_PERMISSION_PRESET_DEFAULT", "AGENT_PERMISSION_PRESET_AUTO"];
  if (preset !== undefined && !knownPresets.includes(preset)) fail("Native permission preset is unsupported");
  if (!['CASCADE_COMMANDS_AUTO_EXECUTION_EAGER', 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF', 'CASCADE_COMMANDS_AUTO_EXECUTION_AUTO', 'CASCADE_COMMANDS_AUTO_EXECUTION_PROCEED_IN_SANDBOX'].includes(execution)
    || typeof sandbox !== "boolean" || !["AGENT_SETTING_POLICY_ALLOW", "AGENT_SETTING_POLICY_ASK", "AGENT_SETTING_POLICY_DENY"].includes(fileAccess)
    || !["ARTIFACT_REVIEW_MODE_ALWAYS", "ARTIFACT_REVIEW_MODE_TURBO", "ARTIFACT_REVIEW_MODE_AUTO"].includes(artifact)
    || !["BROWSER_JS_EXECUTION_POLICY_DISABLED", "BROWSER_JS_EXECUTION_POLICY_ALWAYS_ASK", "BROWSER_JS_EXECUTION_POLICY_MODEL_DECIDES", "BROWSER_JS_EXECUTION_POLICY_TURBO"].includes(browser)) fail("Native permission settings are incomplete or unsupported");
  const restricted = globalGrants.ask.length + globalGrants.deny.length + projectGrants.ask.length + projectGrants.deny.length > 0;
  const unrestricted = (!preset || preset === "AGENT_PERMISSION_PRESET_TURBO") && execution === "CASCADE_COMMANDS_AUTO_EXECUTION_EAGER" && sandbox === false && fileAccess === "AGENT_SETTING_POLICY_ALLOW" && artifact === "ARTIFACT_REVIEW_MODE_TURBO" && browser === "BROWSER_JS_EXECUTION_POLICY_TURBO" && !restricted;
  const mode = unrestricted ? "bypass" : "prompting";
  return { mode, fingerprint: hash({ preset, execution, sandbox, fileAccess, artifact, browser, globalGrants, projectGrants, globalMigration: settings.permissionGrantsV2Migrated, projectMigration: wrapper.v2Migrated }) };
}

export async function resolveAntigravitySenderContext(meta, dependencies = {}) {
  let reason = "Native Antigravity caller metadata is missing or invalid";
  try {
    if (!object(meta)) fail(reason);
    const conversationId = meta[PREFIX + "conversation_id"];
    const workspaces = meta[PREFIX + "workspace_paths"];
    if (typeof conversationId !== "string" || !UUID.test(conversationId) || (workspaces !== undefined && (!Array.isArray(workspaces) || workspaces.length !== 1))) fail(reason);
    const parent = meta[PREFIX + "parent_conversation_id"];
    const root = meta[PREFIX + "root_conversation_id"];
    if ((parent !== undefined && parent !== null && parent !== "") || (root !== undefined && root !== null && root !== "" && root !== conversationId)) fail("Nested Antigravity callers are not supported");
    const { home = os.homedir(), platform = process.platform, parentPid = process.ppid, readAncestry = readProcessAncestry, readExecutables: executables = readExecutables, readJson: json = readAntigravityConfigurationJson, realpath = fs.realpath } = dependencies;
    const paths = platform === "win32" ? path.win32 : path.posix;
    const canonical = async (value) => {
      if (typeof value !== "string" || value.includes("\0") || !paths.isAbsolute(value)) fail("Native workspace path is invalid");
      const resolved = paths.normalize(await realpath(value));
      return platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    reason = "Native Antigravity Desktop process ancestry could not be verified";
    const before = await readAncestry({ parentPid, platform });
    if (!validAncestry(before, parentPid)) fail(reason);
    const images = await executables(before, { platform });
    if (!Array.isArray(images) || images.length !== before.length || new Set(images.map((image) => image.pid)).size !== before.length) fail(reason);
    let appIndex = -1;
    let expected;
    for (let index = 0; index < before.length; index++) {
      const executable = await canonical(images.find((image) => image.pid === before[index].pid)?.executable);
      if (expected && executable === expected) { appIndex = index; break; }
      const suffix = platform === "win32" ? "\\resources\\bin\\language_server.exe" : "/Contents/Resources/bin/language_server";
      if (executable.endsWith(suffix)) {
        const rootPath = executable.slice(0, -suffix.length);
        expected = platform === "win32" ? paths.join(rootPath, "antigravity.exe") : paths.join(rootPath, "Contents", "MacOS", "Antigravity");
      }
    }
    if (appIndex < 0) fail(reason);
    reason = "Native Antigravity conversation could not be verified";
    const readNative = dependencies.readNative ?? ((id) => callAntigravityDesktop({ operation: "read", conversationId: id }, { directory: antigravityBridgeDirectory(home) }));
    const native = await readNative(conversationId);
    if (native?.conversationId !== conversationId || native.surface !== "desktop" || !UUID.test(native.projectId)) fail(reason);
    const cwd = await canonical(native.cwd);
    if (workspaces !== undefined && await canonical(workspaces[0]) !== cwd) fail(reason);
    const projectId = native.projectId;
    reason = "Native Antigravity project permissions could not be verified";
    const globalPath = paths.join(home, ".gemini", "config", "config.json");
    const projectPath = paths.join(home, ".gemini", "config", "projects", projectId + ".json");
    const global = await json(globalPath);
    const project = await json(projectPath);
    const resources = project?.projectResources?.resources;
    if (project?.id !== projectId || !Array.isArray(resources) || resources.length !== 1) fail(reason);
    const uri = resources[0]?.gitFolder?.folderUri;
    if (typeof uri !== "string" || await canonical(fileURLToPath(uri, { windows: platform === "win32" })) !== cwd) fail(reason);
    const policy = permissions(global, project);
    const after = await readAncestry({ parentPid, platform });
    if (!validAncestry(after, parentPid) || hash(before.slice(0, appIndex + 1)) !== hash(after.slice(0, appIndex + 1))) fail("Native Antigravity host changed during verification");
    if (hash(global) !== hash(await json(globalPath)) || hash(project) !== hash(await json(projectPath))) fail("Native Antigravity permissions changed during verification");
    return { status: "verified", provider: "antigravity", id: conversationId, conversationId, cwd, projectId, surface: "desktop", mode: policy.mode, permissionFingerprint: policy.fingerprint };
  } catch (error) {
    return { status: "unverified", provider: "antigravity", reason: error instanceof ContextError ? error.message : reason };
  }
}
