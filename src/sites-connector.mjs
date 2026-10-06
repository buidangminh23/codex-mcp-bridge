#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BridgeSecurityPolicy } from "./security-policy.mjs";
import { DesktopTaskDelivery } from "./thread-delivery.mjs";
import { DesktopTaskReceipts } from "./desktop-task-receipts.mjs";
import { NativeDesktopRelay, resolveRelayThreadId } from "./native-relay.mjs";
import { createNativeScopeAuthorizer } from "./native-relay-companion.mjs";
import { assertAccountIdentity, readBridgeAccounts, requireBridgeAccounts } from "./bridge-account-context.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";

exitForVersionRequest(import.meta.url);

const text = z.string().min(1).max(8192);
const uuid = z.string().uuid();
const accountSchema = z.object({ claude: z.string().regex(/^[a-f0-9]{64}$/), codex: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const configSchema = z.object({
  siteUrl: z.string().url(), serviceToken: text.optional(), connectorId: uuid, connectorToken: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  ownerEmail: z.string().email().optional(), allowedRoots: z.array(text).min(1).max(64), accountContext: accountSchema,
}).strict();
const toolSchemas = {
  list_codex_projects: z.object({}).strict(),
  list_codex_threads: z.object({ cwd: text.optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  read_codex_thread: z.object({ threadId: text, turnLimit: z.number().int().min(1).max(10).optional() }).strict(),
  start_codex_thread: z.object({ cwd: text, prompt: z.string().min(1).max(60000), title: z.string().min(1).max(200), requestId: uuid }).strict(),
  send_to_codex_thread: z.object({ threadId: text, prompt: z.string().min(1).max(60000), requestId: uuid }).strict(),
};
const mutations = new Set(["start_codex_thread", "send_to_codex_thread"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const result = (value, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) });
const failed = (state, message) => result({ state, message }, true);

export function validateSitesConfig(value, { allowLoopback = false } = {}) {
  const config = configSchema.parse(value);
  const url = new URL(config.siteUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowLoopback && loopback && url.protocol === "http:")) throw new Error("Sites connector requires an HTTPS site URL");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Sites URL must be an origin without credentials, path, query or fragment");
  if ([config.serviceToken, config.connectorToken].some((token) => token && /[\r\n]/.test(token))) throw new Error("Connector credentials contain invalid characters");
  if (config.allowedRoots.some((root) => !path.isAbsolute(root) || root.includes(path.delimiter))) throw new Error("Allowed roots must be absolute directories without a path-list separator");
  return Object.freeze({ ...config, siteUrl: url.origin, allowedRoots: Object.freeze([...config.allowedRoots]), accountContext: Object.freeze({ ...config.accountContext }) });
}

async function readPrivateJson(file, maxBytes = 2 * 1024 * 1024) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error("Private connector file is unsafe or oversized");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    const fields = ["dev", "ino", "size", "mtimeMs", "ctimeMs"];
    const matches = (left, right) => fields.every((field) => left[field] === right[field]);
    if (!current.isFile() || current.nlink !== 1 || current.size > maxBytes || !matches(info, current)) throw new Error("Private connector file changed during access");
    const data = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error("Private connector file changed during access");
      offset += bytesRead;
    }
    const after = await handle.stat();
    const entry = await fs.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || !matches(current, after) || !matches(after, entry)) throw new Error("Private connector file changed during access");
    return JSON.parse(data.toString("utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Private connector file changed during access", { cause: error });
    throw error;
  } finally { await handle.close(); }
}

export async function loadSitesConfig(file, options) {
  if (!path.isAbsolute(file)) throw new Error("--config requires an absolute filename");
  return validateSitesConfig(await readPrivateJson(file, 65536), options);
}

