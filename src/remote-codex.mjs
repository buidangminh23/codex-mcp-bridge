import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { relaySocketPath, resolveRelayThreadId, validateDesktopOperation, decodeNativeToolResult } from "./native-relay.mjs";
import { readCodexAccountContext } from "./codex-account-context.mjs";
import { NativeCreationReceipts, creationIdValid, creationRequestHash } from "./native-creation-receipts.mjs";
import { captureProjectScope, recheckProjectScope } from "./project-scope.mjs";
import { createHardenedRootPolicy } from "./hardened-root-policy.mjs";

const LIMIT = 128 * 1024;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const ownObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const cleanPath = (value) => typeof value === "string" && value.length <= 4096 && !/[\0\r\n]/.test(value);
const home = (env) => env.CODEX_HOME ?? path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
export const remoteCodexSocketPath = (env = process.env) => `${relaySocketPath(env)}-codex-remote-v1`;

export function currentRemoteAccount() {
  const account = readCodexAccountContext();
  if (account.status !== "verified") throw remoteFailure("REMOTE_ACCOUNT_UNVERIFIED", account.reason);
  return { codex: account.fingerprint };
}

export function assertRemoteAccount(expected) {
  if (currentRemoteAccount().codex !== expected.codex) throw remoteFailure("REMOTE_ACCOUNT_CHANGED", "The receiving Codex account changed during this operation");
}

export function remoteNativeAdapter(nativeTools, env = process.env) {
  return { async requestDesktop(operation, args, { beforeSend }) {
    validateDesktopOperation(operation, args);
    const result = await nativeTools.dispatchDesktop({ executorThreadId: resolveRelayThreadId(env).threadId, operation, arguments: args }, { beforeSend });
    return { result: decodeNativeToolResult(result) };
  } };
}

export function forwardRemoteRequest(request, { env = process.env, timeoutMs = 30000, socketPath = remoteCodexSocketPath(env) } = {}) {
  validateRemoteRequest(request);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    let output = Buffer.alloc(0), settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const uncertain = () => remoteFailure("REMOTE_DELIVERY_UNCONFIRMED", "The Codex remote companion did not confirm delivery. Keep the requestId and inspect the destination; no fallback or resend was attempted");
    const timer = setTimeout(() => finish(uncertain()), timeoutMs);
    socket.on("error", () => finish(uncertain()));
    socket.on("close", () => { if (!settled) finish(uncertain()); });
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 4 * 1024 * 1024) return finish(uncertain());
      const end = output.indexOf(10);
      if (end < 0) return;
      try {
        const response = JSON.parse(output.subarray(0, end).toString("utf8"));
        if (response.version !== 1 || response.action !== request.action || response.requestId !== (request.requestId ?? null)) throw uncertain();
        if (!response.ok) throw remoteFailure(response.error?.code ?? "REMOTE_FAILED", response.error?.message ?? "Remote Codex refused the request");
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
  });
}

export async function remoteRequestResponse(request, options) {
  try {
    const result = await handleRemoteRequest(request, options);
    return { version: 1, ok: true, action: request.action, requestId: request.requestId ?? null, result };
  } catch (error) {
    return { version: 1, ok: false, action: request?.action, requestId: request?.requestId ?? null, error: { code: error.code ?? "REMOTE_FAILED", message: error.message } };
  }
}

