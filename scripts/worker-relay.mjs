#!/usr/bin/env node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { callBackgroundRelay } from "../src/background-relay-client.mjs";
import { withBridgeDiagnostic } from "../src/recipient-preflight.mjs";

const args = process.argv.slice(2);
const action = args.shift() ?? "status";
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
try {
  let result;
  if (action === "status" || action === "list") result = await callBackgroundRelay(action);
  else if (action === "read") result = await callBackgroundRelay("read", { requestId: option("--request-id"), waitSec: Number(option("--wait") ?? 0) }, { timeoutMs: (Number(option("--wait") ?? 0) + 10) * 1000 });
  else if (action === "send") {
    if (!args.includes("--stdin")) throw new Error("Use --stdin to provide the authorized prompt without putting it on the command line");
    const prompt = fs.readFileSync(0, "utf8");
    result = await callBackgroundRelay("send", { agent: option("--agent"), cwd: option("--cwd"), requestId: option("--request-id") ?? randomUUID(), prompt });
  } else if (action === "--help" || action === "help") {
    process.stdout.write("worker-relay status | list | send --agent <codex|claude|antigravity> --cwd <project> --request-id <uuid> --stdin | read --request-id <uuid> [--wait <0-60>]\n");
  } else throw new Error("Unknown worker relay command");
  if (result) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status === "failed" || result.status === "unknown") process.exitCode = 1;
  }
} catch (error) {
  const result = withBridgeDiagnostic({ isError: true, content: [] }, error, { component: "worker-relay-cli", operation: action, requestId: option("--request-id") });
  process.stderr.write(result.content.map(item => item.text ?? "").join("\n") + "\n");
  process.exitCode = 1;
}
