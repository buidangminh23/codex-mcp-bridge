import net from "node:net";

export const RELAY_WAKE_WAIT_MS = 20000;

export function relayWakeEnabled(env = process.env, platform = process.platform) {
  const value = (env.CODEX_BRIDGE_RELAY_WAKE ?? "").toLowerCase();
  if (["0", "off", "false"].includes(value)) return false;
  return platform === "darwin" || platform === "win32";
}

export function endpointAnswers(socketPath, { timeoutMs = 1000 } = {}) {
  if (typeof socketPath !== "string" || !socketPath) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = net.connect({ path: socketPath });
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      probe.destroy();
      resolve(answer);
    };
    const timer = globalThis.setTimeout(() => done(false), timeoutMs);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.once("close", () => done(false));
  });
}

export function createRelayWake({
  env = process.env,
  enabled = relayWakeEnabled(env),
  answers = endpointAnswers,
  waitMs = RELAY_WAKE_WAIT_MS,
  pollMs = 250,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)),
  log = () => {},
} = {}) {
  return async ({ socketPath, deadline }) => {
    if (!enabled || typeof socketPath !== "string" || !socketPath) return null;
    const until = Math.min(now() + waitMs, deadline ?? Infinity);
    while (now() < until) {
      if (await answers(socketPath, { timeoutMs: Math.min(1000, until - now()) })) {
        if (now() >= until) return null;
        log("relay transport available; the original operation will verify native dispatch");
        return { threadId: null };
      }
      const remaining = until - now();
      if (remaining > 0) await sleep(Math.min(pollMs, remaining));
    }
    log("native relay recovery timed out; no task or window was opened");
    return null;
  };
}
