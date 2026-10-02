const VERSION = "0.1.0";
const TTL = 120000;
const MAX_BYTES = 100000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const schema = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description, maxLength = 500) => ({ type: "string", minLength: 1, maxLength, description });
const requestId = { ...string("Fresh UUID per independent mutation. Retain exactly on retries."), pattern: uuid.source };
export const tools = [
  ["codex_bridge_status", "Check the connection to Codex Desktop", schema(), true],
  ["list_codex_projects", "List saved local Codex Desktop projects", schema(), true],
  ["list_codex_threads", "List local Codex conversations in an allowed project", schema({ cwd: string("Exact project path"), limit: { type: "integer", minimum: 1, maximum: 50 } }), true],
  ["read_codex_thread", "Read the selected Codex conversation", schema({ threadId: string("Verified Codex thread ID"), turnLimit: { type: "integer", minimum: 1, maximum: 10 } }, ["threadId"]), true],
  ["start_codex_thread", "Create a new Codex task with its initial prompt when the user authorizes new work", schema({ cwd: string("Exact saved local project path"), prompt: string("Full task brief", 48000), title: string("Task title", 200), requestId }, ["cwd", "prompt", "title", "requestId"]), false],
  ["send_to_codex_thread", "Continue unfinished work in its verified original Codex conversation when authorized", schema({ threadId: string("Verified original thread ID"), prompt: string("Follow-up brief", 48000), requestId }, ["threadId", "prompt", "requestId"]), false],
  ["read_codex_request", "Read the queued operation result by returned request ID; do not resend a mutation", schema({ id: string("Returned queue request ID", 64) }, ["id"]), true],
].map(([name, description, inputSchema, readOnlyHint]) => ({ name, title: description, description: `${description}. Desktop requests return a queue ID; use read_codex_request until completed. An uncertain outcome must be inspected, never resent automatically.`, inputSchema, annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false } }));

