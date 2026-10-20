import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { creationRequestHash, creationIdValid } from "./native-creation-receipts.mjs";
import { homeDir } from "./platform.mjs";
import { fileIdentity, sameFileIdentity } from "./file-identity.mjs";

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const LIMIT = 256 * 1024;
const sameFile = (left, right) => ["dev", "ino", "size", "mode", "uid", "nlink", "mtimeNs", "ctimeNs"].every(field => left[field] === right[field]);

function owner(context) {
  const { sessionId, taskId } = context?.caller ?? {};
  const { claude, codex } = context?.accounts ?? {};
  if (![sessionId, taskId, claude, codex].every((v) => typeof v === "string" && v.length)) {
    throw new Error("Reply continuation requires a verified sender and both accounts");
  }
  return { sessionId, taskId, claude, codex };
}

// These are observation bindings, never permission grants. Every continuation
// still passes the normal live sender, account, workspace and rollout checks.
export class DesktopReplyReceipts {
  #boundary;
  constructor({ directory = path.join(process.env.CODEX_HOME ?? path.join(homeDir(), ".codex"), "bridge-reply-receipts") } = {}) {
    this.directory = path.resolve(directory);
  }

  file(id, create = false) {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid reply deliveryId");
    if (create) fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(this.directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe reply receipt directory");
    const canonical = fs.realpathSync.native(this.directory);
    if (this.#boundary && (this.#boundary.path !== canonical || !sameFileIdentity(this.#boundary, fileIdentity(info)))) throw new Error("Reply receipt directory changed");
    this.#boundary ??= { path: canonical, ...fileIdentity(info) };
    return path.join(canonical, `${id}.json`);
  }

  create(delivered, context) {
    const id = randomUUID();
    const receipt = { version: 1, deliveryId: id, owner: owner(context), delivered };
    const bytes = Buffer.from(JSON.stringify(receipt));
    if (bytes.length > LIMIT) throw new Error("Reply observation binding exceeds the receipt limit; inspect the accepted task without resending");
    const file = this.file(id, true);
    // Publish only a complete, durable receipt. The unpredictable identifier is
    // returned after rename; a crash cannot expose a partially written binding.
    const temporary = `${file}.pending`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    return id;
  }

  acknowledge(id, delivered, context) {
    const previous = this.read(id, context);
    const acknowledgement = JSON.parse(JSON.stringify(delivered));
    if (acknowledgement.deliveryStatus !== "accepted" || previous.creationObservation ||
        !["unconfirmed", "accepted"].includes(previous.deliveryStatus) ||
        !isDeepStrictEqual({ ...acknowledgement, deliveryStatus: previous.deliveryStatus }, previous)) {
      throw new Error("Delivery acknowledgement does not match the original reply binding");
    }
    if (previous.deliveryStatus === "accepted") return;
    const file = this.file(id);
    const bytes = Buffer.from(JSON.stringify({ version: 1, deliveryId: id, owner: owner(context), delivered: acknowledgement }));
    if (bytes.length > LIMIT) throw new Error("Reply observation binding exceeds the receipt limit");
    const temporary = `${file}.${randomUUID()}.pending`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (!isDeepStrictEqual(this.read(id, context), previous) || this.file(id) !== file) {
        throw new Error("Reply receipt changed before acknowledgement");
      }
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  read(id, context) {
    const file = this.file(id);
    const before = fs.lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(LIMIT)) throw new Error("Unsafe reply receipt");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameFile(before, opened)) throw new Error("Reply receipt changed while opening");
      const buffer = Buffer.alloc(LIMIT + 1);
      let length = 0;
      for (;;) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
        if (length > LIMIT) throw new Error("Reply receipt exceeds its read limit");
      }
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.lstatSync(this.file(id), { bigint: true });
      if (current.isSymbolicLink() || !sameFile(opened, after) || !sameFile(after, current) || BigInt(length) !== opened.size) throw new Error("Reply receipt changed while reading");
      const receipt = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      const expected = owner(context);
      if (receipt.version !== 1 || receipt.deliveryId !== id || !receipt.owner ||
          Object.keys(expected).some((key) => expected[key] !== receipt.owner[key])) throw new Error("Reply receipt belongs to another sender or account");
      const d = receipt.delivered;
      if (d?.creationObservation) {
        const c = d.creationObservation;
        if (d.threadId !== null || d.previousTurnId !== null || !path.isAbsolute(d.cwd ?? "") ||
            !creationIdValid(c.receiptId) || !/^[a-f0-9]{64}$/.test(c.receiptKey) || creationRequestHash(c.args) !== c.requestHash ||
            c.accountContext?.claude !== expected.claude || c.accountContext?.codex !== expected.codex) throw new Error("Invalid creation observation binding");
        return d;
      }
      if (!d || typeof d.threadId !== "string" || !path.isAbsolute(d.cwd ?? "") ||
          !d.responseObservation || d.responseObservation.threadId !== d.threadId ||
          d.responseObservation.expectedCwd !== d.cwd || d.previousTurnId !== d.responseObservation.previousTurnId ||
          d.responseObservation.accountContext?.claude !== expected.claude || d.responseObservation.accountContext?.codex !== expected.codex) throw new Error("Invalid reply observation binding");
      return d;
    } finally { fs.closeSync(fd); }
  }
}
