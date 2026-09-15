import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const defaultRepo = 'buidangminh23/codex-mcp-bridge';
const defaultPackage = '@minhspark/codex-mcp-bridge';

export function defaultOutput(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'codex-mcp-bridge', 'analytics');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'codex-mcp-bridge', 'analytics');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'codex-mcp-bridge', 'analytics');
}

export function parseArgs(args) {
  const options = { repo: defaultRepo, package: defaultPackage, output: defaultOutput() };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') return { help: true };
    const name = args[i].slice(2);
    if (!['--repo', '--package', '--output'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Expected --repo owner/name, --package name, or --output directory.');
    options[name] = args[++i];
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) throw new Error('Invalid repository: expected owner/name.');
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(options.package)) throw new Error('Invalid npm package name.');
  options.output = path.resolve(options.output);
  return options;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count.');
  return value;
}

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Invalid date.');
  return value.slice(0, 10);
}

function traffic(data, key) {
  if (!Array.isArray(data[key])) throw new Error('Missing daily traffic.');
  return { count: count(data.count), uniques: count(data.uniques), [key]: data[key].map(row => ({ timestamp: `${day(row.timestamp)}T00:00:00Z`, count: count(row.count), uniques: count(row.uniques) })) };
}

export function httpStatus(error) {
  const match = /\(HTTP (\d{3})\)/.exec(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);
  return match ? Number(match[1]) : undefined;
}

async function github(endpoint, paginate = false) {
  const args = ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint];
  if (paginate) args.push('--paginate', '--slurp');
  const { stdout } = await execute('gh', args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return JSON.parse(stdout);
}

export async function collectSources(options, { gh = github, fetcher = fetch, now = new Date() } = {}) {
  const snapshot = { collectedAt: now.toISOString(), errors: [] };
  const jobs = {
    views: async () => traffic(await gh(`repos/${options.repo}/traffic/views`), 'views'),
    clones: async () => traffic(await gh(`repos/${options.repo}/traffic/clones`), 'clones'),
    repository: async () => {
      const data = await gh(`repos/${options.repo}`);
      return { stars: count(data.stargazers_count), forks: count(data.forks_count), subscribers: count(data.subscribers_count) };
    },
    releases: async () => {
      const pages = await gh(`repos/${options.repo}/releases?per_page=100`, true);
      if (!Array.isArray(pages)) throw new Error('Invalid releases.');
      return pages.flat().filter(release => !release.draft).map(release => ({
        id: count(release.id), tag: String(release.tag_name),
        assets: release.assets.map(asset => ({ id: count(asset.id), name: String(asset.name), downloads: count(asset.download_count) })),
      }));
    },
    npm: async () => {
      const response = await fetcher(`https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(options.package)}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error('npm request failed.');
      const data = await response.json();
      if (data.package !== options.package || !Array.isArray(data.downloads)) throw new Error('Invalid npm response.');
      return { start: day(data.start), end: day(data.end), downloads: data.downloads.map(row => ({ day: day(row.day), downloads: count(row.downloads) })) };
    },
  };
  await Promise.all(Object.entries(jobs).map(async ([source, job]) => {
    try { snapshot[source] = await job(); }
    catch (error) {
      const entry = { source, message: source === 'npm' ? 'Request failed or response invalid. Check npm package, network, and npm API availability.' : 'Request failed or response invalid. Check gh authentication, repository permissions, network, and GitHub API limits.' };
      const status = httpStatus(error);
      if (status) entry.status = status;
      snapshot.errors.push(entry);
    }
  }));
  snapshot.errors.sort((a, b) => a.source.localeCompare(b.source));
  return snapshot;
}

export function mergeHistory(previous, options, snapshot) {
  if (previous && (previous.schemaVersion !== 1 || previous.repo !== options.repo || previous.package !== options.package || !Array.isArray(previous.snapshots) || !previous.daily?.views || !previous.daily?.clones || !previous.daily?.npm)) throw new Error('History schema or repository/package mismatch. Use a separate output directory.');
  const history = previous ? structuredClone(previous) : { schemaVersion: 1, repo: options.repo, package: options.package, snapshots: [], daily: { views: {}, clones: {}, npm: {} } };
  const collectionDay = day(snapshot.collectedAt);
  const index = history.snapshots.findIndex(row => day(row.collectedAt) === collectionDay);
  const prior = index < 0 ? {} : history.snapshots[index];
  const merged = { ...prior, ...snapshot, sourceCollectedAt: { ...prior.sourceCollectedAt } };
  for (const source of ['views', 'clones', 'npm', 'repository', 'releases']) {
    if (Object.hasOwn(snapshot, source)) merged.sourceCollectedAt[source] = snapshot.collectedAt;
  }
  if (index < 0) history.snapshots.push(merged);
  else history.snapshots[index] = merged;
  history.snapshots.sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
  history.updatedAt = snapshot.collectedAt;
  for (const source of ['views', 'clones']) {
    for (const row of snapshot[source]?.[source] || []) history.daily[source][day(row.timestamp)] = { count: row.count, uniques: row.uniques };
  }
  for (const row of snapshot.npm?.downloads || []) history.daily.npm[row.day] = { downloads: row.downloads };
  return history;
}

export async function atomicWrite(filename, contents) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(contents, 'utf8');
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, filename);
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function runCollection(options, dependencies = {}) {
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const lockPath = path.join(options.output, '.collection.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Collection lock exists. Wait for the active collector; if it crashed, remove .collection.lock only after confirming no collector is running.'); throw error; }
  try {
    await lock.writeFile(String(process.pid));
    const historyPath = path.join(options.output, 'history.json');
    let previous;
    try { previous = JSON.parse(await readFile(historyPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read existing history; preserve it and repair it before collecting.'); }
    const snapshot = await collectSources(options, dependencies);
    const history = mergeHistory(previous, options, snapshot);
    await atomicWrite(historyPath, `${JSON.stringify(history, null, 2)}\n`);
    const render = dependencies.render || (await import('./render-repo-analytics.mjs')).renderAnalytics;
    await atomicWrite(path.join(options.output, 'index.html'), render(history));
    return { history, errors: snapshot.errors, output: options.output };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/collect-repo-analytics.mjs [--repo owner/name] [--package name] [--output directory]\nRequires authenticated GitHub CLI (gh). Saves aggregate analytics locally; partial source failure exits 1.');
    else {
      const result = await runCollection(options);
      console.log(`Analytics saved: ${result.output}`);
      for (const error of result.errors) console.error(`${error.source}: ${error.message}`);
      if (result.errors.length) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Analytics collection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
