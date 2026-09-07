import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { homeDir } from "./platform.mjs";

const HASH = /^[a-f0-9]{64}$/;
const FIELDS = new Set(["version", "key", "cwd", "promptHash", "state", "startedAt", "threadId", "projectId", "projectName", "name", "accountContext"]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const normalizedName = (name) => name?.normalize("NFC").trim().replace(/\s+/g, " ");
const canonicalCwd = (cwd) => process.platform === "win32" ? path.normalize(cwd).toLowerCase() : path.normalize(cwd);
const nonemptyString = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 8192 && !/[\u0000-\u001f]/.test(value);

function assertKey(key) {
  if (typeof key !== "string" || !HASH.test(key)) throw new Error("Invalid Desktop task receipt key; refusing unsafe filesystem access.");
}

function unsafeReceipt(key, cause) {
  return new Error(`Desktop task receipt ${key} is unsafe or corrupt. Do not resend creation; inspect the existing Desktop task and repair the receipt first.`, { cause });
}

function validateReceipt(key, receipt) {
  const valid = receipt && typeof receipt === "object" && !Array.isArray(receipt)
    && Object.keys(receipt).every((field) => FIELDS.has(field))
    && receipt.version === 1 && receipt.key === key && HASH.test(receipt.promptHash)
    && nonemptyString(receipt.cwd) && path.isAbsolute(receipt.cwd)
    && ["pending", "unknown", "known"].includes(receipt.state)
    && Number.isSafeInteger(receipt.startedAt) && receipt.startedAt >= 0
    && (receipt.accountContext === undefined || receipt.accountContext && typeof receipt.accountContext === "object" && !Array.isArray(receipt.accountContext)
      && Object.keys(receipt.accountContext).length === 2 && ["claude", "codex"].every((provider) => typeof receipt.accountContext[provider] === "string" && HASH.test(receipt.accountContext[provider])))
    && ["threadId", "projectId", "projectName", "name"].every((field) => receipt[field] === undefined || nonemptyString(receipt[field]))
    && (receipt.state !== "known" || nonemptyString(receipt.threadId));
  if (!valid) throw unsafeReceipt(key);
  const expected = digest(JSON.stringify([canonicalCwd(receipt.cwd), normalizedName(receipt.name) || receipt.promptHash]));
  if (expected !== key) throw unsafeReceipt(key);
  return receipt;
}

export class DesktopTaskReceipts {
  constructor({ directory = path.join(process.env.CODEX_HOME ?? path.join(homeDir(), ".codex"), "bridge-task-receipts") } = {}) {
    this.directory = path.resolve(directory);
  }

  key({ cwd, prompt, name }) {
    if (!nonemptyString(cwd) || !path.isAbsolute(cwd) || typeof prompt !== "string" || (name !== undefined && typeof name !== "string")) {
      throw new Error("Desktop task receipts require an absolute validated cwd, a prompt string, and an optional name string.");
    }
    const promptHash = digest(prompt);
    return { key: digest(JSON.stringify([canonicalCwd(cwd), normalizedName(name) || promptHash])), promptHash };
  }

  async ensureDirectory(create = false) {
    if (create) await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const info = await fs.lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Desktop task receipt directory is unsafe; refusing creation or resend.");
      return true;
    } catch (err) {
      if (!create && err.code === "ENOENT") return false;
      throw err;
    }
  }

  async read(key) {
    assertKey(key);
    if (!await this.ensureDirectory()) return null;
    const file = path.join(this.directory, `${key}.json`);
    let handle;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw unsafeReceipt(key);
      handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > 65536) throw unsafeReceipt(key);
      return validateReceipt(key, JSON.parse(await handle.readFile("utf8")));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw unsafeReceipt(key, err);
    } finally {
      await handle?.close();
    }
  }

  async write(key, receipt) {
    assertKey(key);
    validateReceipt(key, receipt);
    await this.ensureDirectory(true);
    await this.read(key);
    const temporary = path.join(this.directory, `${key}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, path.join(this.directory, `${key}.json`));
      if (process.platform !== "win32") {
        const directory = await fs.open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch((err) => { if (err.code !== "ENOENT") throw err; });
    }
  }

  async withLock(key, callback) {
    assertKey(key);
    await this.ensureDirectory(true);
    const file = path.join(this.directory, `${key}.lock`);
    const token = randomUUID();
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (err) {
      if (err.code === "EEXIST") {
        throw new Error(`Desktop task creation ${key} is already in progress or a previous process left its lock. Do not resend; inspect the existing task. Locks never expire automatically.`, { cause: err });
      }
      throw err;
    }
    try {
      await handle.writeFile(token, "utf8");
      await handle.sync();
      return await callback();
    } finally {
      await handle.close();
      if (await fs.readFile(file, "utf8") === token) await fs.unlink(file);
    }
  }
}
