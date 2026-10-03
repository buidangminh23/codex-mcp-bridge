import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { githubApi, githubClient, githubEnvironment } from '../scripts/publish-repo-analytics.mjs';
import { refreshHostedAnalytics } from '../scripts/refresh-hosted-analytics.mjs';

const repo = 'buidangminh23/codex-mcp-bridge';
const previous = { schemaVersion: 1, repo, package: '@minhspark/codex-mcp-bridge', snapshots: [], daily: { views: {}, clones: {}, npm: {} } };
const usage = { collectedAt: '2026-09-30T00:00:00Z', active: { day: 1, week: 2, month: 3 }, daily: [{ day: '2026-09-30', installations: 1 }], platforms: [{ platform: 'windows', installations: 3 }], versions: [{ version: '1.19.2', installations: 3 }] };

function fakeGithub({ verifiedSha = 'new-sha' } = {}) {
  const calls = [];
  let published = false;
  const api = async (endpoint, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ endpoint, method, token: options.token });
    if (endpoint === `repos/${repo}/contents/data.json?ref=analytics`) return { content: Buffer.from(JSON.stringify(previous)).toString('base64') };
    if (endpoint === `repos/${repo}/git/ref/heads/analytics`) return { object: { sha: published ? verifiedSha : 'old-sha' } };
    if (endpoint === `repos/${repo}/git/trees`) return { sha: 'tree-sha' };
    if (endpoint === `repos/${repo}/git/commits`) return { sha: 'new-sha' };
    if (endpoint === `repos/${repo}/git/refs/heads/analytics` && method === 'PATCH') { published = true; return {}; }
    throw new Error(`Unexpected GitHub call: ${method} ${endpoint}`);
  };
  return { api, calls };
}

async function refresh(t, env, github = fakeGithub()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-analytics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const collected = [];
  const result = await refreshHostedAnalytics({
    env, api: github.api, directory,
    collect: async options => { collected.push(options); return { collectedAt: '2026-09-30T00:00:00.000Z', errors: [] }; },
    fetcher: async () => ({ ok: true, json: async () => ({ usage }) }),
  });
  return { result, collected, directory, calls: github.calls };
}

test('a branch token replaces the gh credentials only for calls made with it', async () => {
  const env = { GH_TOKEN: 'owner-token', PATH: 'bin' };
  assert.deepEqual(githubEnvironment('bot-token', env), { GH_TOKEN: 'bot-token', PATH: 'bin' });
  assert.equal(env.GH_TOKEN, 'owner-token');
  assert.equal(githubEnvironment(undefined, env), env);
  const received = [];
  const api = async (endpoint, options) => { received.push({ endpoint, options }); return {}; };
  assert.equal(githubClient(undefined, api), api);
  await githubClient('bot-token', api)(`repos/${repo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/analytics' } });
  assert.deepEqual(received, [{ endpoint: `repos/${repo}/git/refs`, options: { method: 'POST', body: { ref: 'refs/heads/analytics' }, token: 'bot-token' } }]);
});

test('gh receives the branch token only on calls made with it', { skip: process.platform === 'win32' && 'the stand-in gh is a shell script' }, async t => {
  const bin = await mkdtemp(path.join(tmpdir(), 'bridge-gh-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nprintf \'{"token":"%s"}\' "$GH_TOKEN"\n', { mode: 0o755 });
  const saved = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN };
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.GH_TOKEN = 'owner-token';
  assert.deepEqual(await githubApi(`repos/${repo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/analytics' }, token: 'bot-token' }), { token: 'bot-token' });
  assert.deepEqual(await githubApi(`repos/${repo}/traffic/views`), { token: 'owner-token' });
  assert.equal(process.env.GH_TOKEN, 'owner-token');
});

test('hosted refresh reads, writes and verifies the analytics branch with the branch token', async t => {
  const { result, collected, directory, calls } = await refresh(t, { GH_TOKEN: 'owner-token', ANALYTICS_BRANCH_TOKEN: 'bot-token' });
  assert.deepEqual(result, { sha: 'new-sha', errors: [], usageFailed: false });
  assert.deepEqual(calls.map(call => `${call.method} ${call.endpoint.replace(`repos/${repo}/`, '')}`), [
    'GET contents/data.json?ref=analytics',
    'GET git/ref/heads/analytics',
    'POST git/trees',
    'POST git/commits',
    'PATCH git/refs/heads/analytics',
    'GET git/ref/heads/analytics',
  ]);
  assert.ok(calls.every(call => call.token === 'bot-token'));
  assert.deepEqual(collected, [{ repo, package: '@minhspark/codex-mcp-bridge' }]);
  assert.deepEqual((await readdir(directory)).sort(), ['README.md', 'dashboard.svg', 'data.json', 'index.html']);
});

test('hosted refresh keeps the default gh credentials when no branch token is set', async t => {
  const { result, calls } = await refresh(t, { GH_TOKEN: 'owner-token' });
  assert.equal(result.sha, 'new-sha');
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.token === undefined));
});

test('hosted refresh fails when the analytics branch moves during verification', async t => {
  await assert.rejects(refresh(t, { ANALYTICS_BRANCH_TOKEN: 'bot-token' }, fakeGithub({ verifiedSha: 'someone-else' })), /changed during verification/);
});

test('Pages approval cannot block hourly data collection or keep newer runs waiting', async () => {
  const workflow = await readFile(new URL('../.github/workflows/analytics.yml', import.meta.url), 'utf8');
  const refreshJob = workflow.split('  refresh:')[1].split(/\n  \w+:/)[0];
  const deployJob = workflow.split('  deploy:')[1].split(/\n  \w+:/)[0];
  assert.ok(workflow.includes('cancel-in-progress: true'));
  assert.ok(!refreshJob.includes('environment:'));
  assert.ok(refreshJob.includes('node scripts/refresh-hosted-analytics.mjs'));
  assert.ok(refreshJob.includes('actions/upload-pages-artifact@'));
  assert.ok(!refreshJob.includes('actions/deploy-pages@'));
  assert.ok(deployJob.includes('needs: refresh'));
  assert.ok(deployJob.includes('name: github-pages'));
  assert.ok(deployJob.includes('actions/deploy-pages@'));
});

test('usage failure retains its original timestamp while independent sources publish fresh data', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-analytics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const github = fakeGithub();
  const retained = { ...previous, usage };
  const result = await refreshHostedAnalytics({
    directory,
    api: async (endpoint, options) => endpoint.endsWith('contents/data.json?ref=analytics')
      ? { content: Buffer.from(JSON.stringify(retained)).toString('base64') }
      : github.api(endpoint, options),
    collect: async () => ({ collectedAt: '2026-10-02T14:00:00Z', repository: { stars: 20, forks: 9, subscribers: 1 }, errors: [] }),
    fetcher: async () => ({ ok: true, json: async () => ({ errors: [{ source: 'usage' }], usage: { active: { day: 99 } } }) }),
  });
  const published = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
  assert.equal(result.usageFailed, true);
  assert.deepEqual(published.usage, usage);
  assert.equal(published.snapshots.at(-1).repository.stars, 20);
  assert.equal(published.snapshots.at(-1).sourceCollectedAt.repository, '2026-10-02T14:00:00Z');
  assert.equal(published.usage.collectedAt, '2026-09-30T00:00:00Z');
});
