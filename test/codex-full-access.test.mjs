import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  applyFullAccessPolicy,
  enableCodexFullAccess,
  fullAccessConfigContents,
  fullAccessEnabled,
  fullAccessPolicyContents,
} from "../src/codex-full-access.mjs";

function fixture(action) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-full-access-"));
  const paths = {
    config: path.join(directory, "home", "config.toml"),
    marker: path.join(directory, "home", "bridge-full-access.enabled"),
    policy: path.join(directory, "system", "requirements.toml"),
  };
  try { return action(paths); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

describe("Codex Full access setup", () => {
  it("repairs an invalid managed policy and preserves unrelated settings", () => fixture((paths) => {
    fs.mkdirSync(path.dirname(paths.config), { recursive: true });
    fs.mkdirSync(path.dirname(paths.policy), { recursive: true });
    fs.writeFileSync(paths.config, 'model = "gpt-6.1-sol"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[projects."C:\\work"]\ntrust_level = "trusted"\n');
    fs.writeFileSync(paths.policy, 'allowed_sandbox_modes = ["danger-full-access"]\nallowed_approval_policies = ["on-request"]\n\n[allowed_permission_profiles]\n":danger-full-access" = false\n\n[other_section]\nkeep = true\n');

    assert.equal(fullAccessEnabled(paths), false);
    enableCodexFullAccess({ paths, allowElevation: false });
    const config = fs.readFileSync(paths.config, "utf8");
    const policy = fs.readFileSync(paths.policy, "utf8");
    assert.match(config, /^approval_policy = "never"\nsandbox_mode = "danger-full-access"/);
    assert.match(config, /model = "gpt-6.1-sol"/);
    assert.match(config, /trust_level = "trusted"/);
    assert.match(policy, /^default_permissions = ":danger-full-access"/);
    assert.match(policy, /allowed_approval_policies = \["never"\]/);
    assert.match(policy, /allowed_sandbox_modes = \["read-only", "danger-full-access"\]/);
    assert.match(policy, /\[allowed_permission_profiles\]\n":danger-full-access" = true/);
    assert.match(policy, /\[other_section\]\nkeep = true/);
    assert.equal(fullAccessEnabled(paths), true);

    enableCodexFullAccess({ paths, allowElevation: false });
    assert.equal(fs.readFileSync(paths.config, "utf8"), config);
    assert.equal(fs.readFileSync(paths.policy, "utf8"), policy);
  }));

  it("creates global configuration and the required managed policy on a fresh machine", () => fixture((paths) => {
    enableCodexFullAccess({ paths, allowElevation: false });
    assert.match(fs.readFileSync(paths.config, "utf8"), /approval_policy = "never"/);
    assert.match(fs.readFileSync(paths.policy, "utf8"), /allowed_sandbox_modes = \["read-only", "danger-full-access"\]/);
    assert.equal(fullAccessEnabled(paths), true);
  }));

  it("preserves valid files and normalizes only the requested policy fields", () => {
    const config = 'approval_policy = "never"\r\nsandbox_mode = "danger-full-access"\r\nmodel = "gpt-6.1-sol"\r\n';
    assert.equal(fullAccessConfigContents(config), config);
    const policy = 'allowed_sandbox_modes = ["danger-full-access"]\r\n\r\n[allowed_permission_profiles]\r\n":danger-full-access" = false\r\n';
    const repaired = fullAccessPolicyContents(policy);
    assert.equal(fullAccessPolicyContents(repaired), repaired);
    assert.ok(repaired.includes("\r\n"));
    assert.ok(!repaired.includes('":danger-full-access" = false'));
  });

  it("does not enable automatic repair after a failed policy write", () => fixture((paths) => {
    fs.mkdirSync(paths.policy, { recursive: true });
    assert.throws(() => enableCodexFullAccess({ paths, allowElevation: false }));
    assert.equal(fullAccessEnabled(paths), false);
  }));

  it("refuses to follow a symbolic-link managed policy", { skip: process.platform === "win32" }, () => fixture((paths) => {
    const target = path.join(path.dirname(paths.policy), "target.toml");
    fs.mkdirSync(path.dirname(paths.policy), { recursive: true });
    fs.writeFileSync(target, 'allowed_sandbox_modes = ["danger-full-access"]\n');
    fs.symlinkSync(target, paths.policy);
    assert.throws(() => applyFullAccessPolicy(paths.policy), /symbolic-link/);
    assert.equal(fs.readFileSync(target, "utf8"), 'allowed_sandbox_modes = ["danger-full-access"]\n');
  }));

  it("restores saved access when a Desktop bridge process starts", { skip: process.platform !== "win32" }, () => fixture((paths) => {
    fs.mkdirSync(path.dirname(paths.marker), { recursive: true });
    fs.writeFileSync(paths.marker, "enabled\n");
    const programData = path.join(path.dirname(paths.policy), "program-data");
    const result = spawnSync(process.execPath, [path.resolve("src/index.mjs")], {
      env: {
        ...process.env,
        CODEX_HOME: path.dirname(paths.config),
        ProgramData: programData,
        CODEX_BRIDGE_DESKTOP_TASKS: "1",
      },
      input: "",
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(paths.config, "utf8"), /approval_policy = "never"/);
    assert.match(fs.readFileSync(path.join(programData, "OpenAI", "Codex", "requirements.toml"), "utf8"), /allowed_sandbox_modes = \["read-only", "danger-full-access"\]/);
  }));
});
