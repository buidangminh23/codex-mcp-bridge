const maxBodyBytes = 1024;
export const publicKey = "sb_publishable_2GIhGKL82wM8mN44L-Gzxw_Zgd-Vioh";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function reply(status: number, result: string): Response {
  return new Response(JSON.stringify({ status: result }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("invalid_body");
  const reader = request.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("body_timeout"));
      void reader.cancel().catch(() => {});
    }, 3000);
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        throw new Error("body_too_large");
      }
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
}

export async function handleUsage(request: Request): Promise<Response> {
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  if (request.headers.get("apikey") !== publicKey) return reply(401, "unauthorized");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return reply(415, "unsupported_media_type");
  }
  const declaredSize = request.headers.get("content-length");
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > maxBodyBytes)) {
    return reply(413, "body_too_large");
  }
  let body: Record<string, unknown>;
  try {
    const value = await readBody(request);
    if (!value || typeof value !== "object" || Array.isArray(value)) return reply(400, "invalid_payload");
    body = value as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid_payload";
    return reply(message === "body_too_large" ? 413 : message === "body_timeout" ? 408 : 400, message === "body_timeout" ? "body_timeout" : "invalid_payload");
  }
  const fields = Object.keys(body).sort().join(",");
  if (fields !== "day,install_id,platform,version" ||
      typeof body.install_id !== "string" || !uuidPattern.test(body.install_id) ||
      body.day !== new Date().toISOString().slice(0, 10) ||
      typeof body.version !== "string" || body.version.length > 64 || !versionPattern.test(body.version) ||
      !["windows", "macos", "linux"].includes(body.platform as string)) {
    return reply(400, "invalid_payload");
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return reply(503, "unavailable");
  try {
    const response = await fetch(new URL("/rest/v1/rpc/record_bridge_usage", url), {
      method: "POST",
      headers: { "content-type": "application/json", "apikey": key, "authorization": `Bearer ${key}` },
      body: JSON.stringify({ p_install_id: body.install_id, p_day: body.day, p_version: body.version, p_platform: body.platform }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return reply(503, "unavailable");
    }
    const result = await response.json();
    if (result === "recorded" || result === "duplicate") return reply(200, result);
    if (result === "capacity") return reply(429, "daily_capacity_reached");
    if (result === "invalid") return reply(400, "invalid_payload");
    return reply(503, "unavailable");
  } catch {
    return reply(503, "unavailable");
  }
}

if (import.meta.main) Deno.serve(handleUsage);
