import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { projectRevocationEntry, scopeEntry, updateProjectPolicy } from './project-policy.mjs';

const empty = () => ({ projects: [], parents: [], excluded: [] });
const key = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const same = (a, b) => key(a) === key(b);
const includes = (list, p) => list.some(v => same(v, p));
function canonicalSettingsPath(value) {
  // Policy entries use real directory paths. Native pages can use /var aliases
  // or Windows short names; compare them in the same namespace. Keep missing
  // paths removable by resolving their nearest existing ancestor, not dropping
  // the record (in particular a revoked or deleted project).
  let current = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(value);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}
function normalize(page) {
  const output = empty();
  for (const field of Object.keys(output)) {
    if (!Array.isArray(page?.[field]) || page[field].length > 512) throw new Error('Invalid card settings list: ' + field);
    for (const item of page[field]) {
      if (typeof item !== 'string' || item.length > 32768) throw new Error('Invalid card settings path');
      const value = item.trim();
      if (!value) continue;
      if (!path.isAbsolute(value)) throw new Error('Card settings paths must be absolute');
      const canonical = canonicalSettingsPath(value);
      if (!includes(output[field], canonical)) output[field].push(canonical);
    }
    output[field].sort((a, b) => key(a).localeCompare(key(b)));
  }
  return output;
}
const equal = (a, b) => Object.keys(empty()).every(k => a[k].length === b[k].length && a[k].every(p => includes(b[k], p)));
const pageHash = page => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(page).map(([k, v]) => [k, v.map(key).sort()])))).digest('hex');
const fingerprint = policy => createHash('sha256').update(JSON.stringify({ grants: policy.grants, denies: policy.denies })).digest('hex');
const projection = policy => normalize({ projects: policy.grants.filter(g => g.kind === 'project').map(g => g.path),
  parents: policy.grants.filter(g => g.kind === 'parent').map(g => g.path), excluded: policy.denies.map(g => g.path) });
const sameEntry = (a, b) => same(a.path, b.path) || (a.repository && b.repository && same(a.repository.path, b.repository.path) && a.repository.identity === b.repository.identity);

// This optional UI adapter is not read by messaging permission checks. Keep the
// acknowledgement in the same atomic file as grants so a crash cannot replay an
// old settings save as a fresh permission change. No card grants or trust flags
// are copied into the messaging policy.
export function syncCardSettings(policyFile, input, options = {}) {
  const page = normalize(input);
  let result;
  updateProjectPolicy(policyFile, policy => {
    const saved = policy.uiAdapters?.localCardDesktop;
    if (saved && saved.version !== 1) throw new Error('Unsupported card settings acknowledgement');
    const previous = saved ? normalize(saved.page) : empty();
    const current = fingerprint(policy);
    const priorRenders = saved?.renderTargets ?? [];
    if (!Array.isArray(priorRenders) || priorRenders.length > 16 || priorRenders.some(v => !/^[a-f0-9]{64}$/.test(v))) throw new Error('Invalid settings render acknowledgement');
    const rendered = saved && (equal(page, normalize(saved.target)) || priorRenders.includes(pageHash(page)));
    const changed = !equal(page, previous);
    // Reinstalling the extension resets its page to blank while this acknowledgement
    // survives, so a blank page cannot be told apart from "remove everything". Treat
    // it like a first page: import the current lists and revoke nothing. A last
    // project can still be revoked explicitly through the exclusion list.
    const blank = Object.values(page).every(list => list.length === 0);
    const reset = saved && changed && blank && !rendered && !options.acknowledgeRender;
    const conflict = saved && changed && !rendered && !reset && (saved.renderOverflow || current !== saved.authorizationFingerprint);
    const warnings = [];
    if (conflict) warnings.push('通信授权刚被其他入口修改，本次页面更改未应用；先同步最新页面，再修改。');
    if (reset) warnings.push('通信页面为空，未撤销任何授权，已按现有授权重新填充。确需撤销，请把项目移入通信禁止列表后保存。');
    if (changed && !rendered && !conflict && !reset && !options.acknowledgeRender) {
      // Removing a displayed exclusion is an explicit UI action. A new grant
      // never implicitly removes an exclusion that the page has not shown.
      const removedExclusions = previous.excluded.filter(p => !includes(page.excluded, p));
      policy.denies = policy.denies.filter(d => !includes(removedExclusions, d.path));
      for (const [field, kind] of [['projects', 'project'], ['parents', 'parent']]) {
        const removed = previous[field].filter(p => !includes(page[field], p));
        const oldGrants = policy.grants.filter(g => g.kind === kind && includes(removed, g.path));
        policy.grants = policy.grants.filter(g => !(g.kind === kind && includes(removed, g.path)));
        // Removing one project revokes it even under a granted parent. Removing
        // a parent only removes that broad grant; exact project grants survive.
        if (kind === 'project') for (const grant of oldGrants) {
          if (!policy.denies.some(d => sameEntry(d, grant))) policy.denies.push(projectRevocationEntry(grant, options));
        }
        for (const p of page[field].filter(p => !includes(previous[field], p))) {
          if (policy.grants.some(g => g.kind === kind && same(g.path, p))) continue;
          const entry = scopeEntry(p, kind, options);
          if (policy.denies.some(d => sameEntry(d, entry))) {
            warnings.push(`项目仍被禁止，未恢复授权：${p}。请先从通信禁止列表移除，再添加授权。`);
            continue;
          }
          policy.grants = policy.grants.filter(g => !(g.kind === kind && sameEntry(g, entry)));
          policy.grants.push(entry);
        }
      }
      for (const p of page.excluded.filter(p => !includes(previous.excluded, p))) {
        if (policy.denies.some(d => same(d.path, p))) continue;
        const old = policy.grants.find(g => same(g.path, p));
        const entry = projectRevocationEntry(old ?? scopeEntry(p, 'project', options), options);
        policy.grants = policy.grants.filter(g => !sameEntry(g, entry));
        policy.denies.push(entry);
      }
    }
    const target = projection(policy);
    // A detached page helper can finish rendering an older policy after a newer
    // revocation. Remember issued snapshots: that save is display acknowledgement,
    // never a user's request to restore the old grant.
    const aligned = equal(page, target);
    const acknowledged = aligned && (options.acknowledgeRender || (changed && rendered));
    const renderTargets = acknowledged ? [] : aligned ? [...priorRenders] : [...new Set([...priorRenders, pageHash(target)])];
    policy.uiAdapters ??= {};
    policy.uiAdapters.localCardDesktop = { version: 1, page, target, authorizationFingerprint: fingerprint(policy),
      renderTargets: renderTargets.slice(-16), renderOverflow: !acknowledged && (saved?.renderOverflow === true || renderTargets.length > 16) };
    result = { status: conflict ? 'conflict_preserved' : reset ? 'blank_page_imported' : 'synchronized', target,
      needsPageUpdate: !equal(page, target), warnings, authorizationChanged: current !== fingerprint(policy),
      detail: 'Only messaging lists were reconciled. Card grants and workspace trust are unchanged.' };
  });
  return result;
}