export function remoteFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function repositoryIdentity(cwd) {
  const value = execFileSync("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
  const scp = value.includes("://") ? null : value.match(/^(?:[^@/:]+@)?([^/:]+):([^/].*)$/);
  let url;
  try { url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : value); }
  catch { throw remoteFailure("REMOTE_PROJECT_UNVERIFIED", "The project needs a canonical network origin URL"); }
  if (!["https:", "ssh:"].includes(url.protocol) || url.password || url.protocol === "https:" && url.username || url.search || url.hash) throw remoteFailure("REMOTE_PROJECT_UNVERIFIED", "The project origin is unsupported");
  const name = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!name || name.split("/").some((part) => !part || part === "." || part === "..")) throw remoteFailure("REMOTE_PROJECT_UNVERIFIED", "The project origin path is invalid");
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${name}`;
}

export function readRemoteProfile(name, { env = process.env } = {}) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw remoteFailure("REMOTE_HOST_INVALID", "Choose an exact configured remote host name");
  const root = home(env);
  if (!cleanPath(root) || !path.isAbsolute(root)) throw remoteFailure("REMOTE_CONFIG_UNSAFE", "Codex configuration directory must be absolute");
  const directory = fs.realpathSync.native(root);
  const file = path.resolve(directory, "bridge-remote-hosts.json");
  if (!file.startsWith(directory + path.sep)) throw remoteFailure("REMOTE_CONFIG_UNSAFE", "Remote host configuration is outside Codex home");
  const safe = (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n && entry.size <= BigInt(LIMIT)
    && (process.platform === "win32" || entry.uid === BigInt(process.getuid()) && !(entry.mode & 0o077n));
  const same = (left, right) => ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"].every((key) => left[key] === right[key]);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  let config;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const stat = fs.lstatSync(file, { bigint: true });
    if (!safe(opened) || !safe(stat)) throw remoteFailure("REMOTE_CONFIG_UNSAFE", "Remote host configuration must be a private regular file");
    if (!same(stat, opened)) throw remoteFailure("REMOTE_CONFIG_CHANGED", "Remote host configuration changed after opening");
    const data = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw remoteFailure("REMOTE_CONFIG_CHANGED", "Remote host configuration changed during reading");
      offset += count;
    }
    const current = fs.lstatSync(file, { bigint: true });
    if (!safe(current) || !same(opened, fs.fstatSync(descriptor, { bigint: true })) || !same(opened, current)
        || fs.realpathSync.native(root) !== directory) throw remoteFailure("REMOTE_CONFIG_CHANGED", "Remote host configuration changed during reading");
    config = JSON.parse(data.toString("utf8"));
  } finally { fs.closeSync(descriptor); }
  const profile = config.version === 1 && Object.hasOwn(config.hosts ?? {}, name) ? config.hosts[name] : null;
  if (!ownObject(profile) || Object.keys(profile).sort().join() !== ["sshHost", "node", "receiver", "localCwd", "remoteCwd"].sort().join()
      || typeof profile.sshHost !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(profile.sshHost)
      || ![profile.node, profile.receiver, profile.remoteCwd].every((value) => cleanPath(value) && path.posix.isAbsolute(value))
      || !cleanPath(profile.localCwd) || !path.isAbsolute(profile.localCwd)) throw remoteFailure("REMOTE_CONFIG_INVALID", "Remote host needs an SSH alias, absolute POSIX runtime/receiver/project paths and an absolute local project path");
  return Object.freeze({ ...profile });
}

export function validateRemoteRequest(request) {
  if (!ownObject(request) || Object.keys(request).some((key) => !["version", "action", "cwd", "repository", "account", "sender", "threadId", "message", "requestId"].includes(key))
      || request.version !== 1 || !["list", "read", "send"].includes(request.action)
      || !cleanPath(request.cwd) || !path.isAbsolute(request.cwd)
      || typeof request.repository !== "string" || request.repository.length > 4096 || !HASH.test(request.account)
      || !ownObject(request.sender) || Object.keys(request.sender).sort().join() !== ["host", "threadId", "mode"].sort().join()
      || !ID.test(request.sender.threadId) || !["bypass", "prompting"].includes(request.sender.mode)
      || typeof request.sender.host !== "string" || !/^[A-Za-z0-9_.-]{1,255}$/.test(request.sender.host)
      || request.action !== "list" && !ID.test(request.threadId)
      || request.action === "send" && (!creationIdValid(request.requestId) || typeof request.message !== "string" || !request.message.trim() || request.message.length > 50000)
      || request.action !== "send" && (request.message !== undefined || request.requestId !== undefined)
      || request.action === "list" && request.threadId !== undefined
      || Buffer.byteLength(JSON.stringify(request)) > LIMIT) throw remoteFailure("REMOTE_REQUEST_INVALID", "Invalid remote Codex request");
  if (request.action === "send" && request.sender.mode !== "bypass") throw remoteFailure("REMOTE_SENDER_PERMISSION", "Remote sending requires a verified Full access Codex turn; no permission setting was changed");
  return request;
}

export function remoteSshArguments(profile) {
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const command = `${quote(profile.node)} ${quote(profile.receiver)}`;
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no", "--", profile.sshHost, `zsh -lc ${quote(command)}`];
}

export function exchangeRemoteRequest(profile, request, { spawnProcess = spawn, timeoutMs = 35000 } = {}) {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > LIMIT) throw remoteFailure("REMOTE_REQUEST_INVALID", "Remote request exceeds its limit");
  return new Promise((resolve, reject) => {
    const child = spawnProcess("ssh", remoteSshArguments(profile), { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const uncertain = () => remoteFailure("REMOTE_DELIVERY_UNCONFIRMED", "SSH did not confirm the result. Keep the same requestId and inspect the existing destination; do not send a new request");
    const timer = setTimeout(() => finish(uncertain()), timeoutMs);
    child.on("error", () => finish(uncertain()));
    child.stdin.on("error", () => finish(uncertain()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 4 * 1024 * 1024) return finish(uncertain());
      output += chunk;
    });
    child.stderr.resume();
    child.on("close", (code) => {
      if (code !== 0) return finish(uncertain());
      try {
        const response = JSON.parse(output);
        if (response.version !== 1 || response.action !== request.action || response.requestId !== (request.requestId ?? null)) throw uncertain();
        if (!response.ok) return finish(remoteFailure(response.error?.code ?? "REMOTE_FAILED", response.error?.message ?? "Remote Codex refused the request"));
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    child.stdin.end(input + "\n");
  });
}

export async function handleRemoteRequest(request, {
  env = process.env,
  readAccounts = currentRemoteAccount,
  assertAccounts = assertRemoteAccount,
  repository = repositoryIdentity,
  canonical = (value) => fs.realpathSync.native(value),
  captureScope = captureProjectScope,
  recheckScope = recheckProjectScope,
  relay,
  rootPolicy = createHardenedRootPolicy(env),
  receipts = new NativeCreationReceipts({ directory: path.join(home(env), "bridge-remote-deliveries"), accountProviders: ["codex"] }),
  executor = () => resolveRelayThreadId(env).threadId,
} = {}) {
  validateRemoteRequest(request);
  const accounts = readAccounts();
  if (!accounts || Object.keys(accounts).join() !== "codex" || !HASH.test(accounts.codex)) throw remoteFailure("REMOTE_ACCOUNT_UNVERIFIED", "No current receiving Codex account was verified");
  const cwd = canonical(request.cwd);
  const scope = captureScope(cwd, cwd);
  const check = () => {
    assertAccounts(accounts);
    rootPolicy.assert(cwd, "Remote Codex project");
    recheckScope(scope);
    if (canonical(request.cwd) !== cwd || repository(cwd) !== request.repository) throw remoteFailure("REMOTE_PROJECT_MISMATCH", "The remote project differs from the verified sender repository");
  };
  check();
  const call = async (operation, args, guard = check) => {
    check();
    const { result } = await relay.requestDesktop(operation, args, { beforeSend: guard });
    check();
    return result;
  };
  const project = async () => {
    const result = await call("list_projects", {});
    const matches = (result?.projects ?? []).filter((item) => item.projectKind === "local" && item.hostId === "local" && exactCwd(item.path));
    if (matches.length !== 1 || !matches[0].projectId) throw remoteFailure("REMOTE_PROJECT_UNVERIFIED", "Select exactly one existing saved Codex project on the remote computer");
    return matches[0].projectId;
  };
  const exactCwd = (value) => {
    try { return typeof value === "string" && canonical(value) === cwd; } catch { return false; }
  };
  const projectId = await project();
  const matchesIdentity = (thread) => thread?.kind === "codex" && thread.hostId === "local" && exactCwd(thread.cwd);
  const matches = (thread) => matchesIdentity(thread) && thread.projectId === projectId;
  const listedThreads = async () => {
    const result = await call("list_threads", { limit: 50 });
    return [...(result?.pinnedThreads ?? []), ...(result?.threads ?? [])];
  };
  if (request.action === "list") {
    const threads = (await listedThreads()).filter(matches)
      .map(({ id, title, status }) => ({ id, title, status, cwd, projectId }));
    return { threads, coverage: "Most recent 50 unpinned tasks plus pinned tasks in the exact saved project" };
  }
  const inspect = async (includeOutputs = false) => {
    if (await project() !== projectId) throw remoteFailure("REMOTE_PROJECT_MISMATCH", "The destination saved project changed");
    const result = await call("read_thread", { threadId: request.threadId, hostId: "local", turnLimit: 2, includeOutputs, maxOutputCharsPerItem: includeOutputs ? 6000 : 1 });
    const thread = result?.thread;
    if (!matchesIdentity(thread) || thread.id !== request.threadId || (thread.projectId !== undefined && thread.projectId !== projectId)) throw remoteFailure("REMOTE_THREAD_MISMATCH", "The target task does not belong to the exact saved project");
    const listed = (await listedThreads()).filter((item) => item.id === request.threadId);
    if (listed.length !== 1 || !matches(listed[0])) throw remoteFailure("REMOTE_THREAD_MISMATCH", "The target task is no longer listed in the exact saved project");
    return result;
  };
  if (request.action === "read") return inspect(true);
  await inspect();
  const executorId = executor();
  if (request.threadId === executorId) throw remoteFailure("REMOTE_THREAD_MISMATCH", "The relay executor cannot be a handoff destination");
  const hash = creationRequestHash(request);
  const existing = receipts.read(request.requestId, accounts, hash);
  if (existing) return { requestId: request.requestId, threadId: request.threadId, status: existing.state === "completed" ? "submitted" : "unconfirmed", result: existing.result ?? null, duplicate: true };
  let row;
  try { row = receipts.reserve(request.requestId, request, accounts, executorId); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    receipts.read(request.requestId, accounts, hash);
    return { requestId: request.requestId, threadId: request.threadId, status: "unconfirmed", duplicate: true };
  }
  try {
    await inspect();
    const prompt = `[From Codex on ${request.sender.host} · task ${request.sender.threadId}]\n\n${request.message}`;
    const result = await call("send_message_to_thread", { threadId: request.threadId, prompt }, async () => { await inspect(); check(); });
    await inspect();
    receipts.write({ ...row, state: "completed", result });
    return { requestId: request.requestId, threadId: request.threadId, status: "submitted", result, duplicate: false };
  } catch (error) {
    receipts.write({ ...row, state: "failed", error: { code: error.code ?? "REMOTE_FAILED", message: error.message } });
    throw remoteFailure("REMOTE_DELIVERY_UNCONFIRMED", "The send was reserved but its outcome was not confirmed. Inspect this task with read; reuse the original requestId only to recover its receipt");
  }
}

export function sameRemoteProfile(left, right) {
  if (!isDeepStrictEqual(left, right)) throw remoteFailure("REMOTE_CONFIG_CHANGED", "The remote host profile changed during the operation");
}
