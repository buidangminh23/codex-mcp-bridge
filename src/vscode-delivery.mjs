const BLOCKED = new Set(["held", "refused", "denied", "expired", "dropped"]);

export function classifyClaudeDelivery(receipt, senderMode) {
  if (receipt.reply) return { ...receipt, status: "reply_received" };
  const status = receipt.delivery?.status ?? "sent_unconfirmed";
  if (BLOCKED.has(status)) {
    throw Object.assign(new Error(`Claude returned ${status}: ${receipt.delivery.reason ?? "the message was not delivered to the conversation"}. Sender permission class: ${senderMode}. This does not prove an approval control exists in the VS Code extension. Report the receipt to the user; do not resend, change permissions, or claim that the user can click an unverified approval button.`), { msgId: receipt.msgId, delivery: receipt.delivery });
  }
  return { ...receipt, status };
}

export function classifyCodexCompletion(lifecycle, turnId) {
  if (lifecycle?.turn_id !== turnId) return { status: "pending_or_unavailable", turnId };
  if (["turn_aborted", "task_aborted"].includes(lifecycle.type)) return { status: "interrupted", turnId };
  if (!["task_complete", "task_completed", "turn_complete", "turn_completed"].includes(lifecycle.type)) return { status: "pending_or_unavailable", turnId };
  if (lifecycle.error) return { status: "failed", turnId, error: lifecycle.error };
  if (typeof lifecycle.last_agent_message !== "string") return { status: "response_unavailable", turnId };
  return { status: "completed", turnId, text: lifecycle.last_agent_message };
}
