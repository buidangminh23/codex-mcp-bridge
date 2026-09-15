export const publicKey = "sb_publishable_2GIhGKL82wM8mN44L-Gzxw_Zgd-Vioh";

type Json = Record<string, unknown>;
type Cache = { value?: Json; checkedAt: number; failed: boolean; pending?: Promise<void> };
const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "apikey",
};

function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid source");
  return value as Json;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid count");
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid timestamp");
  return value;
}

function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid date");
  return value;
}

function usageSummary(value: unknown): Json {
  const usage = object(value);
  const active = object(usage.active);
  const rows = (input: unknown, field: string) => {
    if (!Array.isArray(input) || input.length > 10000) throw new Error("Invalid aggregate rows");
    return input.map((inputRow) => {
      const row = object(inputRow);
      const label = row[field];
      if (typeof label !== "string" || label.length > 64) throw new Error("Invalid aggregate label");
      if (field === "day") date(label);
      if (field === "platform" && !["windows", "macos", "linux"].includes(label)) throw new Error("Invalid platform");
      return { [field]: label, installations: count(row.installations) };
    });
  };
  return {
    collectedAt: timestamp(usage.collectedAt),
    active: { day: count(active.day), week: count(active.week), month: count(active.month) },
    daily: rows(usage.daily, "day"),
    platforms: rows(usage.platforms, "platform"),
    versions: rows(usage.versions, "version"),
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error("Source unavailable");
  const reader = response.body.getReader();
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) {
        void reader.cancel().catch(() => {});
        throw new Error("Source too large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}

export function createStatsHandler({
  fetcher = fetch,
  now = Date.now,
  env = (name: string) => Deno.env.get(name),
} = {}) {
  const caches: Record<string, Cache> = Object.fromEntries(["usage", "repository", "npm", "traffic"].map((source) => [source, { checkedAt: -Infinity, failed: false }]));
  const get = async (url: string, init: RequestInit = {}) => readJson(await fetcher(url, { ...init, signal: AbortSignal.timeout(5000) }));
  const loaders: Record<string, () => Promise<Json>> = {
    async usage() {
      const url = env("SUPABASE_URL");
      const key = env("SUPABASE_SERVICE_ROLE_KEY");
      if (!url || !key) throw new Error("Unavailable");
      return usageSummary(await get(new URL("/rest/v1/rpc/get_bridge_usage_summary", url).href, {
        method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}",
      }));
    },
    async repository() {
      const value = object(await get("https://api.github.com/repos/buidangminh23/codex-mcp-bridge", { headers: { accept: "application/vnd.github+json", "user-agent": "codex-mcp-bridge-stats" } }));
      return { stars: count(value.stargazers_count), forks: count(value.forks_count), subscribers: count(value.subscribers_count), collectedAt: new Date(now()).toISOString() };
    },
    async npm() {
      const value = object(await get("https://api.npmjs.org/downloads/point/last-month/@minhspark%2Fcodex-mcp-bridge"));
      return { start: date(value.start), end: date(value.end), downloads: count(value.downloads), collectedAt: new Date(now()).toISOString() };
    },
    async traffic() {
      const value = object(await get("https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/data.json"));
      if (!Array.isArray(value.snapshots)) throw new Error("Unavailable");
      const snapshots = value.snapshots.map(object).sort((a, b) => timestamp(b.collectedAt).localeCompare(timestamp(a.collectedAt)));
      const select = (field: string) => {
        for (const snapshot of snapshots) {
          if (!snapshot[field]) continue;
          const row = object(snapshot[field]);
          const sourceTimes = snapshot.sourceCollectedAt ? object(snapshot.sourceCollectedAt) : {};
          return { count: count(row.count), uniques: count(row.uniques), collectedAt: timestamp(sourceTimes[field] ?? snapshot.collectedAt) };
        }
        throw new Error("Unavailable");
      };
      const views = select("views");
      const clones = select("clones");
      const releaseSnapshot = snapshots.find((snapshot) => Array.isArray(snapshot.releases));
      const releaseFields: Json = {};
      if (releaseSnapshot) {
        releaseFields.releases = (releaseSnapshot.releases as unknown[]).map((input) => {
          const release = object(input);
          if (typeof release.tag !== "string" || release.tag.length > 256 || !Array.isArray(release.assets)) throw new Error("Invalid release");
          return { tag: release.tag, assets: release.assets.map((inputAsset) => {
            const asset = object(inputAsset);
            if (typeof asset.name !== "string" || asset.name.length > 256) throw new Error("Invalid asset");
            return { name: asset.name, downloads: count(asset.downloads) };
          }) };
        });
        const sourceTimes = releaseSnapshot.sourceCollectedAt ? object(releaseSnapshot.sourceCollectedAt) : {};
        releaseFields.releasesCollectedAt = timestamp(sourceTimes.releases ?? releaseSnapshot.collectedAt);
      }
      return {
        views: { count: views.count, uniques: views.uniques }, clones: { count: clones.count, uniques: clones.uniques },
        collectedAt: Date.parse(views.collectedAt) <= Date.parse(clones.collectedAt) ? views.collectedAt : clones.collectedAt,
        ...releaseFields,
      };
    },
  };
  const refresh = async (source: string) => {
    const cache = caches[source];
    if (cache.pending) return cache.pending;
    if (now() - cache.checkedAt < (source === "usage" ? 15000 : 60000)) return;
    cache.pending = (async () => {
      try { cache.value = await loaders[source](); cache.failed = false; }
      catch { cache.failed = true; }
      finally { cache.checkedAt = now(); }
    })();
    try { await cache.pending; } finally { cache.pending = undefined; }
  };
  return async (request: Request): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
    if (request.headers.get("apikey") !== publicKey) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
    await Promise.all(Object.keys(caches).map(refresh));
    const output: Json = { collectedAt: new Date(now()).toISOString() };
    const errors: Json[] = [];
    for (const [source, cache] of Object.entries(caches)) {
      if (cache.value && source === "traffic") {
        const { releases, releasesCollectedAt, ...traffic } = cache.value;
        output.traffic = traffic;
        if (releases) { output.releases = releases; output.releasesCollectedAt = releasesCollectedAt; }
      } else if (cache.value) output[source] = cache.value;
      if (cache.failed) errors.push({ source, error: "source_unavailable", stale: Boolean(cache.value) });
    }
    if (errors.length) output.errors = errors;
    return new Response(JSON.stringify(output), { status: caches.usage.value ? 200 : 503, headers });
  };
}

export const handleStats = createStatsHandler();
if (import.meta.main) Deno.serve(handleStats);
