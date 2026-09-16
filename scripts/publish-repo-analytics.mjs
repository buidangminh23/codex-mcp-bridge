import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultOutput } from './collect-repo-analytics.mjs';

const escapeXml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const numericFields = (value, keys) => Object.fromEntries(keys.map(key => [key, number(value?.[key])]));
const format = value => value == null ? 'Unavailable' : value.toLocaleString('en-US');

function sanitizeSnapshot(snapshot) {
  const output = { collectedAt: date(snapshot.collectedAt) };
  for (const source of ['views', 'clones']) {
    if (snapshot[source]) output[source] = { ...numericFields(snapshot[source], ['count', 'uniques']), [source]: (snapshot[source][source] || []).map(row => ({ timestamp: date(row.timestamp), ...numericFields(row, ['count', 'uniques']) })) };
  }
  if (snapshot.repository) output.repository = numericFields(snapshot.repository, ['stars', 'forks', 'subscribers']);
  if (snapshot.npm) output.npm = { start: date(snapshot.npm.start), end: date(snapshot.npm.end), downloads: (snapshot.npm.downloads || []).map(row => ({ day: date(row.day), downloads: number(row.downloads) })) };
  if (snapshot.releases) output.releases = snapshot.releases.map(release => ({ tag: String(release.tag ?? '').slice(0, 120), assets: (release.assets || []).map(asset => ({ name: String(asset.name ?? '').slice(0, 180), downloads: number(asset.downloads) })) }));
  output.sourceCollectedAt = Object.fromEntries(['views', 'clones', 'npm', 'repository', 'releases'].filter(source => output[source]).map(source => [source, date(snapshot.sourceCollectedAt?.[source] || snapshot.collectedAt)]));
  return output;
}

export function sanitizeAnalytics(history, usage) {
  if (history.schemaVersion !== 1 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(history.repo) || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(history.package) || !Array.isArray(history.snapshots)) throw new Error('Invalid analytics history.');
  const output = { schemaVersion: 1, repo: history.repo, package: history.package, updatedAt: date(history.updatedAt), snapshots: history.snapshots.map(sanitizeSnapshot), daily: {} };
  for (const source of ['views', 'clones', 'npm']) output.daily[source] = Object.fromEntries(Object.entries(history.daily?.[source] || {}).filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && date(day)).map(([day, row]) => [day, numericFields(row, source === 'npm' ? ['downloads'] : ['count', 'uniques'])]));
  if (usage) output.usage = {
    collectedAt: date(usage.collectedAt), active: numericFields(usage.active, ['day', 'week', 'month']),
    daily: (usage.daily || []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.day) && date(row.day)).map(row => ({ day: row.day, installations: number(row.installations) })),
    platforms: (usage.platforms || []).filter(row => ['windows', 'macos', 'linux'].includes(row.platform)).map(row => ({ platform: row.platform, installations: number(row.installations) })),
    versions: (usage.versions || []).filter(row => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(row.version)).map(row => ({ version: row.version, installations: number(row.installations) })),
  };
  return output;
}

