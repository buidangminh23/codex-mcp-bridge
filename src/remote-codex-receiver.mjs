import { forwardRemoteRequest } from "./remote-codex.mjs";

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 128 * 1024) throw new Error("Remote request exceeds its limit");
  chunks.push(chunk);
}
let request;
try {
  request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result = await forwardRemoteRequest(request);
  process.stdout.write(JSON.stringify({ version: 1, ok: true, action: request.action, requestId: request.requestId ?? null, result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ version: 1, ok: false, action: request?.action, requestId: request?.requestId ?? null, error: { code: error.code ?? "REMOTE_FAILED", message: error.message } }) + "\n");
}
