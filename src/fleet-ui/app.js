const el = id => document.getElementById(id);
const svgNs = "http://www.w3.org/2000/svg";
const hostFilter = new URLSearchParams(location.search).get("host");

function consumeSessionHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("session")) return false;
  localStorage.setItem("fleet-session", params.get("session"));
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

consumeSessionHash();

function applyTheme(theme) {
  const resolved = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = resolved;
  const toggle = el("theme-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(resolved === "dark"));
    const label = resolved === "dark" ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }
}

applyTheme(localStorage.getItem("fleet-theme") || "light");

const statusNames = {
  queued: "Chờ phân công", running: "Đang chạy", uncertain: "Chờ xác minh",
  completed: "Hoàn tất", failed: "Thất bại", cancelled: "Đã hủy", pending: "Chưa chạy"
};
const statusOrder = ["running", "queued", "uncertain", "completed", "failed", "cancelled"];
const tones = { running: "blue", completed: "green", failed: "red", queued: "amber", uncertain: "amber" };
const sessionTones = { running: "blue", waiting: "amber", connected: "green", idle: "gray", unknown: "gray" };
const agentNames = { codex: "Codex", claude: "Claude", antigravity: "Antigravity" };
const platforms = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const numbers = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const percents = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const dates = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });
const gib = bytes => numbers.format(bytes / (1024 ** 3)) + " GiB";

let state = { hosts: [], jobs: [] };
let selected = null;
let requestIndex = 0;
let online = false;
let changing = false;
let detailId;
let stepHistory;
let targetKey;
let filterSignature;
let pollError = "";
let actionError = "";
let toastTimer;

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function svgEl(tag, attrs = {}) {
  const item = document.createElementNS(svgNs, tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
  return item;
}

function icon(name, size = 14) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24", width: size, height: size, fill: "none",
    stroke: "currentColor", "stroke-width": "1.9", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true"
  });
  if (name === "win32") {
    svg.append(
      svgEl("rect", { x: 3, y: 3, width: 8, height: 8, rx: 1.5 }),
      svgEl("rect", { x: 13, y: 3, width: 8, height: 8, rx: 1.5 }),
      svgEl("rect", { x: 3, y: 13, width: 8, height: 8, rx: 1.5 }),
      svgEl("rect", { x: 13, y: 13, width: 8, height: 8, rx: 1.5 })
    );
  } else if (name === "darwin") {
    svg.append(
      svgEl("rect", { x: 3, y: 4, width: 18, height: 12, rx: 2 }),
      svgEl("path", { d: "M2 20h20" })
    );
  } else if (name === "linux") {
    svg.append(
      svgEl("rect", { x: 3, y: 4, width: 18, height: 16, rx: 2.5 }),
      svgEl("path", { d: "M8 10l3 2.5L8 15M13 15h4" })
    );
  } else if (name === "git") {
    svg.append(
      svgEl("circle", { cx: 6, cy: 6, r: 2.5 }),
      svgEl("circle", { cx: 6, cy: 18, r: 2.5 }),
      svgEl("circle", { cx: 18, cy: 10, r: 2.5 }),
      svgEl("path", { d: "M6 8.5v7M8.5 6H14a4 4 0 0 1 4 4" })
    );
  } else if (name === "sessions") {
    svg.append(
      svgEl("path", { d: "M12 3l8 4.5-8 4.5-8-4.5L12 3z" }),
      svgEl("path", { d: "M4 12.5l8 4.5 8-4.5M4 17l8 4.5 8-4.5" })
    );
  } else if (name === "chevron-down") {
    svg.classList.add("chevron");
    svg.append(svgEl("path", { d: "M6 9l6 6 6-6" }));
  } else if (name === "chevron-right") {
    svg.classList.add("chevron");
    svg.append(svgEl("path", { d: "M9 6l6 6-6 6" }));
  } else if (name === "screen") {
    svg.append(
      svgEl("rect", { x: 2.5, y: 3.5, width: 19, height: 13, rx: 2 }),
      svgEl("path", { d: "M8 20.5h8M12 16.5v4" })
    );
  } else if (name === "external") {
    svg.append(
      svgEl("path", { d: "M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" })
    );
  } else if (name === "info") {
    svg.append(
      svgEl("circle", { cx: 12, cy: 12, r: 9 }),
      svgEl("path", { d: "M12 16v-4M12 8h.01" })
    );
  } else if (name === "check") {
    svg.append(svgEl("path", { d: "M20 6L9 17l-5-5" }));
  } else if (name === "copy") {
    svg.append(
      svgEl("rect", { x: 9, y: 9, width: 11, height: 11, rx: 2 }),
      svgEl("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
    );
  } else {
    svg.append(
      svgEl("rect", { x: 3, y: 4, width: 18, height: 14, rx: 2 }),
      svgEl("path", { d: "M8 21h8M12 18v3" })
    );
  }
  return svg;
}

