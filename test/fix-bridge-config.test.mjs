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

const processCases = [
  { name: 'Squirrel Desktop', executable: String.raw`C:\Users\fixture\AppData\Local\AnthropicClaude\app-1.0\claude.exe`, blocked: ['desktop'] },
  { name: 'Roaming CLI', executable: String.raw`C:\Users\fixture\AppData\Roaming\Claude\claude-code\claude.exe`, blocked: ['cli'] },
  { name: 'VS Code CLI', executable: String.raw`C:\Users\fixture\.vscode\extensions\anthropic.claude-code-1.0\resources\native-binary\claude.exe`, blocked: ['cli'] },
  { name: 'MSIX Desktop', executable: String.raw`C:\Program Files\WindowsApps\Claude_1.0_x64__fixture\app\claude.exe`, blocked: ['desktop'] },
  { name: 'no running processes', executable: null, blocked: [] },
  { name: 'unknown executable path', executable: undefined, blocked: ['desktop', 'cli'] },
];

function guardFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-process-'));
  const appdata = path.join(directory, 'AppData', 'Roaming');
  const profile = path.join(directory, 'User');
  const files = { desktop: path.join(appdata, 'Claude', 'claude_desktop_config.json'), cli: path.join(profile, '.claude.json') };
  const original = JSON.stringify({ mcpServers: { 'codex-bridge': { command: process.execPath, args: ['old/index.mjs'] } } });
  for (const file of Object.values(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
  }
  const marker = path.join(directory, 'process-query.txt');
  const execute = (target, processes, whatIf = false) => spawnSync('pwsh', ['-NoProfile', '-Command', `
    $ErrorActionPreference = 'Stop'
    $env:APPDATA = $env:BRIDGE_TEST_APPDATA
    $env:USERPROFILE = $env:BRIDGE_TEST_PROFILE
    $query = {
      [IO.File]::WriteAllText($env:BRIDGE_TEST_QUERY_MARKER, 'queried')
      ConvertFrom-Json -InputObject $env:BRIDGE_TEST_PROCESSES
    }
    $arguments = @{ ConfigPath = $env:BRIDGE_TEST_CONFIG; RunningProcesses = $query }
    if ($env:BRIDGE_TEST_WHATIF -eq '1') { $arguments.WhatIf = $true }
    & $env:BRIDGE_TEST_SCRIPT @arguments
  `], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      BRIDGE_TEST_APPDATA: appdata,
      BRIDGE_TEST_PROFILE: profile,
      BRIDGE_TEST_SCRIPT: path.join(root, 'fix-bridge-config.ps1'),
      BRIDGE_TEST_CONFIG: files[target],
      BRIDGE_TEST_PROCESSES: JSON.stringify(processes),
      BRIDGE_TEST_QUERY_MARKER: marker,
      BRIDGE_TEST_WHATIF: whatIf ? '1' : '0',
    },
  });
  return { directory, files, original, marker, execute };
}

for (const scenario of processCases) {
  test(`process guard distinguishes ${scenario.name}`, { skip: !available }, () => {
    const fixture = guardFixture();
    const processes = scenario.executable === null ? [] : [{ Name: 'claude.exe', ExecutablePath: scenario.executable }];
    try {
      for (const target of ['desktop', 'cli']) {
        const result = fixture.execute(target, processes);
        const file = fixture.files[target];
        if (scenario.blocked.includes(target)) {
          assert.notEqual(result.status, 0, `${target}: ${result.stdout} ${result.stderr}`);
          assert.match(result.stderr, target === 'desktop' ? /Close Claude Desktop/ : /Close Claude Code/);
          assert.equal(fs.readFileSync(file, 'utf8'), fixture.original);
          assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
        } else {
          assert.equal(result.status, 0, `${target}: ${result.stderr}`);
          assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['codex-bridge'].args, [path.join(root, 'src', 'mcp-supervisor.mjs'), 'index.mjs']);
          assert.equal(fs.readdirSync(path.dirname(file)).length, 2);
        }
        assert.equal(fs.readFileSync(fixture.marker, 'utf8'), 'queried');
        fs.unlinkSync(fixture.marker);
      }
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
}

test('WhatIf neither writes configuration nor queries running processes', { skip: !available }, () => {
  const fixture = guardFixture();
  try {
    for (const target of ['desktop', 'cli']) {
      const result = fixture.execute(target, [{ Name: 'claude.exe' }], true);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(fixture.files[target], 'utf8'), fixture.original);
      assert.deepEqual(fs.readdirSync(path.dirname(fixture.files[target])), [path.basename(fixture.files[target])]);
    }
    assert.equal(fs.existsSync(fixture.marker), false);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
