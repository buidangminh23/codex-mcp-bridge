import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fleetSender, registerFleetSessionTools } from "../src/fleet-session-tools.mjs";

const id = randomUUID();
const requestId = randomUUID();
const account = "1".repeat(64);
const verified = { status: "verified", mode: "prompting", cwd: process.cwd() };

function fixture(identify, router) {
  const tools = new Map();
  registerFleetSessionTools((name, definition, run) => tools.set(name, run), { identify, loadRouter: async () => router });
  return Object.fromEntries(tools);
}

test("each native provider addresses a different receiving provider using the verified sending session", async () => {
  for (const [agent, fields, receiver] of [
    ["claude", { sessionId: id, taskId: randomUUID(), pid: 21, processStart: "now", permissionMode: "default" }, "codex"],
    ["codex", { threadId: id, turnId: randomUUID() }, "antigravity"],
    ["antigravity", { id, surface: "desktop", projectId: randomUUID(), permissionFingerprint: "verified-policy" }, "claude"],
  ]) {
    const identity = { ...verified, ...fields };
    const { send_to_fleet_session } = fixture(() => fleetSender(agent, identity, account), {
      async sendFleetSession({ sender, checkSender, host, agent: target }) {
        await checkSender();
        assert.equal(sender.agent, agent);
        assert.equal(sender.id, id);
        assert.match(sender.account, /^[a-f0-9]{64}$/);
        assert.equal(host, "mac");
        assert.equal(target, receiver);
        return { requestId, status: "completed", output: "answer" };
      },
    });
    const result = await send_to_fleet_session({ requestId, host: "mac", agent: receiver, prompt: "Check", waitSec: 0,
      sender: { id: randomUUID() } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.output, "answer");
  }
});

test("pending work is polled through its original receipt without sending a second time", async () => {
  const identity = () => fleetSender("codex", { ...verified, threadId: id, turnId: id }, account);
  let sends = 0;
  let reads = 0;
  const tools = fixture(identity, {
    async sendFleetSession() { sends++; return { requestId, status: "running" }; },
    async readFleetSession(input) { reads++; assert.deepEqual(input.sender, identity().sender); return { requestId, status: "completed", output: "ok" }; },
  });
  assert.equal((await tools.send_to_fleet_session({ requestId, prompt: "hello", waitSec: 1 })).structuredContent.output, "ok");
  assert.equal(sends, 1);
  assert.equal(reads, 1);
});

test("an in-flight sender change or unrelated receipt withholds the reply", async () => {
  for (const change of ["turn", "account", "receipt"]) {
    let turnId = id;
    let binding = account;
    const tools = fixture(() => fleetSender("codex", { ...verified, threadId: id, turnId }, binding), {
      async readFleetSession() {
        if (change === "turn") turnId = randomUUID();
        if (change === "account") binding = "3".repeat(64);
        return { requestId: change === "receipt" ? randomUUID() : requestId, status: "completed", output: "private reply" };
      },
    });
    const response = await tools.read_fleet_session_delivery({ requestId, waitSec: 0 });
    assert.equal(response.isError, true);
    assert.doesNotMatch(JSON.stringify(response), /private reply/);
    assert.equal(response.structuredContent.diagnostic.code, change === "receipt" ? "FLEET_RECEIPT_INVALID" : "FLEET_SENDER_CHANGED");
  }
});

test("the same Codex chat can recover its receipt in a new turn, unknown caller permissions block sending", () => {
  const identity = { ...verified, threadId: id, turnId: randomUUID() };
  const first = fleetSender("codex", identity, account);
  const next = fleetSender("codex", { ...identity, turnId: randomUUID() }, account);
  assert.deepEqual(first.sender, next.sender);
  assert.notDeepEqual(first.proof, next.proof);
  assert.throws(() => fleetSender("claude", { ...verified, sessionId: id, mode: null }, account), { code: "FLEET_SENDER_UNVERIFIED" });
  assert.throws(() => fleetSender("codex", identity, undefined), { code: "FLEET_SENDER_UNVERIFIED" });
  assert.throws(() => fleetSender("antigravity", { ...verified, id }, undefined), { code: "FLEET_SENDER_UNVERIFIED" });
});