function setText(item, value) {
  if (item.textContent !== value) item.textContent = value;
}

function notice(item, value) {
  setText(item, value || "");
  item.hidden = !value;
}

function showToast(message) {
  const item = el("toast");
  setText(item, message);
  item.dataset.visible = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { item.dataset.visible = "false"; }, 3200);
}

async function copyText(text, button, message) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.querySelector(".copy-label");
    if (label) {
      const previous = label.textContent;
      label.textContent = "Đã chép";
      setTimeout(() => { label.textContent = previous; }, 1600);
    }
    showToast(message || "Đã sao chép vào bảng tạm.");
  } catch {
    showToast("Không sao chép được tự động.");
  }
}

async function api(path, data) {
  const headers = { Authorization: "Bearer " + (localStorage.getItem("fleet-session") ?? "") };
  const options = { headers, cache: "no-store", mode: "same-origin", redirect: "error" };
  if (data !== undefined) {
    options.method = "POST";
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(data);
  }
  const response = await fetch(path, options);
  if (response.status === 401) throw new Error("Phiên đã hết hạn. Chạy lại worker-relay dashboard để mở bảng điều phối.");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Không thể thực hiện yêu cầu.");
  return result;
}

function hostName(id) {
  if (id === "auto") return "Tự động";
  return state.hosts.find(host => host.id === id)?.hostname || id;
}

function badge(item, text, tone) {
  item.dataset.tone = tone || "gray";
  setText(item, text);
}

function agentChip(agent) {
  const chip = node("span", "agent-chip", agentNames[agent] || agent);
  chip.dataset.agent = agent;
  return chip;
}

function hostUrl(path, id) {
  const url = new URL(path, location.origin);
  url.searchParams.set("host", id);
  return url;
}

function externalAction(label, iconName, path, id) {
  const link = node("a", "host-action");
  link.href = hostUrl(path, id);
  link.target = "_blank";
  link.rel = "noopener";
  link.append(icon(iconName, 14), node("span", "", label));
  return link;
}

const sessionStates = {
  running: "Đang làm việc", waiting: "Đang chờ", idle: "Đang rảnh",
  connected: "Đã kết nối", unknown: "Chưa rõ trạng thái"
};

function sessionGroup(title, rows) {
  const group = node("div", "session-group");
  const head = node("div", "session-group-head");
  head.append(node("span", "session-group-title", title), node("span", "count-pill", String(rows.length)));
  const list = node("ul", "session-list");
  for (const { title: name, agent, statusText, tone } of rows) {
    const row = node("li", "session-item");
    const main = node("div", "session-main");
    main.append(agentChip(agent), node("span", "session-title", name));
    const statusBadge = node("span", "badge");
    badge(statusBadge, statusText, tone);
    row.append(main, statusBadge);
    list.append(row);
  }
  group.append(head, list);
  return group;
}

function sessionNote(text) {
  const note = node("p", "session-note");
  note.append(icon("info", 14), node("span", "", text));
  return note;
}

