import { NativeDesktopRelay } from "./native-relay.mjs";
import { runTurn } from "./turn.mjs";

/**
 * Which backend puts a message into a Codex thread.
 *
 * There are two, and they are not interchangeable. The app-server path resumes
 * the thread through a second app-server, which takes the per-thread writer
 * lock - correct for a thread nobody else has open, and guaranteed to fail with
 * `thread <id> already has an active writer` for a thread Codex Desktop is
 * showing. The native path asks Codex Desktop's own app-server to deliver the
 * message, so the app stays the single writer and the thread stays open.
 *
 * Naming the choice here rather than branching inside the relay keeps
 * `claude-bridge` unaware of either mechanism: it asks for delivery and is told
 * which backend did it.
 */
export const NATIVE_BACKEND = "codex-desktop-native";
export const APP_SERVER_BACKEND = "app-server";

export function createThreadDelivery({
  codex,
  relay = new NativeDesktopRelay(),
  log = () => {},
  timeoutMs = 240000,
} = {}) {
  let reportedUnavailable = null;

  /**
   * Falling back is right when the companion never answered - an absent relay
   * says nothing about the target thread, and the older path is exactly as good
   * as it was before this backend existed. It is wrong once the companion has
   * answered: Codex has already refused, and retrying through a second
   * app-server only spawns a process that contends for the ~/.codex state and
   * then fails on the writer lock the native path exists to avoid.
   */
  async function deliver(threadId, text) {
    const status = relay.status();
    if (status.enabled) {
      try {
        const ack = await relay.sendMessage(threadId, text);
        reportedUnavailable = null;
        return { backend: NATIVE_BACKEND, threadId, ack };
      } catch (err) {
        if (err.reachedCompanion) throw err;
        log(`native relay unreachable (${err.message}); falling back to the app-server path`);
      }
    } else if (status.reason !== reportedUnavailable) {
      reportedUnavailable = status.reason;
      log(`native relay not in use: ${status.reason}`);
    }

    if (!codex) throw new Error("No Codex app-server client is configured to deliver this message");
    await codex.ensureThreadAttached(threadId);
    const turn = await runTurn(codex, {
      threadId,
      input: [{ type: "text", text }],
      timeoutMs,
    });
    return { backend: APP_SERVER_BACKEND, threadId, turn };
  }

  function describe() {
    const status = relay.status();
    return status.enabled
      ? `${NATIVE_BACKEND} via ${status.socketPath}`
      : `${APP_SERVER_BACKEND} (${status.reason})`;
  }

  return { deliver, describe };
}
