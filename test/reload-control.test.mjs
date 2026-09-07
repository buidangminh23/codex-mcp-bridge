import assert from "node:assert/strict";
import { it } from "node:test";
import { createReloadControl } from "../src/reload-control.mjs";
import { PeerEndpoint } from "../src/peer-protocol.mjs";
import { ReplyForwarder } from "../src/reply-forwarder.mjs";

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
