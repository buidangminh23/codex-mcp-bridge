import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { BridgeSecurityPolicy, assertAllowedAppServerUrl } from "../src/security-policy.mjs";

describe("bridge security policy", () => {
  it("denies thread access until an exact thread capability is configured", () => {
    const policy = new BridgeSecurityPolicy({});
    assert.throws(() => policy.assertThread("thread-a"), /No authorized Codex threads/);

    const configured = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_THREADS: "thread-a, thread-b" });
    configured.assertThread("thread-a");
    assert.throws(() => configured.assertThread("thread-c"), /not authorized/);
  });

  it("keeps newly created threads in the bridge-owned capability set", () => {
    const policy = new BridgeSecurityPolicy({});
    policy.registerThread("created-here");
    policy.assertThread("created-here");
    assert.deepEqual(policy.filterThreads([{ id: "created-here" }, { id: "other" }]), [{ id: "created-here" }]);
  });

  it("contains cwd access to configured roots, including traversal attempts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-policy-"));
    const child = path.join(root, "project");
    fs.mkdirSync(child);
    try {
      const policy = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: root });
      policy.assertCwd(child);
      assert.throws(() => policy.assertCwd(path.join(root, "..", "outside")), /outside CODEX_BRIDGE_ALLOWED_ROOTS/);
      assert.throws(() => new BridgeSecurityPolicy({ CODEX_BRIDGE_SANDBOX: "danger-full-access" }), /must be read-only/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated remote app-server endpoints", () => {
    assertAllowedAppServerUrl("ws://127.0.0.1:8791");
    assert.throws(() => assertAllowedAppServerUrl("ws://192.0.2.10:8791"), /non-loopback/);
    assert.throws(() => assertAllowedAppServerUrl("http://127.0.0.1:8791"), /ws:\/\//);
  });
});
