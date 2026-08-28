import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeEnvNames = [
  "CODEX_APP_SERVER_URL",
  "CODEX_BIN",
  "CODEX_BRIDGE_ALLOWED_ROOTS",
  "CODEX_BRIDGE_ALLOWED_THREADS",
  "CODEX_BRIDGE_APPROVAL",
  "CODEX_BRIDGE_AUTO_APPROVE_ACK",
  "CODEX_BRIDGE_APPROVAL_POLICY",
  "CODEX_BRIDGE_AUTOSTART",
  "CODEX_BRIDGE_EFFORT",
  "CODEX_BRIDGE_MODEL",
  "CODEX_BRIDGE_PATH_MAP",
  "CODEX_BRIDGE_REMAP",
  "CODEX_BRIDGE_SANDBOX",
  "CODEX_BRIDGE_THREAD_POLICY",
  "CODEX_BRIDGE_WORKSPACE_ROOTS",
];
const bridgeEnv = Object.fromEntries(
  bridgeEnvNames
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "index.mjs")],
  env: bridgeEnv,
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
