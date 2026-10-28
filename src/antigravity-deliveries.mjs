import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureBridgeDirectory } from "./antigravity-ipc.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AntigravityDeliveries {
  constructor(directory) {
    this.directory = ensureBridgeDirectory(directory);
    this.active = new Set();
  }

  file(requestId) {
    if (!UUID.test(requestId)) throw new Error("requestId must be a UUID");
    return path.join(this.directory, `${requestId}.json`);
  }

  read(requestId) {
    const file = this.file(requestId);
    let descriptor;
    try { descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    let record;
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 4n * 1024n * 1024n) throw new Error("Invalid delivery record");
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeNs !== stat.mtimeNs) throw new Error("Delivery record changed before reading");
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
        if (!count) break;
        bytes += count;
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (bytes !== Number(opened.size) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) throw new Error("Delivery record changed while reading");
      record = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
    } finally { fs.closeSync(descriptor); }
    if (record.requestId !== requestId) throw new Error("Delivery identity mismatch");
    if (record.status === "pending" && !this.active.has(requestId)) return { ...record, status: "unknown", reason: "This process cannot observe the original worker. Inspect the exact destination; do not resend." };
    return record;
  }

  identify(requestId, conversationId) {
    if (!UUID.test(conversationId) || !this.active.has(requestId)) throw new Error("Cannot bind inactive delivery");
    const record = this.read(requestId);
    record.conversationId = conversationId;
    this.write(record);
  }

  write(record) {
    const temporary = `${this.file(record.requestId)}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, this.file(record.requestId));
  }

  async dispatch(request, operation) {
    const { requestId, ...identity } = request;
    const digest = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const existing = this.read(requestId);
    if (existing) {
      if (existing.digest !== digest) throw new Error("requestId was already used for a different delivery");
      return existing;
    }
    const record = { requestId, digest, status: "pending", cwd: request.cwd, sender: request.sender, conversationId: request.conversationId ?? null, surface: request.surface, createdAt: new Date().toISOString() };
    try { fs.writeFileSync(this.file(requestId), JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error("Delivery is owned by another process. Inspect requestId; do not resend.");
    }
    this.active.add(requestId);
    void Promise.resolve().then(operation).then((result) => {
      record.status = result?.status === "accepted" ? "accepted" : result?.status && result.status !== "SUCCESS" ? "failed" : "completed";
      record.result = result;
      record.conversationId = result?.conversationId ?? result?.conversation_id ?? record.conversationId;
    }, (error) => {
      record.status = ["not_sent", "not-sent"].includes(error.deliveryState) ? "failed" : "unknown";
      record.reason = error.message;
    }).finally(() => {
      record.finishedAt = new Date().toISOString();
      try {
        record.conversationId ??= this.read(requestId)?.conversationId;
        this.write(record);
      } catch (error) { process.stderr.write(`Could not persist Antigravity delivery outcome: ${error.code ?? "WRITE_FAILED"}\n`); }
      this.active.delete(requestId);
    });
    return record;
  }
}
