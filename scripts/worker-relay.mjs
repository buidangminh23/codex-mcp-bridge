#!/usr/bin/env node
import fs from "node:fs";
import { callBackgroundRelay } from "../src/background-relay-client.mjs";
import { withBridgeDiagnostic } from "../src/recipient-preflight.mjs";
import { relayFailure, RELAY_UUID } from "../src/background-relay-config.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";

exitForVersionRequest(import.meta.url);
const args = process.argv.slice(2);
const action = args.shift() ?? "status";
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
try {
  let result;
  if (action === "status" || action === "list") result = await callBackgroundRelay(action);
  else if (action === "read") result = await callBackgroundRelay("read", { requestId: option("--request-id"), waitSec: Number(option("--wait") ?? 0) }, { timeoutMs: (Number(option("--wait") ?? 0) + 10) * 1000 });
  else if (action === "send") {
    if (!args.includes("--stdin") || !RELAY_UUID.test(option("--request-id") ?? "")) throw relayFailure("WORKER_REQUEST_INVALID", "Use --stdin and a persistent --request-id UUID so uncertain deliveries can be inspected safely");
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536);
      const count = fs.readSync(0, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > 256 * 1024) throw relayFailure("WORKER_REQUEST_TOO_LARGE", "The authorized prompt exceeds the worker input limit");
      chunks.push(buffer.subarray(0, count));
    }
    const prompt = Buffer.concat(chunks).toString("utf8");
    result = await callBackgroundRelay("send", { agent: option("--agent"), cwd: option("--cwd"), requestId: option("--request-id"), prompt });
  } else if (action === "--help" || action === "help") {
    process.stdout.write("worker-relay status | list | send --agent <codex|claude|antigravity> --cwd <project> --request-id <uuid> --stdin | read --request-id <uuid> [--wait <0-60>]\n");
  } else throw relayFailure("WORKER_COMMAND_INVALID", "Unknown worker relay command");
  if (result) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "failed" || result.status === "unknown") process.exitCode = 1;
  }
} catch (error) {
  const result = withBridgeDiagnostic({ isError: true, content: [] }, error, { component: "worker-relay-cli", operation: action, requestId: option("--request-id") });
  process.stderr.write(result.content.map(item => item.text ?? "").join("\n") + "\n");
  process.exitCode = 1;
}