function sessionView(id, button) {
  const region = node("div", "session-region");
  region.id = "sessions-" + id;
  region.hidden = true;
  button.setAttribute("aria-controls", region.id);
  button.setAttribute("aria-expanded", "false");
  const labelSpan = button.querySelector(".action-label");
  let timer, loading = false, signature;
  async function refreshSessions() {
    if (loading || region.hidden || !region.isConnected) return;
    loading = true;
    let result, failure;
    try {
      result = await api("/api/hosts/" + encodeURIComponent(id) + "/sessions", {});
    } catch (error) {
      failure = error.message;
    } finally {
      loading = false;
    }
    if (region.hidden || !region.isConnected) return;
    const sessions = (result?.sessions || []).map(item => ({
      title: item.title || "Phiên " + item.id,
      agent: item.agent,
      statusText: sessionStates[item.status] || sessionStates.unknown,
      tone: sessionTones[item.status] || "gray"
    }));
    const jobs = state.jobs.filter(job => job.hostId === id && job.status === "running").map(job => ({
      title: job.title,
      agent: job.agent,
      statusText: "Đang chạy · Bước " + (job.stepIndex + 1) + "/" + job.steps.length,
      tone: "blue"
    }));
    const next = JSON.stringify([sessions, jobs, result?.note, failure]);
    if (next !== signature) {
      const content = [];
      if (jobs.length) content.push(sessionGroup("Việc đang chạy qua bộ điều phối", jobs));
      if (sessions.length) content.push(sessionGroup("Phiên AI trong dự án", sessions));
      if (failure) content.push(node("p", "notice error", "Chưa tải được phiên AI. " + failure));
      else if (!sessions.length) content.push(node("p", "hint", "Lần kiểm tra này chưa ghi nhận phiên AI nào của dự án trên máy này."));
      if (result?.note) content.push(sessionNote(result.note));
      region.replaceChildren(...content);
      signature = next;
    }
    timer = setTimeout(refreshSessions, 10000);
  }
  button.addEventListener("click", () => {
    clearTimeout(timer);
    region.hidden = !region.hidden;
    button.setAttribute("aria-expanded", String(!region.hidden));
    if (labelSpan) setText(labelSpan, region.hidden ? "Phiên AI" : "Ẩn phiên AI");
    if (!region.hidden) {
      region.replaceChildren(node("p", "hint", "Đang tải phiên AI…"));
      signature = undefined;
      void refreshSessions();
    }
  });
  return region;
}

function machineCard(host) {
  const card = node("article", "machine");

  const head = node("div", "host-top");
  const identity = node("div", "host-identity");
  const platformBox = node("span", "platform-icon");
  const heading = node("div", "host-heading");
  const title = node("h3", "host-title");
  const subRow = node("div", "host-sub-row");
  const roleChip = node("span", "host-role-chip");
  const platformText = node("span", "host-platform");
  const gitPill = node("span", "git-pill");
  gitPill.hidden = true;
  subRow.append(roleChip, platformText, gitPill);
  heading.append(title, subRow);
  identity.append(platformBox, heading);
  head.append(identity, node("span", "badge"));

  const ramBlock = node("div", "ram-block");
  const ramHead = node("div", "ram-head");
  const ramText = node("p", "ram-text");
  const ramFree = node("span", "ram-free");
  const ramTotal = node("span", "ram-total");
  ramText.append(ramFree, ramTotal);
  const ramPercent = node("span", "ram-percent");
  ramHead.append(ramText, ramPercent);
  const meter = node("div", "ram-meter");
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-valuemin", "0");
  const fill = node("div", "ram-fill");
  const floor = node("div", "ram-floor");
  meter.append(fill, floor);
  ramBlock.append(ramHead, meter);

  const foot = node("div", "host-foot");
  const agents = node("div", "agent-chips");
  const links = node("div", "host-links");
  const sessions = node("button", "host-action");
  sessions.type = "button";
  sessions.append(icon("sessions", 14), node("span", "action-label", "Phiên AI"), icon("chevron-down", 13));
  const region = sessionView(host.id, sessions);
  links.append(sessions);
  if (!host.local) links.append(externalAction("Màn hình", "screen", "/screen.html", host.id));
  if (!hostFilter) links.append(externalAction("Bảng riêng", "external", "/", host.id));
  foot.append(agents, links);

  card.append(head, ramBlock, foot, node("p", "notice"), region);
  return card;
}

