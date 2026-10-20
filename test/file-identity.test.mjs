import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { it } from "node:test";
import { fileIdentity, sameFileIdentity } from "../src/file-identity.mjs";

const HIGH = 2n ** 60n;

it("serializes exact bigint identities as decimal strings that survive JSON", () => {
  const identity = fileIdentity(fs.lstatSync(os.tmpdir(), { bigint: true }));
  assert.equal(typeof identity.dev, "string");
  assert.equal(typeof identity.ino, "string");
  assert.deepEqual(JSON.parse(JSON.stringify(identity)), identity);
  assert.equal(sameFileIdentity(JSON.parse(JSON.stringify(identity)), identity), true);
  assert.throws(() => fileIdentity(fs.lstatSync(os.tmpdir())), /bigint stats/);
});

it("distinguishes identities that differ only below Number precision", () => {
  assert.equal(Number(HIGH), Number(HIGH + 1n), "Number stats would report these inodes as equal");
  const left = fileIdentity({ dev: 7n, ino: HIGH });
  const right = fileIdentity({ dev: 7n, ino: HIGH + 1n });
  assert.equal(sameFileIdentity(left, right), false);
  assert.equal(sameFileIdentity(fileIdentity({ dev: HIGH, ino: 7n }), fileIdentity({ dev: HIGH + 1n, ino: 7n })), false);
  assert.equal(sameFileIdentity(left, fileIdentity({ dev: 7n, ino: HIGH })), true);
});

it("accepts a legacy numeric identity only when it is exactly representable", () => {
  const exact = fileIdentity({ dev: 16777233n, ino: 71197354n });
  assert.equal(sameFileIdentity({ dev: 16777233, ino: 71197354 }, exact), true);
  assert.equal(sameFileIdentity({ dev: 16777233, ino: 71197355 }, exact), false);
  const rounded = { dev: 7, ino: Number(HIGH + 1n) };
  assert.equal(sameFileIdentity(rounded, fileIdentity({ dev: 7n, ino: HIGH })), false);
  assert.equal(sameFileIdentity(rounded, fileIdentity({ dev: 7n, ino: HIGH + 1n })), false);
});

it("rejects missing, fractional and non-decimal identity values", () => {
  const exact = fileIdentity({ dev: 1n, ino: 2n });
  for (const candidate of [undefined, null, {}, { dev: "1" }, { dev: "1", ino: "2.0" }, { dev: "1", ino: "0x2" },
    { dev: "1", ino: "2 " }, { dev: "1", ino: 2.5 }, { dev: "1", ino: "" }, { dev: true, ino: "2" }]) {
    assert.equal(sameFileIdentity(candidate, exact), false, JSON.stringify(candidate));
    assert.equal(sameFileIdentity(exact, candidate), false, JSON.stringify(candidate));
  }
});
