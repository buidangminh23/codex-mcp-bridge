import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (entry) => JSON.parse(fs.readFileSync(path.join(root, entry), "utf8"));

test("portable and compatibility packages resolve the same production endpoint and skill", () => {
  const pkg = read("package.json");
  const manifest = read("plugin.json");
  const compatibility = read(".codex-plugin/plugin.json");
  const server = read("mcp.json").mcpServers[manifest.name];
  const legacyServer = read(".mcp.json").mcpServers[manifest.name];
  assert.equal(manifest.version, pkg.version);
  assert.equal(compatibility.version, pkg.version);
  assert.equal(manifest.author.email, "buidangminh23@gmail.com");
  assert.equal(manifest.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(server.type, "streamable-http");
  assert.equal(server.url, legacyServer.url);
  assert.equal(server.url, `${manifest.extensions["com.openai"].interface.websiteURL}/mcp`);
  const presentation = manifest.extensions["com.openai"].interface;
  assert.ok(presentation.shortDescription.length <= 30);
  assert.equal(presentation.category, "Developer Tools");
  for (const field of ["logo", "composerIcon"]) {
    assert.equal(presentation[field], compatibility.interface[field]);
    assert.match(presentation[field], /^\.\/assets\/[a-z-]+\.svg$/);
    const svg = fs.readFileSync(path.join(root, presentation[field]), "utf8");
    assert.match(svg, /viewBox="0 0 256 256"/);
    assert.doesNotMatch(svg, /<script|<foreignObject|href=/i);
  }
  for (const entry of ["plugin.json", "mcp.json", ".mcp.json", ".codex-plugin", "skills", "assets"]) {
    assert.ok(pkg.files.includes(entry), `npm package must include ${entry}`);
    assert.ok(fs.existsSync(path.join(root, entry)), `${entry} must exist`);
  }
  assert.ok(fs.existsSync(path.join(root, compatibility.skills, "codex-bridge", "SKILL.md")));
});