function paintMachine(card, host) {
  setText(card.querySelector(".host-title"), host.hostname || host.id);
  const platformKey = host.platform || "server";
  const platformBox = card.querySelector(".platform-icon");
  if (platformBox.dataset.platform !== platformKey) {
    platformBox.dataset.platform = platformKey;
    platformBox.replaceChildren(icon(platformKey, 18));
  }
  const roleChip = card.querySelector(".host-role-chip");
  roleChip.hidden = !host.local;
  setText(roleChip, "Máy này");
  const subParts = [host.local ? null : host.id, platforms[host.platform] || host.platform].filter(Boolean);
  setText(card.querySelector(".host-platform"), subParts.join(" · "));

  const gitPill = card.querySelector(".git-pill");
  if (host.revision) {
    const shortRev = host.revision.slice(0, 7);
    const cleanText = host.clean === true ? "Sạch" : host.clean === false ? "Có thay đổi" : "";
    const sig = shortRev + ":" + String(host.clean);
    if (gitPill.dataset.sig !== sig) {
      gitPill.dataset.sig = sig;
      gitPill.dataset.clean = host.clean === true ? "true" : host.clean === false ? "false" : "";
      gitPill.replaceChildren(icon("git", 11), node("span", "", cleanText ? shortRev + " · " + cleanText : shortRev));
      gitPill.title = "Commit " + shortRev + (cleanText ? " (" + cleanText + ")" : "");
    }
    gitPill.hidden = false;
  } else {
    gitPill.hidden = true;
  }

  const low = host.online && host.freeBytes < state.minFreeBytes;
  const health = !host.checkedAt ? "Đang kiểm tra" : !host.online ? "Ngoại tuyến" : low ? "Thiếu RAM" : "Trực tuyến";
  badge(card.querySelector(".host-top .badge"), health, host.online ? (low ? "amber" : "green") : "gray");

  const ramFree = card.querySelector(".ram-free");
  const ramTotal = card.querySelector(".ram-total");
  const ramPercent = card.querySelector(".ram-percent");
  const meter = card.querySelector(".ram-meter");
  const floor = card.querySelector(".ram-floor");

  if (host.online && host.totalBytes > 0) {
    const usedBytes = Math.max(0, host.totalBytes - host.freeBytes);
    const usedPct = Math.max(0, Math.min(100, (usedBytes / host.totalBytes) * 100));
    const floorPct = Math.max(0, Math.min(100, (1 - state.minFreeBytes / host.totalBytes) * 100));
    const nearFloor = low || host.freeBytes < state.minFreeBytes * 1.25;
    setText(ramFree, gib(host.freeBytes) + " khả dụng");
    setText(ramTotal, " / " + gib(host.totalBytes));
    setText(ramPercent, percents.format(usedPct) + "% đã dùng");
    ramPercent.dataset.low = String(nearFloor);
    meter.hidden = false;
    meter.dataset.low = String(nearFloor);
    meter.style.setProperty("--used-pct", usedPct.toFixed(1) + "%");
    meter.style.setProperty("--floor-pct", floorPct.toFixed(1) + "%");
    meter.setAttribute("aria-valuemax", String(host.totalBytes));
    meter.setAttribute("aria-valuenow", String(usedBytes));
    meter.setAttribute("aria-label", "RAM đã dùng trên " + (host.hostname || host.id));
    meter.setAttribute("aria-valuetext", gib(host.freeBytes) + " khả dụng / " + gib(host.totalBytes));
    floor.hidden = state.minFreeBytes <= 0 || state.minFreeBytes >= host.totalBytes;
    floor.title = "Ngưỡng điều phối: cần tối thiểu " + gib(state.minFreeBytes) + " khả dụng";
  } else {
    setText(ramFree, "Chưa có số liệu RAM hiện tại");
    setText(ramTotal, "");
    setText(ramPercent, "");
    meter.hidden = true;
  }

  const agentsBox = card.querySelector(".agent-chips");
  const agentsSig = host.online ? host.agents.join(",") : "offline";
  if (agentsBox.dataset.sig !== agentsSig) {
    agentsBox.dataset.sig = agentsSig;
    if (!host.online) {
      agentsBox.replaceChildren();
    } else if (host.agents.length) {
      agentsBox.replaceChildren(...host.agents.map(agentChip));
    } else {
      agentsBox.replaceChildren(node("span", "agent-empty", "Chưa có trợ lý sẵn sàng"));
    }
  }

  notice(card.querySelector(".notice"), host.error || host.reason);
}

function reconcile(container, items, create, update) {
  const current = new Map(Array.from(container.children, item => [item.dataset.key, item]));
  for (const [index, item] of items.entries()) {
    const row = current.get(item.id) || create(item);
    row.dataset.key = item.id;
    update(row, item);
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
    current.delete(item.id);
  }
  for (const row of current.values()) row.remove();
}

function targets(select, value) {
  select.replaceChildren(new Option("Tự động theo RAM", "auto"), ...state.hosts.map(host => new Option(host.hostname || host.id, host.id)));
  select.value = value;
}

function jobRow(job) {
  const row = node("button", "job-row");
  row.type = "button";
  const top = node("div", "job-row-top");
  top.append(node("span", "row-title"), node("span", "badge"));
  row.append(top, node("div", "job-meta"));
  row.addEventListener("click", () => {
    selected = job.id;
    render();
    if (matchMedia("(max-width: 960px)").matches) el("detail-heading").scrollIntoView({ block: "start", behavior: "smooth" });
  });
  return row;
}

