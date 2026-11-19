import os from "node:os";
import path from "node:path";
import { RELAY_UUID } from "./background-relay-config.mjs";
import { authorizedProject } from "./fleet-host.mjs";
import { repositoryIdentity } from "./remote-codex.mjs";
import { captureProjectScope, recheckProjectScope } from "./project-scope.mjs";
import { fail, hash, publicResult, senderIdentity, SessionReceipts, targetIdentity, terminal, validText } from "./fleet-session-protocol.mjs";

const byteLimit = 256 * 1024;
const availableMemory = () => Math.min(os.totalmem(), process.availableMemory?.() ?? os.freemem());
const targetSlot = (cwd, target) => {
  const { scopeFingerprint, ...identity } = targetIdentity(target);
  return hash([cwd, identity]);
};
const sameTarget = (row, target) => row.agent === target.agent && row.id === target.id && row.accountFingerprint === target.accountFingerprint
  && row.taskId === target.taskId && (!target.scopeFingerprint || row.scopeFingerprint === target.scopeFingerprint);

function boundedOutcome(result) {
  if (typeof result?.output !== "string" || Buffer.byteLength(result.output) <= 240 * 1024) return result;
  return { ...result, output: Buffer.from(result.output).subarray(0, 240 * 1024).toString("utf8") + "\n[Reply truncated at 240 KiB]" };
}

async function observe(record, native, store, check) {
  const { target, sender, cwd, repository } = record.route;
  if (hash([sender, repository, cwd, target]) !== record.owner) return;
  if (!record.result?.adapterReceipt) {
    if (record.state === "reserved" && Number.isSafeInteger(record.route.receiverPid) && record.route.receiverPid > 0) {
      try { process.kill(record.route.receiverPid, 0); }
      catch (error) {
        if (error.code === "ESRCH") store.update(record.id, "failed", { output: "The receiver exited before preparing a native delivery" });
      }
    }
    return;
  }
  const result = boundedOutcome(await native.readSessionReply({ cwd, target, sender, requestId: record.id, receipt: record.result.adapterReceipt, check }));
  check();
  publicResult(record.id, target, undefined, result);
  store.update(record.id, result.status, { output: result.output, adapterReceipt: result.adapterReceipt ?? record.result.adapterReceipt });
}

export async function handleFleetSessionRequest(input, { authorize = authorizedProject, identify = repositoryIdentity,
  capture = captureProjectScope, recheck = recheckProjectScope, freeBytes = availableMemory,
  adapters, receipts = () => new SessionReceipts("receiver"), env = process.env } = {}) {
  if (env.AGENT_RELAY_TOKEN || env.AGENT_RELAY_WORKER_ID || env.AGENT_RELAY_ENDPOINT) throw fail("OPERATOR", "A scoped worker cannot receive native session handoffs");
  if (input?.version !== 1 || !RELAY_UUID.test(input.nonce ?? "") || !["inspect", "send", "read"].includes(input.action)
    || !validText(input.cwd, 4096) || !path.isAbsolute(input.cwd) || !validText(input.repository, 4096)) throw fail("INPUT", "Invalid fleet session frame");
  const cwd = authorize(input.cwd);
  const scope = capture(cwd, cwd);
  const check = () => {
    recheck(scope);
    if (authorize(input.cwd) !== cwd || identify(cwd) !== input.repository) throw fail("PROJECT", "The destination project grant or repository changed");
  };
  check();
  const native = adapters ?? await import("./fleet-session-destination.mjs");
  const sender = senderIdentity(input.sender);
  if (input.action === "inspect") {
    const { sessions } = await native.listSessionTargets(cwd, { sender });
    check();
    const store = receipts();
    try {
      const idle = sessions.filter(row => row.status === "idle").slice(0,256);
      const keys = idle.map(row => targetSlot(cwd, row));
      const previous = store.claimIdleChecks(keys).filter(record => record.route.cwd === cwd && record.route.repository === input.repository
        && idle.some(row => sameTarget(row, record.route.target)));
      await Promise.allSettled(previous.map(record => observe(record, native, store, check)));
      check();
      const occupied = store.occupied();
      const targets = idle.filter(row => !occupied.has(targetSlot(cwd, row)))
        .map(row => ({ ...targetIdentity(row), status: "idle", title: String(row.title ?? "").slice(0, 256) }));
      return { freeBytes: freeBytes(), targets: targets.slice(0,100) };
    } finally { store.close(); }
  }
  const target = targetIdentity(input.target);
  const requestId = input.requestId;
  if (!RELAY_UUID.test(requestId ?? "") || input.action === "send" && (typeof input.prompt !== "string"
      || !input.prompt.trim() || Buffer.byteLength(input.prompt) > 128 * 1024 || !Number.isSafeInteger(input.minFreeBytes) || input.minFreeBytes < 1)) {
    throw fail("INPUT", "Invalid session request or RAM threshold");
  }
  const owner = hash([sender, input.repository, cwd, target]);
  const digest = input.action === "send" ? hash([owner, input.prompt]) : undefined;
  const store = receipts();
  const status = row => publicResult(requestId, target, undefined, { status: row.state === "reserved" ? "uncertain" : row.state, output: row.result?.output });
  try {
    let record = store.get(requestId, owner, digest);
    if (!record && input.action === "read") throw fail("MISSING", "The destination has no matching receipt for the original request");
    if (!record) {
      if (freeBytes() < input.minFreeBytes) throw fail("MEMORY", "The receiving computer is now below the minimum available RAM");
      const { sessions } = await native.listSessionTargets(cwd, { sender });
      check();
      if (!sessions.some(row => row.status === "idle" && sameTarget(row, target))) throw fail("BUSY", "The selected AI session is no longer ready under its original identity");
      const fresh = store.reserve(requestId, owner, digest, { target, sender, cwd, repository: input.repository, receiverPid: process.pid }, targetSlot(cwd, target));
      if (fresh) {
        let prepared;
        const onPrepared = receipt => {
          check();
          if (freeBytes() < input.minFreeBytes) throw fail("MEMORY", "Available RAM dropped before dispatch");
          store.update(requestId, "uncertain", { adapterReceipt: receipt });
          prepared = receipt;
        };
        try {
          check();
          const result = boundedOutcome(await native.dispatchSession({ cwd, target, sender, prompt: input.prompt, requestId, check, onPrepared }));
          check();
          publicResult(requestId, target, undefined, result);
          store.update(requestId, result.status, { output: result.output, adapterReceipt: result.adapterReceipt ?? prepared });
        } catch (error) {
          const state = prepared || error.deliveryState === "unknown" ? "uncertain" : "failed";
          store.update(requestId, state, { adapterReceipt: prepared, output: state === "failed" ? String(error.message).slice(0, 512) : undefined });
        }
        check();
        return status(store.get(requestId, owner));
      }
      record = store.get(requestId, owner, digest);
    }
    if (!terminal(record.state)) {
      await observe(record, native, store, check);
    }
    check();
    return status(store.get(requestId, owner));
  } finally { store.close(); }
}

export async function runFleetSessionHost(stream = process.stdin) {
  let input;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > byteLimit) throw fail("INPUT", "Fleet session frame exceeds its size limit");
      chunks.push(chunk);
    }
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return { version: 1, nonce: input.nonce, result: await handleFleetSessionRequest(input) };
  } catch (error) {
    return { version: 1, nonce: input?.nonce, error: { code: error.code ?? "FLEET_SESSION_FAILED", message: String(error.message).slice(0, 512) } };
  }
}
