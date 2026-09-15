import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collectSources, mergeHistory, parseArgs, runCollection, defaultOutput } from '../scripts/collect-repo-analytics.mjs';

const options = { repo: 'owner/repo', package: '@owner/pkg' };

function dependencies(overrides = {}) {
  return {
    now: new Date('2026-09-15T12:00:00Z'),
    gh: async (endpoint, paginate) => {
      if (endpoint.endsWith('/traffic/views')) return { count: 8, uniques: 3, views: [{ timestamp: '2026-09-14T00:00:00Z', count: 8, uniques: 3 }] };
      if (endpoint.endsWith('/traffic/clones')) return { count: 4, uniques: 2, clones: [{ timestamp: '2026-09-14T00:00:00Z', count: 4, uniques: 2 }] };
      if (endpoint.includes('/releases?')) {
        assert.equal(paginate, true);
        return [[{ id: 1, tag_name: 'v1', assets: [{ id: 2, name: 'package.zip', download_count: 5 }] }], [{ id: 3, draft: true, assets: [] }]];
      }
      return { stargazers_count: 10, forks_count: 4, subscribers_count: 1, description: 'not persisted' };
    },
    fetcher: async (url) => {
      assert.equal(url, 'https://api.npmjs.org/downloads/range/last-month/%40owner%2Fpkg');
      return { ok: true, json: async () => ({ package: '@owner/pkg', start: '2026-08-15', end: '2026-09-14', downloads: [{ day: '2026-09-14', downloads: 20 }] }) };
    },
    render: history => `<html>${history.repo}</html>`,
    ...overrides,
  };
}

test('validates CLI options and chooses OS-private storage defaults', () => {
  assert.throws(() => parseArgs(['--repo', '../bad/repo']), /Invalid repository/);
  assert.throws(() => parseArgs(['--package', '--output']), /Expected/);
  assert.throws(() => parseArgs(['--unknown', 'x']), /Expected/);
  assert.equal(parseArgs(['--repo', 'owner/repo', '--package', '@owner/pkg']).package, '@owner/pkg');
  assert.equal(defaultOutput('win32', { LOCALAPPDATA: '/local' }, '/home'), path.join('/local', 'codex-mcp-bridge', 'analytics'));
  assert.equal(defaultOutput('darwin', {}, '/home'), path.join('/home', 'Library', 'Application Support', 'codex-mcp-bridge', 'analytics'));
  assert.equal(defaultOutput('linux', {}, '/home'), path.join('/home', '.local', 'share', 'codex-mcp-bridge', 'analytics'));
});

test('collects only aggregate fields, paginates releases, and preserves source windows', async () => {
  const snapshot = await collectSources(options, dependencies());
  assert.deepEqual(snapshot.errors, []);
  assert.deepEqual(snapshot.repository, { stars: 10, forks: 4, subscribers: 1 });
  assert.deepEqual(snapshot.releases, [{ id: 1, tag: 'v1', assets: [{ id: 2, name: 'package.zip', downloads: 5 }] }]);
  assert.equal(snapshot.views.uniques, 3);
  assert.equal(snapshot.npm.start, '2026-08-15');
});

test('overlapping days upsert counts and never add unique totals across windows', async () => {
  const first = await collectSources(options, dependencies());
  const original = mergeHistory(null, options, first);
  const next = structuredClone(first);
  next.collectedAt = '2026-09-16T12:00:00Z';
  next.views = { count: 18, uniques: 4, views: [{ timestamp: '2026-09-14T00:00:00Z', count: 9, uniques: 3 }, { timestamp: '2026-09-15T00:00:00Z', count: 9, uniques: 3 }] };
  const history = mergeHistory(original, options, next);
  assert.equal(history.daily.views['2026-09-14'].count, 9);
  assert.equal(original.daily.views['2026-09-14'].count, 8);
  assert.equal(history.snapshots.length, 2);
  assert.equal(history.snapshots[1].views.uniques, 4);
  const retry = mergeHistory(history, options, next);
  assert.equal(retry.snapshots.length, 2);
});

test('partial collection preserves same-day successful data and records actual source age', async () => {
  const first = await collectSources(options, dependencies());
  const history = mergeHistory(null, options, first);
  const partial = await collectSources(options, dependencies({ now: new Date('2026-09-15T14:00:00Z'), gh: async () => { throw new Error('secret token=abc'); } }));
  assert.equal(partial.errors.length, 4);
  assert.ok(!JSON.stringify(partial).includes('secret'));
  const updated = mergeHistory(history, options, partial);
  assert.equal(updated.snapshots.length, 1);
  assert.deepEqual(updated.snapshots[0].views, first.views);
  assert.equal(updated.snapshots[0].sourceCollectedAt.views, first.collectedAt);
  assert.equal(updated.snapshots[0].sourceCollectedAt.npm, partial.collectedAt);
  assert.deepEqual(updated.daily.views, history.daily.views);
  assert.throws(() => mergeHistory(history, { ...options, repo: 'different/repo' }, first), /mismatch/);
});

test('invalid counts or package identity become isolated source failures', async () => {
  const base = dependencies();
  const snapshot = await collectSources(options, dependencies({
    gh: async (endpoint, paginate) => endpoint.endsWith('/traffic/views') ? { count: -1, uniques: 1, views: [] } : base.gh(endpoint, paginate),
    fetcher: async () => ({ ok: true, json: async () => ({ package: 'wrong', start: '2026-08-15', end: '2026-09-14', downloads: [] }) }),
  }));
  assert.deepEqual(snapshot.errors.map(row => row.source), ['npm', 'views']);
  assert.equal(snapshot.views, undefined);
  assert.equal(snapshot.repository.stars, 10);
});

test('persists partial results, refuses corrupt history, and excludes simultaneous writes', async () => {
  const output = await mkdtemp(path.join(tmpdir(), 'bridge-analytics-'));
  try {
    const opts = { ...options, output };
    await runCollection(opts, dependencies());
    const partial = await runCollection(opts, dependencies({ fetcher: async () => { throw new Error('offline'); } }));
    assert.equal(partial.errors.length, 1);
    const stored = JSON.parse(await readFile(path.join(output, 'history.json'), 'utf8'));
    assert.equal(stored.daily.npm['2026-09-14'].downloads, 20);
    assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), '<html>owner/repo</html>');
    await assert.rejects(access(path.join(output, '.collection.lock')));
    await writeFile(path.join(output, '.collection.lock'), '123');
    await assert.rejects(runCollection(opts, dependencies()), /Collection lock exists/);
    await rm(path.join(output, '.collection.lock'));
    await writeFile(path.join(output, 'history.json'), '{broken');
    await assert.rejects(runCollection(opts, dependencies()), /Cannot read existing history/);
    assert.equal(await readFile(path.join(output, 'history.json'), 'utf8'), '{broken');
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
