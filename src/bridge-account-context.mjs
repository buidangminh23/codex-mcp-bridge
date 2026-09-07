import { readClaudeAccountContext } from "./desktop-account-context.mjs";
import { readCodexAccountContext } from "./codex-account-context.mjs";
import { preflightFailure } from "./recipient-preflight.mjs";
import { assertClaudeSessionProcess, listClaudeSessions } from "./peer-protocol.mjs";
import { readClaudeDesktopContext } from "./claude-desktop-context.mjs";

const unsolicitedAccountInspections = new WeakSet();
const MAX_SESSION_CANDIDATES = 8192;

export function readBridgeAccounts() {
  return { claude: readClaudeAccountContext(), codex: readCodexAccountContext() };
}

export function accountIdentity(accounts) {
  if (["claude", "codex"].some((provider) => accounts?.[provider]?.status !== "verified"
    || typeof accounts[provider].fingerprint !== "string" || !accounts[provider].fingerprint)) return null;
  return Object.freeze({ claude: accounts.claude.fingerprint, codex: accounts.codex.fingerprint });
}

export function sameAccountIdentity(expected, accounts) {
  const current = accountIdentity(accounts);
  return Boolean(expected?.claude && expected?.codex && current
    && expected.claude === current.claude && expected.codex === current.codex);
}

export function requireBridgeAccounts(accounts) {
  for (const provider of ["claude", "codex"]) {
    if (accounts?.[provider]?.status !== "verified" || typeof accounts[provider].fingerprint !== "string" || !accounts[provider].fingerprint) {
      throw preflightFailure("BRIDGE_ACCOUNT_UNVERIFIED", `${provider === "claude" ? "Claude" : "Codex"} account is ${accounts?.[provider]?.status ?? "unavailable"}: ${accounts?.[provider]?.reason ?? "No current account evidence"}. Finish signing in; the next call will discover the account again.`);
    }
  }
  return accountIdentity(accounts);
}

export function assertAccountIdentity(expected, accounts = readBridgeAccounts()) {
  if (!sameAccountIdentity(expected, accounts)) {
    const error = preflightFailure("BRIDGE_ACCOUNT_CHANGED", "The Claude or Codex account changed or signed out while this operation was pending. Its original destination was preserved; discover the current account before sending new work.");
    error.code = "BRIDGE_ACCOUNT_CHANGED";
    throw error;
  }
}

export function publicAccountState(account) {
  return { status: account?.status ?? "unavailable", fingerprint: account?.fingerprint ?? null, reason: account?.reason ?? "No account evidence" };
}

export function bindUnsolicitedClaudeMessageAccount(record, {
  readAccounts = readBridgeAccounts,
  listSessions = listClaudeSessions,
  assertProcess = assertClaudeSessionProcess,
  readContext = (session, account) => readClaudeDesktopContext(session, { account }),
  hasPendingSource = () => false,
} = {}) {
  if (!record || typeof record !== "object" || record.accountContext != null || record.inReplyTo != null
      || unsolicitedAccountInspections.has(record)) return false;
  unsolicitedAccountInspections.add(record);
  if (typeof record.fromSocket !== "string" || !record.fromSocket) return false;
  try {
    if (hasPendingSource(record.fromSocket)) return false;
    const accounts = readAccounts();
    const selected = accountIdentity(accounts);
    if (!selected) return false;
    const sessions = listSessions();
    if (!Array.isArray(sessions) || sessions.length > MAX_SESSION_CANDIDATES) return false;
    const matches = sessions.filter((session) => session?.alive === true && session.socket === record.fromSocket);
    if (matches.length !== 1 || matches[0].entrypoint !== "claude-desktop") return false;
    const session = matches[0];
    assertProcess(session);
    const context = readContext(session, accounts.claude);
    if (context?.status !== "matched" || context.accountFingerprint !== selected.claude) return false;
    if (!sameAccountIdentity(selected, readAccounts())) return false;
    record.accountContext = selected;
    return true;
  } catch {
    return false;
  }
}
