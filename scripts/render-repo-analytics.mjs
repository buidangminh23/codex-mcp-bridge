const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const number = (value) => Number.isFinite(value) ? value.toLocaleString("en-US") : "Unavailable";

function seriesChart(entries, label, color) {
  const width = 760;
  const height = 160;
  const values = entries.map(([, row]) => row.downloads ?? row.count ?? 0);
  const maximum = Math.max(1, ...values);
  const bars = entries.map(([day], index) => {
    const slot = width / Math.max(1, entries.length);
    const barHeight = values[index] / maximum * (height - 20);
    return `<rect x="${index * slot + 1}" y="${height - barHeight}" width="${Math.max(1, slot - 2)}" height="${barHeight}" rx="2" fill="${color}"><title>${escapeHtml(day)}: ${number(values[index])}</title></rect>`;
  }).join("");
  return `<section class="chart"><h2>${escapeHtml(label)}</h2><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)} by source day">${bars}</svg><div class="axis"><span>${escapeHtml(entries[0]?.[0] ?? "No data")}</span><span>${escapeHtml(entries.at(-1)?.[0] ?? "")}</span></div></section>`;
}

function lastAvailable(snapshots, field) {
  return [...snapshots].reverse().find((snapshot) => snapshot[field] != null)?.[field];
}

export function renderAnalytics(history) {
  const snapshots = [...(history.snapshots ?? [])].sort((left, right) => left.collectedAt.localeCompare(right.collectedAt));
  const latest = snapshots.at(-1);
  const views = lastAvailable(snapshots, "views");
  const clones = lastAvailable(snapshots, "clones");
  const repository = lastAvailable(snapshots, "repository");
  const npm = lastAvailable(snapshots, "npm");
  const daily = history.daily ?? {};
  const entries = (source) => Object.entries(daily[source] ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const days = [...new Set([...Object.keys(daily.views ?? {}), ...Object.keys(daily.clones ?? {}), ...Object.keys(daily.npm ?? {})])].sort().reverse();
  const npmTotal = npm?.downloads?.reduce((sum, row) => sum + row.downloads, 0);
  const range = (rows) => rows?.length ? `${rows[0].timestamp.slice(0, 10)} — ${rows.at(-1).timestamp.slice(0, 10)} UTC` : "No source data";
  const card = (label, value, detail) => `<article class="card"><p>${label}</p><strong>${number(value)}</strong><small>${escapeHtml(detail)}</small></article>`;
  const errors = latest?.errors ?? [];
  const freshness = ["views", "clones", "npm", "repository", "releases"].map((source) => {
    const snapshot = [...snapshots].reverse().find((row) => row[source] != null);
    return `${source}: ${snapshot?.sourceCollectedAt?.[source] ?? snapshot?.collectedAt ?? "Unavailable"}`;
  }).join(" · ");
  const rows = days.map((day) => `<tr><td>${escapeHtml(day)}</td><td>${number(daily.views?.[day]?.count)}</td><td>${number(daily.views?.[day]?.uniques)}</td><td>${number(daily.clones?.[day]?.count)}</td><td>${number(daily.clones?.[day]?.uniques)}</td><td>${number(daily.npm?.[day]?.downloads)}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'"><title>Repository analytics · ${escapeHtml(history.repo)}</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0d1320;color:#edf2fa;font:15px/1.6 system-ui,sans-serif}main{max-width:1180px;margin:auto;padding:40px 24px}h1{font-size:32px;line-height:1.2;margin:12px 0}h2{font-size:18px}p{margin:8px 0}.muted,small,.axis{color:#a8b5c8}a{color:#94cfff}.badge{font-size:12px;letter-spacing:.12em;color:#6ee7be;text-transform:uppercase}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;margin:28px 0}.card,.chart,.notice{background:#172133;border:1px solid #2b3b54;border-radius:14px;padding:20px}.card p{color:#a8b5c8}.card strong{display:block;font-size:36px;line-height:1.5}.card small{display:block}.charts{display:grid;gap:20px}.chart svg{width:100%;height:auto;max-height:180px;display:block}.axis{display:flex;justify-content:space-between;font-size:12px}.notice{margin:20px 0}.warning{border-color:#b98938}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;white-space:nowrap}th,td{padding:10px 14px;border-bottom:1px solid #2b3b54;text-align:right}th:first-child,td:first-child{text-align:left}th{color:#a8b5c8;font-size:12px}details{margin-top:28px}summary{cursor:pointer;font-weight:600}footer{margin-top:32px;color:#a8b5c8;font-size:13px}@media(max-width:600px){main{padding:24px 16px}h1{font-size:25px}}</style></head>
<body><main><div class="badge">Private local report · UTC dates</div><h1>${escapeHtml(history.repo)}</h1><p class="muted">GitHub traffic and npm downloads, archived over time.</p><p class="muted">Last collection: ${escapeHtml(latest?.collectedAt ?? "Not collected")}</p>
${errors.length ? `<div class="notice warning"><strong>Partial collection</strong><p>Some sources could not be refreshed. Available values may come from an earlier successful collection.</p><ul>${errors.map((error) => `<li>${escapeHtml(typeof error === "string" ? error : `${error.source ?? "Source"}: ${error.message ?? error.error ?? "Unavailable"}`)}</li>`).join("")}</ul></div>` : ""}
<div class="cards">${card("GitHub views", views?.count, range(views?.views))}${card("Unique visitors", views?.uniques, "Distinct visitors in the reported GitHub window")}${card("GitHub clones", clones?.count, range(clones?.clones))}${card("Unique cloners", clones?.uniques, "Distinct cloners in the reported GitHub window")}${card("npm downloads", npmTotal, npm ? `${npm.start} — ${npm.end} UTC` : "Unavailable")}${card("Stars", repository?.stars, `${number(repository?.forks)} forks · ${number(repository?.subscribers)} subscribers`)}</div>
<div class="notice"><strong>Downloads are not active users.</strong><p>Reinstalls, updates, automation, and CI can contribute to downloads or clones. Daily unique counts must not be added to estimate unique people across multiple days. App usage measurement is not enabled by this report.</p></div>
<div class="charts">${seriesChart(entries("npm").slice(-90), "npm downloads · last 90 archived days", "#68d7b0")}${seriesChart(entries("views").slice(-90), "GitHub views · last 90 archived days", "#73b7f3")}${seriesChart(entries("clones").slice(-90), "GitHub clones · last 90 archived days", "#b3a0fb")}</div>
<details open><summary>Daily history (${days.length} source days)</summary><div class="table-wrap"><table><thead><tr><th>Date (UTC)</th><th>Views</th><th>Unique visitors</th><th>Clones</th><th>Unique cloners</th><th>npm downloads</th></tr></thead><tbody>${rows}</tbody></table></div></details>
<footer><p>Source collection times: ${escapeHtml(freshness)}</p>Missing values mean unavailable, not zero. Repeated collection updates overlapping dates rather than adding them twice. Keep history.json to preserve the archive. This report has no tracking scripts or external resources.</footer></main></body></html>`;
}
