import assert from "node:assert/strict";
import { it } from "node:test";

import { assertRecipientClass, preflightFailure, bridgeDiagnostic, withBridgeDiagnostic } from "../src/recipient-preflight.mjs";

const desktop = (permissionMode, permissionClass) => ({ status: "matched", title: "Exact task", permissionMode, permissionClass });
const sender = (mode) => ({ status: "verified", mode });
const code = (fn) => { try { fn(); return null; } catch (error) { return error.preflight ?? error; } };

it("reports exact bridge and transport codes with safe correlation identifiers", () => {
  const cause = Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });
  const error = Object.assign(new Error("Native relay is unavailable", { cause }), { code: "RELAY_UNREACHABLE", sent: false });
  const requestId = "94fcf128-7244-4dba-a046-0941c1bc05fa";
  const result = withBridgeDiagnostic({ isError: true, content: [] }, error, { component: "codex-bridge", operation: "send_to_codex_thread", requestId });
  const diagnostic = result.structuredContent.diagnostic;
  assert.equal(diagnostic.code, "RELAY_UNREACHABLE");
  assert.deepEqual(diagnostic.causeCodes, ["ECONNREFUSED"]);
  assert.equal(diagnostic.sent, false);
  assert.equal(diagnostic.deliveryState, "not_sent");
  assert.equal(diagnostic.ids.requestId, requestId);
  assert.match(result.content[0].text, /RELAY_UNREACHABLE.*codex-bridge/);
  assert.match(result.content[0].text, /ECONNREFUSED/);
  assert.match(result.content[0].text, /Do not open or create chats/);
});

it("keeps uncertain delivery and the original report stable across receipt reads", () => {
  const diagnostic = bridgeDiagnostic(Object.assign(new Error("Disconnected after write"), { code: "RELAY_DISCONNECTED", deliveryUncertain: true }), { component: "codex-bridge" });
  assert.equal(diagnostic.deliveryState, "unknown");
  assert.equal(diagnostic.sent, null);
  assert.equal(diagnostic.retrySafe, false);
  const result = withBridgeDiagnostic({ content: [], structuredContent: { diagnostic } }, null, { operation: "read_agent_delivery", readOnly: true });
  assert.equal(result.structuredContent.diagnostic.reportId, diagnostic.reportId);
  assert.equal(result.structuredContent.diagnostic.timestamp, diagnostic.timestamp);
  assert.equal(result.structuredContent.diagnostic.deliveryState, "unknown");
  const repeated = withBridgeDiagnostic(result, null);
  assert.equal(repeated.content.length, 1);
  assert.equal(repeated.structuredContent.diagnostic.reportId, diagnostic.reportId);
  assert.equal(bridgeDiagnostic(new Error("Unexpected error")).deliveryState, "unknown");
});

it("redacts credentials, account addresses and private paths from report blocks", () => {
  const error = new Error('Failed https://user:secret@example.invalid/request?token=fixture-url-secret; Authorization: Bearer fixture-bearer; token=fixture-token; user@example.invalid; "C:\\Users\\Fixture Person\\private\\data.json"; /tmp/fixture/private/file');
  const diagnostic = bridgeDiagnostic(error, { requestId: "not-a-valid-id", prompt: "private prompt", token: "private token" });
  const text = JSON.stringify(diagnostic);
  for (const value of ["fixture-url-secret", "fixture-bearer", "fixture-token", "Fixture Person", "user@example.invalid", "/tmp/fixture", "private prompt", "private token"]) assert.equal(text.includes(value), false, value);
  assert.deepEqual(diagnostic.ids, {});
});

it("bounds malformed and cyclic error causes and does not mistake diagnostics for sends", () => {
  const error = Object.assign(new Error("Read failed"), { code: "READ_FAILED" });
  error.cause = error;
  const diagnostic = bridgeDiagnostic(error, { readOnly: true });
  assert.equal(diagnostic.deliveryState, "not_applicable");
  assert.equal(diagnostic.sent, null);
  assert.deepEqual(diagnostic.causeCodes, []);
  assert.doesNotThrow(() => bridgeDiagnostic({ diagnostic: { ...diagnostic, causeCodes: "malformed" } }));
});

