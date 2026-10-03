import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createWorker } from "../worker/index.mjs";

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../drizzle/0000_sour_thunderbolt.sql", import.meta.url), "utf8"));
  const prepare = (sql) => {
    const statement = sqlite.prepare(sql);
    let args = [];
    const wrapper = { bind(...values) { args = values; return wrapper; }, async first() { return statement.get(...args) ?? null; }, async run() { const result = statement.run(...args); return { meta: { changes: Number(result.changes) } }; } };
    return wrapper;
  };
  const db = { prepare, async batch(statements) { sqlite.exec("BEGIN"); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } } };
  let clock = 1000000;
  const worker = createWorker({ now: () => clock });
  const call = async (pathname, data, headers = {}, method = "POST") => {
    const response = await worker.fetch(new Request(`https://bridge.example${pathname}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify(data) } : {}) }), { DB: db });
    const raw = await response.text();
    return { status: response.status, value: raw ? JSON.parse(raw) : null };
  };
  const user = (id) => ({ "oai-authenticated-user-id": id, Origin: "https://bridge.example" });
  const rpc = (owner, name, arguments_ = {}) => call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } }, user(owner));
  async function pair(owner) {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const headers = { Authorization: `Bearer ${token}`, "X-Codex-Connector-ID": id };
    const started = await call("/agent/pair/start", { connectorId: id, connectorToken: token });
    assert.equal(started.status, 200);
    const url = new URL(started.value.pairingUrl);
    const pairing = { connectorId: id, challenge: url.searchParams.get("challenge"), issued: Number(url.searchParams.get("issued")) };
    assert.equal((await call("/api/pair", pairing, user(owner))).status, 200);
    assert.equal((await call("/agent/poll", {}, headers)).value.paired, true);
    return { id, token, headers, pairing };
  }
  return { call, pair, rpc, user, advance: (ms) => { clock += ms; }, close: () => sqlite.close() };
}

test("MCP discovery contains no private data and protected calls require identity", async () => {
  const f = fixture();
  try {
    const response = await f.call("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    assert.equal(response.value.result.protocolVersion, "2025-11-25");
    assert.equal((await f.call("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" })).value.result.tools.length, 7);
    assert.equal((await f.call("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "codex_bridge_status" } })).status, 401);
    assert.equal((await f.call("/mcp", {}, {}, "GET")).status, 405);
  } finally { f.close(); }
});

test("pairing binds one account, rejects CSRF, expiry and token replacement", async () => {
  const f = fixture();
  try {
    const id = randomUUID(), token = randomBytes(32).toString("base64url");
    const started = await f.call("/agent/pair/start", { connectorId: id, connectorToken: token });
    const url = new URL(started.value.pairingUrl);
    const pairing = { connectorId: id, challenge: url.searchParams.get("challenge"), issued: Number(url.searchParams.get("issued")) };
    assert.equal((await f.call("/api/pair", { connectorId: id }, { "oai-authenticated-user-id": "a" })).status, 403);
    assert.equal((await f.call("/agent/poll", {}, { Authorization: `Bearer ${token}`, "X-Codex-Connector-ID": id })).value.paired, false);
    f.advance(600001);
    assert.equal((await f.call("/api/pair", pairing, f.user("a"))).status, 400);
    const paired = await f.pair("a");
    assert.equal((await f.call("/api/pair", paired.pairing, f.user("b"))).status, 409);
    assert.equal((await f.call("/agent/pair/start", { connectorId: paired.id, connectorToken: randomBytes(32).toString("base64url") })).status, 409);
  } finally { f.close(); }
});

test("users and connectors cannot consume or read each other's work", async () => {
  const f = fixture();
  try {
    const a = await f.pair("a"), b = await f.pair("b");
    const queued = (await f.rpc("a", "list_codex_projects")).value.result.structuredContent;
    assert.equal((await f.call("/agent/poll", {}, b.headers)).value.job, null);
    assert.equal((await f.rpc("b", "read_codex_request", { id: queued.id })).value.result.isError, true);
    const job = (await f.call("/agent/poll", {}, a.headers)).value.job;
    assert.equal(job.id, queued.id);
    assert.equal((await f.call("/agent/result", { id: job.id, result: { content: [] } }, b.headers)).status, 400);
    assert.equal((await f.call("/agent/poll", {}, { ...a.headers, Authorization: `Bearer ${b.token}` })).status, 401);
  } finally { f.close(); }
});

test("mutation request IDs are durable, content-bound and claimed once", async () => {
  const f = fixture();
  try {
    const a = await f.pair("a");
    const args = { threadId: "selected-thread", prompt: "Do the approved work", requestId: randomUUID() };
    const first = (await f.rpc("a", "send_to_codex_thread", args)).value.result.structuredContent;
    const retry = (await f.rpc("a", "send_to_codex_thread", args)).value.result.structuredContent;
    assert.equal(first.id, retry.id);
    assert.equal((await f.rpc("a", "send_to_codex_thread", { ...args, prompt: "Different work" })).value.result.isError, true);
    assert.equal((await f.call("/agent/poll", {}, a.headers)).value.job.id, first.id);
    assert.equal((await f.call("/agent/poll", {}, a.headers)).value.job, null);
    const result = { content: [{ type: "text", text: "accepted" }] };
    assert.equal((await f.call("/agent/result", { id: first.id, result }, a.headers)).status, 200);
    assert.equal((await f.call("/agent/result", { id: first.id, result }, a.headers)).status, 200);
    assert.equal((await f.call("/agent/result", { id: first.id, result: { content: [] } }, a.headers)).status, 400);
    assert.equal((await f.rpc("a", "read_codex_request", { id: first.id })).value.result.structuredContent.status, "completed");
  } finally { f.close(); }
});

test("expired queued work never executes and a lost claimed mutation stays uncertain", async () => {
  const f = fixture();
  try {
    const a = await f.pair("a");
    const queued = (await f.rpc("a", "list_codex_projects")).value.result.structuredContent;
    f.advance(120001);
    assert.equal((await f.call("/agent/poll", {}, a.headers)).value.job, null);
    assert.equal((await f.rpc("a", "read_codex_request", { id: queued.id })).value.result.structuredContent.status, "expired_not_dispatched");
    const mutation = (await f.rpc("a", "send_to_codex_thread", { threadId: "x", prompt: "approved", requestId: randomUUID() })).value.result.structuredContent;
    await f.call("/agent/poll", {}, a.headers);
    f.advance(120001);
    assert.equal((await f.call("/agent/poll", {}, a.headers)).value.job, null);
    assert.equal((await f.rpc("a", "read_codex_request", { id: mutation.id })).value.result.structuredContent.status, "uncertain");
  } finally { f.close(); }
});

test("disconnect revokes credentials and cancels work that has not dispatched", async () => {
  const f = fixture();
  try {
    const a = await f.pair("a");
    const queued = (await f.rpc("a", "list_codex_projects")).value.result.structuredContent;
    assert.equal((await f.call("/api/disconnect", {}, f.user("b"))).status, 200);
    assert.equal((await f.call("/agent/poll", {}, a.headers)).status, 200);
    await f.call("/api/disconnect", {}, f.user("a"));
    assert.equal((await f.call("/agent/poll", {}, a.headers)).status, 401);
    assert.equal((await f.rpc("a", "read_codex_request", { id: queued.id })).value.result.structuredContent.status, "uncertain");
    assert.equal((await f.rpc("a", "list_codex_projects")).value.result.isError, true);
  } finally { f.close(); }
});

test("invalid and oversized calls are rejected without queuing work", async () => {
  const f = fixture();
  try {
    await f.pair("a");
    assert.equal((await f.rpc("a", "send_to_codex_thread", { threadId: "x", prompt: "x", requestId: "invalid" })).value.result.isError, true);
    assert.equal((await f.rpc("a", "list_codex_projects", { arbitraryMethod: "execute" })).value.result.isError, true);
    assert.equal((await f.call("/mcp", { padding: "x".repeat(100001) })).status, 400);
  } finally { f.close(); }
});
