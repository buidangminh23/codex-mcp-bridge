import assert from "node:assert/strict";
import test from "node:test";
import { createFleetQueue } from "../src/fleet-queue.mjs";

const hosts = [{ id: "local", cwd: "/project" }, { id: "worker", sshHost: "worker", cwd: "/data/project" }];
const input = { title: "Check the project", agent: "codex", steps: ["Check metadata", "Summarize the findings"] };
const revision = "a".repeat(40);
const receipt = (job, status, output = "") => ({ requestId: job.id, agent: job.agent, status, output });

function fixture() {
  const samples = new Map(hosts.map(host => [host.id, { freeBytes: 8, totalBytes: 32, agents: ["codex"], revision, clean: true }]));
  const sends = [];
  const reads = [];
  const client = {
    async probe(host) {
      const result = samples.get(host.id);
      if (!result) throw new Error("Offline");
      return result;
    },
    async send(host, job) {
      sends.push({ host: host.id, ...job });
      return receipt(job, "queued");
    },
    async read(host, job) {
      reads.push({ host: host.id, ...job });
      return receipt(job, "completed", "metadata is current");
    },
  };
  let stored;
  let now = 1000;
  const config = { hosts, client, minFreeBytes: 4, now: () => now, maxProbeAgeMs: 500, load: () => structuredClone(stored),
    save(state) { stored = structuredClone(state); } };
  return { config, client, sends, reads, samples, queue: createFleetQueue(config), shift: ms => { now += ms; } };
}

test("the next step moves under RAM pressure with the verified checkpoint and prior output", async () => {
  const { samples, queue, sends, reads, client } = fixture();
  queue.submit(input);
  await queue.tick();
  assert.equal(sends[0].host, "local");
  const read = client.read;
  client.read = async (...args) => {
    const result = await read(...args);
    samples.get("local").freeBytes = 1;
    samples.get("local").revision = "b".repeat(40);
    return result;
  };
  await queue.tick();
  assert.equal(reads[0].id, sends[0].id);
  assert.equal(sends.length, 1);
  assert.match(queue.snapshot().jobs[0].error, /matching clean Git/);
  samples.get("worker").revision = "b".repeat(40);
  await queue.tick();
  assert.equal(sends[1].host, "worker");
  assert.equal(sends[1].expectedRevision, "b".repeat(40));
  assert.notEqual(sends[1].id, sends[0].id);
  assert.match(sends[1].prompt, /metadata is current/);
  assert.match(sends[1].prompt, /Summarize the findings/);
  await queue.tick();
  assert.equal(queue.snapshot().jobs[0].status, "completed");
});

test("a dirty or unreachable previous host pins continuation until its own capacity returns", async () => {
  const { samples, queue, sends } = fixture();
  queue.submit(input);
  await queue.tick();
  const local = samples.get("local");
  local.freeBytes = 1;
  local.clean = false;
  await queue.tick();
  assert.equal(queue.snapshot().jobs[0].status, "queued");
  samples.delete("local");
  await queue.tick();
  assert.equal(sends.length, 1);
  samples.set("local", { ...local, freeBytes: 12 });
  await queue.tick();
  assert.deepEqual(sends.map(job => job.host), ["local", "local"]);
});

test("queued tasks remain editable while a probe is pending and explicit pins never spill over", async () => {
  const { queue, samples, sends, client } = fixture();
  samples.get("local").freeBytes = 1;
  const pinned = queue.submit({ ...input, target: "local" });
  const cancelled = queue.submit(input);
  const probe = client.probe;
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  client.probe = async host => { await wait; return probe(host); };
  const first = queue.tick();
  assert.equal(queue.tick(), first);
  queue.cancel(cancelled.id);
  finish();
  await first;
  assert.equal(sends.length, 0);
  queue.retarget(pinned.id, "auto");
  await queue.tick();
  assert.deepEqual(sends.map(job => job.host), ["worker"]);
  assert.throws(() => queue.cancel(pinned.id), { statusCode: 409 });
  assert.throws(() => queue.retarget(pinned.id, "local"), { statusCode: 409 });
});

test("an unconfirmed send survives restart and only reads its original machine and UUID", async () => {
  const { queue, client, config, sends, reads } = fixture();
  const send = client.send;
  client.send = async (...args) => { await send(...args); throw new Error("Disconnected"); };
  queue.submit({ ...input, steps: ["Check metadata"] });
  await queue.tick();
  assert.equal(queue.snapshot().jobs[0].status, "uncertain");
  const resumed = createFleetQueue(config);
  await resumed.tick();
  assert.equal(sends.length, 1);
  assert.equal(reads[0].host, sends[0].host);
  assert.equal(reads[0].id, sends[0].id);
  assert.equal(resumed.snapshot().jobs[0].status, "completed");
});

test("a changed host binding and a mismatched receipt both block advancement", async () => {
  const { config, queue, client, reads, sends } = fixture();
  queue.submit(input);
  await queue.tick();
  const changed = createFleetQueue({ ...config, hosts: [{ ...hosts[0], cwd: "/other" }, hosts[1]] });
  await changed.tick();
  assert.equal(reads.length, 0);
  assert.equal(changed.snapshot().jobs[0].status, "uncertain");
  const restored = createFleetQueue(config);
  client.read = async () => ({ requestId: "wrong", agent: "codex", status: "completed" });
  await restored.tick();
  assert.equal(restored.snapshot().jobs[0].status, "uncertain");
  assert.equal(sends.length, 1);
});

test("a storage failure before send leaves the step queued; failure after send only needs a read", async () => {
  const { config, sends } = fixture();
  const persist = config.save;
  let attempts = 0;
  let failAt = 2;
  const queue = createFleetQueue({ ...config, save(state) {
    if (++attempts === failAt) throw new Error("Disk full");
    persist(state);
  } });
  queue.submit({ ...input, steps: ["Check metadata"] });
  await assert.rejects(queue.tick(), /Disk full/);
  assert.equal(sends.length, 0);
  assert.equal(queue.snapshot().jobs[0].status, "queued");
  config.client.send = async (host, job) => {
    sends.push({ host: host.id, ...job });
    return receipt(job, "completed", "finished");
  };
  failAt = 4;
  await assert.rejects(queue.tick(), /Disk full/);
  assert.equal(sends.length, 1);
  const restored = createFleetQueue(config);
  await restored.tick();
  assert.equal(sends.length, 1);
  assert.equal(restored.snapshot().jobs[0].status, "completed");
});

test("expired probes and hosts without the selected agent cannot accept a task", async () => {
  const { client, samples, queue, sends, shift } = fixture();
  samples.get("worker").agents = [];
  const probe = client.probe;
  client.probe = async host => {
    const info = await probe(host);
    if (host.id === "worker") shift(1000);
    return info;
  };
  queue.submit(input);
  await queue.tick();
  assert.equal(sends.length, 0);
  assert.equal(queue.snapshot().hosts[0].online, false);
});
