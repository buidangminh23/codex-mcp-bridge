import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { publicFiles, sanitizeAnalytics, publishAnalytics } from '../scripts/publish-repo-analytics.mjs';

const history = {
  schemaVersion: 1, repo: 'owner/repo', package: '@owner/pkg', updatedAt: '2026-09-15T12:00:00Z',
  install_id: 'private-installation-id',
  snapshots: [{ collectedAt: '2026-09-15T12:00:00Z', errors: [{ message: 'private-token-and-path' }],
    views: { count: 20, uniques: 7, views: [{ timestamp: '2026-09-14T00:00:00Z', count: 20, uniques: 7 }] },
    repository: { stars: 10, forks: 4, subscribers: 2, secret: 'private-extra' },
    releases: [{ tag: '<release>', assets: [{ name: '<script>&".zip', downloads: 12, install_id: 'private-asset-id' }] }],
  }], daily: { views: { '2026-09-14': { count: 20, uniques: 7, install_id: 'private-row-id' } } },
};
const usage = { collectedAt: '2026-09-15T12:00:00Z', active: { day: 1, week: 2, month: 3 }, daily: [{ day: '2026-09-15', installations: 1, install_id: 'private-daily-id' }], platforms: [{ platform: 'windows', installations: 3 }], versions: [{ version: '1.16.0', installations: 3 }], install_ids: ['private-usage-id'] };

test('public data allowlists aggregate fields and excludes private identities/errors', () => {
  const data = sanitizeAnalytics(history, usage);
  const json = JSON.stringify(data);
  assert.ok(!json.includes('private-'));
  assert.ok(!json.includes('install_id'));
  assert.ok(!json.includes('errors'));
  assert.deepEqual(data.usage.active, { day: 1, week: 2, month: 3 });
  assert.deepEqual(data.daily.views['2026-09-14'], { count: 20, uniques: 7 });
  assert.equal(data.snapshots[0].views.uniques, 7);
});

test('dashboard escapes external text and renders all metric families without pretending missing is zero', () => {
  const files = publicFiles(history, usage);
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'dashboard.svg', 'data.json', 'index.html']);
  const svg = files['dashboard.svg'];
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;.zip'));
  assert.ok(!svg.includes('<script>'));
  for (const label of ['GitHub views', 'Unique visitors', 'GitHub clones', 'npm downloads', 'Stars', 'Forks', 'Subscribers', 'Release downloads', 'Active installations', 'Operating systems / 30 days', 'Versions / 30 days', 'Unavailable']) assert.ok(svg.includes(label), label);
  assert.ok(svg.includes('width="820"'));
  assert.ok(svg.includes('font-size="40"'));
  assert.ok(files['README.md'].includes('| 2026-09-14 | 20 | 7 | Unavailable | Unavailable | Unavailable | Unavailable |'));
  assert.ok(files['README.md'].includes('| 2026-09-15 | Unavailable | Unavailable | Unavailable | Unavailable | Unavailable | 1 |'));
  assert.ok(files['README.md'].includes('never sum daily unique'));
  assert.ok(!JSON.stringify(files).includes('private-'));
});

test('first publication creates an isolated four-file tree and analytics ref only', async () => {
  const calls = [];
  const gh = async (endpoint, options) => {
    calls.push({ endpoint, ...options });
    if (endpoint.endsWith('/git/ref/heads/analytics')) throw Object.assign(new Error('missing'), { status: 404 });
    return { sha: endpoint.endsWith('/git/trees') ? 'tree-sha' : 'commit-sha' };
  };
  assert.equal(await publishAnalytics('owner/repo', publicFiles(history), gh), 'commit-sha');
  const tree = calls.find(call => call.endpoint.endsWith('/git/trees')).body;
  assert.equal(tree.base_tree, undefined);
  assert.equal(tree.tree.length, 4);
  assert.deepEqual(calls.find(call => call.endpoint.endsWith('/git/commits')).body.parents, []);
  assert.equal(calls.at(-1).body.ref, 'refs/heads/analytics');
  assert.ok(!JSON.stringify(calls).includes('heads/main'));
});

test('existing branch publication is non-forced and concurrent update failure propagates', async () => {
  const calls = [];
  const gh = async (endpoint, options) => {
    calls.push({ endpoint, ...options });
    if (endpoint.endsWith('/git/ref/heads/analytics')) return { object: { sha: 'old-sha' } };
    if (options?.method === 'PATCH') throw new Error('concurrent update');
    return { sha: 'new-sha' };
  };
  await assert.rejects(publishAnalytics('owner/repo', publicFiles(history), gh), /concurrent update/);
  assert.deepEqual(calls.find(call => call.endpoint.endsWith('/git/commits')).body.parents, ['old-sha']);
  assert.deepEqual(calls.at(-1).body, { sha: 'new-sha', force: false });
  assert.ok(!calls.some(call => call.endpoint.endsWith('/git/trees/old-sha')));
  const tree = calls.find(call => call.endpoint.endsWith('/git/trees')).body.tree;
  assert.deepEqual(tree.map(row => row.path).sort(), Object.keys(publicFiles(history)).sort());
});

test('authentication failure cannot be mistaken for a missing analytics branch', async () => {
  let calls = 0;
  await assert.rejects(publishAnalytics('owner/repo', publicFiles(history), async () => { calls++; throw Object.assign(new Error('unauthorized'), { status: 401 }); }), /unauthorized/);
  assert.equal(calls, 1);
});

test('live page script is syntactically valid and uses safe rendering with delayed-source caveats', () => {
  const files = publicFiles(history, usage);
  const html = files['index.html'];
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(script.includes('30000'));
  assert.ok(script.includes('bridge-stats'));
  assert.ok(script.includes('textContent'));
  assert.ok(script.includes('Reporting installations / 30 days'));
  assert.ok(script.includes('Release downloads'));
  assert.ok(script.includes('release-assets'));
  assert.ok(!script.includes('innerHTML'));
  assert.ok(html.includes('source data can be delayed'));
  assert.ok(html.includes('showing previously available values'));
  assert.ok(html.includes('Some sources stale'));
  assert.ok(files['README.md'].includes('https://owner.github.io/repo/'));
});
