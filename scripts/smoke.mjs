import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwdForTest = process.env.SMOKE_CWD ?? root;
const codeword = "BRIDGE-" + randomUUID();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "index.mjs")],
  env: { ...process.env, CODEX_BRIDGE_ALLOWED_ROOTS: process.env.CODEX_BRIDGE_ALLOWED_ROOTS ?? cwdForTest },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "1.0.0" });

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 240000 });
  const text = result.content.map(item => item.text ?? "").join("\n");
  if (result.isError) throw new Error(text);
  return text;
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map(tool => tool.name).join(", "));
  const created = await call("start_codex_thread", { cwd: cwdForTest, name: "Bridge continuity smoke test" });
  console.log(created);
  const threadId = created.match(/threadId: ([0-9a-f-]+)/)?.[1];
  if (!threadId) throw new Error("could not parse threadId");
  const options = { threadId, timeoutSec: 180, openInApp: false, releaseAfterTurn: false };
  const first = await call("send_to_codex_thread", {
    ...options,
    prompt: "This is a transport smoke test. Do not run tools, commands, or change files. Remember this exact codeword: " + codeword + ". Reply with only: SAVED",
  });
  if (!/status: completed/.test(first) || first.split("--- Codex reply ---").at(-1).trim() !== "SAVED") {
    throw new Error("The first smoke turn did not complete with SAVED: " + first);
  }
  const second = await call("send_to_codex_thread", {
    ...options,
    prompt: "What exact codeword did I give you? Do not use tools. Reply with only that codeword.",
  });
  if (!/status: completed/.test(second) || second.split("--- Codex reply ---").at(-1).trim() !== codeword) {
    throw new Error("Codex did not recall the per-run codeword: " + second);
  }
  const read = await call("read_codex_thread", { threadId, limit: 6 });
  if (!read.includes(codeword)) throw new Error("The saved thread did not contain the smoke reply");
  console.log("RESULT: PASS - two completed turns preserved a unique codeword and its transcript");
} finally {
  await client.close();
}
