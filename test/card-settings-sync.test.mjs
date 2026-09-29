import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncCardSettings } from '../src/card-settings-sync.mjs';
import { updateProjectPolicy, editProjectGrant, readProjectPolicy, createProjectScope } from '../src/project-scope.mjs';
const empty = () => ({ projects: [], parents: [], excluded: [] });
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'card-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a'), b = path.join(root, 'b'); fs.mkdirSync(a); fs.mkdirSync(b);
  const file = path.join(root, 'policy.json');
  const edit = (action, p) => updateProjectPolicy(file, policy => editProjectGrant(policy, action, p));
  const sync = page => syncCardSettings(file, page);
  const read = () => readProjectPolicy(file).policy;
  return { root, a, b, file, edit, sync, read };
}
test('first empty native page imports existing MCP grants without revoking or trusting anything', t => {
  const f = fixture(t); f.edit('allow-project', f.a);
  const result = f.sync(empty());
  assert.deepEqual(result.target.projects, [f.a]); assert.equal(result.needsPageUpdate, true);
  assert.equal(result.authorizationChanged, false);
  assert.equal(fs.existsSync(path.join(f.root, '.claude.json')), false);
  assert.equal(f.sync(result.target).needsPageUpdate, false);
  const files = fs.readdirSync(f.root); const raw = fs.readFileSync(f.file, 'utf8');
  f.sync(result.target);
  assert.equal(fs.readFileSync(f.file, 'utf8'), raw); assert.deepEqual(fs.readdirSync(f.root), files);
});
test('native save authorizes projects and parents; removing project blocks inherited grant', t => {
  const f = fixture(t);
  let page = { projects: [f.a], parents: [f.root], excluded: [] };
  f.sync(page); assert.equal(createProjectScope(f.file).allows(f.b), true);
  page = { ...page, projects: [] };
  const result = f.sync(page);
  assert.deepEqual(result.target.excluded, [f.a]);
  assert.equal(createProjectScope(f.file).allows(f.a), false);
  assert.equal(createProjectScope(f.file).allows(f.b), true);
});
test('removing a parent preserves independently authorized projects', t => {
  const f = fixture(t); const page = { projects: [f.a], parents: [f.root], excluded: [] };
  f.sync(page); f.sync({ ...page, parents: [] });
  assert.equal(createProjectScope(f.file).allows(f.a), true);
  assert.equal(createProjectScope(f.file).allows(f.b), false);
});
test('stale native page never restores a revoked project, including an unrelated Save', t => {
  const f = fixture(t); const page = { ...empty(), projects: [f.a] }; f.sync(page);
  f.edit('revoke', f.a);
  const result = f.sync(page); assert.deepEqual(result.target.excluded, [f.a]);
  f.sync({ ...page, projects: [f.a, f.b] });
  assert.equal(createProjectScope(f.file).allows(f.a), false);
  assert.equal(createProjectScope(f.file).allows(f.b), true);
});
test('a concurrent manual page edit conflicts instead of replacing newer MCP records', t => {
  const f = fixture(t); f.sync(empty()); f.edit('allow-project', f.a);
  const result = f.sync({ ...empty(), projects: [f.b] });
  assert.equal(result.status, 'conflict_preserved'); assert.deepEqual(result.target.projects, [f.a]);
});
test('delayed helper Save after a newer revocation is only a render acknowledgement', t => {
  const f = fixture(t); f.edit('revoke', f.a);
  let projected = f.sync(empty()).target; f.sync(projected);
  f.edit('allow-project', f.a); const oldRender = f.sync(projected).target;
  f.edit('revoke', f.a); f.sync(projected);
  const delayed = f.sync(oldRender);
  assert.equal(delayed.authorizationChanged, false);
  assert.equal(createProjectScope(f.file).allows(f.a), false);
  assert.deepEqual(delayed.target.excluded, [f.a]);
});
test('removing a displayed exclusion and adding the project explicitly reauthorizes', t => {
  const f = fixture(t); f.edit('revoke', f.a); const page = f.sync(empty()).target; f.sync(page);
  f.sync({ ...empty(), projects: [f.a] }); assert.equal(createProjectScope(f.file).allows(f.a), true);
});
test('new grant without removing known exclusion cannot clear it', t => {
  const f = fixture(t); f.edit('revoke', f.a); const page = f.sync(empty()).target; f.sync(page);
  const result = f.sync({ ...page, projects: [f.a] });
  assert.equal(createProjectScope(f.file).allows(f.a), false); assert.equal(result.warnings.length, 1);
});
test('invalid settings never partly apply and optional metadata is not a messaging dependency', t => {
  const f = fixture(t); f.edit('allow-project', f.a); const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.sync({ ...empty(), projects: [f.b, 'relative'] }), /absolute/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  f.sync(empty()); updateProjectPolicy(f.file, p => delete p.uiAdapters);
  assert.equal(createProjectScope(f.file).allows(f.a), true);
});

test('helper acknowledgement clears obsolete render history without applying permissions', t => {
  const f = fixture(t); f.edit('revoke', f.a); const denied = f.sync(empty()).target; f.sync(denied);
  f.edit('allow-project', f.a); f.sync(denied);
  f.edit('revoke', f.a); f.sync(denied);
  syncCardSettings(f.file, denied, { acknowledgeRender: true });
  assert.deepEqual(f.read().uiAdapters.localCardDesktop.renderTargets, []);
  f.sync({ ...empty(), projects: [f.a] });
  assert.equal(createProjectScope(f.file).allows(f.a), true);
});
