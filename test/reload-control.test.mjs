import assert from "node:assert/strict";
import { it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createProcessReaper, waitForExit } from "./helpers/process-reaper.mjs";
import { assertRoutingReload, createReloadControl, exitWhenClientCloses } from "../src/reload-control.mjs";
import { PeerEndpoint } from "../src/peer-protocol.mjs";
import { ReplyForwarder } from "../src/reply-forwarder.mjs";

it("upgrades a quiescent legacy worker to Desktop delivery without replaying confirmed replies", async () => {
  let sends = 0;
  const previousForwarder = new ReplyForwarder({ deliver: async () => { sends++; }, minIntervalMs: 0 });
  previousForwarder.enqueue({ inReplyTo: "confirmed", text: "reply" }, "original-task");
  while (previousForwarder.reloadReason()) await new Promise(resolve => setTimeout(resolve, 5));
  const nextForwarder = new ReplyForwarder({ deliver: async () => { sends++; }, minIntervalMs: 0 });
  const previous = createReloadControl({ entry: "claude-bridge.mjs",
    inspect: () => previousForwarder.reloadReason(),
    exportState: () => ({ desktopOnly: false, forwarding: previousForwarder.exportReloadState() }) });
  const next = createReloadControl({ entry: "claude-bridge.mjs", env: { CODEX_BRIDGE_WORKER: "1", CODEX_BRIDGE_STAGED: "1" }, channel: { send() {} },
    restore: state => { assertRoutingReload(state.desktopOnly, true); nextForwarder.restoreReloadState(state.forwarding); } });
  const { state } = await previous.control("quiesce");
  await next.control("restore", state);
  await next.control("activate");
  assert.equal(nextForwarder.enqueue({ inReplyTo: "confirmed", text: "duplicate" }, "original-task").status, "forwarded");
  assert.equal(sends, 1);
  for (const [from, to] of [[true, false], [undefined, true], ["false", true], [false, undefined]]) {
    assert.throws(() => assertRoutingReload(from, to), /routing reload/);
  }
  assert.doesNotThrow(() => assertRoutingReload(false, false));
  assert.doesNotThrow(() => assertRoutingReload(true, true));
  previousForwarder.close();
  nextForwarder.close();
});

it("blocks staging and concurrent work, transfers state, and resumes a failed switch",async()=>{
  let busy=false;
  let value=0;
  const make=staged=>createReloadControl({entry:"index.mjs",env:{CODEX_BRIDGE_WORKER:"1",CODEX_BRIDGE_STAGED:staged?"1":"0"},channel:{send(){}},inspect:()=>busy?"pending":null,
    exportState:()=>({value}),restore:state=>{value=state.value;}});
  const old=make(false);
  const candidate=make(true);
  await assert.rejects(candidate.run(()=>{}),/staged/);
  busy=true;
  await assert.rejects(old.control("quiesce"),/pending/);
  busy=false;
  value=42;
  const {state}=await old.control("quiesce");
  await assert.rejects(old.run(()=>{}),/quiesced/);
  await assert.rejects(candidate.control("restore",{...state,entry:"claude-bridge.mjs"}),/schema/);
  await candidate.control("restore",state);
  await candidate.control("activate");
  assert.equal(await candidate.run(()=>value),42);
  await old.control("resume");
  assert.equal(old.inspect().reloadable,true);
});

it("keeps the account, original task and unread inbox while transferring completed peer receipts",()=>{
  const first=new PeerEndpoint({name:"original"});
  const accounts={claude:"a".repeat(64),codex:"b".repeat(64)};
  const reply={msgId:"reply",inReplyTo:"sent",text:"completed",sequence:1,receivedAt:100,fromSocket:"destination",accountContext:accounts,replyThreadId:"original-task"};
  first.messageSequence=1;
  first.inbox.push(reply);
  first.sentMessages.set("sent",{targetSocket:"destination",sentAt:90,reply,accountContext:accounts,replyThreadId:"original-task"});
  first.deliveryReceipts.set("sent",{status:"delivered"});
  const second=new PeerEndpoint({name:"replacement"});
  second.restoreReloadState(first.exportReloadState());
  assert.equal(second.readDelivery("sent").reply,"completed");
  assert.equal(second.readDelivery("sent").replyThreadId,"original-task");
  assert.deepEqual(second.readDelivery("sent").accountContext,accounts);
  assert.equal(second.drainInbox(1)[0].text,"completed");
  assert.equal(first.inbox.length,1);
  first.pendingMessages.set("other",{targetSocket:"destination"});
  assert.throws(()=>first.exportReloadState(),/pending/);
});