export function validate(name, args) {
  const definition = tools.find((tool) => tool.name === name);
  if (!definition || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Unknown tool or invalid arguments");
  if (Object.keys(args).some((key) => !Object.hasOwn(definition.inputSchema.properties, key))) throw new Error("Unexpected argument");
  for (const key of definition.inputSchema.required) if (!Object.hasOwn(args, key)) throw new Error(`Missing ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const field = definition.inputSchema.properties[key];
    if (field.type === "string" && (typeof value !== "string" || !value.trim() || value.length > field.maxLength)) throw new Error(`Invalid ${key}`);
    if (field.type === "integer" && (!Number.isInteger(value) || value < field.minimum || value > field.maximum)) throw new Error(`Invalid ${key}`);
    if (key === "requestId" && !uuid.test(value)) throw new Error("requestId must be a UUID");
  }
  return Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
}

export class Queue {
  constructor(db, now = Date.now) { this.db = db; this.now = now; }
  async get(id) { return this.db.prepare("SELECT * FROM bridge_jobs WHERE id = ?").bind(id).first(); }
  async connector(ownerId) { return this.db.prepare("SELECT * FROM bridge_connector WHERE owner_id = ? AND status = 'active'").bind(ownerId).first(); }
  async status(ownerId) {
    const state = await this.connector(ownerId);
    return { paired: Boolean(state), connected: Boolean(state && this.now() - state.last_seen < 15000), lastSeen: state?.last_seen || null };
  }
  async enqueue(ownerId, tool, args) {
    const identity = args.requestId ?? crypto.randomUUID();
    const bytes = new TextEncoder().encode(`${ownerId}:${identity}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const existing = await this.get(id);
    const serialized = JSON.stringify(args);
    if (existing) {
      if (existing.tool !== tool || existing.arguments !== serialized) throw new Error("This requestId is already bound to different work. Inspect the original operation.");
      return this.describe(existing);
    }
    const connection = await this.connector(ownerId);
    if (!connection || this.now() - connection.last_seen >= 15000) throw new Error("The paired computer is offline. No operation was queued.");
    const pending = await this.db.prepare("SELECT COUNT(*) AS count FROM bridge_jobs WHERE connector_id = ? AND status IN ('queued', 'claimed') AND expires_at > ?").bind(connection.id, this.now()).first();
    if (pending.count >= 10) throw new Error("The bridge queue is full. Read existing operation results first.");
    const now = this.now();
    await this.db.prepare("INSERT OR IGNORE INTO bridge_jobs (id, owner_id, connector_id, request_id, tool, arguments, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)").bind(id, ownerId, connection.id, args.requestId ?? null, tool, serialized, now, now + TTL).run();
    const saved = await this.get(id);
    if (saved.tool !== tool || saved.arguments !== serialized) throw new Error("requestId conflict");
    return this.describe(saved);
  }
  describe(job) {
    let status = job.status;
    if (job.expires_at <= this.now() && status === "queued") status = "expired_not_dispatched";
    if (job.expires_at <= this.now() && status === "claimed") status = "uncertain";
    return { id: job.id, status, requestId: job.request_id, ...(job.result ? { result: JSON.parse(job.result) } : {}), ...(status === "uncertain" ? { instruction: "Inspect the original Desktop task; this operation will never be automatically resent." } : {}) };
  }
  async poll(connector) {
    const now = this.now();
    if (connector.status !== "active") return { paired: false, job: null };
    await this.db.prepare("UPDATE bridge_connector SET last_seen = ? WHERE id = ? AND status = 'active'").bind(now, connector.id).run();
    const job = await this.db.prepare("UPDATE bridge_jobs SET status = 'claimed', claimed_at = ? WHERE id = (SELECT id FROM bridge_jobs WHERE connector_id = ? AND owner_id = ? AND status = 'queued' AND expires_at > ? ORDER BY created_at LIMIT 1) AND status = 'queued' RETURNING *").bind(now, connector.id, connector.owner_id, now).first();
    return { paired: true, job: job ? { id: job.id, tool: job.tool, arguments: JSON.parse(job.arguments), requestId: job.request_id, expiresAt: job.expires_at } : null };
  }
  async complete(connector, id, result) {
    const job = await this.get(id);
    if (!job || connector.status !== "active" || job.connector_id !== connector.id || job.owner_id !== connector.owner_id || !["claimed", "completed"].includes(job.status)) throw new Error("Job was not claimed by this connector");
    const serialized = JSON.stringify(result);
    if (job.result && job.result !== serialized) throw new Error("A confirmed result cannot be replaced");
    await this.db.prepare("UPDATE bridge_jobs SET status = 'completed', result = ? WHERE id = ? AND status = 'claimed'").bind(serialized, id).run();
    const confirmed = await this.get(id);
    if (confirmed.status !== "completed" || confirmed.result !== serialized) throw new Error("The result was not persisted; inspect the original operation");
    return { ok: true };
  }
}

async function body(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES) throw new Error("Payload too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("JSON body required");
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Payload too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function tokenHash(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function owner(request) {
  const id = request.headers.get("oai-authenticated-user-id");
  return typeof id === "string" && id.length > 0 && id.length <= 500 ? id : null;
}

async function authenticatedConnector(request, queue) {
  const id = request.headers.get("X-Codex-Connector-ID");
  const authorization = request.headers.get("Authorization") ?? "";
  if (!uuid.test(id ?? "") || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(authorization)) return null;
  const row = await queue.db.prepare("SELECT * FROM bridge_connector WHERE id = ?").bind(id).first();
  if (!row) return { id, status: "pending" };
  if (row.status === "revoked") return null;
  const actual = await tokenHash(authorization.slice(7));
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ row.token_hash.charCodeAt(i);
  return difference === 0 ? row : null;
}

const connectPage = (code, challenge, issued, signedIn) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Codex MCP Bridge</title><style>body{background:#0d141c;color:#e7edf4;font:16px system-ui;margin:0}main{max-width:620px;margin:12vh auto;padding:24px}p{line-height:1.6;color:#afbac8}button,a{background:#6ee7b7;color:#0d141c;border:0;padding:14px 20px;border-radius:8px;font:inherit;cursor:pointer;display:inline-block;text-decoration:none}#result{white-space:pre-wrap}</style></head><body><main><h1>Connect your computer</h1><p>Approve only the pairing opened by the connector on your own computer. This account will be able to read conversations and send work to that computer's allowed Codex projects.</p>${signedIn ? `<button id="pair">Connect this computer</button><p><button id="disconnect">Disconnect existing computer</button></p><p id="result"></p><script>document.getElementById('pair').onclick=async()=>{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectorId:${JSON.stringify(code)},challenge:${JSON.stringify(challenge)},issued:${issued}})});document.getElementById('result').textContent=r.ok?'Computer paired. Keep the connector running, then install Codex MCP Bridge in ChatGPT.':(await r.json()).error};document.getElementById('disconnect').onclick=async()=>{if(!confirm('Disconnect the currently paired computer? Tasks already sent to Desktop keep running.'))return;const r=await fetch('/api/disconnect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});document.getElementById('result').textContent=r.ok?'Disconnected. You can pair the new computer now.':'Unable to disconnect.'}</script>` : `<a href="/signin-with-chatgpt?return_to=${encodeURIComponent(`/connect?code=${code}&challenge=${challenge}&issued=${issued}`)}" target="_top">Sign in with ChatGPT</a>`}</main></body></html>`;

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex MCP Bridge</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%2316202b'/%3E%3Cpath d='m12 9-7 7 7 7m8-14 7 7-7 7' fill='none' stroke='%236ee7b7' stroke-width='3'/%3E%3C/svg%3E"><style>body{margin:0;background:#0d141c;color:#e7edf4;font:16px system-ui}main{max-width:720px;margin:12vh auto;padding:24px}h1{font-size:36px;letter-spacing:-1px}section{border:1px solid #2c3a49;border-radius:16px;padding:24px;margin:24px 0}#state{color:#6ee7b7;font-size:24px}p{color:#afbac8;line-height:1.6}code{color:#d5e3f1}a{color:#6ee7b7}</style></head><body><main><h1>Codex MCP Bridge</h1><section><div id="state">Checking connection…</div><p id="detail"></p></section><p>Use the Codex MCP Bridge plugin in ChatGPT to list projects, read conversations, start a task, or continue unfinished work.</p><p>Queued operations return a request ID. Check that request to read the result. Keep the computer and Codex Desktop running.</p><p><a href="/signin-with-chatgpt?return_to=%2F" target="_top">Sign in with ChatGPT</a></p><h2>Connect your own computer</h2><p>Install the connector, select your local project, and approve the pairing link it prints. Each account can access only its paired computer.</p><p><code>npm install -g @minhspark/codex-mcp-bridge@latest</code></p><p><code>codex-native-relay-install --desktop-tasks</code></p><p><code>codex-sites-connector --pair --site https://codex-mcp-bridge.minhspark.chatgpt.site --roots &quot;/absolute/project/path&quot;</code></p><p>Windows: use the .cmd launchers and a Windows project path. Native Desktop support requires Windows or macOS.</p><p>Install the Codex MCP Bridge plugin from this Site after pairing.</p><p><a href="https://github.com/buidangminh23/codex-mcp-bridge">Source and setup</a></p></main><script>async function refresh(){try{const r=await fetch('/api/status');if(!r.ok)throw Error();const s=await r.json();document.getElementById('state').textContent=s.connected?'Computer connected':s.paired?'Computer offline':'No computer paired';document.getElementById('detail').textContent=s.connected?'Ready to receive operations. Desktop access is checked for every request.':'Start the paired connector on the computer to use the bridge.'}catch{document.getElementById('state').textContent='Connection unavailable';document.getElementById('detail').textContent='Sign in with your ChatGPT account to check your computer.'}}refresh();setInterval(refresh,10000)</script></body></html>`;

export function createWorker({ now = Date.now } = {}) {
  return { async fetch(request, env) {
    const url = new URL(request.url);
    const queue = new Queue(env.DB, now);
    try {
      if (url.pathname === "/agent/pair/start" && request.method === "POST") {
        const input = await body(request);
        if (!uuid.test(input.connectorId ?? "") || !/^[A-Za-z0-9_-]{43,128}$/.test(input.connectorToken ?? "")) return json({ error: "Invalid pairing credentials" }, 400);
        const hash = await tokenHash(input.connectorToken);
        const existing = await queue.db.prepare("SELECT * FROM bridge_connector WHERE id = ?").bind(input.connectorId).first();
        if (existing && (existing.token_hash !== hash || existing.status === "revoked")) return json({ error: "Pairing cannot be replaced. Start a new pairing." }, 409);
        return json({ pairingUrl: `${url.origin}/connect?code=${input.connectorId}&challenge=${hash}&issued=${now()}` });
      }
      if (url.pathname.startsWith("/agent/")) {
        if (request.method !== "POST") return json({ error: "POST required" }, 405);
        const connector = await authenticatedConnector(request, queue);
        if (!connector) return json({ error: "Unauthorized connector" }, 401);
        const input = await body(request);
        if (url.pathname === "/agent/heartbeat") {
          if (connector.status !== "active") return json({ error: "Pairing required" }, 401);
          await queue.db.prepare("UPDATE bridge_connector SET last_seen = ? WHERE id = ? AND status = 'active'").bind(now(), connector.id).run();
          return json({ paired: true });
        }
        if (url.pathname === "/agent/poll") return json(await queue.poll(connector));
        if (url.pathname === "/agent/result") {
          if (typeof input.id !== "string" || !Array.isArray(input.result?.content) || input.result.content.some((item) => item.type !== "text" || typeof item.text !== "string")) throw new Error("Invalid result");
          return json(await queue.complete(connector, input.id, input.result));
        }
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname === "/mcp") {
        if (request.method === "GET") return new Response(null, { status: 405, headers: { Allow: "POST" } });
        if (request.method !== "POST") return json({ error: "POST required" }, 405);
        const rpc = await body(request);
        if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" || Array.isArray(rpc)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, 400);
        const reply = (result) => json({ jsonrpc: "2.0", id: rpc.id, result });
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.id === undefined) return new Response(null, { status: 202 });
        if (rpc.method === "initialize") return reply({ protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "codex-bridge", version: VERSION }, instructions: "Access the paired local Codex Desktop. Inspect projects and conversations before acting. Create new conversations only when authorized. Continue unfinished work in its verified original task. Calls return a queue ID: read_codex_request retrieves results. Keep the same requestId on retries; never automatically resend uncertain work. This connection does not impersonate a Claude session." });
        if (rpc.method === "ping") return reply({});
        if (rpc.method === "tools/list") return reply({ tools });
        if (rpc.method !== "tools/call") return json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
        const user = owner(request);
        if (!user) return json({ error: "ChatGPT authentication required" }, 401);
        try {
          const name = rpc.params?.name;
          const args = validate(name, rpc.params?.arguments ?? {});
          if (name === "codex_bridge_status") { const state = await queue.status(user); return reply({ ...text(state), structuredContent: state }); }
          if (name === "read_codex_request") {
            const job = await queue.get(args.id);
            if (!job || job.owner_id !== user) return reply(text("Request not found", true));
            const result = queue.describe(job);
            return reply({ ...text(result), structuredContent: result });
          }
          const result = await queue.enqueue(user, name, args);
          return reply({ ...text(result), structuredContent: result });
        } catch (error) { return reply(text(error.message, true)); }
      }
      const user = owner(request);
      if (["/api/pair", "/api/disconnect"].includes(url.pathname)) {
        if (!user) return json({ error: "ChatGPT authentication required" }, 401);
        if (request.method !== "POST" || request.headers.get("Origin") !== url.origin || !request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "Same-origin POST required" }, 403);
        const input = await body(request);
        if (url.pathname === "/api/disconnect") {
          const existing = await queue.connector(user);
          if (existing) await queue.db.batch([
            queue.db.prepare("UPDATE bridge_connector SET owner_id = NULL, status = 'revoked' WHERE id = ? AND owner_id = ?").bind(existing.id, user),
            queue.db.prepare("UPDATE bridge_jobs SET status = CASE WHEN status = 'queued' THEN 'revoked_not_dispatched' ELSE 'uncertain' END WHERE connector_id = ? AND status IN ('queued', 'claimed')").bind(existing.id),
          ]);
          return json({ ok: true });
        }
        if (!uuid.test(input.connectorId ?? "") || !/^[0-9a-f]{64}$/.test(input.challenge ?? "") || !Number.isSafeInteger(input.issued) || input.issued > now() + 30000 || now() - input.issued >= 600000) return json({ error: "Invalid or expired pairing code" }, 400);
        const pending = await queue.db.prepare("SELECT * FROM bridge_connector WHERE id = ?").bind(input.connectorId).first();
        if (pending) {
          if (pending.owner_id === user && pending.status === "active" && pending.token_hash === input.challenge) return json({ ok: true });
          return json({ error: "Pairing already used" }, 409);
        }
        if (await queue.connector(user)) return json({ error: "This account already has a paired computer. Disconnect it before pairing another." }, 409);
        const result = await queue.db.prepare("INSERT OR IGNORE INTO bridge_connector (id, owner_id, token_hash, expires_at, status, last_seen) VALUES (?, ?, ?, ?, 'active', 0)").bind(input.connectorId, user, input.challenge, input.issued + 600000).run();
        if (result.meta?.changes !== 1) return json({ error: "Pairing was already used" }, 409);
        return json({ ok: true });
      }
      if (request.method !== "GET") return json({ error: "GET required" }, 405);
      if (url.pathname === "/connect") {
        const code = url.searchParams.get("code") ?? "";
        const challenge = url.searchParams.get("challenge") ?? "";
        const issued = Number(url.searchParams.get("issued"));
        if (!uuid.test(code) || !/^[0-9a-f]{64}$/.test(challenge) || !Number.isSafeInteger(issued) || issued > now() + 30000 || now() - issued >= 600000) return json({ error: "Open a fresh pairing URL printed by your local connector" }, 400);
        return new Response(connectPage(code, challenge, issued, Boolean(user)), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      }
      if (url.pathname === "/api/status") return user ? json(await queue.status(user)) : json({ error: "Sign in with ChatGPT" }, 401);
      if (url.pathname === "/") return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(`bridge request failed: ${error.name}`);
      return json({ error: "Bridge request unavailable" }, 400);
    }
  } };
}

export default createWorker();