export function defaultSitesConfigPath(env = process.env) {
  return path.join(env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sites-bridge", "connector.json");
}

async function protectPrivatePath(target, directory = false) {
  if (process.platform !== "win32") { await fs.chmod(target, directory ? 0o700 : 0o600); return; }
  const run = promisify(execFile);
  const { stdout } = await run("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
  const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
  if (!sid) throw new Error("Current Windows user SID could not be verified");
  await run("icacls.exe", [target, "/inheritance:r", "/grant:r", `*${sid}:${directory ? "(OI)(CI)" : ""}(F)`], { windowsHide: true });
}

export async function pairSitesConnector({ siteUrl, allowedRoots, configFile = defaultSitesConfigPath(), readAccounts = readBridgeAccounts, fetchImpl = fetch, allowLoopback = false }) {
  if (!path.isAbsolute(configFile)) throw new Error("Pairing configuration path must be absolute");
  const accounts = requireBridgeAccounts(readAccounts());
  let config;
  try {
    config = await loadSitesConfig(configFile, { allowLoopback });
    if (config.siteUrl !== new URL(siteUrl).origin || JSON.stringify(config.allowedRoots) !== JSON.stringify(allowedRoots)) throw new Error("Existing pairing belongs to a different Site or allowed roots; use a separate private config file");
    assertAccountIdentity(config.accountContext, readAccounts());
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = validateSitesConfig({ siteUrl, connectorId: randomUUID(), connectorToken: randomBytes(32).toString("base64url"), allowedRoots, accountContext: accounts }, { allowLoopback });
    new BridgeSecurityPolicy(sitesHardenedEnv(config));
    const directory = path.dirname(configFile);
    const created = await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("Pairing configuration directory is unsafe");
    if (created !== undefined) await protectPrivatePath(directory, true);
    const handle = await fs.open(configFile, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(config, null, 2)); await handle.sync(); } finally { await handle.close(); }
    await protectPrivatePath(configFile);
  }
  const client = new SitesConnector({ config, fetchImpl });
  const paired = await client.post("/agent/pair/start", { connectorId: config.connectorId, connectorToken: config.connectorToken });
  if (typeof paired.pairingUrl !== "string") throw new Error("Sites did not return a pairing URL");
  const url = new URL(paired.pairingUrl);
  if (url.origin !== config.siteUrl || url.pathname !== "/connect" || url.searchParams.get("code") !== config.connectorId) throw new Error("Sites returned an unexpected pairing destination");
  assertAccountIdentity(config.accountContext, readAccounts());
  return { config, configFile, pairingUrl: url.href };
}

export function validateSitesJob(value, { requireExpiry = false } = {}) {
  const envelope = z.object({ id: z.string().min(1).max(128), tool: z.string(), arguments: z.record(z.unknown()), requestId: uuid.nullish(), expiresAt: z.number().int().positive().optional() }).strict().parse(value);
  if (requireExpiry && envelope.expiresAt === undefined) throw new Error("Job has no dispatch deadline");
  const schema = toolSchemas[envelope.tool];
  if (!schema) throw new Error("Unsupported Sites connector tool");
  const arguments_ = schema.parse(envelope.arguments);
  if (mutations.has(envelope.tool) && envelope.requestId && envelope.requestId.toLowerCase() !== arguments_.requestId.toLowerCase()) throw new Error("Job requestId does not match its mutation arguments");
  return { ...envelope, arguments: arguments_ };
}

export function sitesHardenedEnv(config, env = process.env) {
  return { ...env, CODEX_BRIDGE_HARDENED: "1", CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_THREAD_POLICY: "roots", CODEX_BRIDGE_REMAP: "0", CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_PATH_MAP: "", CODEX_BRIDGE_ALLOWED_THREADS: "", CODEX_BRIDGE_ALLOWED_ROOTS: config.allowedRoots.join(path.delimiter) };
}

export function createSitesDesktopBackend(config, {
  configDirectory, env = process.env, readAccounts = readBridgeAccounts,
  relay, authorizeFactory = createNativeScopeAuthorizer, Delivery = DesktopTaskDelivery,
  resolveExecutor = resolveRelayThreadId, now = Date.now,
} = {}) {
  const strictEnv = sitesHardenedEnv(config, env);
  const security = new BridgeSecurityPolicy(strictEnv);
  const native = relay ?? new NativeDesktopRelay({ env: strictEnv });
  let operationDeadline = Infinity;
  let remoteBeforeDispatch;
  const checkAccount = () => { assertAccountIdentity(config.accountContext, readAccounts()); };
  const checkDispatch = () => { checkAccount(); if (now() >= operationDeadline) throw new Error("Sites request expired; no further dispatch is allowed"); };
  requireBridgeAccounts(readAccounts());
  checkAccount();
  const metadata = async ({ operation, arguments: args }, options) => {
    checkDispatch();
    const reply = await native.requestDesktop(operation, args, { ...options, timeoutMs: Math.min(30000, operationDeadline - now()), accountContext: config.accountContext, beforeSend: checkDispatch });
    checkAccount();
    return { success: true, structuredContent: reply.result };
  };
  const authorize = authorizeFactory({ env: strictEnv, dispatchDesktop: metadata });
  const guardedRelay = {
    status: (options) => native.status(options),
    requestDesktop: async (operation, args, options = {}) => {
      checkDispatch();
      const executorThreadId = resolveExecutor(strictEnv).threadId;
      const request = { executorThreadId, targetThreadId: args.threadId, operation, arguments: args, accountContext: config.accountContext };
      const expected = await authorize(request);
      const reply = await native.requestDesktop(operation, args, {
        ...options, timeoutMs: Math.min(options.timeoutMs ?? 30000, operationDeadline - now()), accountContext: config.accountContext,
        beforeSend: async () => {
          checkDispatch();
          await authorize({ ...request, phase: "write", expected });
          if (["create_thread", "send_message_to_thread", "set_thread_title", "navigate_to_codex_page"].includes(operation)) await remoteBeforeDispatch?.();
          await options.beforeSend?.();
          checkDispatch();
        },
      });
      checkAccount();
      if (reply.executorThreadId !== executorThreadId) throw new Error("Native relay executor changed during dispatch; outcome is unverified");
      const checked = await authorize({ ...request, phase: "return", expected, result: reply.result });
      checkAccount();
      return { ...reply, result: checked?.result ?? reply.result };
    },
  };
  const delivery = new Delivery({
    relay: guardedRelay, security, accountContext: () => config.accountContext,
    beforeRequest: checkAccount, now,
    ...(configDirectory ? { receipts: new DesktopTaskReceipts({ directory: path.join(configDirectory, "sites-task-receipts") }) } : {}),
  });
  return {
    checkAccount,
    async execute(job, { beforeDispatch } = {}) {
      checkAccount();
      remoteBeforeDispatch = beforeDispatch;
      const args = job.arguments;
      const deadline = Math.min(now() + 40000, job.expiresAt ?? Infinity);
      operationDeadline = deadline;
      checkDispatch();
      let value;
      switch (job.tool) {
        case "list_codex_projects": value = await delivery.request("list_projects", {}, { deadline }); break;
        case "list_codex_threads": value = await delivery.list(args); break;
        case "read_codex_thread":
          await delivery.inspect(args.threadId, undefined, { deadline });
          value = await delivery.request("read_thread", { threadId: args.threadId, hostId: "local", turnLimit: args.turnLimit ?? 3 }, { deadline });
          break;
        case "start_codex_thread": value = await delivery.create({ ...args, name: args.title, deadline }); break;
        case "send_to_codex_thread": {
          const sent = await delivery.withThread(args.threadId, () => delivery.send({ ...args, deadline }), { deadline });
          value = { threadId: sent.threadId, cwd: sent.cwd, name: sent.name, previousTurnId: sent.previousTurnId, backend: sent.backend, state: "accepted" };
          break;
        }
        default: throw new Error("Unsupported Sites connector tool");
      }
      checkAccount();
      return result(value);
    },
  };
}

export class SitesOperationJournal {
  constructor({ directory, config }) {
    this.directory = directory;
    this.binding = hash(JSON.stringify([config.siteUrl, config.connectorId, config.accountContext, config.allowedRoots]));
  }
  key(job) { return hash(JSON.stringify([this.binding, mutations.has(job.tool) ? job.arguments.requestId.toLowerCase() : job.id])); }
  fingerprint(job) { return hash(JSON.stringify([job.tool, job.arguments])); }
  async prepare() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Connector journal directory is unsafe");
    this.protection ??= protectPrivatePath(this.directory, true);
    await this.protection;
  }
  async read(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid journal key");
    try {
      const entry = await readPrivateJson(path.join(this.directory, `${key}.json`));
      if (entry.binding !== this.binding || entry.key !== key || !["started", "finished"].includes(entry.state) || typeof entry.fingerprint !== "string" || typeof entry.id !== "string") throw new Error("Connector journal identity is invalid");
      return entry;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async begin(job) {
    await this.prepare();
    const key = this.key(job);
    const entry = { version: 1, key, binding: this.binding, fingerprint: this.fingerprint(job), id: job.id, state: "started", uploaded: false };
    let handle;
    try {
      handle = await fs.open(path.join(this.directory, `${key}.json`), "wx", 0o600);
      await handle.writeFile(JSON.stringify(entry));
      await handle.sync();
      return { entry, fresh: true };
    } catch (error) { if (error.code === "EEXIST") return { entry: await this.read(key), fresh: false }; throw error; }
    finally { await handle?.close(); }
  }
  async save(entry) {
    await this.prepare();
    const temporary = path.join(this.directory, `${entry.key}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(entry)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, path.join(this.directory, `${entry.key}.json`));
  }
  async pending() {
    await this.prepare();
    const entries = [];
    for (const filename of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const entry = await this.read(filename.slice(0, -5));
      if (!entry.uploaded) entries.push(entry);
    }
    return entries;
  }
}

export class SitesConnector {
  constructor({ config, backend, journal, fetchImpl = fetch, timeoutMs = 15000, heartbeatMs = 5000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {} }) {
    this.config = config; this.backend = backend; this.journal = journal;
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.heartbeatMs = heartbeatMs; this.sleep = sleep; this.log = log;
  }
  async post(route, body, signal) {
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 99000) throw new Error("Sites request exceeded the hosted body limit");
    const response = await this.fetch(`${this.config.siteUrl}${route}`, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      headers: { "Content-Type": "application/json", ...(this.config.serviceToken ? { "OAI-Sites-Authorization": `Bearer ${this.config.serviceToken}` } : {}), Authorization: `Bearer ${this.config.connectorToken}`, "X-Codex-Connector-ID": this.config.connectorId },
      body: encoded,
    });
    if (!response.ok) throw new Error(`Sites endpoint returned HTTP ${response.status}`);
    const chunks = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Sites response exceeded the size limit"); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  async withHeartbeat(operation) {
    const controller = new AbortController();
    let timer;
    let pending;
    let failure;
    const verify = async () => {
      if (failure) throw failure;
      if (!pending) {
        pending = (async () => {
          this.backend.checkAccount();
          const response = await this.post("/agent/heartbeat", {}, controller.signal);
          if (response.paired !== true) throw new Error("The device pairing is no longer active");
        })().catch((error) => { failure = error; clearInterval(timer); throw error; }).finally(() => { pending = null; });
      }
      return pending;
    };
    try {
      await verify();
      timer = setInterval(() => { void verify().catch(() => {}); }, this.heartbeatMs);
      timer.unref?.();
      return await operation(verify);
    } finally {
      clearInterval(timer);
      controller.abort();
      await pending?.catch(() => {});
    }
  }
  async upload(entry) {
    this.backend.checkAccount();
    await this.post("/agent/result", { id: entry.id, result: entry.result });
    await this.journal.save({ ...entry, uploaded: true });
  }
  async recover() {
    for (let entry of await this.journal.pending()) {
      if (entry.state === "started") {
        entry = { ...entry, state: "finished", result: failed("uncertain", "The connector stopped after claiming this request. It may have dispatched. Inspect the original task; this request will not be replayed.") };
        await this.journal.save(entry);
      }
      await this.withHeartbeat(() => this.upload(entry));
    }
  }
  async step() {
    this.backend.checkAccount();
    await this.recover();
    const response = await this.post("/agent/poll", {});
    if (response.job == null) return { state: response.paired === false ? "pairing" : "idle" };
    let job;
    try { job = validateSitesJob(response.job, { requireExpiry: true }); }
    catch {
      if (typeof response.job?.id === "string" && response.job.id.length <= 8192) await this.post("/agent/result", { id: response.job.id, result: failed("blocked", "Invalid or unsupported connector job") });
      return { state: "blocked" };
    }
    if (Date.now() >= job.expiresAt) {
      await this.post("/agent/result", { id: job.id, result: failed("blocked", "This request expired before local dispatch. No operation was sent.") });
      return { state: "blocked" };
    }
    const { entry, fresh } = await this.journal.begin(job);
    if (!fresh && entry.fingerprint !== this.journal.fingerprint(job)) {
      await this.post("/agent/result", { id: job.id, result: failed("blocked", "The requestId belongs to a different operation. No prompt was sent.") });
      return { state: "blocked" };
    }
    return this.withHeartbeat(async (verifyPairing) => {
      let outcome;
      if (!fresh) outcome = entry.result ?? failed("uncertain", "An earlier connector claimed this request; it will not be replayed.");
      else {
        try { this.backend.checkAccount(); outcome = await this.backend.execute(job, { beforeDispatch: verifyPairing }); this.backend.checkAccount(); }
        catch { outcome = failed(mutations.has(job.tool) ? "uncertain" : "blocked", mutations.has(job.tool) ? "The Desktop operation could not be fully verified. It may have dispatched. Inspect the original task before any further send." : "The Desktop operation is unavailable or blocked by local account/project policy."); }
      }
      if (Buffer.byteLength(JSON.stringify(outcome)) > 90000) outcome = failed("result_too_large", "The operation produced a result larger than the hosted response limit. Inspect the original Desktop task. The operation will not be replayed.");
      const finished = { ...entry, id: job.id, state: "finished", result: outcome, uploaded: false };
      await this.journal.save(finished);
      await this.upload(finished);
      return { state: outcome.isError ? outcome.structuredContent?.state ?? "blocked" : "completed", id: job.id };
    });
  }
  async run({ once = false, signal } = {}) {
    do {
      if (signal?.aborted) break;
      try { const state = await this.step(); this.log(state); if (once) return state; }
      catch { this.log({ state: "offline", message: "Connector paused: Sites transport or local account verification is unavailable. Claimed operations are retained." }); if (once) throw new Error("Connector could not complete its polling cycle; retained operations will not be replayed"); }
      await this.sleep(2000);
    } while (!signal?.aborted);
  }
}

export async function runSitesConnector({ configFile, once = false, signal, ...dependencies }) {
  const config = await loadSitesConfig(configFile);
  const directory = path.dirname(configFile);
  const receiptDirectory = path.join(directory, "sites-task-receipts");
  await fs.mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(receiptDirectory)).isSymbolicLink()) throw new Error("Sites task receipt directory is unsafe");
  await protectPrivatePath(receiptDirectory, true);
  const backend = createSitesDesktopBackend(config, { configDirectory: directory, ...dependencies });
  const journal = new SitesOperationJournal({ directory: path.join(directory, "sites-operation-journal"), config });
  return new SitesConnector({ config, backend, journal, log: (state) => process.stderr.write(`[sites-connector] ${JSON.stringify(state)}\n`), ...dependencies }).run({ once, signal });
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Map();
  let invalid = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!["--config", "--site", "--roots", "--pair", "--once"].includes(name) || flags.has(name)) { invalid = true; break; }
    if (["--pair", "--once"].includes(name)) flags.set(name, true);
    else if (!args[index + 1] || args[index + 1].startsWith("--")) { invalid = true; break; }
    else flags.set(name, args[++index]);
  }
  if (invalid || flags.has("--pair") && (!flags.has("--site") || !flags.has("--roots"))) {
    process.stderr.write("Usage: node src/sites-connector.mjs [--config <absolute-file>] [--once] [--pair --site <HTTPS-origin> --roots <path-list>]\n"); process.exitCode = 1;
  } else {
    const controller = new AbortController();
    for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => controller.abort());
    const configFile = flags.get("--config") ?? defaultSitesConfigPath();
    await (async () => {
      if (flags.has("--pair")) {
        const paired = await pairSitesConnector({ configFile, siteUrl: flags.get("--site"), allowedRoots: flags.get("--roots").split(path.delimiter).filter(Boolean) });
        process.stderr.write(`[sites-connector] Authorize this device in ChatGPT: ${paired.pairingUrl}\n`);
      }
      await runSitesConnector({ configFile, once: flags.has("--once"), signal: controller.signal });
    })().catch(() => { process.stderr.write("[sites-connector] Startup or polling failed. Check the private configuration, original accounts and native relay.\n"); process.exitCode = 1; });
  }
}
