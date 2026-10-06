import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { publicFiles, sanitizeAnalytics, publishAnalytics, renderStatisticsBadges } from '../scripts/publish-repo-analytics.mjs';

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
  assert.deepEqual(Object.keys(files).filter(name => !name.startsWith('stats-')).sort(), ['README.md', 'dashboard.svg', 'data.json', 'index.html']);
  assert.equal(Object.keys(files).filter(name => name.startsWith('stats-')).length, 13);
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

test('first publication creates an isolated aggregate tree including all statistics badges and analytics ref only', async () => {
  const calls = [];
  const gh = async (endpoint, options) => {
    calls.push({ endpoint, ...options });
    if (endpoint.endsWith('/git/ref/heads/analytics')) throw Object.assign(new Error('missing'), { status: 404 });
    return { sha: endpoint.endsWith('/git/trees') ? 'tree-sha' : 'commit-sha' };
  };
  assert.equal(await publishAnalytics('owner/repo', publicFiles(history), gh), 'commit-sha');
  const tree = calls.find(call => call.endpoint.endsWith('/git/trees')).body;
  assert.equal(tree.base_tree, undefined);
  assert.deepEqual(tree.tree.map(row => row.path).sort(), Object.keys(publicFiles(history)).sort());
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

function liveHarness(data = history, report = usage) {
  class Element {
    children = [];
    className = '';
    text = '';
    set textContent(value) { this.text = String(value); this.children = []; }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.text = ''; }
  }
  const elements = Object.fromEntries(['cards', 'status', 'platforms', 'versions', 'panels'].map(id => [id, new Element()]));
  const clock = { now: Date.parse('2026-09-15T12:00:00Z') };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  let response = { ok: true, body: { collectedAt: '2026-09-15T12:00:00Z' } };
  const context = vm.createContext({
    document: { hidden: true, createElement: () => new Element(), getElementById: id => elements[id], querySelector: () => elements.panels, addEventListener() {} },
    Date: ClockDate, AbortSignal, setInterval() {},
    fetch: async () => { if (response instanceof Error) throw response; return { ok: response.ok, json: async () => response.body }; },
  });
  vm.runInContext(publicFiles(data, report)['index.html'].match(/<script>([\s\S]*)<\/script>/)[1], context);
  return {
    elements, clock,
    card: label => elements.cards.children.find(card => card.children[0].textContent === label),
    async poll(next, ok = true) {
      response = next instanceof Error ? next : { ok, body: next };
      context.document.hidden = false;
      await vm.runInContext('refresh()', context);
    },
  };
}

test('live refresh updates healthy sources while retaining failed sources with their original dates', async () => {
  const page = liveHarness();
  await page.poll({ collectedAt: '2026-09-15T12:01:00Z',
    repository: { stars: 20, forks: 8, subscribers: 0, collectedAt: '2026-09-15T12:01:00Z' },
    traffic: { clones: { count: 0, uniques: 0, start: '2026-09-02', end: '2026-09-14' }, clonesCollectedAt: '2026-09-15T12:01:00Z' },
    errors: [{ source: 'views' }, { source: 'usage' }],
  });
  assert.equal(page.card('Stars').children[1].textContent, '20');
  assert.equal(page.card('Subscribers').children[1].textContent, '0');
  assert.equal(page.card('GitHub views').children[1].textContent, '20');
  assert.match(page.card('GitHub views').textContent, /2026-09-15 12:00 UTC.*Stale/);
  assert.equal(page.card('GitHub clones').children[1].textContent, '0');
  assert.match(page.card('GitHub clones').textContent, /2026-09-02 to 2026-09-14 UTC/);
  assert.match(page.elements.status.textContent, /Some sources stale/);
});

test('empty opted-in usage is explained and real zeros are not shown as unavailable', async () => {
  const page = liveHarness(history, { ...usage, active: { day: 0, week: 0, month: 0 }, daily: [], platforms: [], versions: [] });
  assert.equal(page.card('Reporting installations / 30 days').children[1].textContent, '0');
  assert.match(page.elements.platforms.textContent, /No opted-in reports.*telemetry consent/);
  assert.match(page.elements.versions.textContent, /No opted-in reports/);
  const absent = liveHarness(history, null);
  assert.equal(absent.card('Reporting installations / 30 days').children[1].textContent, 'Unavailable');
  assert.match(absent.elements.platforms.textContent, /Unavailable/);
});

test('polling old data cannot claim fresh source data and failures recover automatically', async () => {
  const page = liveHarness();
  page.clock.now += 4 * 60 * 60 * 1000;
  await page.poll({ collectedAt: '2026-09-15T16:00:00Z', usage });
  assert.match(page.card('GitHub views').textContent, /Stale or unavailable/);
  assert.match(page.elements.status.textContent, /Some sources stale/);
  await page.poll(new Error('offline'));
  assert.match(page.elements.status.textContent, /Refresh failed/);
  assert.equal(page.card('GitHub views').children[1].textContent, '20');
  const time = '2026-09-15T16:00:00Z';
  await page.poll({ collectedAt: time, usage: { ...usage, collectedAt: time },
    repository: { stars: 0, forks: 0, subscribers: 0, collectedAt: time },
    npm: { downloads: 0, start: '2026-08-15', end: '2026-09-14', collectedAt: time },
    traffic: { views: { count: 0, uniques: 0, start: '2026-09-01', end: '2026-09-14' }, clones: { count: 0, uniques: 0, start: '2026-09-01', end: '2026-09-14' }, viewsCollectedAt: time, clonesCollectedAt: time },
    releases: [], releasesCollectedAt: time,
  });
  assert.equal(page.elements.status.className, '');
  assert.match(page.elements.status.textContent, /^Last API refresh:/);
  assert.equal(page.card('GitHub views').children[1].textContent, '0');
  assert.equal(page.card('Release downloads').children[1].textContent, '0');
});

test('malformed source updates and unavailable responses cannot erase last-good values', async () => {
  const page = liveHarness();
  await page.poll({ collectedAt: '2026-09-15T12:01:00Z',
    repository: { stars: -1, forks: 0, subscribers: 0, collectedAt: '2026-09-15T12:01:00Z' },
    traffic: { views: { count: '999', uniques: 9 }, viewsCollectedAt: '2026-09-15T12:01:00Z' },
    usage: { ...usage, platforms: [null] },
  });
  assert.equal(page.card('Stars').children[1].textContent, '10');
  assert.equal(page.card('GitHub views').children[1].textContent, '20');
  assert.equal(page.card('Reporting installations / 30 days').children[1].textContent, '3');
  await page.poll({ collectedAt: '2026-09-15T12:02:00Z' }, false);
  assert.match(page.elements.status.textContent, /Refresh failed/);
  assert.equal(page.card('Stars').children[1].textContent, '10');
});

test('snapshot labels generation and individual source age without breaking UTC onto a separate line', () => {
  const old = structuredClone(history);
  old.updatedAt = '2026-09-15T16:00:00Z';
  const svg = publicFiles(old, { ...usage, active: { day: 0, week: 0, month: 0 }, daily: [], platforms: [], versions: [] })['dashboard.svg'];
  assert.ok(svg.includes('Generated: 2026-09-15 16:00 UTC'));
  assert.ok(svg.includes('Stale · 2026-09-15 12:00 UTC'));
  assert.ok(svg.includes('No opted-in reports in this period'));
  assert.ok(svg.includes('Snapshot freshness is relative to generation time.'));
  assert.ok(!svg.includes('>(UTC)</text>'));
});


test('statistics badges retain source periods, exact counts and unavailable metrics', () => {
  const data = sanitizeAnalytics(history, usage);
  const files = renderStatisticsBadges(data, { now: Date.parse(history.updatedAt) });
  assert.match(files['stats-github-views.svg'], /aria-label="GitHub views \/ 1d: 20"/);
  assert.match(files['stats-github-views.svg'], /2026-09-14 to 2026-09-14 UTC/);
  assert.match(files['stats-github-clones.svg'], /GitHub clones \/ window: Unavailable/);
  assert.match(files['stats-active-installations-30-days.svg'], /Reporting \/ 30d: 3/);
  assert.match(files['stats-release-downloads.svg'], /Release downloads: 12/);
  assert.match(files['stats-updated.svg'], /Snapshot UTC: 2026-09-15 12:00/);
  for (const svg of Object.values(files)) {
    assert.match(svg, /height="24"/);
    assert.ok(!svg.includes('private-'));
    assert.ok(!svg.includes('<script>'));
  }
});

test('statistics badges preserve old sources when a newer snapshot lacks them', () => {
  const data = sanitizeAnalytics(history, usage);
  data.updatedAt = '2026-09-15T16:00:00Z';
  data.snapshots.push({ collectedAt: data.updatedAt, repository: { stars: 21, forks: 10, subscribers: 1 }, sourceCollectedAt: { repository: data.updatedAt } });
  const files = renderStatisticsBadges(data, { now: Date.parse(data.updatedAt) });
  assert.match(files['stats-github-views.svg'], /GitHub views \/ 1d: 20 · stale/);
  assert.match(files['stats-github-views.svg'], /Source: 2026-09-15 12:00 UTC/);
  assert.match(files['stats-stars.svg'], /aria-label="Stars: 21"/);
  assert.ok(!files['stats-stars.svg'].includes('21 · stale'));
});

test('statistics badges sum npm source days and retain real zero reports and release downloads', () => {
  const data = sanitizeAnalytics(history, { ...usage, active: { day: 0, week: 0, month: 0 }, platforms: [], versions: [] });
  data.snapshots[0].npm = { start: '2026-08-17', end: '2026-09-15', downloads: [{ day: '2026-09-14', downloads: 4000 }, { day: '2026-09-15', downloads: 2000 }] };
  data.snapshots[0].sourceCollectedAt.npm = history.updatedAt;
  data.snapshots[0].releases = [];
  const files = renderStatisticsBadges(data, { now: Date.parse(history.updatedAt) });
  assert.match(files['stats-npm-downloads.svg'], /npm downloads \/ 30d: 6,000/);
  assert.match(files['stats-release-downloads.svg'], /Release downloads: 0/);
  assert.match(files['stats-active-installations-day.svg'], /Reporting \/ 1d: 0/);
  assert.match(files['stats-active-installations-day.svg'], /No opted-in reports in this period/);
  data.snapshots[0].npm.downloads[1].downloads = null;
  assert.match(renderStatisticsBadges(data)['stats-npm-downloads.svg'], /npm downloads \/ 30d: Unavailable/);
});


test('statistics badges keep a valid count but expose unavailable source age', () => {
  const data = sanitizeAnalytics(history, usage);
  data.snapshots[0].sourceCollectedAt.repository = null;
  const files = renderStatisticsBadges(data, { now: Date.parse(history.updatedAt) });
  assert.match(files['stats-stars.svg'], /Stars: 10 · undated/);
  assert.match(files['stats-stars.svg'], /fill="#92400e"/);
  assert.match(files['stats-stars.svg'], /Source: Unavailable/);
});