export function renderPublicDashboard(data) {
  const latest = source => [...data.snapshots].sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt))).find(row => row[source]);
  const views = latest('views')?.views;
  const clones = latest('clones')?.clones;
  const repository = latest('repository')?.repository;
  const npm = latest('npm')?.npm;
  const releases = latest('releases')?.releases;
  const assets = releases?.flatMap(release => release.assets.map(asset => ({ ...asset, tag: release.tag }))) || [];
  const sum = rows => rows?.every(row => row.downloads != null) ? rows.reduce((total, row) => total + row.downloads, 0) : null;
  const window = (source, rows) => `${rows?.[0]?.timestamp?.slice(0, 10) || '?'} to ${rows?.at(-1)?.timestamp?.slice(0, 10) || '?'} UTC`;
  const cards = [
    ['GitHub views', views?.count, window('views', views?.views)], ['Unique visitors', views?.uniques, 'Distinct within GitHub window'], ['GitHub clones', clones?.count, window('clones', clones?.clones)],
    ['Unique cloners', clones?.uniques, 'Distinct within GitHub window'], ['npm downloads', sum(npm?.downloads), npm ? `${npm.start} to ${npm.end} UTC` : 'Source unavailable'], ['Stars', repository?.stars, 'Current repository total'],
    ['Forks', repository?.forks, 'Current repository total'], ['Subscribers', repository?.subscribers, 'Current repository total'], ['Release downloads', releases ? sum(assets) : null, 'Cumulative asset downloads'],
  ];
  if (data.usage) cards.push(['Active installations / day', data.usage.active.day, 'Consenting installations only'], ['Active installations / 7 days', data.usage.active.week, 'Distinct across the whole period'], ['Active installations / 30 days', data.usage.active.month, 'Distinct across the whole period']);
  const details = [
    ['Release assets', ...assets.map(asset => `${asset.tag} / ${asset.name}: ${format(asset.downloads)}`)],
    ['Operating systems / 30 days', ...(data.usage?.platforms || []).map(row => `${row.platform}: ${format(row.installations)}`)],
    ['Versions / 30 days', ...(data.usage?.versions || []).map(row => `${row.version}: ${format(row.installations)}`)],
    ['Source freshness (UTC)', ...['views', 'clones', 'npm', 'repository', 'releases'].map(source => `${source}: ${latest(source)?.sourceCollectedAt?.[source] || 'Unavailable'}`), ...(data.usage ? [`usage: ${data.usage.collectedAt || 'Unavailable'}`] : [])],
  ];
  const wrap = (value, maximum) => {
    const lines = [];
    let remaining = String(value);
    while (remaining.length > maximum) {
      const space = remaining.lastIndexOf(' ', maximum);
      const cut = space > maximum / 2 ? space : maximum;
      lines.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    return [...lines, remaining];
  };
  const cardRows = Math.ceil(cards.length / 2);
  const text = (value, x, yy, size = 20, color = '#acbcd0') => `<text x="${x}" y="${yy}" font-size="${size}" fill="${color}">${escapeXml(value)}</text>`;
  const body = [];
  let y = 48;
  for (const line of wrap(data.repo, 42)) { body.push(text(line, 32, y, 28, '#f4f7fd')); y += 36; }
  for (const line of wrap(`Public aggregate analytics • Updated ${data.updatedAt || 'Unavailable'} (UTC)`, 65)) { body.push(text(line, 32, y)); y += 28; }
  const cardTop = y + 12;
  cards.forEach(([label, value, detail], index) => {
    const x = 32 + index % 2 * 390;
    const top = cardTop + Math.floor(index / 2) * 176;
    body.push(`<rect x="${x}" y="${top}" width="366" height="160" rx="12" fill="#18253b"/>`);
    wrap(label, 28).forEach((line, row) => body.push(text(line, x + 16, top + 30 + row * 25, 22)));
    body.push(text(format(value), x + 16, top + 103, 40, '#7ee5c0'));
    wrap(detail, 43).forEach((line, row) => body.push(text(line, x + 16, top + 132 + row * 18, 15)));
  });
  y = cardTop + cardRows * 176 + 16;
  for (const caveat of ['Downloads and clones are not people or active users. CI, updates and reinstalls count.', 'Daily unique counts must not be added across dates. Missing values are unavailable, not zero.', data.usage ? 'Usage covers opted-in installations only; one person may use multiple installations.' : 'Active installation metrics unavailable; no aggregate usage report supplied.']) {
    for (const line of wrap(caveat, 70)) { body.push(text(line, 32, y)); y += 28; }
    y += 8;
  }
  for (const [title, ...lines] of details) {
    y += 45;
    body.push(text(title, 32, y, 22, '#f4f7fd'));
    for (const line of lines.length ? lines : ['No data available']) {
      for (const piece of wrap(line, 70)) { y += 28; body.push(text(piece, 32, y, 20)); }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="820" height="${y + 35}" viewBox="0 0 820 ${y + 35}" role="img" aria-label="Repository aggregate analytics"><rect width="100%" height="100%" fill="#0d1626"/><g font-family="Arial, sans-serif">${body.join('')}</g></svg>\n`;
}

export function renderLiveDashboard(data) {
  const latest = source => [...data.snapshots].sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt))).find(row => row[source]);
  const npm = latest('npm');
  const initial = { usage: data.usage, repository: latest('repository') ? { ...latest('repository').repository, collectedAt: latest('repository').sourceCollectedAt.repository } : undefined, npm: npm ? { start: npm.npm.start, end: npm.npm.end, downloads: npm.npm.downloads.every(row => row.downloads != null) ? npm.npm.downloads.reduce((sum, row) => sum + row.downloads, 0) : null, collectedAt: npm.sourceCollectedAt.npm } : undefined, traffic: { views: latest('views')?.views, clones: latest('clones')?.clones, collectedAt: latest('views')?.sourceCollectedAt.views, viewsCollectedAt: latest('views')?.sourceCollectedAt.views, clonesCollectedAt: latest('clones')?.sourceCollectedAt.clones } };
  initial.releases = latest('releases')?.releases;
  initial.releasesCollectedAt = latest('releases')?.sourceCollectedAt.releases;
  const serialized = JSON.stringify(initial).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https://vdbwkowdggtcihixowxi.supabase.co; base-uri 'none'"><title>Live repository analytics</title><style>
*{box-sizing:border-box}body{margin:0;background:#0d1626;color:#f4f7fd;font:17px/1.6 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:32px 20px}h1{font-size:32px;line-height:1.2}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin:24px 0}article,.panel{background:#18253b;border-radius:12px;padding:20px}h2{font-size:19px;margin:0 0 8px}strong{font-size:38px;color:#7ee5c0;display:block}small,.muted{color:#acbcd0;display:block;font-size:14px}a{color:#9bcaff}.stale{color:#ffcb80}.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}ul{padding-left:20px}#status{min-height:28px}footer{margin:24px 0}</style></head><body><main><h1>${escapeXml(data.repo)}</h1><p>Live aggregate dashboard</p><p id="status" role="status">Loading current statistics…</p><p class="muted">Refreshes every 30 seconds while visible. GitHub and npm source data can be delayed; source timestamps appear on every card. Active installations include consenting installations only.</p><div class="cards" id="cards"></div><div class="panels"><section class="panel"><h2>Operating systems / 30 days</h2><ul id="platforms"></ul></section><section class="panel"><h2>Versions / 30 days</h2><ul id="versions"></ul></section></div><footer>Downloads and clones are not people. Never add daily unique counts across dates. Missing metrics are unavailable, not zero.<p><a href="https://github.com/${data.repo}/tree/analytics">Full archived daily history and release assets</a> · <a href="data.json">Aggregate JSON</a></p></footer></main><script>
let state = ${serialized};
const releasesPanel=document.createElement('section');releasesPanel.className='panel';const releasesTitle=document.createElement('h2');releasesTitle.textContent='Release assets';const releasesList=document.createElement('ul');releasesList.id='release-assets';releasesPanel.append(releasesTitle,releasesList);document.querySelector('.panels').append(releasesPanel);
const format = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable';
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : 'Unavailable';
function render() {
  const u = state.usage || {}, r = state.repository || {}, n = state.npm || {}, t = state.traffic || {};
  const assets=Array.isArray(state.releases)?state.releases.flatMap(release=>(Array.isArray(release.assets)?release.assets:[]).map(asset=>({...asset,tag:release.tag}))):null;
  const releaseTotal=assets && assets.every(asset=>Number.isSafeInteger(asset.downloads)&&asset.downloads>=0)?assets.reduce((sum,asset)=>sum+asset.downloads,0):null;
  const rows = [['Reporting installations / day',u.active?.day,u.collectedAt],['Reporting installations / 7 days',u.active?.week,u.collectedAt],['Reporting installations / 30 days',u.active?.month,u.collectedAt],['GitHub views',t.views?.count,t.viewsCollectedAt || t.collectedAt],['Unique visitors',t.views?.uniques,t.viewsCollectedAt || t.collectedAt],['GitHub clones',t.clones?.count,t.clonesCollectedAt || t.collectedAt],['Unique cloners',t.clones?.uniques,t.clonesCollectedAt || t.collectedAt],['npm downloads',n.downloads,n.collectedAt,n.start && n.end ? n.start+' to '+n.end+' UTC' : 'Source window unavailable'],['Stars',r.stars,r.collectedAt],['Forks',r.forks,r.collectedAt],['Subscribers',r.subscribers,r.collectedAt],['Release downloads',releaseTotal,state.releasesCollectedAt,'Cumulative asset downloads']];
  document.getElementById('cards').replaceChildren(...rows.map(([label,value,time,detail]) => { const card=document.createElement('article'); const title=document.createElement('h2');title.textContent=label;const count=document.createElement('strong');count.textContent=format(value);const source=document.createElement('small');source.textContent='Source: '+timestamp(time);card.append(title,count,source);if(detail){const note=document.createElement('small');note.textContent=detail;card.append(note);}return card;}));
  for(const [id,key] of [['platforms','platform'],['versions','version']]){const list=Array.isArray(u[id])?u[id]:[];document.getElementById(id).replaceChildren(...(list.length?list:[{}]).map(row=>{const item=document.createElement('li');item.textContent=row[key]?String(row[key])+': '+format(row.installations):'Unavailable';return item;}));}
  releasesList.replaceChildren(...(assets?.length?assets:[null]).map(asset=>{const item=document.createElement('li');item.textContent=asset?String(asset.tag)+' / '+String(asset.name)+': '+format(asset.downloads):assets?'No release assets':'Unavailable';return item;}));
}
let pending = false;
async function refresh() {
  if(pending || document.hidden) return;
  pending=true;
  const status=document.getElementById('status');
  try {
    const response=await fetch('https://vdbwkowdggtcihixowxi.supabase.co/functions/v1/bridge-stats',{headers:{apikey:'sb_publishable_2GIhGKL82wM8mN44L-Gzxw_Zgd-Vioh'},cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(!response.ok) throw new Error('request failed');
    const next=await response.json();
    if(!next || typeof next!=='object' || !next.collectedAt) throw new Error('invalid response');
    for(const source of ['usage','repository','npm','traffic']){if(next[source] && typeof next[source]==='object') state[source]=next[source];}
    if(Array.isArray(next.releases)){state.releases=next.releases;state.releasesCollectedAt=next.releasesCollectedAt || next.sourceCollectedAt?.releases || null;}
    render();const partial=Array.isArray(next.errors)&&next.errors.length>0;status.className=partial?'stale':'';status.textContent=(partial?'Some sources stale · Last refresh: ':'Last refresh: ')+new Date().toISOString()+' · Source delays still apply';
  }catch{status.className='stale';status.textContent='Refresh failed — showing previously available values. Retrying in 30 seconds.';}
  finally{pending=false;}
}
render();void refresh();setInterval(()=>{void refresh();},30000);document.addEventListener('visibilitychange',()=>{if(!document.hidden) void refresh();});
</script></body></html>\n`;
}

export function publicFiles(history, usage) {
  const data = sanitizeAnalytics(history, usage);
  const usageDays = Object.fromEntries((data.usage?.daily || []).map(row => [row.day, row.installations]));
  const days = [...new Set([...Object.keys(data.daily.views), ...Object.keys(data.daily.clones), ...Object.keys(data.daily.npm), ...Object.keys(usageDays)])].sort().reverse();
  const table = ['| Date (UTC) | Views | Unique visitors | Clones | Unique cloners | npm downloads | Active installations |', '|---|---:|---:|---:|---:|---:|---:|', ...days.map(day => `| ${day} | ${[data.daily.views[day]?.count, data.daily.views[day]?.uniques, data.daily.clones[day]?.count, data.daily.clones[day]?.uniques, data.daily.npm[day]?.downloads, usageDays[day]].map(format).join(' | ')} |`)].join('\n');
  const readme = `# Public repository analytics\n\n![Repository dashboard](dashboard.svg)\n\n[Aggregate JSON history](data.json) · [Repository](https://github.com/${data.repo})\n\nAll dates and source windows use UTC. Source timestamps on the dashboard show when each metric was last available. Downloads and clones include automation and do not measure people. Unique visitors/cloners apply only to the source window; never sum daily unique counts across dates. Active installations cover consenting installations only, with distinct counts for each whole period. Operating system and version breakdowns cover 30 days; an installation may appear in multiple version groups after upgrading.\n\nThis branch contains only aggregate statistics. No installation identifiers, prompts, account details, credentials, private error messages, or local paths are published. Missing metrics mean unavailable, not zero.\n\n## Daily history\n\nEvery archived source day is listed below, newest first. Active installations count consenting installations that reported that UTC day.\n\n${table}\n`;
  const pagesUrl = `https://${data.repo.split('/')[0]}.github.io/${data.repo.split('/')[1]}/`;
  return { 'dashboard.svg': renderPublicDashboard(data), 'README.md': readme.replace('![Repository dashboard]', `[Live dashboard · refreshes every 30 seconds](${pagesUrl})\n\n![Repository dashboard]`), 'data.json': `${JSON.stringify(data, null, 2)}\n`, 'index.html': renderLiveDashboard(data) };
}

export function githubApi(endpoint, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['api', '--hostname', 'github.com', '--method', method, endpoint];
    if (body) args.push('--input', '-');
    const child = spawn('gh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('GitHub CLI could not start.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { const error = new Error('GitHub API request failed. Check authentication, write permissions, and concurrent updates.'); error.status = /HTTP 404/.test(stderr) ? 404 : null; reject(error); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid GitHub API response.')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function publishAnalytics(repo, files, gh = githubApi) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid repository.');
  let previous;
  try { previous = (await gh(`repos/${repo}/git/ref/heads/analytics`)).object.sha; }
  catch (error) { if (error.status !== 404) throw error; }
  const existing = previous ? (await gh(`repos/${repo}/git/trees/${previous}`)).tree : [];
  const media = existing.filter(row => row.type === 'blob' && row.mode === '100644' && ['desktop-demo.gif', 'desktop-demo.mp4'].includes(row.path)).map(({ path, mode, type, sha }) => ({ path, mode, type, sha }));
  const tree = await gh(`repos/${repo}/git/trees`, { method: 'POST', body: { tree: [...media, ...Object.entries(files).map(([filename, content]) => ({ path: filename, mode: '100644', type: 'blob', content }))] } });
  const commit = await gh(`repos/${repo}/git/commits`, { method: 'POST', body: { message: 'docs: refresh public aggregate analytics', tree: tree.sha, parents: previous ? [previous] : [] } });
  if (previous) await gh(`repos/${repo}/git/refs/heads/analytics`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
  else await gh(`repos/${repo}/git/refs`, { method: 'POST', body: { ref: 'refs/heads/analytics', sha: commit.sha } });
  return commit.sha;
}

async function main(args) {
  const options = { history: path.join(defaultOutput(), 'history.json') };
  for (let i = 0; i < args.length; i++) {
    if (!['--history', '--usage', '--dry-run'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: node scripts/publish-repo-analytics.mjs [--history file] [--usage file] [--dry-run directory]');
    options[args[i].slice(2)] = args[++i];
  }
  const history = JSON.parse(await readFile(options.history, 'utf8'));
  const usage = options.usage ? JSON.parse(await readFile(options.usage, 'utf8')) : undefined;
  const files = publicFiles(history, usage);
  if (options['dry-run']) {
    const directory = path.resolve(options['dry-run']);
    const workspace = path.resolve(process.cwd());
    if (directory === workspace || directory.startsWith(`${workspace}${path.sep}`)) throw new Error('Dry-run directory must be outside the current workspace.');
    await mkdir(directory, { recursive: true });
    for (const [filename, content] of Object.entries(files)) await writeFile(path.join(directory, filename), content);
    console.log(`Public analytics preview: ${directory}`);
  } else {
    const sha = await publishAnalytics(history.repo, files);
    console.log(`Published analytics: https://github.com/${history.repo}/tree/analytics (${sha})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => { console.error('Public analytics publish failed. Check input files, GitHub permissions, and concurrent updates.'); process.exitCode = 1; });
