import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { it } from "node:test";

import { removeRelayFile, verifyRelaySocketMode } from "../src/native-relay-files.mjs";
import { RelaySocketServer } from "../src/native-relay-companion.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-files-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

it("removes only the relay configuration in a custom Codex directory", (t) => {
  const directory = fixture(t);
  const config = path.join(directory, "native-relay.json");
  const other = path.join(directory, "config.toml");
  fs.writeFileSync(config, "{}");
  fs.writeFileSync(other, "preserved");
  assert.throws(() => removeRelayFile(other, { kind: "config", directory }), /filename/);
  assert.equal(removeRelayFile(config, { kind: "config", directory }), true);
  assert.equal(removeRelayFile(config, { kind: "config", directory }), false);
  assert.equal(fs.readFileSync(other, "utf8"), "preserved");
});

it("refuses regular files and directories selected as relay sockets", (t) => {
  const directory = fixture(t);
  const victim = path.join(directory, "important.txt");
  fs.writeFileSync(victim, "preserved", { mode: 0o644 });
  assert.throws(() => removeRelayFile(victim), /Unsafe relay/);
  assert.throws(() => removeRelayFile(directory), /Unsafe relay/);
  assert.throws(() => verifyRelaySocketMode(victim), /Unsafe relay/);
  assert.equal(fs.readFileSync(victim, "utf8"), "preserved");
});

it("refuses configuration hardlinks without deleting either name", (t) => {
  const directory = fixture(t);
  const victim = path.join(directory, "important.txt");
  const config = path.join(directory, "native-relay.json");
  fs.writeFileSync(victim, "preserved");
  fs.linkSync(victim, config);
  assert.throws(() => removeRelayFile(config, { kind: "config" }), /Unsafe relay/);
  assert.equal(fs.readFileSync(victim, "utf8"), "preserved");
  assert.equal(fs.readFileSync(config, "utf8"), "preserved");
});

it("refuses configuration symlinks and socket symlinks", { skip: process.platform === "win32" }, (t) => {
  const directory = fixture(t);
  const victim = path.join(directory, "important.txt");
  const config = path.join(directory, "native-relay.json");
  fs.writeFileSync(victim, "preserved", { mode: 0o644 });
  fs.symlinkSync(victim, config);
  assert.throws(() => removeRelayFile(config, { kind: "config" }), /Unsafe relay/);
  assert.throws(() => removeRelayFile(config), /Unsafe relay/);
  assert.throws(() => verifyRelaySocketMode(config), /Unsafe relay/);
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
});

it("removes a Unix socket with a custom filename while preserving its directory", { skip: process.platform === "win32" }, async (t) => {
  const directory = fixture(t);
  const target = path.join(directory, "custom-endpoint");
  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.listen(target);
  await once(server, "listening");
  assert.equal(removeRelayFile(target), true);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.statSync(directory).isDirectory(), true);
});

it("creates Unix relay sockets privately before the restriction hook and restores umask", { skip: process.platform === "win32" }, async (t) => {
  const directory = fixture(t);
  const originalMask = process.umask();
  let checked = false;
  const relay = new RelaySocketServer({
    socketPath: path.join(directory, "custom-endpoint"),
    signalExit: false,
    restrictSocket: (target, identity) => {
      assert.equal(process.umask(), originalMask);
      verifyRelaySocketMode(target, identity);
      checked = true;
    },
  });
  t.after(async () => { relay.stop(); await relay.closed; });
  await relay.start();
  assert.equal(checked, true);
  assert.equal(process.umask(), originalMask);
});

it("preserves a regular file and restores umask when a relay cannot bind", { skip: process.platform === "win32" }, async (t) => {
  const directory = fixture(t);
  const target = path.join(directory, "important.txt");
  fs.writeFileSync(target, "preserved", { mode: 0o644 });
  const originalMask = process.umask();
  const relay = new RelaySocketServer({ socketPath: target, signalExit: false });
  t.after(async () => { relay.stop(); await relay.closed; });
  await assert.rejects(relay.start(), /Unsafe relay/);
  assert.equal(process.umask(), originalMask);
  assert.equal(fs.readFileSync(target, "utf8"), "preserved");
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

it("refuses replaced socket identities before accepting their permissions", { skip: process.platform === "win32" }, async (t) => {
  const directory = fixture(t);
  const target = path.join(directory, "relay.sock");
  const relay = new RelaySocketServer({ socketPath: target, signalExit: false });
  t.after(async () => { relay.stop(); await relay.closed; });
  await relay.start();
  const identity = fs.lstatSync(target, { bigint: true });
  assert.throws(() => verifyRelaySocketMode(target, { ...identity, ino: identity.ino + 1n }), /Unsafe relay/);
});