function paintRow(row, job) {
  row.setAttribute("aria-current", String(selected === job.id));
  setText(row.querySelector(".row-title"), job.title);
  badge(row.querySelector(".badge"), statusNames[job.status], tones[job.status]);
  const meta = row.querySelector(".job-meta");
  const target = hostName(job.hostId || job.target);
  const stepText = "Bước " + (job.stepIndex + 1) + "/" + job.steps.length;
  const created = dates.format(new Date(job.createdAt));
  const sig = JSON.stringify([job.agent, target, stepText, created]);
  if (meta.dataset.sig !== sig) {
    meta.dataset.sig = sig;
    meta.replaceChildren(
      agentChip(job.agent),
      node("span", "job-meta-sep", "·"),
      node("span", "", target),
      node("span", "job-meta-sep", "·"),
      node("span", "", stepText),
      node("span", "job-meta-sep", "·"),
      node("span", "", created)
    );
  }
}

function renderFilterPills(jobs, activeFilter) {
  const container = el("filter-pills");
  if (!jobs.length) {
    container.hidden = true;
    filterSignature = "";
    return;
  }
  const counts = new Map();
  for (const job of jobs) counts.set(job.status, (counts.get(job.status) || 0) + 1);
  const items = [{ value: "all", label: "Tất cả", count: jobs.length }];
  for (const key of statusOrder) {
    const count = counts.get(key) || 0;
    if (count > 0 || activeFilter === key) {
      items.push({ value: key, label: statusNames[key], count });
    }
  }
  const sig = JSON.stringify([activeFilter, items]);
  container.hidden = false;
  if (sig === filterSignature) return;
  filterSignature = sig;
  container.replaceChildren(...items.map(item => {
    const button = node("button", "filter-pill");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(activeFilter === item.value));
    button.append(node("span", "", item.label), node("span", "filter-pill-count", String(item.count)));
    button.addEventListener("click", () => {
      el("status-filter").value = item.value;
      render();
    });
    return button;
  }));
}

function renderOverview(hosts, jobs) {
  const onlineHosts = hosts.filter(host => host.online);
  const lowHosts = onlineHosts.filter(host => host.freeBytes < state.minFreeBytes);
  const offlineCount = hosts.length - onlineHosts.length;

  setText(el("stat-hosts"), onlineHosts.length + " / " + hosts.length);
  if (!hosts.length) setText(el("stat-hosts-sub"), "Chưa có máy cấu hình");
  else if (!onlineHosts.length) setText(el("stat-hosts-sub"), "Chưa có máy trực tuyến");
  else if (lowHosts.length) setText(el("stat-hosts-sub"), lowHosts.length + " máy dưới ngưỡng RAM");
  else if (offlineCount > 0) setText(el("stat-hosts-sub"), offlineCount + " máy ngoại tuyến");
  else setText(el("stat-hosts-sub"), "Tất cả sẵn sàng nhận việc");

  const totalFree = onlineHosts.reduce((sum, host) => sum + (host.freeBytes || 0), 0);
  const totalCap = onlineHosts.reduce((sum, host) => sum + (host.totalBytes || 0), 0);
  setText(el("stat-ram"), onlineHosts.length ? gib(totalFree) : "—");
  setText(el("stat-ram-sub"), totalCap > 0 ? "/ " + gib(totalCap) + " toàn cụm" : "Chưa có số liệu RAM");

  const runningCount = jobs.filter(job => job.status === "running").length;
  const queuedCount = jobs.filter(job => job.status === "queued").length;
  const uncertainCount = jobs.filter(job => job.status === "uncertain").length;
  const activeCount = runningCount + queuedCount + uncertainCount;
  setText(el("stat-active"), String(activeCount));
  const activeParts = [];
  if (runningCount) activeParts.push(runningCount + " đang chạy");
  if (queuedCount) activeParts.push(queuedCount + " chờ phân công");
  if (uncertainCount) activeParts.push(uncertainCount + " chờ xác minh");
  setText(el("stat-active-sub"), activeParts.length ? activeParts.join(" · ") : "Hàng chờ đang rảnh");

  const doneCount = jobs.filter(job => job.status === "completed").length;
  const failCount = jobs.filter(job => job.status === "failed").length;
  const cancelCount = jobs.filter(job => job.status === "cancelled").length;
  setText(el("stat-done"), doneCount + " / " + jobs.length);
  if (failCount) setText(el("stat-done-sub"), failCount + " thất bại" + (cancelCount ? " · " + cancelCount + " đã hủy" : ""));
  else if (cancelCount) setText(el("stat-done-sub"), cancelCount + " đã hủy");
  else if (!jobs.length) setText(el("stat-done-sub"), "Chưa có công việc nào");
  else setText(el("stat-done-sub"), "Không có công việc thất bại");
}

