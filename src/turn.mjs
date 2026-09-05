const TERMINAL_STATUSES = new Set(["completed", "interrupted", "failed"]);

function summarizeItem(item) {
  switch (item?.type) {
    case "agentMessage":
      return { kind: "agentMessage", text: item.text ?? "" };
    case "commandExecution":
      return {
        kind: "command",
        command: item.command ?? item.parsedCmd ?? null,
        exitCode: item.exitCode ?? null,
        status: item.status ?? null,
      };
    case "fileChange":
      return {
        kind: "fileChange",
        files: (item.changes ?? []).map((c) => c.path ?? c.file ?? null).filter(Boolean),
        status: item.status ?? null,
      };
    case "mcpToolCall":
      return { kind: "mcpToolCall", server: item.server ?? null, tool: item.tool ?? null };
    case "webSearch":
      return { kind: "webSearch", query: item.query ?? null };
    default:
      return null;
  }
}

/**
 * Send one user turn into an existing Codex thread and wait for it to finish.
 * Returns the agent text plus a compact activity trail.
 */
export async function runTurn(client, { threadId, input, timeoutMs = 240000, turnOverrides = {} }) {
  const messages = [];
  const activity = [];
  const errors = [];
  const buffered = [];
  let turnId = null;
  let settled = false;
  let resolveDone;

  /**
   * Only ever resolved, never rejected. `done` has exactly one consumer, and it
   * sits after `turn/start` has already returned - so rejecting it from the
   * catch below would reject a promise nobody is awaiting, which Node turns
   * into an unhandledRejection and, by default, into process exit. A failing
   * `turn/start` (a thread locked by the desktop app is the everyday case) used
   * to take the whole MCP server down that way, while the tool handler was
   * still busy formatting a tidy error message for a client that no longer had
   * a server to talk to.
   */
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const process = (msg) => {
    if (settled) return;
    const params = msg.params ?? {};
    if (turnId && params.turnId && params.turnId !== turnId) return;

    switch (msg.method) {
      case "thread/closed": {
        settled = true;
        resolveDone({ status: "disconnected", error: { message: "The thread closed before its turn completed" } });
        return;
      }
      case "item/completed": {
        const summary = summarizeItem(params.item);
        if (!summary) return;
        if (summary.kind === "agentMessage") {
          if (summary.text.trim()) messages.push(summary.text);
        } else {
          activity.push(summary);
        }
        return;
      }
      case "error": {
        errors.push(params.error ?? { message: "unknown error" });
        if (!params.willRetry && !settled) {
          settled = true;
          resolveDone({ status: "failed", error: params.error ?? null });
        }
        return;
      }
      case "turn/completed": {
        const turn = params.turn ?? {};
        if (turnId && turn.id && turn.id !== turnId) return;
        if (!TERMINAL_STATUSES.has(turn.status)) return;
        if (settled) return;
        settled = true;
        resolveDone({ status: turn.status, error: turn.error ?? null, durationMs: turn.durationMs ?? null });
        return;
      }
      default:
    }
  };

  const unsubscribe = client.subscribe(threadId, (msg) => {
    if (!turnId && msg.method !== "thread/closed") {
      buffered.push(msg);
      return;
    }
    process(msg);
  });

  const timer = globalThis.setTimeout(() => {
    if (settled) return;
    settled = true;
    resolveDone({ status: "timeout", error: null });
  }, timeoutMs);

  const unsubscribeDisconnect = client.subscribeDisconnect(() => {
    if (settled) return;
    settled = true;
    resolveDone({
      status: "disconnected",
      error: { message: "the app-server connection dropped while the turn was running" },
    });
  });

  try {
    const start = await Promise.race([
      client.request(
        "turn/start",
        { ...turnOverrides, threadId, input },
        { timeoutMs: Math.min(timeoutMs, 60000) },
      ).then((started) => ({ started }), (error) => ({ error })),
      done.then((outcome) => ({ outcome })),
    ]);
    if (start.error) throw start.error;
    let outcome = start.outcome;
    if (!outcome) {
      turnId = start.started?.turn?.id ?? null;
      if (typeof turnId !== "string" || !turnId.trim()) {
        throw new Error("Codex app-server did not return a turn id for turn/start");
      }
      for (const msg of buffered.splice(0)) process(msg);
      if (TERMINAL_STATUSES.has(start.started?.turn?.status)) {
        process({ method: "turn/completed", params: { turn: start.started.turn } });
      }
      outcome = await done;
    }
    return {
      threadId,
      turnId,
      status: outcome.status,
      error: outcome.error,
      durationMs: outcome.durationMs ?? null,
      text: messages.join("\n\n").trim(),
      activity,
      errors,
    };
  } finally {
    globalThis.clearTimeout(timer);
    unsubscribe();
    unsubscribeDisconnect();
  }
}
