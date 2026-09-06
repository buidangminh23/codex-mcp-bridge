export function preflightFailure(code, reason) {
  const error = new Error(`${reason} No message was sent.`);
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
  throw preflightFailure("CLAUDE_RECIPIENT_CLASS_MISMATCH", `The Claude Desktop task "${session.desktop.title}" runs in ${session.desktop.permissionMode} (${recipient} class) while this sender attests ${sender.mode}. With no explicit crossSessionInbound setting, Claude holds a cross-session message whose sender class differs from the recipient's, and Claude Desktop declares no peer approval dialog, so the message would expire unapproved. Report this to the user: they can run that task in the ${sender.mode} class, change this Codex task's approval policy so its class matches, or set crossSessionInbound to accept in the recipient session's own settings. Do not change the attested sender class or recipient settings yourself.`);
}
