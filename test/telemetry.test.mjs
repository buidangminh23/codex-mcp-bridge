import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { enableTelemetry, disableTelemetry, getTelemetryStatus, reportUsage, handleTelemetryCommand, startUsageReporting } from '../src/telemetry.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-telemetry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, env: {}, platform: 'win32', now: new Date('2026-09-15T12:00:00Z'), version: '1.16.0', config: { TELEMETRY_ENDPOINT: 'https://example.test/ingest', TELEMETRY_PUBLIC_KEY: 'public-key' } };
}

test('default off neither creates identity nor contacts the endpoint', async t => {
  const opts = await fixture(t);
  let calls = 0;
  assert.equal(await reportUsage({ ...opts, fetcher: async () => { calls++; } }), false);
  assert.equal((await getTelemetryStatus(opts)).enabled, false);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(opts.directory), []);
});

test('consent is explicit, enable is idempotent, disable removes identity', async t => {
  const opts = await fixture(t);
  await enableTelemetry(opts);
  const filename = path.join(opts.directory, 'telemetry.json');
  const first = JSON.parse(await readFile(filename));
  assert.match(first.installId, /^[0-9a-f-]{36}$/);
  await enableTelemetry(opts);
  assert.deepEqual(JSON.parse(await readFile(filename)), first);
  await disableTelemetry(opts);
  assert.deepEqual(JSON.parse(await readFile(filename)), { enabled: false });
  await enableTelemetry(opts);
  assert.notEqual(JSON.parse(await readFile(filename)).installId, first.installId);
});

test('reports only four allowlisted fields with public bearer and once per UTC day', async t => {
  const opts = await fixture(t);
  await enableTelemetry(opts);
  const sent = [];
  const fetcher = async (endpoint, request) => {
    assert.equal(endpoint, opts.config.TELEMETRY_ENDPOINT);
    assert.equal(request.headers.apikey, 'public-key');
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.redirect, 'error');
    sent.push(JSON.parse(request.body));
    return { ok: true };
  };
  assert.equal(await reportUsage({ ...opts, fetcher }), true);
  assert.equal(await reportUsage({ ...opts, fetcher }), false);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['day', 'install_id', 'platform', 'version']);
  assert.equal(sent[0].platform, 'windows');
  assert.equal(sent[0].day, '2026-09-15');
  assert.equal(await reportUsage({ ...opts, fetcher, now: new Date('2026-09-16T00:00:00Z') }), true);
  assert.equal(sent.length, 2);
});

test('concurrent bridge startups cannot duplicate successful daily reports', async t => {
  const opts = await fixture(t);
  await enableTelemetry(opts);
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true }; };
  const results = await Promise.all(Array.from({ length: 10 }, () => reportUsage({ ...opts, fetcher })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(calls, 1);
});

test('network errors, HTTP failures, and timeout are silent and allow later retry', async t => {
  const opts = await fixture(t);
  await enableTelemetry(opts);
  for (const fetcher of [async () => { throw new Error('offline'); }, async () => ({ ok: false }), () => new Promise(() => {})]) {
    assert.equal(await reportUsage({ ...opts, fetcher, timeoutMs: 10 }), false);
    assert.equal((await getTelemetryStatus(opts)).lastReportDay, null);
  }
  assert.equal(await reportUsage({ ...opts, fetcher: async () => ({ ok: true }) }), true);
});

test('privacy environment overrides and invalid versions/platforms prevent all reporting', async t => {
  const opts = await fixture(t);
  await enableTelemetry(opts);
  let calls = 0;
  const fetcher = async () => { calls++; return { ok: true }; };
  for (const override of [{ env: { DO_NOT_TRACK: '1' } }, { env: { CODEX_BRIDGE_TELEMETRY: '0' } }, { version: 'not-semver' }, { version: '1.2.3-01' }, { platform: 'freebsd' }]) {
    assert.equal(await reportUsage({ ...opts, fetcher, ...override }), false);
  }
  assert.equal(calls, 0);
});

test('CLI intercepts only telemetry commands and status never reports identity', async t => {
  const opts = await fixture(t);
  const messages = [];
  const cli = { ...opts, output: message => messages.push(message) };
  assert.equal(await handleTelemetryCommand([], cli), false);
  assert.equal(await handleTelemetryCommand(['--version'], cli), false);
  assert.equal(await handleTelemetryCommand(['telemetry', 'enable'], cli), true);
  assert.ok(messages[0].includes('enabled'));
  const identity = JSON.parse(await readFile(path.join(opts.directory, 'telemetry.json'))).installId;
  assert.ok(!messages.join('\n').includes(identity));
  await handleTelemetryCommand(['telemetry', 'disable'], cli);
  assert.equal((await getTelemetryStatus(opts)).effective, false);
});

test('long-running reporting checks hourly with an unreferenced timer and respects disabled consent', async t => {
  const opts = await fixture(t);
  let tick;
  let unreferenced = false;
  let cancelled = false;
  let calls = 0;
  const handle = { unref: () => { unreferenced = true; } };
  const reporting = startUsageReporting({
    ...opts,
    fetcher: async () => { calls++; return { ok: true }; },
    schedule: (callback, milliseconds) => { tick = callback; assert.equal(milliseconds, 3600000); return handle; },
    cancel: timer => { assert.equal(timer, handle); cancelled = true; },
  });
  assert.equal(await reporting.initialReport, false);
  assert.equal(unreferenced, true);
  await enableTelemetry(opts);
  tick();
  for (let attempt = 0; attempt < 100 && calls === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  for (let attempt = 0; attempt < 100 && !(await getTelemetryStatus(opts)).lastReportDay; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  await disableTelemetry(opts);
  tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  reporting.stop();
  assert.equal(cancelled, true);
});
