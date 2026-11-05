import fs from "node:fs";
import path from "node:path";
import { callAntigravityDesktop } from "./antigravity-ipc.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const HUMAN_SENDER = Object.freeze({ provider: "human-web", id: "minh-spark-company" });

function invalid(message, code = "ANTIGRAVITY_HUMAN_REQUEST_INVALID") {
  return Object.assign(new Error(message), { code, phase: "validation", deliveryState: "not_sent" });
}

export function humanWorkspace(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw invalid("An absolute existing workspace is required");
  try {
    const resolved = fs.realpathSync.native(value);
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch { throw invalid("The requested workspace is unavailable"); }
}

export function humanDeliveryInput(input, operation) {
  if (!input || typeof input !== "object" || !UUID.test(input.conversationId) || input.sender !== undefined) throw invalid("An exact conversation UUID and a fixed human sender are required");
  const out = { conversationId: input.conversationId.toLowerCase(), cwd: humanWorkspace(input.cwd) };
  if (operation !== "inspect") {
    if (typeof input.requestId !== "string" || !UUID.test(input.requestId)) throw invalid("requestId must be a UUID");
    out.requestId = input.requestId.toLowerCase();
  }
  if (operation === "send") {
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 30000 || input.prompt.includes("\0")) throw invalid("Prompt must contain between 1 and 30000 characters without NUL");
    out.prompt = input.prompt;
  }
  return out;
}

export function humanReceipt(record, target) {
  if (record === null) return null;
  if (!record || record.requestId !== target.requestId || record.conversationId !== target.conversationId || record.surface !== "desktop" || record.sender?.provider !== HUMAN_SENDER.provider || record.sender?.id !== HUMAN_SENDER.id || humanWorkspace(record.cwd) !== target.cwd) throw invalid("Receipt does not belong to this human delivery", "ANTIGRAVITY_HUMAN_RECEIPT_MISMATCH");
  return record;
}

async function callHuman(operation, input, options = {}) {
  const target = humanDeliveryInput(input, operation);
  const call = options.call ?? ((request) => callAntigravityDesktop(request, { directory: options.directory, timeoutMs: options.timeoutMs ?? 10000 }));
  let status;
  try { status = await call({ operation: "status" }); }
  catch (error) {
    if (operation === "send") {
      error.deliveryState = "not_sent";
      error.phase = "preflight";
    }
    throw error;
  }
  if (status?.available !== true || status.humanDispatchVersion !== 1) throw invalid("The app-launched Antigravity sidecar must be updated to support human dashboard messages", "ANTIGRAVITY_HUMAN_UNSUPPORTED");
  const result = await call({ operation: `human-${operation}`, ...target });
  if (operation !== "inspect") {
    try {
      if (operation === "send" && result === null) throw invalid("No delivery receipt returned");
      return humanReceipt(result, target);
    } catch (error) {
      if (operation === "send") { error.deliveryState = "unknown"; error.phase = "response"; }
      throw error;
    }
  }
  if (!result || result.conversationId !== target.conversationId || humanWorkspace(result.cwd) !== target.cwd || result.surface !== "desktop" || result.available !== true || result.status !== "CASCADE_RUN_STATUS_IDLE") throw invalid("Native conversation does not match the requested idle workspace", "ANTIGRAVITY_HUMAN_TARGET_MISMATCH");
  return result;
}

export function inspectHumanConversation(input, options) { return callHuman("inspect", input, options); }
export function sendHumanMessage(input, options) { return callHuman("send", input, options); }
export function readHumanReceipt(input, options) { return callHuman("receipt", input, options); }
