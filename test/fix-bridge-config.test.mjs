import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const available = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']).status === 0;

test('configuration repair preserves policy, handles both entry names, and is idempotent', { skip: !available }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'));
  const file = path.join(directory, 'config.json');
  const execute = (...args) => spawnSync('pwsh', ['-NoProfile', '-File', path.join(root, 'fix-bridge-config.ps1'), '-ConfigPath', file, ...args], { encoding: 'utf8' });
  try {
    const original = { unrelated: { keep: [1, 2] }, mcpServers: {
      'codex-bridge': { command: process.execPath, args: ['old/index.mjs'], env: { CODEX_BRIDGE_THREAD_POLICY: 'on-request', CODEX_BRIDGE_ALLOWED_ROOTS: '/restricted', CUSTOM: 'keep' } },
      'codex-bridge-desktop': { command: process.execPath, args: ['old/index.mjs'], env: { CODEX_BRIDGE_AUTOSTART: '1' } },
      other: { command: 'untouched' },
    } };
    fs.writeFileSync(file, JSON.stringify(original));
    const before = fs.readFileSync(file, 'utf8');
    let result = execute('-WhatIf');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readdirSync(directory).length, 1);
    result = execute();
    assert.equal(result.status, 0, result.stderr);
    const repaired = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(repaired.unrelated, original.unrelated);
    assert.deepEqual(repaired.mcpServers.other, original.mcpServers.other);
    assert.deepEqual(repaired.mcpServers['codex-bridge'].env, original.mcpServers['codex-bridge'].env);
    for (const name of ['codex-bridge', 'codex-bridge-desktop']) {
      assert.deepEqual(repaired.mcpServers[name].args, [path.join(root, 'src', 'mcp-supervisor.mjs'), 'index.mjs']);
    }
    assert.equal(repaired.mcpServers['codex-bridge-desktop'].env.CODEX_BRIDGE_DESKTOP_TASKS, '1');
    assert.equal(repaired.mcpServers['codex-bridge-desktop'].env.CODEX_BRIDGE_AUTOSTART, '0');
    assert.equal(fs.readdirSync(directory).length, 2);
    const fixed = fs.readFileSync(file, 'utf8');
    result = execute();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(file, 'utf8'), fixed);
    assert.equal(fs.readdirSync(directory).length, 2);
    fs.writeFileSync(file, '{invalid');
    result = execute();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
    assert.notEqual(execute().status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
