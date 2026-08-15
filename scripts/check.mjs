import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "index.mjs")],
  stderr: "inherit",
});
const client = new Client({ name: "bridge-check", version: "1.0.0" });

await client.connect(transport);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const listed = await client.callTool({ name: "list_codex_threads", arguments: { limit: 3 } });
console.log(listed.content[0].text.slice(0, 600));
await client.close();
process.exit(0);
