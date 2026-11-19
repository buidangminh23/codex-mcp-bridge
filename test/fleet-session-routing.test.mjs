import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createFleetSessionRouter } from "../src/fleet-session-routing.mjs";
import { handleFleetSessionRequest } from "../src/fleet-session-receiver.mjs";
import { SessionReceipts } from "../src/fleet-session-protocol.mjs";
import { fleetSshArgs } from "../src/fleet-host.mjs";

const gib = 1024 ** 3;
const cwd = process.cwd();
const origin = "example.org/operator/project";
const agents = ["codex","claude","antigravity"];
const target = agent => ({ agent, id: randomUUID(), accountFingerprint: "a".repeat(64), taskId: randomUUID(), status: "idle" });
const source = agent => ({ agent, id: randomUUID(), account: "b".repeat(64), mode: "bypass", host: "pc", cwd });
const scoped = { authorize: input => { assert.equal(input, cwd); return input; }, identify: () => origin, capture: () => ({}), recheck: () => {}, env: {} };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-sessions-"));
  const sourceStore = new SessionReceipts("source", dir);
  const remoteStore = new SessionReceipts("receiver", dir);
  const session = db => Object.assign(Object.create(db), { close() {} });
  t.after(() => {
    sourceStore.close();
    remoteStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hosts = [{ id: "mac", cwd, sshHost: "mac", platform: "darwin" }, { id: "office", cwd, sshHost: "office", platform: "win32" }];
  const rows = Object.fromEntries(agents.map(agent => [agent, target(agent)]));
  const settings = { minFreeBytes: gib, hosts };
  const state = { mem: { mac: 4 * gib, office: gib / 2 }, delay: null, lost: false, sends: [], checks: [], reads: [], rows, settings };
  const adapters = {
    listSessionTargets: async () => ({ sessions: Object.values(rows) }),
    dispatchSession: async input => {
      input.check();
      input.onPrepared({ turn: input.requestId });
      state.sends.push([input.sender.agent, input.target.agent, input.requestId]);
      if (state.delay) await state.delay;
      return { status: "running" };
    },
    readSessionReply: async input => {
      assert.equal(input.receipt.turn, input.requestId);
      state.reads.push(input.requestId);
      return state.delay ? { status: "running" } : { status: "completed", output: state.output ?? "receipt " + input.requestId };
    },
  };
  state.contact = async (host, frame) => {
    state.checks.push([host.id, frame.action]);
    const result = await handleFleetSessionRequest(frame, { ...scoped, adapters, freeBytes: () => state.mem[host.id], receipts: () => session(remoteStore) });
    if (frame.action === "send" && state.lost) throw Error("SSH reply lost");
    return result;
  };
  state.router = createFleetSessionRouter({ ...scoped, config: () => settings, contact: state.contact, receipts: () => session(sourceStore) });
  return state;
}

test("every native sender can address every native destination and only that source can read the returned result", async t => {
  const f = fixture(t);
  for (const from of agents) for (const to of agents) {
    const args = { sender: source(from), checkSender: () => {}, requestId: randomUUID(), prompt: "read-only sample", agent: to };
    const result = await f.router.send(args);
    assert.equal(result.status, "running");
    assert.deepEqual(result.target, { agent: to, id: f.rows[to].id });
    assert.equal(result.host, "mac");
    await assert.rejects(f.router.read({ ...args, sender: { ...args.sender, id: randomUUID() } }), { code: "FLEET_SESSION_OWNER" });
    const done = await f.router.read(args);
    assert.equal(done.output, "receipt " + args.requestId);
    assert.deepEqual(await f.router.send(args), done);
  }
  assert.equal(f.sends.length, 9);
  assert.equal(f.reads.length, 9);
});

test("an ambiguous SSH result pins the destination and a duplicate only reads the original receipt", async t => {
  const f = fixture(t);
  const args = { sender: source("claude"), checkSender: () => {}, requestId: randomUUID(), prompt: "hostname", agent: "codex" };
  f.lost = true;
  assert.equal((await f.router.send(args)).status, "uncertain");
  f.mem = { office: 8 * gib, mac: 0 };
  const result = await f.router.send(args);
  assert.equal(result.status, "completed");
  assert.equal(result.host, "mac");
  assert.equal(f.sends.length, 1);
  await assert.rejects(f.router.send({ ...args,prompt: "different" }), { code: "FLEET_SESSION_OWNER" });
  f.settings.hosts[0] = { ...f.settings.hosts[0], sshHost: "reassigned" };
  await assert.rejects(f.router.read(args), { code: "FLEET_SESSION_CONFIG" });
});

test("concurrent requests competing for a single idle session produce one native write", async t => {
  const f = fixture(t);
  let release;
  f.delay = new Promise(resolve => { release = resolve; });
  const args = { sender: source("codex"), checkSender: () => {}, requestId: randomUUID(), prompt: "read-only", agent: "claude" };
  const first = f.router.send(args);
  while (!f.sends.length) await new Promise(resolve => setTimeout(resolve, 10));
  try {
    await assert.rejects(f.router.send({ ...args, requestId: randomUUID() }), { code: "FLEET_SESSION_UNAVAILABLE" });
    assert.equal(f.sends.length, 1);
  } finally { release(); await first; }
});

test("capacity, requested session and source checks are applied before dispatch", async t => {
  const f = fixture(t);
  const args = { sender: source("codex"), checkSender: () => {}, requestId: randomUUID(), prompt: "read-only", agent: "claude" };
  await assert.rejects(f.router.send({ ...args, host: "office" }), { code: "FLEET_SESSION_UNAVAILABLE" });
  await assert.rejects(f.router.send({ ...args, sessionId: randomUUID() }), { code: "FLEET_SESSION_UNAVAILABLE" });
  let verified = 0;
  await assert.rejects(f.router.send({ ...args, checkSender() { if (++verified === 2) throw Error("changed"); } }), /changed/);
  assert.equal(f.sends.length, 0);
  assert.ok(fleetSshArgs(f.settings.hosts[1], "fleet-session-host").includes("worker-relay.cmd fleet-session-host"));
  assert.throws(() => fleetSshArgs(f.settings.hosts[1], "unknown"));
});

test("an idle target is released by exact completion evidence after its first caller stops polling", async t => {
  const f = fixture(t);
  const a = { sender: source("codex"), checkSender: () => {}, requestId: randomUUID(), prompt: "first", host: "mac", agent: "claude" };
  assert.equal((await f.router.send(a)).status, "running");
  f.output = "a".repeat(300 * 1024);
  const b = { ...a, sender: source("antigravity"), requestId: randomUUID(), prompt: "second" };
  const next = await f.router.send(b);
  assert.equal(next.status, "running");
  assert.equal(next.output, undefined);
  assert.equal(f.sends.length, 2);
  assert.ok(f.reads.includes(a.requestId));
  const answer = await f.router.read(a);
  assert.equal(answer.status, "completed");
  assert.match(answer.output, /truncated at 240 KiB/);
});
