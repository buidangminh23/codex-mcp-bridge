import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { startFakeAppServer } from "./fake-app-server.mjs";

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

const server = await startFakeAppServer({ port: PORT });

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
  server.send({ jsonrpc: "2.0", id, method: testCase.method, params: testCase.params });
  const deadline = Date.now() + 3000;
  let answer = null;
  while (Date.now() < deadline && !answer) {
    await new Promise((r) => globalThis.setTimeout(r, 25));
    answer = server.replies.find((m) => m.id === id);
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
await server.close();

console.log("");
if (failures.length) {
  console.log(`FAIL: ${failures.length}/${SERVER_REQUESTS.length} server requests mishandled`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASS: all ${SERVER_REQUESTS.length} server requests answered with the shape their schema requires`);
process.exit(0);
