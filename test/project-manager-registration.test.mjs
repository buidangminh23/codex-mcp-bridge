import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerProjectManager } from '../src/project-manager-registration.mjs';
import { prepareBridgeProject } from '../src/project-onboarding.mjs';

test('optional manager registration is idempotent and neither grants projects nor needs the card extension', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-registration-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' };
  const policyFile = path.join(home, 'policy.json');
  const first = registerProjectManager({ policyFile, env });
  assert.equal(first.changed, true);
  assert.equal(fs.existsSync(policyFile), false);
  assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
  const descriptor = JSON.parse(fs.readFileSync(first.file));
  assert.equal(descriptor.node, process.execPath);
  assert.equal(descriptor.policyFile, policyFile);
  assert.equal(path.basename(descriptor.script), 'bridge-projects.mjs');
  assert.equal(registerProjectManager({ policyFile, env }).changed, false);
  // Removing the UI adapter does not affect core onboarding.
  fs.unlinkSync(first.file);
  const cwd = path.join(home, 'repo'); fs.mkdirSync(cwd);
  const result = prepareBridgeProject({ cwd }, { env: { ...env, CODEX_BRIDGE_PROJECT_POLICY: policyFile } });
  assert.equal(result.status, 'configured');
  assert.equal(fs.existsSync(first.file), false);
});

test('manager registration preserves a prior descriptor and refuses linked destinations', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-backup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '' };
  const original = registerProjectManager({ policyFile: path.join(home, 'one.json'), env });
  const raw = fs.readFileSync(original.file, 'utf8');
  registerProjectManager({ policyFile: path.join(home, 'two.json'), env });
  const dir = path.dirname(original.file);
  const backup = fs.readdirSync(dir).find(f => f.startsWith('management.json.backup-'));
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), raw);
  fs.linkSync(original.file, path.join(home, 'linked.json'));
  assert.throws(() => registerProjectManager({ policyFile: path.join(home, 'three.json'), env }), /Invalid manager/);
});
