import net from "node:net";
import { readRelayConfiguration, relayFailure } from "./background-relay-config.mjs";
import { RELAY_FRAME_LIMIT, RELAY_REPLY_LIMIT, relayHello, validRelayHello, verifyRelayChallenge, relayOperation, verifyRelayResponse } from "./background-relay-protocol.mjs";

export function relayConnection(env = process.env) {
  if (env.AGENT_RELAY_TOKEN || env.AGENT_RELAY_WORKER_ID || env.AGENT_RELAY_ENDPOINT) {
    if (!env.AGENT_RELAY_TOKEN || !env.AGENT_RELAY_WORKER_ID || !env.AGENT_RELAY_ENDPOINT) throw relayFailure("WORKER_IDENTITY_INCOMPLETE", "The worker relay capability is incomplete");
    return { endpoint: env.AGENT_RELAY_ENDPOINT, token: env.AGENT_RELAY_TOKEN, workerId: env.AGENT_RELAY_WORKER_ID };
  }
  const config = readRelayConfiguration({ env, missing: true });
  if (!config) throw relayFailure("WORKER_RELAY_NOT_CONFIGURED", "Run the package update or setup command to configure the independent background relay");
  if (!config.enabled) throw relayFailure("WORKER_RELAY_DISABLED", "Background relay is intentionally disabled in its configuration");
  return { endpoint: config.endpoint, token: config.token, workerId: null };
}

export async function callBackgroundRelay(method, params = {}, { env = process.env, connection = relayConnection(env), timeoutMs = 10000, connect = net.createConnection } = {}) {
  const initial = relayHello(connection.workerId ?? null);
  if (!validRelayHello(initial) || typeof connection.token !== "string" || !connection.token || typeof connection.endpoint !== "string" || !connection.endpoint
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw relayFailure("WORKER_CONNECTION_INVALID", "Background relay connection options are invalid");
  const operation = JSON.parse(JSON.stringify({ schemaVersion: 1, id: initial.id, workerId: initial.workerId, clientPid: process.pid, method, params }));
  if (Buffer.byteLength(JSON.stringify(operation)) + 256 > RELAY_FRAME_LIMIT) throw relayFailure("WORKER_REQUEST_TOO_LARGE", "Background relay request is too large");
  return new Promise((resolve, reject) => {
    let socket;
    let sent = false;
    let complete = false;
    let attempts = 0;
    let retryTimer;
    const deadline = Date.now() + timeoutMs;
    const state = () => sent && method === "send" ? "unknown" : "not_sent";
    const failed = (code, message) => relayFailure(code, message, state(), "relay_transport");
    const finish = (error, result) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      socket?.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(failed("WORKER_RELAY_TIMEOUT", "The independent relay did not answer before the deadline")), timeoutMs);
    const attempt = () => {
      if (complete) return;
      if (Date.now() >= deadline) { finish(failed("WORKER_RELAY_TIMEOUT", "The independent relay did not answer before the deadline")); return; }
      attempts++;
      let current;
      let connected = false;
      let retired = false;
      let buffer = "";
      let challenge;
      const hello = relayHello(initial.workerId, initial.id);
      const disconnect = (error, code = "WORKER_RELAY_UNAVAILABLE") => {
        if (complete || retired) return;
        retired = true;
        current?.destroy();
        if (!connected && !sent && attempts < 3 && ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EBUSY"].includes(error?.code)) {
          retryTimer = setTimeout(attempt, attempts === 1 ? 100 : 250);
        } else finish(failed(code, "The independent relay connection ended before a verified receipt was received"));
      };
      try { current = socket = connect(connection.endpoint); }
      catch (error) { disconnect(error); return; }
      current.setEncoding("utf8");
      current.on("connect", () => {
        if (complete || retired) return;
        if (Date.now() >= deadline) { finish(failed("WORKER_RELAY_TIMEOUT", "The independent relay did not answer before the deadline")); return; }
        connected = true;
        try { current.write(JSON.stringify(hello) + "\n"); }
        catch (error) { disconnect(error); }
      });
      current.on("error", error => disconnect(error));
      current.on("close", () => disconnect(null, "WORKER_RELAY_INTERRUPTED"));
      current.on("data", data => {
        if (complete || retired) return;
        buffer += data;
        if (Buffer.byteLength(buffer) > (challenge ? RELAY_REPLY_LIMIT : 4096)) { finish(failed("WORKER_REPLY_TOO_LARGE", "The relay response exceeded its limit")); return; }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        if (buffer.slice(end + 1).length) { finish(failed("WORKER_REPLY_INVALID", "The relay sent multiple or trailing protocol frames")); return; }
        let message;
        try { message = JSON.parse(buffer.slice(0, end)); }
        catch { finish(failed("WORKER_REPLY_INVALID", "The relay response is not valid JSON")); return; }
        buffer = "";
        if (!challenge) {
          if (!verifyRelayChallenge(connection.token, hello, message)) { finish(failed("WORKER_RELAY_AUTH_FAILED", "The local endpoint could not prove its relay identity; no operation was sent")); return; }
          if (Date.now() >= deadline) { finish(failed("WORKER_RELAY_TIMEOUT", "The independent relay did not answer before the deadline")); return; }
          challenge = message;
          const wire = JSON.stringify(relayOperation(connection.token, hello, challenge, operation)) + "\n";
          sent = true;
          try { current.write(wire); } catch (error) { disconnect(error); }
          return;
        }
        if (!verifyRelayResponse(connection.token, hello, challenge, message)) { finish(failed("WORKER_REPLY_INVALID", "The relay response failed authentication or request correlation")); return; }
        const response = message.response;
        if (response.error) {
          const error = relayFailure(response.error.code ?? "WORKER_OPERATION_FAILED", response.error.message ?? "Background relay operation failed", response.error.deliveryState ?? "unknown", response.error.phase ?? "relay");
          if (response.error.diagnostic) error.diagnostic = response.error.diagnostic;
          finish(error);
        } else finish(null, response.result);
      });
    };
    attempt();
  });
}
