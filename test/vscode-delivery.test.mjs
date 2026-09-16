import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyClaudeDelivery, classifyCodexCompletion } from "../src/vscode-delivery.mjs";

test("Claude blocked receipts preserve identity and never report delivery success", () => {
  for (const status of ["held", "refused", "denied", "expired", "dropped"]) {
    const receipt = { msgId: "message", reply: null, delivery: { status, reason: "permission-mode parity" } };
    assert.throws(() => classifyClaudeDelivery(receipt, "bypass"), (error) => error.msgId === "message" && error.delivery === receipt.delivery && /do not resend/.test(error.message));
  }
});

test("a correlated reply takes precedence over an earlier held receipt", () => {
  assert.equal(classifyClaudeDelivery({ reply: { text: "hello" }, delivery: { status: "held" } }, "prompting").status, "reply_received");
  assert.equal(classifyClaudeDelivery({ reply: null }, "prompting").status, "sent_unconfirmed");
});

test("Codex usage-limit completion is a failure, not a completed reply", () => {
  const error = { codex_error_info: "usage_limit_exceeded" };
  assert.deepEqual(classifyCodexCompletion({ type: "task_complete", turn_id: "turn", last_agent_message: null, error }, "turn"), { status: "failed", turnId: "turn", error });
});

test("Codex replies are correlated and missing content remains unverified", () => {
  const lifecycle = { type: "task_complete", turn_id: "turn", last_agent_message: "hello" };
  assert.equal(classifyCodexCompletion(lifecycle, "other").status, "pending_or_unavailable");
  assert.equal(classifyCodexCompletion(lifecycle, "turn").text, "hello");
  assert.equal(classifyCodexCompletion({ ...lifecycle, last_agent_message: null }, "turn").status, "response_unavailable");
  assert.equal(classifyCodexCompletion({ type: "turn_aborted", turn_id: "turn" }, "turn").status, "interrupted");
});
