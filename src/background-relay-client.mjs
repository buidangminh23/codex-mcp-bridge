import net from "node:net";
import { randomUUID } from "node:crypto";
import { readRelayConfiguration, relayFailure } from "./background-relay-config.mjs";

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
  const requestId = randomUUID();
  const wire = JSON.stringify({ schemaVersion: 1, id: requestId, method, params, token: connection.token, workerId: connection.workerId, clientPid: process.pid }) + "\n";
  if (Buffer.byteLength(wire) > 1024 * 1024) throw relayFailure("WORKER_REQUEST_TOO_LARGE", "Background relay request is too large");
  return new Promise((resolve, reject) => {
    let socket;
    let sent = false;
    let complete = false;
    let buffer = "";
    const finish = (error, result) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket?.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(relayFailure("WORKER_RELAY_TIMEOUT", "The independent relay did not answer before the deadline", sent && method === "send" ? "unknown" : "not_sent", "relay_transport")), timeoutMs);
    try { socket = connect(connection.endpoint); }
    catch { finish(relayFailure("WORKER_RELAY_UNAVAILABLE", "The independent relay endpoint is unavailable", "not_sent", "relay_transport")); return; }
    socket.setEncoding("utf8");
    socket.on("connect", () => { sent = true; socket.write(wire); });
    socket.on("error", () => finish(relayFailure("WORKER_RELAY_UNAVAILABLE", "The independent relay connection failed", sent && method === "send" ? "unknown" : "not_sent", "relay_transport")));
    socket.on("close", () => { if (!complete) finish(relayFailure("WORKER_RELAY_INTERRUPTED", "The independent relay connection closed before a receipt was received", sent && method === "send" ? "unknown" : "not_sent", "relay_transport")); });
    socket.on("data", data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { finish(relayFailure("WORKER_REPLY_TOO_LARGE", "The relay response exceeded its limit", "unknown", "relay_transport")); return; }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); } catch { finish(relayFailure("WORKER_REPLY_INVALID", "The relay response is not valid JSON", "unknown", "relay_transport")); return; }
      if (message.id !== requestId || message.schemaVersion !== 1) { finish(relayFailure("WORKER_REPLY_INVALID", "The relay response does not match this request", "unknown", "relay_transport")); return; }
      if (message.error) {
        const error = relayFailure(message.error.code ?? "WORKER_OPERATION_FAILED", message.error.message ?? "Background relay operation failed", message.error.deliveryState ?? "unknown", message.error.phase ?? "relay");
        if (message.error.diagnostic) error.diagnostic = message.error.diagnostic;
        finish(error);
      } else finish(null, message.result);
    });
  });
}
