import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { DesktopReplyReceipts } from "../src/desktop-reply-receipts.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reply-receipts-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new DesktopReplyReceipts({ directory });
  const context = { caller: { sessionId: "sender", taskId: "task" }, accounts: { claude: "a".repeat(64), codex: "b".repeat(64) } };
  const delivered = { threadId: "target", cwd: directory, previousTurnId: "old", responseObservation: {
    threadId: "target", expectedCwd: directory, previousTurnId: "old", accountContext: context.accounts,
    prompt: "only this prompt", watermark: { status: "available" },
  } };
  return { directory, store, context, delivered };
}

it("preserves the exact response binding across a fresh store instance", (t) => {
  const f = fixture(t);
  const id = f.store.create(f.delivered, f.context);
  assert.deepEqual(new DesktopReplyReceipts({ directory: f.directory }).read(id, f.context), f.delivered);
});

it("refuses another sender, task or account even with the receipt identifier", (t) => {
  const f = fixture(t);
  const id = f.store.create(f.delivered, f.context);
  for (const [group, key] of [["caller", "sessionId"], ["caller", "taskId"], ["accounts", "claude"], ["accounts", "codex"]]) {
    const other = structuredClone(f.context);
    other[group][key] = "different";
    assert.throws(() => f.store.read(id, other), /another sender or account/);
  }
});

it("rejects path traversal, oversized data, corrupt bindings and linked receipts", (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.read("../secrets", f.context), /Invalid reply deliveryId/);
  assert.throws(() => f.store.create({ ...f.delivered, padding: "x".repeat(256 * 1024) }, f.context), /receipt limit/);
  const id = f.store.create(f.delivered, f.context);
  const file = path.join(f.directory, `${id}.json`);
  const receipt = JSON.parse(fs.readFileSync(file));
  receipt.delivered.threadId = "another-target";
  fs.writeFileSync(file, JSON.stringify(receipt));
  assert.throws(() => f.store.read(id, f.context), /Invalid reply observation binding/);
  fs.linkSync(file, path.join(f.directory, "linked.json"));
  assert.throws(() => f.store.read(id, f.context), /Unsafe reply receipt/);
});

it("rejects replacement of a pinned receipt directory", (t) => {
  const f = fixture(t);
  const directory = path.join(f.directory, "store");
  const store = new DesktopReplyReceipts({ directory });
  const id = store.create(f.delivered, f.context);
  fs.renameSync(directory, path.join(f.directory, "original"));
  fs.mkdirSync(directory);
  fs.copyFileSync(path.join(f.directory, "original", `${id}.json`), path.join(directory, `${id}.json`));
  assert.throws(() => store.read(id, f.context), /directory changed/);
});

it("rejects same-inode receipt changes between inspection and opening", (t) => {
  const f = fixture(t);
  const id = f.store.create(f.delivered, f.context);
  const file = f.store.file(id);
  const original = fs.openSync;
  let changed = false;
  fs.openSync = (candidate, ...options) => {
    if (candidate === file && !changed) { changed = true; fs.appendFileSync(file, " "); }
    return original(candidate, ...options);
  };
  try { assert.throws(() => f.store.read(id, f.context), /changed while opening/); }
  finally { fs.openSync = original; }
});

it("rejects a valid receipt path replaced while its descriptor is read", (t) => {
  const f = fixture(t);
  const id = f.store.create(f.delivered, f.context);
  const file = path.join(f.directory, `${id}.json`);
  const original = fs.readSync;
  let swapped = false;
  fs.readSync = (...options) => {
    const count = original(...options);
    if (!swapped) {
      swapped = true;
      fs.renameSync(file, `${file}.saved`);
      fs.copyFileSync(`${file}.saved`, file);
    }
    return count;
  };
  try { assert.throws(() => f.store.read(id, f.context), /changed while reading/); }
  finally { fs.readSync = original; }
});
