import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const diagnosticCode = (value) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
const diagnosticId = (value) => typeof value === "string" && /^(?:[a-f0-9]{64}|(?:local_)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value) ? value : null;

export function diagnosticText(value) {
  return String(value ?? "Unknown bridge failure")
    .replace(/\{[\s\S]*\}|\[\s*(?:\{|"|true|false|null|\d)[\s\S]*\]/g, "[structured details omitted]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[credential]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|token|secret|password|authorization)\s*["']?\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n"'<>|,;]*/gi, "[path]")
    .replace(/(^|[\s"'(])\/(?:Users|home|tmp|var|private|Volumes|mnt)\/[^\r\n"'<>|,;]*/g, "$1[path]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(?:sk-[a-z0-9_-]+|gh[pousr]_[a-z0-9_]+)\b/gi, "[credential]")
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 1400);
}

export function bridgeDiagnostic(error, options = {}) {
  const previous = error?.diagnostic?.schemaVersion === 1 ? error.diagnostic : null;
  const chain = [];
  const seen = new Set();
  for (let cause = error; cause && !seen.has(cause) && chain.length < 8; cause = cause.cause) {
    seen.add(cause);
    chain.push(cause);
  }
  const codes = [...new Set(chain.flatMap((cause) => [cause?.preflight?.code, cause?.code, cause?.reasonCode, cause?.diagnostic?.code]).map(diagnosticCode).filter(Boolean))];
  const code = diagnosticCode(previous?.code) ?? diagnosticCode(options.code) ?? codes[0] ?? "BRIDGE_OPERATION_FAILED";
  const state = options.deliveryState ?? previous?.deliveryState ?? error?.deliveryState;
  const deliveryState = state === "not_applicable" || options.readOnly && !previous ? "not_applicable"
    : ["not_sent", "not-sent"].includes(state) ? "not_sent"
    : state === "sent" ? "sent"
    : state === "unknown" || error?.deliveryUncertain ? "unknown"
    : chain.some((cause) => cause?.sent === false || cause?.preflight?.sent === false) ? "not_sent" : "unknown";
  const name = (value, fallback) => typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_./-]{0,99}$/.test(value) ? value : fallback;
  const ids = {};
  for (const key of ["requestId", "msgId", "deliveryId", "threadId", "taskId", "conversationId"]) {
    const id = diagnosticId(previous?.ids?.[key] ?? options[key] ?? error?.[key]);
    if (id) ids[key] = id;
  }
  const timestamp = previous?.timestamp;
  return {
    schemaVersion: 1,
    reportId: diagnosticId(previous?.reportId) ?? randomUUID(),
    timestamp: typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(timestamp) ? timestamp : new Date().toISOString(),
    component: name(previous?.component ?? options.component, "bridge"),
    operation: name(previous?.operation === "unknown" ? options.operation : previous?.operation ?? options.operation, "unknown"),
    version: typeof previous?.version === "string" && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(previous.version) ? previous.version : version,
    platform: process.platform,
    nodeVersion: process.versions.node,
    code,
    causeCodes: [...new Set([...(Array.isArray(previous?.causeCodes) ? previous.causeCodes : []).map(diagnosticCode).filter(Boolean), ...codes])].filter((value) => value !== code).slice(0, 8),
    phase: name(previous?.phase ?? options.phase ?? error?.phase ?? error?.diagnostic?.stage, deliveryState === "not_sent" ? "preflight" : options.readOnly ? "inspection" : "delivery"),
    deliveryState,
    sent: deliveryState === "not_sent" ? false : deliveryState === "sent" ? true : null,
    retrySafe: deliveryState === "not_sent" && code !== "PEER_REPLY_PENDING",
    nextAction: code === "PEER_REPLY_PENDING" ? "Read read_claude_delivery with the original msgId. Wait for its correlated outcome; do not resend or start another bridge to bypass pending work."
      : deliveryState === "not_sent" ? "Inspect the reported cause and bridge status before retrying. Do not open or create chats to load a relay."
      : deliveryState === "not_applicable" ? "Inspect bridge status and include this diagnostic in the report."
      : "Inspect the original delivery receipt. Do not resend automatically or create a replacement chat.",
    reason: diagnosticText(previous?.reason ?? error?.preflight?.reason ?? error?.message ?? error),
    ids,
  };
}

export function withBridgeDiagnostic(result, error, options = {}) {
  const diagnostic = bridgeDiagnostic({ ...error, cause: error?.cause, message: error?.message ?? String(error ?? "Bridge operation failed"), diagnostic: result?.structuredContent?.diagnostic ?? result?.diagnostic ?? error?.diagnostic }, options);
  const report = ["Bridge diagnostic (include this block in a bug report)", `${diagnostic.code} | ${diagnostic.component} / ${diagnostic.operation}`,
    `Bridge ${diagnostic.version} | ${diagnostic.platform} | Node ${diagnostic.nodeVersion}`,
    `Phase: ${diagnostic.phase} | Delivery: ${diagnostic.deliveryState} | Sent: ${diagnostic.sent ?? "unconfirmed"}`,
    `Reason: ${diagnostic.reason}`, ...(diagnostic.causeCodes.length ? [`Cause codes: ${diagnostic.causeCodes.join(", ")}`] : []),
    ...Object.entries(diagnostic.ids).map(([key, value]) => `${key}: ${value}`),
    `Report: ${diagnostic.reportId} | ${diagnostic.timestamp}`, diagnostic.nextAction].join("\n");
  return { ...result, content: [...(result?.content ?? []).filter((item) => item.type !== "text" || !item.text.startsWith("Bridge diagnostic (")), { type: "text", text: report }],
    structuredContent: { ...result?.structuredContent, diagnostic } };
}

export function preflightFailure(code, reason) {
  const error = new Error(`${reason} No message was sent.`);
  error.code = code;
  error.deliveryState = "not_sent";
  error.sent = false;
  error.preflight = { status: "blocked", code, reason, sent: false };
  return error;
}

/**
 * Claude consults crossSessionInbound before comparing permission classes,
 * then holds any message whose attested sender class differs from the
 * recipient's. Claude Desktop cannot show the approval dialog, so a hold
 * there expires unapproved. Both predictable outcomes are refused here with
 * the setting or both classes named. The recipient's mode comes from Desktop
 * task metadata; an unknown mode leaves the decision to Claude. This runs at
 * request time and again immediately before the socket write.
 */
export function assertRecipientClass(session, sender) {
  if (!sender) return;
  const inbound = session.inbound ?? { value: null, source: null };
  if (inbound.value === "refuse" || inbound.value === "hold") {
    throw preflightFailure("CLAUDE_RECIPIENT_INBOUND_POLICY", `The recipient session's ${inbound.source} settings set crossSessionInbound to ${inbound.value}, so Claude would ${inbound.value === "refuse" ? "drop this message without delivering it" : "hold this message, and Claude Desktop declares no peer approval dialog, so it would expire unapproved"}. Report this to the user: only they can change that setting. Do not edit recipient settings.`);
  }
  if (inbound.value === "accept") return;
  const recipient = session.desktop?.permissionClass ?? null;
  if (!recipient || recipient === sender.mode) return;
  throw preflightFailure("CLAUDE_RECIPIENT_CLASS_MISMATCH", `The Claude Desktop task "${session.desktop.title}" runs in ${session.desktop.permissionMode} (${recipient} class) while this sender attests ${sender.mode}. With no explicit crossSessionInbound setting, Claude holds a cross-session message whose sender class differs from the recipient's, and Claude Desktop declares no peer approval dialog, so the message would expire unapproved. Report this to the user: they can run that task in the ${sender.mode} class, change this Codex task's permissions so its class matches (a Codex task attests bypass only with Full access and approval policy never), or set crossSessionInbound to accept in the recipient session's own settings. Do not change the attested sender class or recipient settings yourself.`);
}