function stepRows(job) {
  const signature = JSON.stringify([job.id, job.status, job.steps, job.history]);
  if (signature === stepHistory) return;
  stepHistory = signature;
  const expanded = new Set(Array.from(el("steps").querySelectorAll("details[open]"), item => item.dataset.receipt));
  const focusReceipt = document.activeElement?.closest("details")?.dataset.receipt;
  el("steps").replaceChildren(...job.steps.map((step, index) => {
    const entry = job.history.find(attempt => attempt.stepIndex === index);
    const status = entry?.status || (index >= job.stepIndex && job.status === "cancelled" ? "cancelled" : "pending");
    const tone = tones[status] || "gray";
    const row = node("li", "step-row");

    const marker = node("span", "step-node");
    marker.dataset.tone = tone;
    if (status === "completed") marker.append(icon("check", 13));
    else marker.textContent = String(index + 1);

    const card = node("div", "step-card");
    const meta = node("div", "step-meta");
    const metaLeft = node("div", "step-meta-left");
    const tag = node("span", "badge");
    badge(tag, statusNames[status] || status, tone);
    metaLeft.append(node("strong", "", "Bước " + (index + 1)), tag);
    meta.append(metaLeft);
    if (entry?.hostId) meta.append(node("span", "step-host", hostName(entry.hostId)));
    card.append(meta, node("p", "step-prompt", step));

    if (entry?.output) {
      const details = node("details", "output-details");
      details.dataset.receipt = entry.requestId;
      details.open = expanded.has(entry.requestId);
      const summary = node("summary", "output-summary");
      const summaryLeft = node("span", "output-summary-left");
      const label = entry.outputTruncated ? "Kết quả (đã rút gọn)" : "Kết quả";
      summaryLeft.append(icon("chevron-right", 13), node("span", "", label));
      const copyBtn = node("button", "copy-btn");
      copyBtn.type = "button";
      copyBtn.append(icon("copy", 12), node("span", "copy-label", "Sao chép"));
      copyBtn.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        void copyText(entry.output, copyBtn, "Đã sao chép kết quả bước " + (index + 1) + ".");
      });
      summary.append(summaryLeft, copyBtn);
      details.append(summary, node("pre", "step-output", entry.output));
      card.append(details);
    }

    if (entry?.status === "uncertain") {
      const receiptRow = node("div", "receipt-row");
      const copyBtn = node("button", "secondary receipt-copy");
      copyBtn.type = "button";
      copyBtn.append(icon("copy", 12), node("span", "copy-label", "Sao chép mã"));
      copyBtn.addEventListener("click", () => {
        void copyText(entry.requestId, copyBtn, "Đã sao chép mã biên nhận.");
      });
      receiptRow.append(node("p", "receipt", "Mã biên nhận: " + entry.requestId), copyBtn);
      card.append(receiptRow);
    }

    row.append(marker, card);
    return row;
  }));
  if (focusReceipt) {
    Array.from(el("steps").querySelectorAll("details"))
      .find(item => item.dataset.receipt === focusReceipt)
      ?.querySelector("summary")
      ?.focus({ preventScroll: true });
  }
}

function renderDetail(job) {
  el("job-detail").hidden = !job;
  el("empty-detail").hidden = Boolean(job);
  const progress = el("detail-progress");
  progress.hidden = !job;
  if (!job) { detailId = null; return; }
  setText(progress, "Bước " + (job.stepIndex + 1) + "/" + job.steps.length);
  setText(el("job-title"), job.title);
  badge(el("job-status"), statusNames[job.status], tones[job.status]);
  const agentTag = el("job-agent");
  agentTag.dataset.agent = job.agent;
  setText(agentTag, agentNames[job.agent] || job.agent);
  setText(el("job-target"), hostName(job.hostId || job.target));
  setText(el("job-created"), dates.format(new Date(job.createdAt)));
  notice(el("job-error"), job.error);
  el("job-actions").hidden = job.status !== "queued";
  const key = JSON.stringify([job.target, state.hosts.map(host => [host.id, host.hostname])]);
  if (detailId !== job.id || targetKey !== key) targets(el("new-target"), job.target);
  targetKey = key;
  detailId = job.id;
  el("move-job").disabled = changing || !online || job.target === el("new-target").value;
  el("cancel-job").disabled = changing || !online;
  stepRows(job);
}

