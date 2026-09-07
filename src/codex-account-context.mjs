import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_BYTES = 128 * 1024;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function readStable(file, limit) {
  const entry = fs.lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Codex account evidence must be a regular file");
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > limit || entry.ino !== before.ino || entry.dev !== before.dev) throw new Error("Codex account evidence is invalid or exceeds its read limit");
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (!count) throw new Error("Codex account evidence changed while reading; retry on the next call");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== current.ino || before.dev !== current.dev || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) throw new Error("Codex account evidence changed while reading; retry on the next call");
    return data.toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function configAllowsFile(file) {
  let text;
  try {
    text = readStable(file, MAX_CONFIG_BYTES);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw new Error("Codex credential storage configuration could not be verified");
  }
  for (const line of text.split(/\r?\n/)) {
    let quote = null;
    let end = line.length;
    for (let index = 0; index < line.length; index++) {
      if (quote) {
        if (quote === '"' && line[index] === "\\") index++;
        else if (line[index] === quote) quote = null;
      } else if (line[index] === '"' || line[index] === "'") quote = line[index];
      else if (line[index] === "#") { end = index; break; }
    }
    const content = line.slice(0, end);
    if (!/\bcli_auth_credentials_store\b/.test(content)) continue;
    const assignments = [...content.matchAll(/(?:^|[\s{,])(?:cli_auth_credentials_store|"cli_auth_credentials_store"|'cli_auth_credentials_store')\s*=\s*(?:"([^"\\]*)"|'([^']*)')(?=\s*(?:[,}]|$))/g)];
    if (!assignments.length || assignments.some((match) => (match[1] ?? match[2]) !== "file")) throw new Error("Codex account detection requires verified file credential storage; keyring, auto, ephemeral, or ambiguous storage is unavailable");
  }
}

function tokenIdentity(token) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_BYTES) throw new Error("Codex account evidence has no usable user identity token");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Codex account user identity is malformed; retry on the next call");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Codex account user identity is malformed; retry on the next call");
  }
  if (!object(claims)) throw new Error("Codex account user identity is unavailable");
  const auth = object(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : {};
  return { userId: identity(auth.chatgpt_user_id) ?? identity(claims.sub), accountId: identity(auth.chatgpt_account_id) };
}

export function readCodexAccountContext({ env = process.env, root } = {}) {
  let source = null;
  const result = (status, reason, values = {}) => ({ status, provider: "codex", accountId: null, userId: null, fingerprint: null, source, reason, ...values });
  try {
    const home = root ?? env.CODEX_HOME ?? path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
    if (typeof home !== "string" || !path.isAbsolute(home)) return result("unavailable", "The configured Codex home must be absolute");
    source = path.join(home, "auth.json");
    configAllowsFile(path.join(home, "config.toml"));
    let text;
    try {
      text = readStable(source, MAX_AUTH_BYTES);
    } catch (error) {
      if (error.code === "ENOENT") return result("signed_out", "Codex has no stored login identity; retry after sign-in completes");
      throw error;
    }
    let auth;
    try {
      auth = JSON.parse(text);
    } catch {
      return result("unavailable", "Codex account evidence is incomplete or malformed; retry on the next call");
    }
    if (!object(auth)) return result("unavailable", "Codex account evidence is not an object");
    if (auth.auth_mode !== "chatgpt") return result("unavailable", "Codex account detection requires a stored ChatGPT login; external tokens and other authentication modes are unavailable");
    const accountId = identity(auth.tokens?.account_id);
    if (!accountId) return result("unavailable", "Codex account evidence has no stable account ID; retry after sign-in completes");
    const decoded = tokenIdentity(auth.tokens?.id_token);
    if (!decoded.userId) return result("unavailable", "Codex account evidence has no stable user ID; no identity was inferred");
    if (decoded.accountId && decoded.accountId !== accountId) return result("unavailable", "Codex account and user identity evidence disagree; retry on the next call");
    configAllowsFile(path.join(home, "config.toml"));
    if (readStable(source, MAX_AUTH_BYTES) !== text) return result("unavailable", "Codex account evidence changed during identity verification; retry on the next call");
    const fingerprint = createHash("sha256").update(JSON.stringify(["codex", accountId, decoded.userId])).digest("hex");
    return result("verified", "Stored Codex ChatGPT account and user identity were read consistently", { accountId, userId: decoded.userId, fingerprint });
  } catch (error) {
    return result("unavailable", error.code ? "Codex account evidence could not be read; retry on the next call" : error.message);
  }
}
