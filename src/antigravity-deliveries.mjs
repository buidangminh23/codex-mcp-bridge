import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureBridgeDirectory } from "./antigravity-ipc.mjs";
import { bridgeDiagnostic } from "./recipient-preflight.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function antigravityDeliveryError(record) {
  if (!record || !UUID.test(record.requestId) || !["failed", "unknown"].includes(record.status)) return null;
  return Object.assign(new Error(record.reason ?? "The original Antigravity delivery did not complete successfully"), {
    code: record.diagnostic?.code ?? (record.status === "unknown" ? "ANTIGRAVITY_DELIVERY_UNKNOWN" : "ANTIGRAVITY_DELIVERY_FAILED"),
    deliveryState: record.diagnostic?.deliveryState ?? "unknown",
    diagnostic: record.diagnostic,
  });
}

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
    if (record.status === "pending" && !this.active.has(requestId)) {
      const error = Object.assign(new Error("This process cannot observe the original worker. Inspect the original delivery receipt; do not resend or open a chat to load the relay."), { code: "ANTIGRAVITY_WORKER_UNAVAILABLE", phase: "receipt", deliveryState: "unknown" });
      const diagnostic = bridgeDiagnostic(error, { component: "antigravity-deliveries", operation: record.operation ?? "send", requestId, conversationId: record.conversationId });
      return { ...record, status: "unknown", reason: diagnostic.reason, diagnostic };
    }
    return record;
  }

  identify(requestId, conversationId) {
    if (!UUID.test(conversationId) || !this.active.has(requestId)) throw new Error("Cannot bind inactive delivery");
    const record = this.read(requestId);
    record.conversationId = conversationId;
    this.write(record);
  }

  captureObservation(requestId, observation) {
    if (!this.active.has(requestId)) throw new Error("Cannot prepare inactive delivery observation");
    if (observation?.version !== 1 || !["ready", "unavailable"].includes(observation.status)
        || !/^[a-f0-9]{64}$/.test(observation.promptSha256 ?? "") || typeof observation.projectId !== "string"
        || observation.status === "ready" && (!UUID.test(observation.trajectoryId ?? "") || !Number.isSafeInteger(observation.beforeStepIndex) || observation.beforeStepIndex < -1)) throw new Error("Invalid native observation boundary");
    const record = this.read(requestId);
    record.nativeObservation = { version: 1, status: observation.status, promptSha256: observation.promptSha256, projectId: observation.projectId,
      ...(observation.status === "ready" ? { trajectoryId: observation.trajectoryId, beforeStepIndex: observation.beforeStepIndex } : { code: "ANTIGRAVITY_TRANSCRIPT_UNAVAILABLE" }) };
    this.write(record);
  }

  async refresh(requestId, observe) {
    const record = this.read(requestId);
    if (!record || this.active.has(requestId)) return record;
    const refreshed = await observe(record);
    if (!refreshed || refreshed.requestId !== record.requestId || refreshed.digest !== record.digest || refreshed.cwd !== record.cwd
        || refreshed.conversationId !== record.conversationId || refreshed.surface !== record.surface || JSON.stringify(refreshed.sender) !== JSON.stringify(record.sender)) throw new Error("Observation changed the delivery identity");
    const current = this.read(requestId);
    if (this.active.has(requestId) || JSON.stringify(current) !== JSON.stringify(record)) return current;
    if (refreshed.status === "reply_received") this.write(refreshed);
    return refreshed;
  }

  write(record) {
    const temporary = `${this.file(record.requestId)}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, this.file(record.requestId));
  }

  async dispatch(request, operation, diagnosticOptions = {}) {
    const { requestId, ...identity } = request;
    const digest = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const existing = this.read(requestId);
    if (existing) {
      if (existing.digest !== digest) throw Object.assign(new Error("requestId was already used for a different delivery; inspect the original receipt before further action"), { code: "ANTIGRAVITY_REQUEST_ID_CONFLICT", phase: "validation", deliveryState: "not_sent" });
      return existing;
    }
    const record = { requestId, digest, status: "pending", operation: diagnosticOptions.operation ?? "send", cwd: request.cwd, sender: request.sender, conversationId: request.conversationId ?? null, surface: request.surface, createdAt: new Date().toISOString() };
    const diagnose = (error) => bridgeDiagnostic(error, { component: "antigravity-deliveries", operation: record.operation, ...diagnosticOptions, requestId, conversationId: record.conversationId, msgId: error.msgId });
    try { fs.writeFileSync(this.file(requestId), JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") {
        error.deliveryState = "not_sent";
        error.phase = "receipt";
        throw error;
      }
      throw Object.assign(new Error("Delivery is owned by another process. Inspect requestId; do not resend."), { code: "ANTIGRAVITY_DELIVERY_IN_PROGRESS", phase: "receipt", deliveryState: "unknown" });
    }
    this.active.add(requestId);
    void Promise.resolve().then(operation).then((result) => {
      record.status = ["accepted", "sent_unconfirmed", "held", "refused", "reply_received"].includes(result?.status) ? result.status : result?.status && result.status !== "SUCCESS" ? "failed" : "completed";
      record.result = result;
      record.conversationId = result?.conversationId ?? result?.conversation_id ?? record.conversationId;
      if (record.status === "failed") {
        record.diagnostic = diagnose(Object.assign(new Error(typeof result.error === "string" ? result.error : "The native Antigravity delivery failed"), { code: result.status, deliveryState: result.deliveryState, sent: result.sent }));
        record.reason = record.diagnostic.reason;
      }
    }, (error) => {
      record.diagnostic = diagnose(error);
      record.status = record.diagnostic.deliveryState === "not_sent" ? "failed" : "unknown";
      record.reason = record.diagnostic.reason;
      if (typeof error.msgId === "string" && UUID.test(error.msgId)) record.result = { msgId: error.msgId, completed: false };
      if (error.accountContext) record.result = { ...record.result, accountContext: error.accountContext };
    }).finally(() => {
      record.finishedAt = new Date().toISOString();
      try {
        const previous = this.read(requestId);
        record.conversationId ??= previous?.conversationId;
        record.nativeObservation ??= previous?.nativeObservation;
        this.write(record);
      } catch (error) { process.stderr.write(`Could not persist Antigravity delivery outcome: ${error.code ?? "WRITE_FAILED"}\n`); }
      this.active.delete(requestId);
    });
    return record;
  }
}
