import { assertClaudeSessionCwd } from "./peer-protocol.mjs";
import { preflightFailure } from "./recipient-preflight.mjs";

function assertCwd(session, expectedCwd) {
  try {
    assertClaudeSessionCwd(session, expectedCwd);
  } catch (error) {
    throw preflightFailure("CLAUDE_SESSION_CWD_MISMATCH", error.message.replace(/ No message was sent\.$/, ""));
  }
}

function taskMatches(session, expectedTaskId) {
  return expectedTaskId === undefined || session.desktop.taskId === expectedTaskId;
}

function uniqueLiveSessions(sessions) {
  const unique = new Map();
  for (const session of sessions) {
    if (!session?.alive) continue;
    const identity = JSON.stringify([session.pid, session.sessionId, session.socket, session.processStart, session.cwd, session.entrypoint, session.name, session.bridgeSessionId]);
    if (!unique.has(identity)) unique.set(identity, session);
  }
  return [...unique.values()];
}

export function resolveClaudeDesktopSession({ target, expectedCwd, expectedTaskId, sessions, account, readContext }) {
  if (account?.status !== "verified") {
    throw preflightFailure("CLAUDE_ACCOUNT_UNVERIFIED", account?.reason ?? "The current Claude Desktop account is not confirmed.");
  }
  assertCwd({ cwd: expectedCwd }, expectedCwd);
  const needle = typeof target === "string" || typeof target === "number" ? String(target).trim() : "";
  const automatic = needle === "auto";
  if (!needle) throw preflightFailure("CLAUDE_SESSION_NOT_FOUND", "Provide an exact Claude Desktop session identity or target auto.");
  const assertExpectedTaskId = () => {
    if ((!automatic && (typeof expectedTaskId !== "string" || !expectedTaskId.trim())) ||
        (expectedTaskId !== undefined && (typeof expectedTaskId !== "string" || !expectedTaskId.trim()))) {
      throw preflightFailure("CLAUDE_DESKTOP_TASK_MISMATCH", "Provide expectedTaskId from the intended native Desktop task after checking its title and cwd.");
    }
  };
  const live = uniqueLiveSessions(sessions ?? []);
  const contextualize = (session) => {
    let desktop;
    try {
      desktop = readContext(session, account);
    } catch {
      throw preflightFailure("CLAUDE_DESKTOP_TASK_UNVERIFIED", "The live session's current-account Desktop task could not be inspected consistently.");
    }
    return { ...session, desktop };
  };
  if (!automatic) {
    const byId = live.filter((session) => String(session.pid) === needle || session.sessionId === needle);
    const matches = byId.length ? byId : live.filter((session) => session.name === needle);
    if (matches.length > 1) {
      throw preflightFailure("CLAUDE_SESSION_AMBIGUOUS", "The exact target identifies multiple live sessions; use an unambiguous sessionId or pid.");
    }
    if (matches.length === 1) {
      const found = matches[0];
      if (found.entrypoint !== "claude-desktop") {
        throw preflightFailure("CLAUDE_DESKTOP_TASK_UNVERIFIED", "The exact target is not an existing Claude Desktop Code session.");
      }
      assertCwd(found, expectedCwd);
      assertExpectedTaskId();
      const session = contextualize(found);
      if (session.desktop?.status !== "matched") {
        throw preflightFailure("CLAUDE_DESKTOP_TASK_UNVERIFIED", session.desktop?.reason ?? "The exact live target does not belong to a verified task in the current Claude Desktop account.");
      }
      if (!taskMatches(session, expectedTaskId)) {
        throw preflightFailure("CLAUDE_DESKTOP_TASK_MISMATCH", "The exact live target belongs to a different native Claude Desktop task than expectedTaskId.");
      }
      return session;
    }
  }
  assertExpectedTaskId();
  const candidates = [];
  for (const candidate of live) {
    if (candidate.entrypoint !== "claude-desktop") continue;
    try {
      assertClaudeSessionCwd(candidate, expectedCwd);
    } catch {
      continue;
    }
    const session = contextualize(candidate);
    if (session.desktop?.status === "matched" && taskMatches(session, expectedTaskId)) candidates.push(session);
  }
  if (candidates.length > 1) {
    throw preflightFailure("CLAUDE_SESSION_AMBIGUOUS", "Multiple live Claude Desktop sessions match the current account and intended project/task; inspect the intended task and provide its exact identity.");
  }
  if (!candidates.length) {
    throw preflightFailure("CLAUDE_SESSION_NOT_FOUND", "No live Claude Desktop session matches the current account and intended project/task. Open or reconnect the existing task in Claude Desktop.");
  }
  return candidates[0];
}
