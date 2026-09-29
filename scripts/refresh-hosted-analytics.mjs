import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectSources, mergeHistory } from './collect-repo-analytics.mjs';
import { githubApi, githubClient, publicFiles, publishAnalytics, sanitizeAnalytics } from './publish-repo-analytics.mjs';
import { TELEMETRY_PUBLIC_KEY } from '../src/telemetry-config.mjs';

const repo = 'buidangminh23/codex-mcp-bridge';

export async function refreshHostedAnalytics({ env = process.env, api = githubApi, collect = collectSources, fetcher = fetch, directory = path.resolve('public-analytics') } = {}) {
  const branch = githubClient(env.ANALYTICS_BRANCH_TOKEN, api);
  const file = await branch(`repos/${repo}/contents/data.json?ref=analytics`);
  const previous = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  const options = { repo, package: '@minhspark/codex-mcp-bridge' };
  const snapshot = await collect(options);
  const history = mergeHistory(previous, options, snapshot);
  let usage = previous.usage;
  let usageFailed = false;
  try {
    const response = await fetcher('https://vdbwkowdggtcihixowxi.supabase.co/functions/v1/bridge-stats', {
      headers: { apikey: TELEMETRY_PUBLIC_KEY }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Stats unavailable');
    const data = await response.json();
    if (!data.usage || data.errors?.some(row => row.source === 'usage')) throw new Error('Usage unavailable');
    usage = sanitizeAnalytics(history, data.usage).usage;
  } catch { usageFailed = true; }
  const sha = await publishAnalytics(repo, publicFiles(history, usage), branch);
  const ref = await branch(`repos/${repo}/git/ref/heads/analytics`);
  if (ref.object.sha !== sha) throw new Error('Analytics publication changed during verification');
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(publicFiles(history, usage))) await writeFile(path.join(directory, name), content);
  return { sha, errors: snapshot.errors, usageFailed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { sha, errors, usageFailed } = await refreshHostedAnalytics();
  console.log(`Published aggregate analytics: ${sha}`);
  for (const error of errors) {
    const status = error.status ? ` (HTTP ${error.status})` : '';
    const hint = error.status === 403 && ['views', 'clones'].includes(error.source) ? ' GitHub traffic requires the ANALYTICS_TOKEN secret to be a token with push access (fine-grained: Administration read); the default workflow token cannot read traffic.' : '';
    console.error(`::warning::${error.source} was not refreshed${status}; previous data retained.${hint}`);
  }
  if (usageFailed) console.error('::warning::Usage was not refreshed; previous data retained.');
  if (errors.length || usageFailed) process.exitCode = 1;
}
