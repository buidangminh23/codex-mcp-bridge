import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { BridgeSecurityPolicy } from "../src/security-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withRoot(run) {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-threadpolicy-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-elsewhere-"));
  try {
    run({ allowed, outside });
  } finally {
    fs.rmSync(allowed, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

describe("thread authorization policy", () => {
  /**
   * The bug this policy exists for. A thread opened in the Codex app or the
   * VS Code extension is handed its id at that moment, so it can never have
   * been listed in CODEX_BRIDGE_ALLOWED_THREADS ahead of time, and the
   * bridge-owned set is in-memory and empties on restart. Under the old
   * behaviour that made every human-opened thread permanently unreachable -
   * not restricted, unreachable - which is what "not authorized" meant on
   * nine out of ten live threads.
   */
  it("reaches a thread nobody allowlisted once the workspace is in scope", () => {
    withRoot(({ allowed }) => {
      const project = path.join(allowed, "project");
      fs.mkdirSync(project);

      const owned = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: allowed });
      assert.throws(
        () => owned.assertThread("opened-in-vscode", project),
        /No authorized Codex threads/,
        "the default policy still refuses a thread it did not create",
      );

      const roots = new BridgeSecurityPolicy({
        CODEX_BRIDGE_ALLOWED_ROOTS: allowed,
        CODEX_BRIDGE_THREAD_POLICY: "roots",
      });
      roots.assertThread("opened-in-vscode", project);
      assert.equal(roots.isThreadAuthorized("opened-in-vscode", project), true);
    });
  });

  it("still refuses a thread working outside every allowed root", () => {
    withRoot(({ allowed, outside }) => {
      const policy = new BridgeSecurityPolicy({
        CODEX_BRIDGE_ALLOWED_ROOTS: allowed,
        CODEX_BRIDGE_THREAD_POLICY: "roots",
      });
      assert.equal(policy.isThreadAuthorized("elsewhere", outside), false);
      assert.throws(() => policy.assertThread("elsewhere", outside), /outside CODEX_BRIDGE_ALLOWED_ROOTS/);
    });
  });

  /**
   * An unknown workspace must fail closed. It is the same shape as a thread
   * outside the roots - there is no evidence it is inside one - and treating
   * the absence as permission would make the policy depend on whether the
   * app-server happened to report a cwd.
   */
  it("refuses a thread that reports no workspace at all", () => {
    withRoot(({ allowed }) => {
      const policy = new BridgeSecurityPolicy({
        CODEX_BRIDGE_ALLOWED_ROOTS: allowed,
        CODEX_BRIDGE_THREAD_POLICY: "roots",
      });
      assert.equal(policy.isThreadAuthorized("nowhere"), false);
      assert.throws(() => policy.assertThread("nowhere"), /reports no workspace/);
      assert.throws(() => policy.assertThread("nowhere", null), /reports no workspace/);
    });
  });

  /**
   * The whole point of making this a setting rather than a fix in place: an
   * install that upgrades and changes nothing must keep the access it had.
   */
  it("defaults to the previous behaviour so an upgrade cannot widen access", () => {
    withRoot(({ allowed }) => {
      const policy = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: allowed });
      assert.equal(policy.threadPolicy, "owned");
      assert.equal(policy.summary().threadPolicy, "owned");
      assert.equal(policy.isThreadAuthorized("anything", allowed), false);
    });
  });

  it("rejects a policy value it does not implement instead of guessing", () => {
    assert.throws(
      () => new BridgeSecurityPolicy({ CODEX_BRIDGE_THREAD_POLICY: "all" }),
      /must be owned or roots/,
    );
    assert.throws(
      () => new BridgeSecurityPolicy({ CODEX_BRIDGE_THREAD_POLICY: "" }),
      /must be owned or roots/,
      "an empty value is a misconfiguration, not a request for the default",
    );
  });

  it("keeps a thread the bridge created reachable regardless of policy", () => {
    for (const threadPolicy of ["owned", "roots"]) {
      const policy = new BridgeSecurityPolicy({ CODEX_BRIDGE_THREAD_POLICY: threadPolicy });
      policy.registerThread("created-here");
      policy.assertThread("created-here");
    }
  });
});

/**
 * Under `roots` the id alone never proves anything - the workspace does. That
 * only holds while every tool that acts on a thread actually asks. This reads
 * the server source rather than mocking it, because the failure it guards
 * against is a new tool being added without the gate, which no runtime test
 * exercising the existing tools would ever notice.
 */
describe("every thread tool is gated on the workspace", () => {
  const source = fs.readFileSync(path.join(root, "src", "index.mjs"), "utf8");
  const tools = source
    .split("server.registerTool(")
    .slice(1)
    .map((block) => ({ name: block.match(/^\s*"([^"]+)"/)?.[1] ?? "(unnamed)", body: block }))
    .filter((tool) => /threadId: z\.string\(\)/.test(tool.body));

  it("finds every tool that takes a thread id", () => {
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      "interrupt_codex_turn",
      "open_codex_thread",
      "read_codex_thread",
      "send_to_codex_thread",
    ]);
  });

  for (const tool of tools) {
    it(`${tool.name} authorizes the thread before acting on it`, () => {
      assert.match(
        tool.body,
        /await assertThreadAccess\(threadId\)/,
        `${tool.name} acts on a caller-supplied thread without asking whether this bridge may touch it`,
      );
      assert.match(
        tool.body,
        /security\.assertCwd\(/,
        `${tool.name} never checks the workspace it ends up working in`,
      );
    });
  }

  /**
   * Attaching takes the per-thread writer lock from whoever else has the
   * thread open, so it must never happen on the way to a refusal.
   */
  it("authorizes before attaching, because attaching takes the writer lock", () => {
    const send = tools.find((tool) => tool.name === "send_to_codex_thread").body;
    assert.ok(
      send.indexOf("await assertThreadAccess(threadId)") < send.indexOf("ensureThreadAttached"),
      "send_to_codex_thread attaches to the thread before deciding whether it is allowed to",
    );
    assert.ok(
      send.indexOf("security.assertCwd(attached.thread?.cwd)") < send.indexOf("openThreadInCodexApp"),
      "send_to_codex_thread raises the thread on screen before it is known to be in scope",
    );
  });
});
