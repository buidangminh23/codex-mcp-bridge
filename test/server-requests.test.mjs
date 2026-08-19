import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { CodexAppServerClient } from "../src/app-server-client.mjs";
import { startFakeAppServer } from "./helpers/fake-app-server.mjs";

/**
 * Every request the app-server can send to a client, with the response field
 * its schema requires. Sourced from `codex app-server generate-json-schema`
 * (ServerRequest.json), identical in codex-cli 0.147 and 0.148.
 *
 * The app-server blocks the turn until the client answers, so an unhandled
 * method does not raise - the turn simply stops mid-run and looks like Codex
 * paused itself. Each reply shape is specific: they are not interchangeable.
 */
const SERVER_REQUESTS = [
  { method: "item/commandExecution/requestApproval", params: { command: ["ls"] }, expect: "decision" },
  { method: "item/fileChange/requestApproval", params: { changes: [] }, expect: "decision" },
  {
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true } } },
    expect: "permissions",
  },
  { method: "item/tool/requestUserInput", params: {}, expect: "answers" },
  { method: "mcpServer/elicitation/request", params: {}, expect: "action" },
  { method: "item/tool/call", params: { name: "x" }, expect: "success" },
  { method: "execCommandApproval", params: { command: ["ls"] }, expect: "decision" },
  { method: "applyPatchApproval", params: {}, expect: "decision" },
  { method: "attestation/generate", params: {}, expect: "error" },
  { method: "account/chatgptAuthTokens/refresh", params: {}, expect: "error" },
];

const REFUSED = SERVER_REQUESTS.filter((r) => r.expect === "error").map((r) => r.method);

async function answerOf(server, method, params) {
  const id = Math.floor(Math.random() * 1e6) + 1000;
  server.send({ jsonrpc: "2.0", id, method, params });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const answer = server.replies.find((m) => m.id === id);
    if (answer) return answer;
    await new Promise((r) => globalThis.setTimeout(r, 20));
  }
  return null;
}

describe("app-server requests are all answered", () => {
  let server;
  let client;

  before(async () => {
    server = await startFakeAppServer({});
    client = new CodexAppServerClient({ url: server.url, autoStart: false, log: () => {} });
    await client.connect();
  });

  after(async () => {
    client.ws?.close();
    await server.close();
  });

  for (const testCase of SERVER_REQUESTS) {
    it(`${testCase.method} gets a reply`, async () => {
      const answer = await answerOf(server, testCase.method, testCase.params);
      assert.ok(answer, `${testCase.method} was never answered - this is what stalls a turn mid-run`);
    });
  }

  for (const testCase of SERVER_REQUESTS.filter((r) => r.expect !== "error")) {
    it(`${testCase.method} replies with the shape its schema declares`, async () => {
      const answer = await answerOf(server, testCase.method, testCase.params);
      assert.equal(answer.error, undefined, `answered with a JSON-RPC error instead of ${testCase.expect}`);
      assert.ok(
        testCase.expect in (answer.result ?? {}),
        `result ${JSON.stringify(answer.result)} is missing "${testCase.expect}"`,
      );
    });
  }

  for (const method of REFUSED) {
    it(`${method} is refused on purpose`, async () => {
      const answer = await answerOf(server, method, {});
      assert.ok(answer.error, `${method} should be refused: the bridge cannot mint real tokens`);
      assert.match(answer.error.message, /codex-mcp-bridge/);
    });
  }

  it("an unknown method is refused rather than left hanging", async () => {
    const answer = await answerOf(server, "some/methodTheBridgeHasNeverHeardOf", {});
    assert.ok(answer, "an unknown method must still get a reply, or the turn stalls");
    assert.ok(answer.error);
  });

  it("denies approvals when configured to deny", async () => {
    const denying = await startFakeAppServer({});
    const denyClient = new CodexAppServerClient({
      url: denying.url,
      autoStart: false,
      approval: "deny",
      log: () => {},
    });
    await denyClient.connect();
    try {
      const answer = await answerOf(denying, "item/commandExecution/requestApproval", { command: ["rm", "-rf", "/"] });
      assert.equal(answer.result.decision, "decline");
    } finally {
      denyClient.ws?.close();
      await denying.close();
    }
  });

  it("denies approvals by default", async () => {
    assert.equal(client.approval, "deny");
    const answer = await answerOf(server, "item/fileChange/requestApproval", { changes: [{ path: "/tmp/x" }] });
    assert.equal(answer.result.decision, "decline");
  });

  it("requires an explicit acknowledgement before enabling automatic approval", () => {
    const messages = [];
    const guarded = new CodexAppServerClient({
      url: "ws://127.0.0.1:9",
      autoStart: false,
      approval: "approve",
      log: (message) => messages.push(message),
    });
    assert.equal(guarded.approval, "deny");
    assert.match(messages.join("\n"), /AUTO_APPROVE_ACK/);
  });
});
