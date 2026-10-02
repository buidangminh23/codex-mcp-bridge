import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../sites/codex-bridge/worker/index.mjs";

test("Sites Worker supports the official MCP HTTP client and protects data-bearing calls", async (t) => {
  const db = { prepare() { return { bind() { return this; }, async first() { return null; } }; } };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = new Request(`http://127.0.0.1:${server.address().port}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers,
        ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }),
      });
      const response = await worker.fetch(request, { DB: db });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const endpoint = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const client = new Client({ name: "sites-compatibility-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { "oai-authenticated-user-id": "test-user" } } }));
  const discovery = await client.listTools();
  assert.equal(discovery.tools.length, 7);
  const status = await client.callTool({ name: "codex_bridge_status", arguments: {} });
  assert.deepEqual(JSON.parse(status.content[0].text), { paired: false, connected: false, lastSeen: null });
  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "codex_bridge_status", arguments: {} } }),
  });
  assert.equal(denied.status, 401);
});
