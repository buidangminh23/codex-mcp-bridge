import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSessionDestinations } from "../src/fleet-session-destination.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const providers = ["codex", "claude", "antigravity"];

function fixture(t) {
  const cwd = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "fleet-recipient-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const controls = { busy: false, account: "recipient", writes: [], prepared: [], rotate: false, substitute: false };
  const taskId = randomUUID(), executor = randomUUID(), instanceId = randomUUID(), turn = randomUUID();
  let sidecarReceipt, peerMessage;
  const account = () => ({ status: "verified", fingerprint: digest(controls.account) });
  const status = () => controls.busy ? "active" : "idle";
  const thread = () => ({ id: taskId, cwd, kind: "codex", hostId: "local", projectId: "project", title: "Existing task", status: { type: status() } });
  const agRow = () => ({ conversationId: taskId, projectId: "project", cwd, surface: "desktop", status: controls.busy ? "busy" : "CASCADE_RUN_STATUS_IDLE", title: "Existing task" });
  function wrote(text) {
    assert.equal(controls.prepared.length, 1);
    controls.writes.push(text);
  }
  const api = createSessionDestinations({
    accounts: () => ({ codex: account(), claude: account() }),
    codex: { async requestDesktop(op, args, opts) {
      await opts.beforeSend();
      let result;
      if (op === "list_projects") result = { projects: [{ projectId: "project", hostId: "local", projectKind: "local", path: cwd }] };
      if (op === "list_threads") result = { pinnedThreads: [], threads: [thread()] };
      if (op === "read_thread") result = { thread: thread(), turns: [] };
      if (op === "send_message_to_thread") { wrote(args.prompt); result = { threadId: taskId, status: "accepted" }; }
      return { result, executorThreadId: executor };
    } },
    watermark: () => ({ status: "available" }),
    observe: () => ({ status: "completed", threadId: taskId, turnId: turn, text: "native response", replySha256: digest(controls.substitute ? "another" : "native response") }),
    claudeAccount: account,
    claudeSessions: () => [{ sessionId: taskId, entrypoint: "claude-desktop", alive: true, pid: 11, processStart: "native-process", socket: "native-socket", cwd, activity: status() }],
    claudeContext: () => ({ status: "matched", accountFingerprint: account().fingerprint, taskId: "local_" + taskId, cwd, title: "Existing task", permissionClass: "bypass" }),
    assertProcess() {}, inbound: () => ({ value: controls.inbound ?? "accept" }),
    peer: () => ({
      start() {}, stop() {},
      async sendAndWait(socket, text, options) {
        const msgId = randomUUID();
        await options.onPrepared(msgId);
        await options.beforeSend();
        wrote(text);
        peerMessage = msgId;
        return { msgId };
      },
    }),
    claudeReply: (id, directory, msgId) => ({ status: "reply_received", reply: { inReplyTo: controls.substitute ? randomUUID() : peerMessage, text: "native response" } }),
    antigravity: async request => {
      if (request.operation === "fleet-status") return { instanceId: controls.rotate ? randomUUID() : instanceId };
      assert.equal(request.instanceId, instanceId);
      if (request.operation === "list") return [agRow()];
      if (request.operation === "read") return agRow();
      if (request.operation === "send") {
        assert.equal(request.expectedProjectId, "project");
        wrote(request.prompt);
        sidecarReceipt = { requestId: request.requestId, conversationId: taskId, cwd, sender: request.sender, status: "pending" };
        return sidecarReceipt;
      }
      return { ...sidecarReceipt, status: "reply_received", result: { reply: "native response" }, replyObservation: { status: "reply_received", replySha256: digest(controls.substitute ? "another" : "native response") } };
    },
  });
  async function inputFor(source, destination) {
    const { sessions } = await api.listSessionTargets(cwd);
    const target = sessions.find(item => item.agent === destination);
    assert.equal(target.id, taskId);
    return { cwd, target, requestId: randomUUID(), prompt: "Read the current platform.", sender: { agent: source, id: randomUUID(), mode: "bypass", host: "test-pc", account: digest("source-account") },
      check() {}, onPrepared: binding => controls.prepared.push(binding) };
  }
  return { api, controls, inputFor };
}

for (const source of providers) {
  for (const destination of providers) {
    test(source + " sends to the exact " + destination + " session and observes its own native reply", async t => {
      const { api, controls, inputFor } = fixture(t);
      const input = await inputFor(source, destination);
      const sent = await api.dispatchSession(input);
      assert.equal(sent.status, "running");
      assert.deepEqual(controls.prepared[0], sent.adapterReceipt);
      assert.equal(controls.writes.length, 1);
      assert.ok(controls.writes[0].includes("From " + source + " on test-pc"));
      assert.ok(controls.writes[0].includes(input.sender.id));
      const read = { ...input, receipt: sent.adapterReceipt };
      assert.deepEqual(await api.readSessionReply(read), { status: "completed", output: "native response" });
      controls.substitute = true;
      const unbound = await api.readSessionReply(read);
      assert.notEqual(unbound.status, "completed");
      assert.equal(unbound.output, undefined);
      assert.equal(controls.writes.length, 1);
    });
  }
}

for (const provider of providers) {
  test(provider + " refuses a busy or replaced native recipient", async t => {
    const { api, controls, inputFor } = fixture(t);
    const input = await inputFor("claude", provider);
    controls.busy = true;
    await assert.rejects(api.dispatchSession(input), /busy/);
    controls.busy = false;
    controls.account = "changed";
    controls.rotate = true;
    await assert.rejects(api.dispatchSession(input));
    assert.deepEqual(controls.writes, []);
  });
}

test("Codex enforces the remote sender permission class before preparing a delivery", async t => {
  const { api, controls, inputFor } = fixture(t);
  const input = await inputFor("claude", "codex");
  input.sender.mode = "prompting";
  await assert.rejects(api.dispatchSession(input), /full-access/);
  assert.deepEqual(controls.prepared, []);
});

test("discovery excludes recipients that would refuse this sender's verified permission mode", async t => {
  const { api, controls, inputFor } = fixture(t);
  const { cwd, sender } = await inputFor("claude", "claude");
  sender.mode = "prompting";
  controls.inbound = "hold";
  const list = await api.listSessionTargets(cwd, { sender });
  assert.deepEqual(list.sessions.map(row => row.agent), ["antigravity"]);
  controls.inbound = "accept";
  assert.deepEqual((await api.listSessionTargets(cwd, { sender })).sessions.map(row => row.agent), ["claude", "antigravity"]);
});
