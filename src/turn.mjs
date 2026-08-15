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
  let rejectDone;

  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const process = (msg) => {
    const params = msg.params ?? {};
    if (turnId && params.turnId && params.turnId !== turnId) return;

    switch (msg.method) {
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
    if (!turnId) {
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

  try {
    const started = await client.request(
      "turn/start",
      { threadId, input, ...turnOverrides },
      { timeoutMs: Math.min(timeoutMs, 60000) },
    );
    turnId = started?.turn?.id ?? null;
    for (const msg of buffered.splice(0)) process(msg);

    const outcome = await done;
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
  } catch (err) {
    rejectDone?.(err);
    throw err;
  } finally {
    globalThis.clearTimeout(timer);
    unsubscribe();
  }
}
