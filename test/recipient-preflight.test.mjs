import assert from "node:assert/strict";
import { it } from "node:test";

import { assertRecipientClass, preflightFailure } from "../src/recipient-preflight.mjs";

const desktop = (permissionMode, permissionClass) => ({ status: "matched", title: "Exact task", permissionMode, permissionClass });
const sender = (mode) => ({ status: "verified", mode });
const code = (fn) => { try { fn(); return null; } catch (error) { return error.preflight ?? error; } };

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
