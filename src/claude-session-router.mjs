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

export async function recoverClaudeDesktopSession(args, { listTasks, listSessions, beforeInspect }) {
  try { return { session: resolveClaudeDesktopSession(args) }; }
  catch (error) {
    if (error.preflight?.code !== "CLAUDE_SESSION_NOT_FOUND" || args.target !== "auto" || !args.expectedTaskId) throw error;
  }
  const assertTask = async () => {
    await beforeInspect();
    const tasks = await listTasks();
    if (!Array.isArray(tasks) || tasks.length > 8192) throw preflightFailure("CLAUDE_DESKTOP_TASK_UNVERIFIED", "Saved Desktop tasks cannot be verified.");
    const matches = tasks.filter((task) => task.taskId === args.expectedTaskId);
    if (matches.length !== 1 || matches[0].fileTaskId !== matches[0].taskId || matches[0].isArchived !== false) {
      throw preflightFailure("CLAUDE_DESKTOP_TASK_UNVERIFIED", "The exact saved Desktop task is missing, archived, or ambiguous; no replacement was opened.");
    }
    assertCwd(matches[0], args.expectedCwd);
    return matches[0];
  };
  const task = await assertTask();
  const sessions = await listSessions();
  await assertTask();
  try { return { session: resolveClaudeDesktopSession({ ...args, sessions }) }; }
  catch (error) { if (error.preflight?.code !== "CLAUDE_SESSION_NOT_FOUND") throw error; }
  throw Object.assign(preflightFailure("CLAUDE_SESSION_NOT_READY", "The exact saved Claude Desktop task has no live native Code endpoint. Background delivery requires that endpoint; this bridge has no supported silent cold-start API. No app or chat was opened. Inspect claude_bridge_status and report this diagnostic; do not create or open a chat to load the relay."), { taskId: task.taskId, phase: "recipient_discovery" });
}

export function sameClaudeDesktopRecipient(selected, current) {
  return Boolean(
    selected && current &&
    selected.pid === current.pid &&
    typeof selected.sessionId === "string" && selected.sessionId.length > 0 &&
    selected.sessionId === current.sessionId &&
    typeof selected.socket === "string" && selected.socket.length > 0 &&
    selected.socket === current.socket &&
    typeof selected.processStart === "string" && selected.processStart.length > 0 &&
    selected.processStart === current.processStart
  );
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
    if (!matches.length) {
      throw preflightFailure("CLAUDE_SESSION_NOT_FOUND", "No live Claude Desktop session matches the exact target. Reinspect the existing task and use its current sessionId or pid.");
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
    throw preflightFailure("CLAUDE_SESSION_NOT_FOUND", "No live Claude Desktop session matches the current account and intended project/task. Inspect list_claude_sessions and claude_bridge_status; do not open or create a chat to load the relay.");
  }
  return candidates[0];
}
