import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_AGENTS, privateRelayDirectory, relayFailure, relayPaths, RELAY_UUID } from "./background-relay-config.mjs";
import { assertPrivateRelayFile } from "./background-relay-storage.mjs";

export const fail = (code, message) => relayFailure("FLEET_SESSION_" + code, message);
export const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const validName = id => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
export const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const validText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
export const terminal = status => status === "completed" || status === "failed";

export function senderIdentity(sender) {
  if (!BACKGROUND_AGENTS.includes(sender?.agent) || !RELAY_UUID.test(sender.id || "") || !validDigest(sender.account)
    || !["prompting", "bypass"].includes(sender.mode) || !/^[A-Za-z0-9_.-]{1,255}$/.test(sender.host || "")
    || !validText(sender.cwd, 4096) || !(path.win32.isAbsolute(sender.cwd) || path.posix.isAbsolute(sender.cwd))) {
    throw fail("SENDER", "The calling AI session must have a verified identity, project and permission mode");
  }
  return { agent: sender.agent, id: sender.id, host: sender.host, account: sender.account, cwd: sender.cwd, mode: sender.mode };
}

export function targetIdentity(target) {
  if (!BACKGROUND_AGENTS.includes(target?.agent) || !RELAY_UUID.test(target.id || "") || !validDigest(target.accountFingerprint)
    || !validText(target.taskId, 512)) throw fail("TARGET", "The native destination identity is incomplete");
  return { agent: target.agent, id: target.id, accountFingerprint: target.accountFingerprint, taskId: target.taskId };
}

export function publicResult(requestId, target, host, result) {
  if (!["running", "completed", "failed", "uncertain"].includes(result?.status)
    || result.output !== undefined && (typeof result.output !== "string" || Buffer.byteLength(result.output) > 256 * 1024)) {
    throw fail("RECEIPT", "The destination returned an invalid session result");
  }
  return { requestId, host, target: { agent: target.agent, id: target.id }, status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }) };
}

export class SessionReceipts {
  constructor(role, directory = path.join(relayPaths().root, "session-deliveries")) {
    privateRelayDirectory(directory);
    const file = path.join(directory, role === "source" ? "outbox.db" : "inbox.db");
    try { fs.closeSync(fs.openSync(file, "wx", 0o600)); } catch (error) { if (error.code !== "EEXIST") throw error; }
    assertPrivateRelayFile(file);
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, owner TEXT NOT NULL, digest TEXT NOT NULL, route TEXT NOT NULL, destination TEXT, state TEXT NOT NULL, result TEXT); CREATE UNIQUE INDEX IF NOT EXISTS occupied ON deliveries(destination) WHERE state NOT IN ('completed','failed');");
    if (role !== "source") this.db.exec("CREATE TABLE IF NOT EXISTS recovery (id TEXT PRIMARY KEY, checked INTEGER NOT NULL)");
  }
  get(id, owner, digest) {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id=?").get(id);
    if (!row) return null;
    if (row.owner !== owner || digest !== undefined && row.digest !== digest) throw fail("OWNER", "The session or request content differs from the original receipt");
    return { ...row, route: JSON.parse(row.route), result: JSON.parse(row.result ?? "null") };
  }
  occupied() {
    return new Set(this.db.prepare("SELECT destination FROM deliveries WHERE destination IS NOT NULL AND state NOT IN ('completed','failed')").all().map(row => row.destination));
  }
  claimIdleChecks(destinations) {
    if (!destinations.length) return [];
    const slots = destinations.map(() => "?").join(",");
    const now = Date.now();
    const due = this.db.prepare(`SELECT d.id, d.owner FROM deliveries d LEFT JOIN recovery r ON r.id=d.id WHERE d.destination IN (${slots}) AND d.state NOT IN ('completed','failed') AND (r.checked IS NULL OR r.checked<?) ORDER BY COALESCE(r.checked,0), d.id LIMIT 3`).all(...destinations, now - 15000);
    const claim = this.db.prepare("INSERT INTO recovery VALUES(?,?) ON CONFLICT(id) DO UPDATE SET checked=excluded.checked WHERE recovery.checked<?");
    return due.filter(row => claim.run(row.id, now, now - 15000).changes).map(row => this.get(row.id, row.owner));
  }
  reserve(id, owner, digest, route, destination = null) {
    const inserted = this.db.prepare("INSERT OR IGNORE INTO deliveries(id,owner,digest,route,destination,state) VALUES(?,?,?,?,?,'reserved')").run(id, owner, digest, JSON.stringify(route), destination);
    if (!inserted.changes && !this.get(id, owner, digest)) throw fail("BUSY", "Another outstanding handoff already owns this receiving AI session");
    return Boolean(inserted.changes);
  }
  update(id, status, result) {
    const data = JSON.stringify(result);
    if (Buffer.byteLength(data) > 1024 * 1024) throw fail("RECEIPT", "The session receipt exceeds its size limit");
    this.db.prepare("UPDATE deliveries SET state=?,result=? WHERE id=? AND state NOT IN ('completed','failed')").run(status, data, id);
  }
  close() { this.db.close(); }
}
