import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";
import { readCodexAccountContext } from "../src/codex-account-context.mjs";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-test-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

function token(claims) {
  return [Buffer.from(JSON.stringify({ alg: "test" })).toString("base64url"), Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(directory, "case-"));
  const source = path.join(root, "auth.json");
  const config = path.join(root, "config.toml");
  const read = () => readCodexAccountContext({ root, env: {} });
  const write = (accountId = "account-a", userId = "user-a", extra = {}) => fs.writeFileSync(source, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: accountId, id_token: token({ sub: userId, "https://api.openai.com/auth": { chatgpt_account_id: accountId }, email: "private@example.test" }), access_token: "private-access", refresh_token: "private-refresh", ...extra }, last_refresh: new Date().toISOString() }));
  write();
  return { root, source, config, read, write };
}

it("re-resolves repeated account switches without retaining an earlier identity", () => {
  const f = fixture();
  const first = f.read();
  assert.equal(first.status, "verified");
  assert.equal(first.provider, "codex");
  assert.equal(first.accountId, "account-a");
  assert.equal(first.userId, "user-a");
  assert.equal(first.source, f.source);
  f.write("account-b", "user-b");
  const second = f.read();
  assert.notEqual(second.fingerprint, first.fingerprint);
  f.write();
  assert.equal(f.read().fingerprint, first.fingerprint);
});

it("distinguishes users within one organization and prefers the ChatGPT user identity", () => {
  const f = fixture();
  const first = f.read();
  f.write("account-a", "user-b");
  assert.notEqual(f.read().fingerprint, first.fingerprint);
  f.write("account-a", "unused", { id_token: token({ sub: "login-provider-subject", "https://api.openai.com/auth": { chatgpt_user_id: "user-a", chatgpt_account_id: "account-a" } }) });
  assert.equal(f.read().fingerprint, first.fingerprint);
});

it("keeps identity stable across token refresh and never returns credentials or email", () => {
  const f = fixture();
  const first = f.read();
  f.write("account-a", "user-a", { access_token: "new-private-access", refresh_token: "new-private-refresh", id_token: token({ sub: "user-a", iat: Date.now(), email: "changed@example.test" }) });
  const next = f.read();
  assert.equal(next.fingerprint, first.fingerprint);
  assert.doesNotMatch(JSON.stringify(next), /private|example\.test|id_token|access_token|refresh_token/);
});

it("fails closed after logout and recovers after the next login", () => {
  const f = fixture();
  fs.unlinkSync(f.source);
  assert.equal(f.read().status, "signed_out");
  assert.equal(f.read().fingerprint, null);
  f.write("account-b", "user-b");
  assert.equal(f.read().accountId, "account-b");
});

it("treats partial and malformed writes as unavailable and retries on the next call", () => {
  const f = fixture();
  for (const text of ["", "{", '{"auth_mode":"chatgpt","tokens":', "null", "[]"]) {
    fs.writeFileSync(f.source, text);
    const state = f.read();
    assert.equal(state.status, "unavailable");
    assert.equal(state.accountId, null);
    assert.equal(state.userId, null);
    assert.equal(state.fingerprint, null);
  }
  f.write();
  assert.equal(f.read().status, "verified");
});

it("rejects an account file that changes during the bounded read", (context) => {
  const f = fixture();
  const original = fs.readSync;
  let changed = false;
  const read = context.mock.method(fs, "readSync", (...args) => {
    const count = original(...args);
    if (!changed) {
      changed = true;
      f.write("different-account", "different-user");
      fs.utimesSync(f.source, new Date(), new Date(Date.now() + 1000));
    }
    return count;
  });
  const state = f.read();
  assert.equal(state.status, "unavailable");
  assert.match(state.reason, /changed while reading/);
  read.mock.restore();
  assert.equal(f.read().accountId, "different-account");
});

it("rejects same-size account changes even when file metadata remains unchanged", (context) => {
  const f = fixture();
  const metadata = fs.lstatSync(f.source);
  const originalRead = fs.readSync;
  const originalLstat = fs.lstatSync;
  let changed = false;
  context.mock.method(fs, "fstatSync", () => metadata);
  context.mock.method(fs, "lstatSync", (file, ...args) => file === f.source ? metadata : originalLstat(file, ...args));
  context.mock.method(fs, "readSync", (...args) => {
    const count = originalRead(...args);
    if (!changed) {
      changed = true;
      f.write("account-b", "user-b");
      assert.equal(fs.statSync(f.source).size, metadata.size);
    }
    return count;
  });
  const state = f.read();
  assert.equal(state.status, "unavailable");
  assert.equal(state.fingerprint, null);
  assert.match(state.reason, /changed during identity verification/);
  context.mock.restoreAll();
  assert.equal(f.read().accountId, "account-b");
});

it("requires both stable account and user IDs without guessing from other fields", () => {
  const f = fixture();
  for (const extra of [{ account_id: "" }, { account_id: { id: "account-a" } }, { id_token: undefined }, { id_token: "not-a-token" }, { id_token: token({ email: "private@example.test" }) }, { id_token: token({ sub: 123 }) }, { id_token: token({ sub: "user\ninvalid" }) }]) {
    f.write("account-a", "user-a", extra);
    assert.equal(f.read().status, "unavailable");
  }
});

it("rejects conflicting account and user identity records", () => {
  const f = fixture();
  f.write("account-a", "user-a", { id_token: token({ sub: "user-a", "https://api.openai.com/auth": { chatgpt_account_id: "account-b" } }) });
  assert.equal(f.read().status, "unavailable");
  assert.match(f.read().reason, /disagree/);
});

it("rejects non-file credential modes including profiles and inline settings", () => {
  const f = fixture();
  for (const config of ['cli_auth_credentials_store = "keyring"', "cli_auth_credentials_store = 'auto'", 'cli_auth_credentials_store = "ephemeral"', '[profiles.test]\ncli_auth_credentials_store = "keyring"', 'profiles.test = { cli_auth_credentials_store = "auto" }', '"cli_auth_credentials_store" = "keyring"', 'cli_auth_credentials_store = "unfinished']) {
    fs.writeFileSync(f.config, config);
    assert.equal(f.read().status, "unavailable", config);
  }
  fs.writeFileSync(f.config, '# cli_auth_credentials_store = "keyring"\ncli_auth_credentials_store = "file" # explicit local storage\n');
  assert.equal(f.read().status, "verified");
});

it("rejects external tokens and other authentication modes", () => {
  const f = fixture();
  for (const mode of ["chatgptAuthTokens", "apikey", "apiKey", "agent_identity", null]) {
    const auth = JSON.parse(fs.readFileSync(f.source, "utf8"));
    auth.auth_mode = mode;
    fs.writeFileSync(f.source, JSON.stringify(auth));
    assert.equal(f.read().status, "unavailable");
  }
});

it("rejects non-regular and oversized evidence without reading beyond its limits", () => {
  const f = fixture();
  fs.unlinkSync(f.source);
  fs.mkdirSync(f.source);
  assert.equal(f.read().status, "unavailable");
  fs.rmdirSync(f.source);
  fs.writeFileSync(f.source, "x".repeat(1024 * 1024 + 1));
  assert.equal(f.read().status, "unavailable");
  f.write();
  fs.mkdirSync(f.config);
  assert.equal(f.read().status, "unavailable");
});

it("uses the configured Codex home and rejects relative roots", () => {
  const f = fixture();
  assert.equal(readCodexAccountContext({ env: { CODEX_HOME: f.root } }).fingerprint, f.read().fingerprint);
  assert.equal(readCodexAccountContext({ root: "relative", env: {} }).status, "unavailable");
});
