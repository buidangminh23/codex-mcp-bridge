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
  assert(staleResponse.status === 200 && stale.errors.length === 6, "Previous values survive dependency failures");
  assert(stale.usage.collectedAt === sourceTime && stale.repository.collectedAt === initial.repository.collectedAt && stale.traffic.collectedAt === sourceTime, "Old values retain source dates");
  assert(!staleText.includes("private-key") && !staleText.includes("secret"), "Errors must stay sanitized");
});

Deno.test("first source failure returns unavailable without fabricated usage", async () => {
  const handler = createStatsHandler({ env: () => undefined, fetcher: async () => new Response("private error", { status: 500 }) });
  const response = await handler(request());
  const body = await response.json();
  assert(response.status === 503 && body.usage === undefined && body.errors.length === 6, "Missing usage is unavailable, not zero");
  assert(!JSON.stringify(body).includes("private error"), "Private source error must not leak");
});

function fixture(snapshot: Record<string, unknown>, clock = Date.parse(sourceTime)) {
  return createStatsHandler({ now: () => clock, env: () => undefined, fetcher: async (input) => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ stargazers_count: 0, forks_count: 0, subscribers_count: 0 }));
    if (url.includes("npmjs.org")) return new Response(JSON.stringify({ start: "2026-08-15", end: "2026-09-14", downloads: 0 }));
    return new Response(JSON.stringify({ snapshots: [snapshot] }));
  } });
}

Deno.test("public sources refresh despite unavailable usage and one missing traffic family", async () => {
  const handler = fixture({ collectedAt: sourceTime, views: { count: 0, uniques: 0, views: [{ timestamp: "2026-09-14T00:00:00Z" }] } });
  const response = await handler(request());
  const body = await response.json();
  assert(response.status === 200 && body.usage === undefined, "Usage failure must not block healthy public sources");
  assert(body.repository.stars === 0 && body.npm.downloads === 0, "Real zero counters must survive");
  assert(body.traffic.views.count === 0 && body.traffic.clones === undefined, "Views survive missing clones without invented clones");
  assert(body.traffic.views.start === "2026-09-14" && body.traffic.views.end === "2026-09-14", "Source window must be explicit");
  assert(body.traffic.viewsCollectedAt === sourceTime && body.errors.some((row: { source: string }) => row.source === "usage"), "Independent source metadata required");
});

Deno.test("release assets survive missing traffic and old archive data is marked stale", async () => {
  const handler = fixture({ collectedAt: sourceTime, releases: [{ tag: "v1", assets: [{ name: "package.tgz", downloads: 4 }] }] }, Date.parse(sourceTime) + 4 * 60 * 60 * 1000);
  const response = await handler(request());
  const body = await response.json();
  assert(response.status === 200 && body.traffic === undefined && body.releases[0].assets[0].downloads === 4, "Releases must be independent of traffic");
  assert(body.releasesCollectedAt === sourceTime, "Archive age must not be replaced by polling time");
  assert(body.errors.some((row: { source: string; error: string }) => row.source === "releases" && row.error === "archive_stale"), "Successful fetch of old data must report stale source");
});

Deno.test("views and clones retain different original source times and reporting windows", async () => {
  const viewsTime = "2026-09-15T00:00:00Z";
  const handler = fixture({ collectedAt: sourceTime, sourceCollectedAt: { views: viewsTime, clones: sourceTime },
    views: { count: 8, uniques: 2, views: [{ timestamp: "2026-09-13T00:00:00Z" }, { timestamp: "2026-09-14T00:00:00Z" }] },
    clones: { count: 9, uniques: 3, clones: [{ timestamp: "2026-09-14T00:00:00Z" }] }, releases: [],
  });
  const body = await (await handler(request())).json();
  assert(body.traffic.viewsCollectedAt === viewsTime && body.traffic.clonesCollectedAt === sourceTime, "Traffic source timestamps must not be collapsed");
  assert(body.traffic.collectedAt === viewsTime && body.sourceCollectedAt.clones === sourceTime, "Legacy and independent timestamps must coexist");
  assert(body.traffic.views.start === "2026-09-13" && body.traffic.clones.start === "2026-09-14", "Each window belongs to its own source");
  assert(Array.isArray(body.releases) && body.releases.length === 0, "Empty release list is available, not missing");
});

Deno.test("invalid archived metric retains last-good value while other sources recover", async () => {
  let clock = Date.parse(sourceTime);
  let invalid = false;
  const handler = createStatsHandler({ now: () => clock, env: () => undefined, fetcher: async (input) => {
    const url = String(input);
    if (url.includes("api.github.com")) return new Response(JSON.stringify({ stargazers_count: invalid ? 10 : 4, forks_count: 5, subscribers_count: 6 }));
    if (url.includes("npmjs.org")) return new Response(JSON.stringify({ start: "2026-08-15", end: "2026-09-14", downloads: 7 }));
    return new Response(JSON.stringify({ snapshots: [{ collectedAt: new Date(clock).toISOString(), views: { count: invalid ? -1 : 8, uniques: 2 }, clones: { count: invalid ? 20 : 9, uniques: 3 }, releases: [] }] }));
  } });
  await handler(request());
  clock += 61000;
  invalid = true;
  const partial = await (await handler(request())).json();
  assert(partial.traffic.views.count === 8 && Date.parse(partial.traffic.viewsCollectedAt) === Date.parse(sourceTime), "Invalid source must retain last-good count and age");
  assert(partial.traffic.clones.count === 20 && partial.repository.stars === 10, "Invalid views must not block independent updates");
  assert(partial.errors.some((row: { source: string; stale: boolean }) => row.source === "views" && row.stale), "Retained values must be marked stale");
  invalid = false;
  clock += 61000;
  const recovered = await (await handler(request())).json();
  assert(recovered.traffic.viewsCollectedAt === new Date(clock).toISOString() && !recovered.errors.some((row: { source: string }) => row.source === "views"), "Recovery clears source failure and updates its actual time");
});
