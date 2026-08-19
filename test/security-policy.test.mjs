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
    assert.throws(() => policy.assertThread("other"), /not authorized/);
  });

  /**
   * Gating the listing on the send allowlist as well left no way to reach a
   * thread at all: an id cannot be allowlisted before it is known, and the
   * bridge is the only thing that can report it. Naming a root is the
   * operator declaring that project in scope, which is what makes the id
   * safe to disclose - acting on it still needs the allowlist.
   */
  it("lists threads inside an allowed root even before they are allowlisted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-policy-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-"));
    try {
      fs.mkdirSync(path.join(root, "project"));
      const policy = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: root });
      const listed = policy.filterThreads([
        { id: "in-scope", cwd: root },
        { id: "nested", cwd: path.join(root, "project") },
        { id: "elsewhere", cwd: outside },
        { id: "no-cwd" },
        { id: "gone", cwd: path.join(root, "deleted-since") },
      ]);

      assert.deepEqual(
        listed.map((thread) => thread.id),
        ["in-scope", "nested", "gone"],
        "a directory inside the root counts as inside it whether or not it still exists - " +
          "the answer must not depend on whether the platform put a symlink above the root",
      );
      assert.equal(policy.isThreadAuthorized("in-scope"), false, "listing must not grant the right to send");
      assert.throws(() => policy.assertThread("in-scope"), /No authorized Codex threads/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  /**
   * The case containment exists for. A link inside an allowed root that points
   * out of it must resolve to where it really goes - otherwise the root is a
   * suggestion, and anything reachable by one hop is in scope.
   */
  it("treats a symlink out of an allowed root as outside it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-"));
    try {
      fs.mkdirSync(path.join(outside, "secrets"));
      fs.symlinkSync(outside, path.join(root, "escape"));
      const policy = new BridgeSecurityPolicy({ CODEX_BRIDGE_ALLOWED_ROOTS: root });

      assert.equal(policy.isCwdAuthorized(path.join(root, "escape")), false);
      assert.equal(policy.isCwdAuthorized(path.join(root, "escape", "secrets")), false);
      assert.equal(
        policy.isCwdAuthorized(path.join(root, "escape", "not-created-yet")),
        false,
        "a missing leaf must not launder a path back inside the root",
      );
      assert.equal(policy.isCwdAuthorized(path.join(root, "real")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("lists nothing at all when no workspace root is configured", () => {
    const policy = new BridgeSecurityPolicy({});
    assert.deepEqual(policy.filterThreads([{ id: "a", cwd: "/tmp" }, { id: "b", cwd: "/" }]), []);
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