function render() {
  const hosts = state.hosts.filter(host => !hostFilter || host.id === hostFilter);
  const jobs = state.jobs.filter(job => !hostFilter || job.hostId === hostFilter || job.target === hostFilter || job.history.some(entry => entry.hostId === hostFilter));
  const filter = el("status-filter").value;
  const shown = jobs.filter(job => filter === "all" || job.status === filter);
  if (!shown.some(job => job.id === selected)) selected = shown[0]?.id || null;
  const title = hostFilter ? "Máy " + hostName(hostFilter) : "Điều phối công việc";
  setText(el("page-title"), title);
  setText(el("bar-division"), hostFilter ? hostName(hostFilter) : "Điều phối máy");
  document.title = title + " · Codex Bridge";
  el("all-hosts").hidden = !hostFilter;
  el("new-job").disabled = !online || hosts.length === 0;
  el("edit-memory").disabled = !online;
  setText(el("summary"), hosts.filter(host => host.online).length + "/" + hosts.length + " máy trực tuyến · " + jobs.length + " công việc");
  setText(el("machines-count"), String(hosts.length));
  setText(el("queue-count"), String(shown.length));
  const floorGiB = state.minFreeBytes ? (state.minFreeBytes / 1024 ** 3).toLocaleString("vi-VN", { maximumSignificantDigits: 7 }) : "—";
  setText(el("threshold"), "RAM tối thiểu " + floorGiB + " GiB");
  el("setup-hint").hidden = Boolean(hostFilter) || state.hosts.some(host => !host.local);
  renderOverview(hosts, jobs);
  reconcile(el("machines"), hosts, machineCard, paintMachine);
  renderFilterPills(jobs, filter);
  reconcile(el("job-list"), shown, jobRow, paintRow);
  el("empty-queue").hidden = shown.length > 0;
  setText(el("empty-heading"), jobs.length ? "Chưa có việc ở trạng thái này" : "Chưa có công việc");
  setText(el("empty-description"), jobs.length ? "Chọn trạng thái khác để xem công việc." : "Công việc đã tạo sẽ xuất hiện ở đây.");
  renderDetail(shown.find(job => job.id === selected));
  if (hostFilter && hosts.length === 0) pollError = "Máy này chưa có trong cấu hình điều phối.";
}

async function refresh() {
  const index = ++requestIndex;
  try {
    const latest = await api("/api/state");
    if (index !== requestIndex) return;
    state = latest;
    online = true;
    pollError = latest.error || "";
    render();
  } catch (error) {
    if (index !== requestIndex) return;
    online = false;
    pollError = error.message;
    el("new-job").disabled = true;
    el("edit-memory").disabled = true;
    el("move-job").disabled = true;
    el("cancel-job").disabled = true;
  }
  el("connection").dataset.online = String(online);
  setText(el("connection"), online ? "Đã kết nối" : "Mất kết nối");
  notice(el("page-error"), pollError || actionError);
}

function numberFields() {
  const fields = Array.from(el("step-fields").children);
  fields.forEach((field, i) => {
    const label = field.querySelector("label");
    label.textContent = "Bước " + (i + 1);
    label.htmlFor = "step-input-" + i;
    field.querySelector("textarea").id = label.htmlFor;
    const remove = field.querySelector("button");
    remove.hidden = fields.length === 1;
    remove.setAttribute("aria-label", "Bỏ bước " + (i + 1));
  });
  el("add-step").disabled = fields.length >= 16;
}

function addField() {
  const field = node("div", "step-field");
  const label = node("div", "step-label");
  const remove = node("button", "step-remove", "Bỏ bước");
  remove.type = "button";
  remove.addEventListener("click", () => {
    const sibling = field.previousElementSibling || field.nextElementSibling;
    field.remove();
    numberFields();
    sibling?.querySelector("textarea").focus();
  });
  label.append(node("label"), remove);
  const input = node("textarea");
  input.required = true;
  input.maxLength = 32768;
  input.placeholder = "Nhập hướng dẫn chi tiết cho bước này…";
  field.append(label, input);
  el("step-fields").append(field);
  numberFields();
  return input;
}

function syncMemoryPresets() {
  const value = el("memory-input").valueAsNumber;
  for (const button of el("memory-presets").querySelectorAll(".preset-chip")) {
    button.dataset.active = String(Number(button.dataset.gib) === value);
  }
}

