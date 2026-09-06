import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "claude-bridge.mjs")],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "claude-bridge-check", version: "1.0.0" });
try {
  console.log("This diagnostic starts a separate MCP process; it does not reload or verify an existing Desktop task's MCP connection.");
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const status = await client.callTool({ name: "claude_bridge_status", arguments: {} });
  console.log("\n--- claude_bridge_status ---\n" + status.content[0].text);
  if (status.isError) throw new Error("Claude bridge status failed");

  const listed = await client.callTool({ name: "list_claude_sessions", arguments: {} });
  console.log("\n--- list_claude_sessions ---\n" + listed.content[0].text);
  if (listed.isError) throw new Error("Claude session listing failed");

  const target = process.env.CLAUDE_TARGET;
  if (target) {
    const message = process.env.CLAUDE_MESSAGE ?? "Ping from the Codex side of the bridge.";
    const waitSec = Number(process.env.CLAUDE_WAIT ?? 180);
    console.log(`\nsending to "${target}" (waiting ${waitSec}s)...`);
    const sent = await client.callTool({
      name: "send_to_claude_session",
      arguments: { target, message, waitSec, expectedCwd: process.env.CLAUDE_EXPECTED_CWD, expectedTaskId: process.env.CLAUDE_EXPECTED_TASK_ID },
    });
    console.log("\n--- send_to_claude_session ---\n" + sent.content[0].text);
    if (sent.isError) throw new Error("Claude message roundtrip failed; receipt or outcome is unconfirmed");
    if (sent.structuredContent?.receipt?.status !== "reply_received") {
      throw new Error("Claude message roundtrip unconfirmed: an actual reply is required; use CLAUDE_WAIT greater than 0");
    }
    console.log("\nClaude message roundtrip passed: reply received.");
  } else {
    console.log("\nDiscovery checks passed. Message roundtrip was not tested; set CLAUDE_TARGET to verify a reply.");
  }
} finally {
  await client.close();
}