it("retains safe sender identity stage and cause codes without copying metadata", () => {
  const error = Object.assign(new Error("Sender verification failed"), { code: "CLAUDE_SENDER_CONTEXT_UNVERIFIED", sent: false, diagnostic: { stage: "task_metadata", code: "METADATA_CHANGED", account: "private account" } });
  const result = bridgeDiagnostic(error);
  assert.equal(result.code, "CLAUDE_SENDER_CONTEXT_UNVERIFIED");
  assert.equal(result.phase, "task_metadata");
  assert.deepEqual(result.causeCodes, ["METADATA_CHANGED"]);
  assert.equal(JSON.stringify(result).includes("private account"), false);
});

it("omits native response bodies from shareable error reasons", () => {
  const result = bridgeDiagnostic(new Error('Creation uncertain: {"prompt":"private request","reply":"private reply"}'));
  assert.equal(JSON.stringify(result).includes("private request"), false);
  assert.equal(JSON.stringify(result).includes("private reply"), false);
  assert.match(result.reason, /structured details omitted/);
});

it("shapes a preflight failure as a blocked, unsent receipt", () => {
  const error = preflightFailure("X", "Why.");
  assert.equal(error.message, "Why. No message was sent.");
  assert.deepEqual(error.preflight, { status: "blocked", code: "X", reason: "Why.", sent: false });
});

it("lets an unverified sender, an unknown recipient class and a matching class through", () => {
  assert.equal(code(() => assertRecipientClass({ desktop: desktop("acceptEdits", "prompting") }, null)), null);
  assert.equal(code(() => assertRecipientClass({ desktop: desktop(null, null) }, sender("bypass"))), null);
  assert.equal(code(() => assertRecipientClass({ desktop: desktop("plan", null) }, sender("prompting"))), null);
  assert.equal(code(() => assertRecipientClass({ desktop: desktop("bypassPermissions", "bypass") }, sender("bypass"))), null);
  assert.equal(code(() => assertRecipientClass({ desktop: desktop("default", "prompting"), inbound: { value: null, source: null } }, sender("prompting"))), null);
});

it("refuses a class mismatch under the parity default and names both classes and the user's remedies", () => {
  for (const [mode, klass, attested] of [["acceptEdits", "prompting", "bypass"], ["bypassPermissions", "bypass", "prompting"]]) {
    const result = code(() => assertRecipientClass({ desktop: desktop(mode, klass), inbound: { value: null, source: null } }, sender(attested)));
    assert.equal(result.code, "CLAUDE_RECIPIENT_CLASS_MISMATCH");
    assert.equal(result.sent, false);
    assert.match(result.reason, new RegExp(`${mode} \\(${klass} class\\)`));
    assert.match(result.reason, new RegExp(`attests ${attested}`));
    assert.match(result.reason, /approval policy/);
    assert.match(result.reason, /crossSessionInbound to accept/);
    assert.match(result.reason, /no peer approval dialog/);
  }
});

it("honours an explicit inbound policy before the class comparison", () => {
  assert.equal(code(() => assertRecipientClass({ desktop: desktop("acceptEdits", "prompting"), inbound: { value: "accept", source: "user" } }, sender("bypass"))), null);
  for (const value of ["hold", "refuse"]) {
    const result = code(() => assertRecipientClass({ desktop: desktop("bypassPermissions", "bypass"), inbound: { value, source: "project" } }, sender("bypass")));
    assert.equal(result.code, "CLAUDE_RECIPIENT_INBOUND_POLICY");
    assert.match(result.reason, new RegExp(`project settings set crossSessionInbound to ${value}`));
    assert.match(result.reason, value === "hold" ? /no peer approval dialog/ : /drop this message/);
  }
});
