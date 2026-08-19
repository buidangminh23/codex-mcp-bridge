import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cwdForTest = process.env.SMOKE_CWD ?? root;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "index.mjs")],
  env: { ...process.env, CODEX_BRIDGE_ALLOWED_ROOTS: process.env.CODEX_BRIDGE_ALLOWED_ROOTS ?? cwdForTest },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const listed = await client.callTool({ name: "list_codex_threads", arguments: { limit: 3 } });
console.log("\n--- list_codex_threads ---\n" + listed.content[0].text.slice(0, 900));

const created = await client.callTool({
  name: "start_codex_thread",
  arguments: { cwd: cwdForTest },
});
console.log("\n--- start_codex_thread ---\n" + created.content[0].text);
const threadId = created.content[0].text.match(/threadId: ([0-9a-f-]+)/)?.[1];
if (!threadId) throw new Error("could not parse threadId");

const first = await client.callTool({
  name: "send_to_codex_thread",
  arguments: { threadId, prompt: "Remember the codeword PAPAYA. Reply with only: SAVED", timeoutSec: 180 },
});
console.log("\n--- send #1 ---\n" + first.content[0].text);

const second = await client.callTool({
  name: "send_to_codex_thread",
  arguments: { threadId, prompt: "What codeword did I give you? Reply with only that word.", timeoutSec: 180 },
});
console.log("\n--- send #2 (same thread, must recall) ---\n" + second.content[0].text);

const read = await client.callTool({ name: "read_codex_thread", arguments: { threadId, limit: 6 } });
console.log("\n--- read_codex_thread ---\n" + read.content[0].text.slice(0, 900));

const ok = /PAPAYA/i.test(second.content[0].text);
console.log("\nRESULT:", ok ? "PASS - thread continuity works" : "FAIL - Codex did not recall the codeword");
await client.close();
process.exit(ok ? 0 : 1);
