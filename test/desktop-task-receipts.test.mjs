import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DesktopTaskReceipts } from "../src/desktop-task-receipts.mjs";

const moduleUrl = new URL("../src/desktop-task-receipts.mjs", import.meta.url).href;
let sandbox;
let counter = 0;
before(async () => { sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-receipts-")); });
after(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

function fixture(name) {
  const store = new DesktopTaskReceipts({ directory: path.join(sandbox, String(++counter)) });
  const identity = store.key({ cwd: sandbox, prompt: "Private prompt that must never be saved", name });
  return { store, key: identity.key, receipt: { version: 1, ...identity, cwd: sandbox, state: "pending", startedAt: Date.now(), ...(name ? { name } : {}) } };
}

function child(code, args) {
  const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", `import { DesktopTaskReceipts } from ${JSON.stringify(moduleUrl)}; ${code}`, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  process.stdout.on("data", (data) => { stdout += data; });
  process.stderr.on("data", (data) => { stderr += data; });
  const completed = once(process, "close").then(([code]) => ({ code, stdout, stderr }));
  return { process, completed };
}

describe("durable Desktop task creation receipts", () => {
  it("keys exact prompts and normalized explicit names without storing prompt text", async () => {
    const { store, key, receipt } = fixture();
    assert.notEqual(store.key({ cwd: sandbox, prompt: "one" }).key, store.key({ cwd: sandbox, prompt: "one " }).key);
    assert.equal(store.key({ cwd: sandbox, prompt: "one", name: " Task  name " }).key, store.key({ cwd: sandbox, prompt: "changed", name: "Task name" }).key);
    if (process.platform === "win32") assert.equal(store.key({ cwd: sandbox.toUpperCase(), prompt: "Private prompt that must never be saved" }).key, key);
    await store.write(key, receipt);
    const saved = await fs.readFile(path.join(store.directory, `${key}.json`), "utf8");
    assert.ok(!saved.includes("Private prompt"));
    assert.equal((await store.read(key)).state, "pending");
  });

  it("preserves pending and unknown receipts across store instances and processes without expiry", async () => {
    const { store, key, receipt } = fixture();
    await store.write(key, { ...receipt, startedAt: 0 });
    assert.equal((await new DesktopTaskReceipts({ directory: store.directory }).read(key)).state, "pending");
    const result = await child('const s = new DesktopTaskReceipts({directory:process.argv[1]}); const r = await s.read(process.argv[2]); console.log(r.state); await s.write(r.key, {...r,state:"unknown"});', [store.directory, key]).completed;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "pending");
    assert.equal((await store.read(key)).state, "unknown");
    assert.equal((await store.read(key)).startedAt, 0);
  });

  it("atomically replaces a pending receipt with a known task and leaves no temporary files", async () => {
    const { store, key, receipt } = fixture("Task");
    await store.withLock(key, async () => {
      await store.write(key, receipt);
      await store.write(key, { ...receipt, state: "known", threadId: "thread-123", projectId: "project-456", projectName: "Project" });
    });
    assert.equal((await store.read(key)).threadId, "thread-123");
    assert.deepEqual(await fs.readdir(store.directory), [`${key}.json`]);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(store.directory, `${key}.json`))).mode & 0o777, 0o600);
    }
  });

  it("rejects corrupt and unsafe receipts without overwriting them", async () => {
    const { store, key, receipt } = fixture();
    assert.equal(await store.read(key), null);
    await store.write(key, receipt);
    const file = path.join(store.directory, `${key}.json`);
    for (const invalid of ["{", JSON.stringify({ ...receipt, prompt: "private" }), JSON.stringify({ ...receipt, state: "known" }), JSON.stringify({ ...receipt, cwd: path.join(sandbox, "different") }), JSON.stringify({ ...receipt, promptHash: "invalid" })]) {
      await fs.writeFile(file, invalid);
      await assert.rejects(store.read(key), /unsafe or corrupt.*Do not resend/);
      await assert.rejects(store.write(key, receipt), /unsafe or corrupt/);
      assert.equal(await fs.readFile(file, "utf8"), invalid);
    }
    await assert.rejects(store.read("../escape"), /Invalid.*key/);
    await assert.rejects(store.write("../escape", receipt), /Invalid.*key/);
    await assert.rejects(store.withLock("../escape", () => assert.fail()), /Invalid.*key/);
  });

  it("holds one exclusive creation lock across actual concurrent processes", async () => {
    const { store, key } = fixture();
    const holder = child('const s = new DesktopTaskReceipts({directory:process.argv[1]}); await s.withLock(process.argv[2], async () => { console.log("locked"); await new Promise(resolve => process.stdin.once("data", resolve)); }); process.stdin.destroy();', [store.directory, key]);
    try {
      await once(holder.process.stdout, "data");
      const competing = await child('const s = new DesktopTaskReceipts({directory:process.argv[1]}); await s.withLock(process.argv[2], () => console.log("unexpected"));', [store.directory, key]).completed;
      assert.notEqual(competing.code, 0);
      assert.match(competing.stderr, /already in progress.*Locks never expire automatically/);
      assert.equal(competing.stdout, "");
      holder.process.stdin.write("release");
      const finished = await holder.completed;
      assert.equal(finished.code, 0, finished.stderr);
      await store.withLock(key, async () => {});
    } finally {
      if (holder.process.exitCode === null) holder.process.kill();
      await holder.completed;
    }
  });

  it("retains a crashed process lock and releases its own lock after callback failures", async () => {
    const { store, key } = fixture();
    await assert.rejects(store.withLock(key, async () => { throw new Error("callback failed"); }), /callback failed/);
    const result = await child('const s = new DesktopTaskReceipts({directory:process.argv[1]}); await s.withLock(process.argv[2], () => process.exit(9));', [store.directory, key]).completed;
    assert.equal(result.code, 9);
    const file = path.join(store.directory, `${key}.lock`);
    await fs.utimes(file, 0, 0);
    await assert.rejects(new DesktopTaskReceipts({ directory: store.directory }).withLock(key, () => assert.fail()), /already in progress.*never expire/);
    assert.ok((await fs.stat(file)).isFile());
  });
});