it("preserves forwarding deduplication and the session limit across a reload",async()=>{
  let deliverCount=0;
  const first=new ReplyForwarder({deliver:async()=>{deliverCount++;},minIntervalMs:0,maxPerSession:1});
  first.enqueue({inReplyTo:"message",text:"answer"},"task");
  while(first.reloadReason()) await new Promise(resolve=>setTimeout(resolve,5));
  const second=new ReplyForwarder({deliver:async()=>{deliverCount++;},minIntervalMs:0,maxPerSession:5});
  second.restoreReloadState(first.exportReloadState());
  assert.equal(second.enqueue({inReplyTo:"message",text:"same answer"},"task").status,"forwarded");
  assert.equal(second.enqueue({inReplyTo:"second",text:"another answer"},"task").status,"blocked");
  assert.equal(second.status().attempts,1);
  assert.equal(deliverCount,1);
  first.close();second.close();
});

it("exits once after the MCP client closes, waiting for open work within its deadline", async () => {
  const { EventEmitter } = await import("node:events");
  const stdin = new EventEmitter();
  const channel = new EventEmitter();
  const events = [];
  let open = "delivery";
  const shutdown = exitWhenClientCloses({ stdin, channel, pollMs: 5, drainMs: 5000,
    prepare: () => events.push("prepare"), busy: () => open, stop: async () => events.push("stop"), exit: (code) => events.push(`exit:${code}`) });
  stdin.emit("end");
  channel.emit("disconnect");
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(events, ["prepare"]);
  open = null;
  await shutdown.close();
  assert.deepEqual(events, ["prepare", "stop", "exit:0"]);

  const logs = [];
  const bounded = [];
  const stuck = exitWhenClientCloses({ stdin: new EventEmitter(), channel: new EventEmitter(), pollMs: 5, drainMs: 40, stopMs: 40,
    busy: () => "never finishes", stop: () => new Promise(() => {}), log: message => logs.push(message), exit: code => bounded.push(code) });
  await stuck.close("test");
  assert.deepEqual(bounded, [0]);
  assert.ok(logs.some(message => message.includes("never finishes")));
  assert.ok(logs.some(message => message.includes("listener shutdown exceeded")));

  const failed = [];
  await exitWhenClientCloses({ stdin: null, channel: null, stop: () => { throw new Error("broken"); }, exit: code => failed.push(code) }).close("test");
  assert.deepEqual(failed, [1]);
});

it("finishes draining after its supervisor is killed and its output pipes lose their reader", { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "client-close-drain-"));
  const reaper = createProcessReaper();
  t.after(async () => { await reaper.reap(); fs.rmSync(directory, { recursive: true, force: true }); });
  const marker = path.join(directory, "exit.json");
  const worker = path.join(directory, "worker.mjs");
  const parent = path.join(directory, "parent.mjs");
  fs.writeFileSync(worker, `import fs from "node:fs";
import { exitWhenClientCloses } from ${JSON.stringify(new URL("../src/reload-control.mjs", import.meta.url).href)};
let open = true;
process.stdin.resume();
exitWhenClientCloses({ busy: () => open ? "delivery" : null, pollMs: 20, log: message => process.stderr.write(message + "\\n"),
  exit: code => { fs.writeFileSync(process.argv[2], JSON.stringify({ code, delivered: !open })); process.exit(code); } });
process.once("disconnect", () => setTimeout(() => {
  for (let index = 0; index < 32; index++) { process.stdout.write("o".repeat(65536)); process.stderr.write("e".repeat(65536)); }
  setTimeout(() => { open = false; }, 300);
}, 300));
process.send({ ready: true });
setInterval(() => {}, 1000);
`);
  fs.writeFileSync(parent, `import { fork } from "node:child_process";
const child = fork(process.argv[2], [process.argv[3]], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
child.stdout.resume(); child.stderr.resume();
child.once("message", () => process.stdout.write(child.pid + "\\n"));
setInterval(() => {}, 1000);
`);
  const supervisor = spawn(process.execPath, [parent, worker, marker], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  reaper.track(supervisor.pid);
  const workerPid = await new Promise((resolve, reject) => {
    let output = "";
    supervisor.stdout.on("data", data => { output += data; if (output.includes("\n")) resolve(Number(output.trim())); });
    supervisor.once("exit", () => reject(new Error("Parent exited before its worker was ready")));
  });
  reaper.track(workerPid);
  supervisor.kill("SIGKILL");
  assert.deepEqual(await waitForExit([workerPid], 15000), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { code: 0, delivered: true });
});
