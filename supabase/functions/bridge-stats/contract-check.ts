import { createStatsHandler, publicKey } from "./index.ts";

function assert(value: unknown, message: string): void { if (!value) throw new Error(message); }
const request = () => new Request("https://example.test", { headers: { apikey: publicKey } });
const sourceTime = "2026-09-15T01:00:00Z";

Deno.test("auth, source projection, cache deduplication and stale timestamps", async () => {
  let clock = Date.parse("2026-09-15T02:00:00Z");
  let broken = false;
  const calls: string[] = [];
  const handler = createStatsHandler({ now: () => clock, env: (name) => name === "SUPABASE_URL" ? "https://project.supabase.co" : "private-key", fetcher: async (input, init) => {
    const url = String(input); calls.push(url);
    assert(init?.signal instanceof AbortSignal, "Source deadline required");
    if (broken) throw new Error("secret private-key error");
    let body;
    if (url.includes("supabase.co")) {
      assert(new Headers(init?.headers).get("authorization") === "Bearer private-key", "Internal auth required");
      body = { collectedAt: sourceTime, active: { day: 1, week: 2, month: 3, install_id: "secret" }, daily: [{ day: "2026-09-15", installations: 1, install_id: "secret" }], platforms: [], versions: [], account: "secret" };
    } else if (url.includes("api.github.com")) body = { stargazers_count: 4, forks_count: 5, subscribers_count: 6, owner: "secret" };
    else if (url.includes("npmjs.org")) body = { start: "2026-08-15", end: "2026-09-14", downloads: 7, token: "secret" };
    else body = { snapshots: [{ collectedAt: sourceTime, sourceCollectedAt: { views: sourceTime, clones: sourceTime }, views: { count: 8, uniques: 2, private: "secret" }, clones: { count: 9, uniques: 3 }, releases: [{ tag: "v1", id: 123, assets: [{ name: "demo.gif", downloads: 2, id: 123 }] }] }] };
    return new Response(JSON.stringify(body));
  } });
  assert((await handler(new Request("https://example.test"))).status === 401, "Missing key must fail");
  assert((await handler(new Request("https://example.test", { method: "POST" }))).status === 405, "Only GET allowed");
  assert((await handler(new Request("https://example.test", { method: "OPTIONS" }))).status === 204, "Preflight allowed");
  assert(calls.length === 0, "Unauthorized calls must not reach sources");
  const [first, concurrent] = await Promise.all([handler(request()), handler(request())]);
  assert(first.status === 200 && concurrent.status === 200 && calls.length === 4, "Concurrent source reads must coalesce");
  assert(first.headers.get("access-control-allow-origin") === "*" && first.headers.get("cache-control") === "no-store", "Browser headers required");
  const text = await first.text();
  assert(!text.includes("secret") && !text.includes("install_id") && !text.includes("private-key") && !text.includes('"id"'), "Private fields must not leak");
  const initial = JSON.parse(text);
  assert(initial.npm.downloads === 7 && initial.releases[0].assets[0].downloads === 2, "Counters must be numeric");
  clock += 16000;
  await handler(request());
  assert(calls.length === 5, "Only usage refreshes after 15 seconds");
  broken = true;
  clock += 61000;
  const staleResponse = await handler(request());
  const staleText = await staleResponse.text();
  const stale = JSON.parse(staleText);
  assert(staleResponse.status === 200 && stale.errors.length === 4, "Previous values survive dependency failures");
  assert(stale.usage.collectedAt === sourceTime && stale.repository.collectedAt === initial.repository.collectedAt && stale.traffic.collectedAt === sourceTime, "Old values retain source dates");
  assert(!staleText.includes("private-key") && !staleText.includes("secret"), "Errors must stay sanitized");
});

Deno.test("first source failure returns unavailable without fabricated usage", async () => {
  const handler = createStatsHandler({ env: () => undefined, fetcher: async () => new Response("private error", { status: 500 }) });
  const response = await handler(request());
  const body = await response.json();
  assert(response.status === 503 && body.usage === undefined && body.errors.length === 4, "Missing usage is unavailable, not zero");
  assert(!JSON.stringify(body).includes("private error"), "Private source error must not leak");
});
