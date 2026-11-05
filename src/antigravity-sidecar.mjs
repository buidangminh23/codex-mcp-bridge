#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { antigravityBridgeDirectory, serveAntigravityDesktop } from "./antigravity-ipc.mjs";
import { AntigravityDeliveries } from "./antigravity-deliveries.mjs";
import { listAntigravityConversations, observeAntigravityDelivery, runAgentApi, sanitizeAntigravityMetadata } from "./antigravity-desktop.mjs";
import { exitForVersionRequest } from "./cli-version.mjs";
import { readProcessAncestry } from "./claude-sender-context.mjs";
import { HUMAN_SENDER, humanDeliveryInput, humanReceipt, humanWorkspace } from "./antigravity-human.mjs";

export async function createAntigravityParentGuard({ parentPid = process.ppid, inspect = readProcessAncestry } = {}) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1 || parentPid > 0xffffffff) throw new Error("Antigravity sidecar parent is unavailable; relaunch it from the native app");
  const read = async () => {
    const rows = await inspect({ parentPid, maxDepth: 1 });
    const row = rows?.[0];
    return rows?.length === 1 && row?.pid === parentPid && typeof row.processStart === "string" && row.processStart ? { pid: row.pid, processStart: row.processStart } : null;
  };
  let initial;
  try { initial = await read(); } catch {}
  if (!initial) throw new Error("Antigravity sidecar parent is unavailable; relaunch it from the native app");
  let unavailable = false;
  let pending;
  return async () => {
    if (!unavailable) {
      pending ??= (async () => {
        try {
          const current = await read();
          unavailable = !current || current.pid !== initial.pid || current.processStart !== initial.processStart;
        } catch { unavailable = true; }
      })();
      await pending;
      pending = undefined;
    }
    if (unavailable) throw Object.assign(new Error("Antigravity sidecar parent exited or changed; relaunch it from the native app"), { deliveryState: "not_sent" });
  };
}

export async function startAntigravitySidecar({ directory = antigravityBridgeDirectory(), env = process.env, createParentGuard = createAntigravityParentGuard, serve = serveAntigravityDesktop, parentCheckIntervalMs = 5000, onParentLost = () => {}, list = listAntigravityConversations, runNative = runAgentApi, observeDelivery = observeAntigravityDelivery } = {}) {
  if (!env.ANTIGRAVITY_AGENTAPI_EXE || !env.ANTIGRAVITY_LS_ADDRESS) throw new Error("Antigravity must launch this sidecar. Do not run it as a replacement app server.");
  const assertParent = await createParentGuard();
  const deliveries = new AntigravityDeliveries(path.join(directory, "desktop-deliveries"));
  const sending = new Set();
  let sidecar;
  let timer;
  let closing;
  let closed = false;
  let parentLost = false;
  const close = () => {
    closed = true;
    clearTimeout(timer);
    return closing ??= Promise.resolve().then(() => sidecar?.close());
  };
  const checkParent = async () => {
    try { await assertParent(); }
    catch (error) {
      if (!parentLost) { parentLost = true; void close().then(onParentLost); }
      throw error;
    }
  };
  sidecar = await serve(async (request) => {
    await checkParent();
    if (!request || typeof request !== "object") throw new Error("Invalid sidecar request");
    if (request.operation === "status") return { available: true, transport: "native-agentapi", permissionPolicy: "native-unchanged", humanDispatchVersion: 1 };
    if (["human-inspect", "human-send", "human-receipt"].includes(request.operation)) {
      const operation = request.operation.slice("human-".length);
      const target = humanDeliveryInput(request, operation);
      if (operation === "receipt") return humanReceipt(deliveries.read(target.requestId), target);
      const inspect = async () => {
        await checkParent();
        const records = (await list({ surface: "desktop", limit: 1000 })).filter((record) => record.conversationId === target.conversationId);
        if (records.length !== 1 || records[0].surface !== "desktop" || humanWorkspace(records[0].cwd) !== target.cwd) throw Object.assign(new Error("Exact Antigravity conversation and workspace are unavailable"), { code: "ANTIGRAVITY_RECIPIENT_MISSING", deliveryState: "not_sent" });
        const record = records[0];
        if (record.status !== "CASCADE_RUN_STATUS_IDLE") throw Object.assign(new Error("Antigravity conversation is busy; no message was sent"), { code: "ANTIGRAVITY_RECIPIENT_BUSY", deliveryState: "not_sent" });
        const metadata = sanitizeAntigravityMetadata(await runNative({ command: "metadata", conversationId: target.conversationId, env }), target.conversationId);
        if (humanWorkspace(metadata.cwd) !== target.cwd || metadata.projectId !== record.projectId) throw Object.assign(new Error("Native Antigravity workspace or project changed"), { code: "ANTIGRAVITY_METADATA_MISMATCH", deliveryState: "not_sent" });
        await checkParent();
        return { ...record, ...metadata, available: true };
      };
      if (operation === "inspect") return inspect();
      return deliveries.dispatch({ ...target, surface: "desktop", sender: HUMAN_SENDER }, async () => {
        await checkParent();
        if (sending.has(target.conversationId)) throw Object.assign(new Error("Another delivery is pending for this conversation"), { deliveryState: "not_sent" });
        sending.add(target.conversationId);
        try {
          await inspect();
          return await runNative({ command: "send", conversationId: target.conversationId, expectedCwd: target.cwd, prompt: target.prompt, env });
        } finally { sending.delete(target.conversationId); }
      });
    }
    if (request.operation === "list") return listAntigravityConversations({ surface: "desktop" });
    if (request.operation === "read") {
      const records = await listAntigravityConversations({ surface: "desktop" });
      const record = records.find((item) => item.conversationId === request.conversationId);
      if (!record) throw new Error("Exact Antigravity Desktop conversation not found");
      const native = sanitizeAntigravityMetadata(await runAgentApi({ command: "metadata", conversationId: request.conversationId, env }), request.conversationId);
      return { ...record, ...native };
    }
    if (request.operation === "receipt") return deliveries.refresh(request.requestId, observeDelivery);
    if (request.operation !== "send" || typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 30000 || request.prompt.includes("\0")
      || typeof request.cwd !== "string" || !path.isAbsolute(request.cwd) || !request.sender || !["codex", "claude"].includes(request.sender.provider)
      || typeof request.sender.id !== "string" || !request.sender.id) throw new Error("Invalid Antigravity delivery request");
    return deliveries.dispatch({ requestId: request.requestId, surface: "desktop", conversationId: request.conversationId, cwd: request.cwd, sender: request.sender, prompt: request.prompt }, async () => {
      await checkParent();
      if (sending.has(request.conversationId)) throw Object.assign(new Error("Another delivery is pending for this conversation"), { deliveryState: "not_sent" });
      sending.add(request.conversationId);
      try { return await runNative({ command: "send", conversationId: request.conversationId, expectedCwd: request.cwd, prompt: request.prompt, env,
        beforeDispatch: (observation) => deliveries.captureObservation(request.requestId, observation) }); }
      finally { sending.delete(request.conversationId); }
    });
  }, { directory });
  try { await checkParent(); } catch (error) { await close(); throw error; }
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(async () => {
      try { await checkParent(); } catch { return; }
      schedule();
    }, parentCheckIntervalMs);
    timer.unref();
  };
  schedule();
  return { ...sidecar, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitForVersionRequest(import.meta.url);
  const sidecar = await startAntigravitySidecar({ onParentLost: () => process.exit(0) });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void sidecar.close().then(() => process.exit(0)); });
}
