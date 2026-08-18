import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { CodexAppServerClient } from "../src/app-server-client.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PORT = Number(process.env.APPROVAL_TEST_PORT ?? 8799);

/**
 * Every request the app-server can send to a client, with the response field
 * its schema requires. Sourced from `codex app-server generate-json-schema`
 * (ServerRequest.json), identical in codex-cli 0.147 and 0.148.
 */
const SERVER_REQUESTS = [
  { method: "item/commandExecution/requestApproval", params: { command: ["ls"] }, expect: "decision" },
  { method: "item/fileChange/requestApproval", params: { changes: [] }, expect: "decision" },
  { method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } }, expect: "permissions" },
  { method: "item/tool/requestUserInput", params: {}, expect: "answers" },
  { method: "mcpServer/elicitation/request", params: {}, expect: "action" },
  { method: "item/tool/call", params: { name: "x" }, expect: "success" },
  { method: "execCommandApproval", params: { command: ["ls"] }, expect: "decision" },
  { method: "applyPatchApproval", params: {}, expect: "decision" },
  { method: "attestation/generate", params: {}, expect: "error" },
  { method: "account/chatgptAuthTokens/refresh", params: {}, expect: "error" },
];

function encodeFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])]);
  return Buffer.concat([header, payload]);
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    if ((buffer[offset] & 0x0f) === 0x01) messages.push(payload.toString("utf8"));
    offset = cursor + length;
  }
  return { messages, rest: buffer.subarray(offset) };
}

const received = [];
let socket = null;

const http = createServer((req, res) => {
  if (req.url === "/readyz") return res.writeHead(200).end("ok");
  res.writeHead(404).end();
});

http.on("upgrade", (req, sock) => {
  const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + WS_GUID).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket = sock;
  let buffered = Buffer.alloc(0);
  sock.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const { messages, rest } = decodeFrames(buffered);
    buffered = rest;
    for (const raw of messages) {
      const msg = JSON.parse(raw);
      if (msg.method === "initialize") {
        sock.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { codexHome: "/fake" } })));
      } else if (msg.id !== undefined && msg.method === undefined) {
        received.push(msg);
      }
    }
  });
});

await new Promise((resolve) => http.listen(PORT, "127.0.0.1", resolve));

const client = new CodexAppServerClient({
  url: `ws://127.0.0.1:${PORT}`,
  autoStart: false,
  log: () => {},
});
await client.connect();

let nextId = 1000;
const failures = [];
for (const testCase of SERVER_REQUESTS) {
  const id = nextId++;
  socket.write(encodeFrame(JSON.stringify({ jsonrpc: "2.0", id, method: testCase.method, params: testCase.params })));
  const deadline = Date.now() + 3000;
  let answer = null;
  while (Date.now() < deadline && !answer) {
    await new Promise((r) => globalThis.setTimeout(r, 25));
    answer = received.find((m) => m.id === id);
  }
  if (!answer) {
    failures.push(`${testCase.method}: NO REPLY (this is what stalls a turn mid-run)`);
    console.log(`  FAIL  ${testCase.method} -> no reply`);
    continue;
  }
  const isError = answer.error !== undefined;
  if (testCase.expect === "error") {
    if (!isError) failures.push(`${testCase.method}: expected a refusal, got a result`);
    console.log(`  ${isError ? "ok  " : "FAIL"}  ${testCase.method} -> refused (correct: bridge cannot serve it)`);
    continue;
  }
  if (isError) {
    failures.push(`${testCase.method}: answered with JSON-RPC error ${answer.error.code} instead of ${testCase.expect}`);
    console.log(`  FAIL  ${testCase.method} -> error ${answer.error.code}: ${answer.error.message}`);
    continue;
  }
  if (!(testCase.expect in (answer.result ?? {}))) {
    failures.push(`${testCase.method}: result missing required field "${testCase.expect}"`);
    console.log(`  FAIL  ${testCase.method} -> result ${JSON.stringify(answer.result)}`);
    continue;
  }
  console.log(`  ok    ${testCase.method} -> ${JSON.stringify(answer.result).slice(0, 70)}`);
}

client.ws?.close();
http.close();

console.log("");
if (failures.length) {
  console.log(`FAIL: ${failures.length}/${SERVER_REQUESTS.length} server requests mishandled`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: all ${SERVER_REQUESTS.length} server requests answered with the shape their schema requires`);
process.exit(0);
