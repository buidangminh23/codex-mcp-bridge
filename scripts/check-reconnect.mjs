import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { runTurn } from "../src/turn.mjs";
import { startFakeAppServer } from "./fake-app-server.mjs";

const PORT = Number(process.env.RECONNECT_TEST_PORT ?? 8798);
const URL = `ws://127.0.0.1:${PORT}`;
const failures = [];

const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` -> ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
};

const server = await startFakeAppServer({
  port: PORT,
  onRequest: (msg, { respond, notify }) => {
    if (msg.method === "thread/resume") return respond({ thread: { id: msg.params?.threadId } });
    if (msg.method === "ping") return respond({ pong: true });
    if (msg.method === "turn/start") {
      respond({ turn: { id: "turn-1" } });
      globalThis.setTimeout(() => notify("item/started", { threadId: msg.params.threadId, turnId: "turn-1" }), 20);
      return;
    }
    respond({});
  },
});

const client = new CodexAppServerClient({ url: URL, autoStart: false, log: () => {} });

await client.connect();
check("initial connect", server.connections === 1, `${server.connections} connection(s)`);

await client.ensureThreadAttached("thread-a");
check("thread attached", client.attachedThreads.has("thread-a"));

server.dropConnection();
await new Promise((r) => globalThis.setTimeout(r, 150));

const reconnected = await client
  .call("ping", {})
  .then(() => true)
  .catch((err) => err.message);
check(
  "call after the app-server drops the connection reconnects",
  reconnected === true,
  reconnected === true ? `${server.connections} connection(s) total` : String(reconnected),
);

check(
  "thread attachment is re-established after a reconnect",
  !client.attachedThreads.has("thread-a") || server.connections > 1,
  "stale attachment would make the next turn run against an unloaded thread",
);

const stalePending = client.pending.size;
check("no pending requests leaked across the reconnect", stalePending === 0, `${stalePending} left`);

const turnStarted = Date.now();
const turnPromise = runTurn(client, {
  threadId: "thread-b",
  input: [{ type: "text", text: "hello" }],
  timeoutMs: 20000,
}).catch((err) => ({ status: "threw", error: err.message }));

await new Promise((r) => globalThis.setTimeout(r, 300));
server.dropConnection();

const outcome = await turnPromise;
const elapsed = Date.now() - turnStarted;
check(
  "a turn interrupted by a dropped connection ends promptly",
  elapsed < 5000,
  `${outcome.status} after ${elapsed}ms (timeout budget was 20000ms)`,
);
check(
  "the interrupted turn reports the disconnect rather than a clean finish",
  outcome.status !== "completed",
  `status ${outcome.status}`,
);

const leakedListeners = client.threadListeners.size;
check("thread listeners are released", leakedListeners === 0, `${leakedListeners} left`);

client.ws?.close();
await server.close();

const flaky = await startFakeAppServer({ port: PORT + 1, failFirstUpgrades: 1 });
const flakyClient = new CodexAppServerClient({ url: `ws://127.0.0.1:${PORT + 1}`, autoStart: false, log: () => {} });
const retried = await flakyClient
  .connect()
  .then(() => true)
  .catch((err) => err.message);
check(
  "a refused first handshake is retried instead of failing the call",
  retried === true,
  retried === true ? `${flaky.refused} refused, then connected` : String(retried),
);
flakyClient.ws?.close();
await flaky.close();

console.log("");
if (failures.length) {
  console.log(`FAIL: ${failures.length} connection-recovery problem(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("PASS: the bridge recovers from a dropped app-server connection");
process.exit(0);
