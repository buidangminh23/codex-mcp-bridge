import { handleUsage, publicKey } from "./index.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const payload = () => ({
  install_id: "12345678-1234-4234-8234-123456789abc",
  day: new Date().toISOString().slice(0, 10),
  version: "1.16.0",
  platform: "windows",
});

function request(value: unknown, contentType = "application/json") {
  return new Request("https://example.test", {
    method: "POST",
    headers: { "content-type": contentType, apikey: publicKey },
    body: JSON.stringify(value),
  });
}

Deno.test("rejects methods, media types and invalid schemas before contacting storage", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error("Unexpected storage request"); };
  try {
    assert((await handleUsage(new Request("https://example.test"))).status === 405, "GET must fail");
    const unauthorized = request(payload());
    unauthorized.headers.delete("apikey");
    assert((await handleUsage(unauthorized)).status === 401, "Missing API key must fail");
    unauthorized.headers.set("apikey", "wrong");
    assert((await handleUsage(unauthorized)).status === 401, "Wrong API key must fail");
    assert((await handleUsage(request(payload(), "text/plain"))).status === 415, "Media type must fail");
    for (const value of [null, [], {}, { ...payload(), chat: "excluded" },
      { ...payload(), install_id: "invalid" }, { ...payload(), day: "2000-01-01" },
      { ...payload(), version: "01.2.3" }, { ...payload(), platform: "other" }]) {
      assert((await handleUsage(request(value))).status === 400, "Invalid schema must fail");
    }
    assert(calls === 0, "Rejected inputs must never reach storage");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("limits streamed bodies without trusting content-length and cancels slow bodies", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1025)); },
    cancel() { cancelled = true; },
  });
  const response = await handleUsage(new Request("https://example.test", {
    method: "POST", headers: { "content-type": "application/json", apikey: publicKey }, body,
  }));
  assert(response.status === 413 && cancelled, "Oversized stream must be cancelled");
  const slow = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  cancelled = false;
  const timedOut = await handleUsage(new Request("https://example.test", {
    method: "POST", headers: { "content-type": "application/json", apikey: publicKey }, body: slow,
  }));
  assert(timedOut.status === 408 && cancelled, "Slow stream must time out and cancel");
});

Deno.test("uses only internal service authentication and maps bounded RPC outcomes", async () => {
  const original = globalThis.fetch;
  const savedUrl = Deno.env.get("SUPABASE_URL");
  const savedKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
  let outcome = "recorded";
  globalThis.fetch = async (input, options) => {
    assert(String(input) === "https://example.supabase.co/rest/v1/rpc/record_bridge_usage", "RPC path must be fixed");
    const headers = new Headers(options?.headers);
    assert(headers.get("authorization") === "Bearer test-service-key", "RPC must use server credential");
    assert(options?.signal instanceof AbortSignal, "RPC must have a deadline");
    const fields = JSON.parse(String(options?.body));
    assert(Object.keys(fields).sort().join(",") === "p_day,p_install_id,p_platform,p_version", "RPC fields must stay minimal");
    return new Response(JSON.stringify(outcome), { headers: { "content-type": "application/json" } });
  };
  try {
    for (const [result, status] of [["recorded", 200], ["duplicate", 200], ["capacity", 429], ["busy", 503], ["invalid", 400]] as const) {
      outcome = result;
      const incoming = request({ ...payload(), version: "1.2.3-beta.1+build.2" });
      incoming.headers.set("authorization", "Bearer caller-key");
      assert((await handleUsage(incoming)).status === status, `Incorrect ${result} result`);
    }
    globalThis.fetch = async () => new Response("private database error", { status: 500 });
    const failure = await handleUsage(request(payload()));
    assert(failure.status === 503 && !(await failure.text()).includes("private"), "Dependency errors must not leak");
    globalThis.fetch = () => { throw new Error("private network error"); };
    assert((await handleUsage(request(payload()))).status === 503, "Network failure must remain optional");
    Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    assert((await handleUsage(request(payload()))).status === 503, "Missing configuration must fail closed");
  } finally {
    globalThis.fetch = original;
    if (savedUrl === undefined) Deno.env.delete("SUPABASE_URL"); else Deno.env.set("SUPABASE_URL", savedUrl);
    if (savedKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY"); else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedKey);
  }
});
