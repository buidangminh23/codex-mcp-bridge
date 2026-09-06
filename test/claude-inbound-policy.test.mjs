import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

import { readClaudeInboundPolicy } from "../src/claude-inbound-policy.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-inbound-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture() {
  const home = fs.mkdtempSync(path.join(root, "home-"));
  const cwd = path.join(home, "project");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const managedFile = path.join(home, "managed-settings.json");
  const write = (file, value) => fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  const read = () => readClaudeInboundPolicy(cwd, { home, managedFile });
  return { home, cwd, managedFile, write, read, user: path.join(home, ".claude", "settings.json"), project: path.join(cwd, ".claude", "settings.json"), local: path.join(cwd, ".claude", "settings.local.json") };
}

it("leaves the decision to Claude's parity default when no source sets a value", () => {
  const f = fixture();
  assert.deepEqual(f.read(), { value: null, source: null });
  f.write(f.user, { permissions: {} });
  f.write(f.project, { crossSessionInbound: "accept" });
  assert.deepEqual(f.read(), { value: null, source: null }, "a project file cannot loosen the default");
});

it("honours the user's explicit accept and lets project or local files only tighten it", () => {
  const f = fixture();
  f.write(f.user, { crossSessionInbound: "accept" });
  assert.deepEqual(f.read(), { value: "accept", source: "user" });
  f.write(f.local, { crossSessionInbound: "hold" });
  assert.deepEqual(f.read(), { value: "hold", source: "local" });
  f.write(f.project, { crossSessionInbound: "refuse" });
  assert.deepEqual(f.read(), { value: "refuse", source: "project" });
});

it("treats an unrecognised value as hold and managed settings as authoritative", () => {
  const f = fixture();
  f.write(f.user, { crossSessionInbound: "yes" });
  assert.deepEqual(f.read(), { value: "hold", source: "user" });
  f.write(f.managedFile, { crossSessionInbound: "accept" });
  assert.deepEqual(f.read(), { value: "accept", source: "managed" });
  f.write(f.managedFile, { crossSessionInbound: "bogus" });
  assert.deepEqual(f.read(), { value: "refuse", source: "managed" });
});

it("ignores unreadable files and a relative or missing project directory", () => {
  const f = fixture();
  f.write(f.user, "{not json");
  assert.deepEqual(f.read(), { value: null, source: null });
  f.write(f.user, { crossSessionInbound: "accept" });
  assert.deepEqual(readClaudeInboundPolicy("relative/dir", { home: f.home, managedFile: f.managedFile }), { value: "accept", source: "user" });
  assert.deepEqual(readClaudeInboundPolicy(undefined, { home: f.home, managedFile: f.managedFile }), { value: "accept", source: "user" });
});