async function changeJob(action, data) {
  if (changing || !online || !selected) return;
  changing = true;
  renderDetail(state.jobs.find(job => job.id === selected));
  try {
    await api("/api/jobs/" + encodeURIComponent(selected) + "/" + action, data);
    actionError = "";
    showToast(action === "target" ? "Đã đổi máy nhận." : "Đã hủy công việc.");
  } catch (error) {
    actionError = error.message;
  } finally {
    changing = false;
    await refresh();
  }
}

el("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("fleet-theme", next);
  applyTheme(next);
});

el("status-filter").addEventListener("change", render);

el("edit-memory").addEventListener("click", () => {
  el("memory-input").value = String(state.minFreeBytes / 1024 ** 3);
  syncMemoryPresets();
  notice(el("memory-error"), "");
  el("memory-dialog").showModal();
});

el("memory-input").addEventListener("input", syncMemoryPresets);

for (const button of el("memory-presets").querySelectorAll(".preset-chip")) {
  button.addEventListener("click", () => {
    el("memory-input").value = button.dataset.gib;
    syncMemoryPresets();
    notice(el("memory-error"), "");
  });
}

for (const id of ["close-memory", "dismiss-memory"]) {
  el(id).addEventListener("click", () => {
    if (!el("save-memory").disabled) el("memory-dialog").close();
  });
}

el("memory-dialog").addEventListener("click", event => {
  if (event.target === el("memory-dialog") && !el("save-memory").disabled) el("memory-dialog").close();
});

el("memory-dialog").addEventListener("cancel", event => {
  if (el("save-memory").disabled) event.preventDefault();
});

el("memory-form").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = el("save-memory");
  if (submit.disabled) return;
  const minFreeGiB = el("memory-input").valueAsNumber;
  const bytes = Math.round(minFreeGiB * 1024 ** 3);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    notice(el("memory-error"), "Nhập ngưỡng RAM dương, tương đương ít nhất 1 byte.");
    return;
  }
  submit.disabled = el("close-memory").disabled = el("dismiss-memory").disabled = true;
  try {
    await api("/api/settings/memory", { minFreeGiB });
    el("memory-dialog").close();
    showToast("Đã cập nhật ngưỡng RAM cho các bước đang chờ.");
    await refresh();
  } catch (error) {
    notice(el("memory-error"), error.message);
  } finally {
    submit.disabled = el("close-memory").disabled = el("dismiss-memory").disabled = false;
  }
});

el("new-target").addEventListener("change", () => renderDetail(state.jobs.find(job => job.id === selected)));
el("move-job").addEventListener("click", () => changeJob("target", { target: el("new-target").value }));
el("cancel-job").addEventListener("click", () => changeJob("cancel", {}));
el("add-step").addEventListener("click", () => addField().focus());

el("new-job").addEventListener("click", () => {
  el("job-form").reset();
  el("step-fields").replaceChildren();
  addField();
  targets(el("target-input"), hostFilter || "auto");
  notice(el("form-error"), "");
  el("job-dialog").showModal();
});

for (const id of ["dismiss", "back"]) {
  el(id).addEventListener("click", () => {
    if (!el("submit-job").disabled) el("job-dialog").close();
  });
}

el("job-dialog").addEventListener("click", event => {
  if (event.target === el("job-dialog") && !el("submit-job").disabled) el("job-dialog").close();
});

el("job-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (el("submit-job").disabled) return;
  el("submit-job").disabled = true;
  try {
    const steps = Array.from(el("step-fields").querySelectorAll("textarea"), input => input.value.trim());
    if (steps.some(step => !step || new TextEncoder().encode(step).length > 32768)) throw new Error("Mỗi bước cần có nội dung và dài tối đa 32 KiB.");
    const title = el("title-input").value.trim();
    if (!title) throw new Error("Nhập tên công việc.");
    const job = await api("/api/jobs", { title, agent: el("agent-input").value, target: el("target-input").value, steps });
    selected = job.id;
    actionError = "";
    el("status-filter").value = "all";
    el("job-dialog").close();
    showToast("Đã thêm công việc vào hàng chờ.");
    await refresh();
  } catch (error) {
    notice(el("form-error"), error.message);
  } finally {
    el("submit-job").disabled = false;
  }
});

window.addEventListener("hashchange", () => {
  if (consumeSessionHash()) void refresh();
});

window.addEventListener("storage", event => {
  if (event.key === "fleet-session") void refresh();
});

async function poll() {
  await refresh();
  setTimeout(poll, 4000);
}
poll();
