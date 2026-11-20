const el = id => document.getElementById(id);
const svgNs = "http://www.w3.org/2000/svg";
const hostFilter = new URLSearchParams(location.search).get("host");
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const maxStepBytes = 32 * 1024;
const encoder = new TextEncoder();

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
    const label = resolved === "dark" ? "Chuyển sang giao diện sáng (D)" : "Chuyển sang giao diện tối (D)";
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
const agentIcons = { codex: "/icons/codex.svg", claude: "/icons/claude.svg", antigravity: "/icons/antigravity.svg" };
const platformIcons = { win32: "/icons/windows.svg", darwin: "/icons/apple.svg", linux: "/icons/linux.svg" };
const platforms = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const numbers = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const percents = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });
const dates = new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short" });
const times = new Intl.DateTimeFormat("vi-VN", { timeStyle: "medium" });
const gib = bytes => numbers.format(bytes / (1024 ** 3)) + " GiB";

const builtinTemplates = [
  {
    id: "builtin-git-node",
    name: "Kiểm tra Git & Node",
    title: "Xác nhận commit và phiên bản Node",
    agent: "codex",
    steps: ["Read-only check. Run git rev-parse --short HEAD, git status --short, and node -v. Reply concisely with the results without modifying files."],
  },
  {
    id: "builtin-tests",
    name: "Chạy kiểm thử",
    title: "Chạy bộ test trên máy đích",
    agent: "codex",
    steps: ["Run the project test suite without changing files and summarize total pass, fail, and any failing test names."],
  },
  {
    id: "builtin-two-step",
    name: "Kiểm tra 2 bước",
    title: "Kiểm tra trạng thái và tổng hợp thay đổi",
    agent: "codex",
    steps: [
      "Inspect git log -n 5 --oneline and git status --short without changing files.",
      "Summarize the recent commits and highlight any follow-up verification needed.",
    ],
  },
];

let state = { hosts: [], jobs: [] };
let selected = null;
let visibleJobs = [];
let requestIndex = 0;
let online = false;
let changing = false;
let refreshingNow = false;
let detailId;
let stepHistory;
let targetKey;
let filterSignature;
let pollError = "";
let actionError = "";
let toastTimer;
let pruneTimer;
let pruneArmed = false;
let hasBaseline = false;
let lastSyncedAt = null;
let previousStatuses = new Map();
let notifyEnabled = localStorage.getItem("fleet-notify") === "1";
let activeActivityTab = "live";
let procCategory = "all";
let procGroupEnabled = true;
let activityScanning = false;
let activityLoadedOnce = false;
let activityLastScan = null;
let activityHostKey = "";
let procPillsSig = "";
let bgListSig = "";
let procTableSig = "";
const hostActivity = new Map();
const hostSessions = new Map();
const openBgTaskIds = new Set();
const processCategories = [
  { value: "all", label: "Tất cả" },
  { value: "agent", label: "Agent AI" },
  { value: "ci", label: "CI / Build / Test" },
  { value: "server", label: "Dev Server" },
  { value: "script", label: "Script / Git" },
  { value: "mcp", label: "MCP Server" },
];
const categoryLabels = { agent: "Agent AI", ci: "CI / Test", server: "Dev Server", script: "Script / Git", mcp: "MCP Server" };
const categoryRank = { agent: 0, ci: 1, server: 2, script: 3, mcp: 4 };
const processStateLabels = { running: "Đang chạy", sleeping: "Ngầm", idle: "Rảnh", stopped: "Tạm dừng", unresponsive: "Không phản hồi" };
const relayTaskStatuses = { queued: "Đang chờ", running: "Đang chạy", completed: "Hoàn tất", failed: "Thất bại", unknown: "Chờ xác minh" };
const relayTaskTones = { queued: "amber", running: "blue", completed: "green", failed: "red", unknown: "amber" };
const workerReadinessLabels = { ready: "Sẵn sàng", "authentication-unverified": "Chưa xác thực", disabled: "Đã tắt", blocked: "Chặn" };
const workerReadinessTones = { ready: "green", "authentication-unverified": "amber", disabled: "gray", blocked: "red" };

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function brandImg(src, className) {
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.className = className;
  img.draggable = false;
  img.decoding = "sync";
  img.setAttribute("aria-hidden", "true");
  return img;
}

function svgEl(tag, attrs = {}) {
  const item = document.createElementNS(svgNs, tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
  return item;
}

function icon(name, size = 14) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24", width: size, height: size, fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true"
  });
  if (name === "sessions") {
    svg.append(
      svgEl("path", { d: "M12 8V4H8" }),
      svgEl("rect", { width: 16, height: 12, x: 4, y: 8, rx: 2 }),
      svgEl("path", { d: "M2 14h2M20 14h2M15 13v2M9 13v2" })
    );
  } else if (name === "windows") {
    svg.append(
      svgEl("rect", { x: 2, y: 4, width: 20, height: 16, rx: 2 }),
      svgEl("path", { d: "M10 4v4M2 8h20M6 4v4" })
    );
  } else if (name === "send") {
    svg.append(
      svgEl("path", { d: "M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" }),
      svgEl("path", { d: "m21.854 2.147-10.94 10.939" })
    );
  } else if (name === "refresh") {
    svg.append(
      svgEl("path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }),
      svgEl("path", { d: "M21 3v5h-5" }),
      svgEl("path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }),
      svgEl("path", { d: "M8 16H3v5" })
    );
  } else if (name === "rotate") {
    svg.append(
      svgEl("path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }),
      svgEl("path", { d: "M21 3v5h-5" })
    );
  } else if (name === "chevron-down") {
    svg.classList.add("chevron");
    svg.append(svgEl("path", { d: "m6 9 6 6 6-6" }));
  } else if (name === "chevron-right") {
    svg.classList.add("chevron");
    svg.append(svgEl("path", { d: "m9 18 6-6-6-6" }));
  } else if (name === "screen") {
    svg.append(
      svgEl("rect", { width: 20, height: 14, x: 2, y: 3, rx: 2 }),
      svgEl("line", { x1: 8, x2: 16, y1: 21, y2: 21 }),
      svgEl("line", { x1: 12, x2: 12, y1: 17, y2: 21 })
    );
  } else if (name === "external") {
    svg.append(
      svgEl("path", { d: "M15 3h6v6" }),
      svgEl("path", { d: "M10 14 21 3" }),
      svgEl("path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" })
    );
  } else if (name === "info") {
    svg.append(
      svgEl("circle", { cx: 12, cy: 12, r: 10 }),
      svgEl("path", { d: "M12 16v-4" }),
      svgEl("path", { d: "M12 8h.01" })
    );
  } else if (name === "check") {
    svg.append(svgEl("path", { d: "M20 6 9 17l-5-5" }));
  } else if (name === "alert") {
    svg.append(
      svgEl("path", { d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }),
      svgEl("path", { d: "M12 9v4" }),
      svgEl("path", { d: "M12 17h.01" })
    );
  } else if (name === "x") {
    svg.append(
      svgEl("path", { d: "M18 6 6 18" }),
      svgEl("path", { d: "m6 6 12 12" })
    );
  } else if (name === "ban") {
    svg.append(
      svgEl("circle", { cx: 12, cy: 12, r: 10 }),
      svgEl("path", { d: "m4.9 4.9 14.2 14.2" })
    );
  } else if (name === "copy") {
    svg.append(
      svgEl("rect", { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 }),
      svgEl("path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" })
    );
  } else if (name === "terminal") {
    svg.append(
      svgEl("polyline", { points: "4 17 10 11 4 5" }),
      svgEl("line", { x1: 12, x2: 20, y1: 19, y2: 19 })
    );
  } else if (name === "arrow-up") {
    svg.append(
      svgEl("path", { d: "m5 12 7-7 7 7" }),
      svgEl("path", { d: "M12 19V5" })
    );
  } else if (name === "arrow-down") {
    svg.append(
      svgEl("path", { d: "M12 5v14" }),
      svgEl("path", { d: "m19 12-7 7-7-7" })
    );
  } else if (name === "trash") {
    svg.append(
      svgEl("path", { d: "M3 6h18" }),
      svgEl("path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }),
      svgEl("path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" })
    );
  } else if (name === "play") {
    svg.append(svgEl("polygon", { points: "6 3 20 12 6 21 6 3" }));
  } else if (name === "activity") {
    svg.append(svgEl("path", { d: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }));
  } else if (name === "globe") {
    svg.append(
      svgEl("circle", { cx: 12, cy: 12, r: 10 }),
      svgEl("path", { d: "M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" }),
      svgEl("path", { d: "M2 12h20" })
    );
  } else if (name === "cog") {
    svg.append(
      svgEl("circle", { cx: 12, cy: 12, r: 3 }),
      svgEl("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" })
    );
  } else if (name === "layers") {
    svg.append(
      svgEl("path", { d: "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" }),
      svgEl("path", { d: "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" }),
      svgEl("path", { d: "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" })
    );
  } else {
    svg.append(
      svgEl("rect", { width: 20, height: 8, x: 2, y: 2, rx: 2, ry: 2 }),
      svgEl("rect", { width: 20, height: 8, x: 2, y: 14, rx: 2, ry: 2 }),
      svgEl("line", { x1: 6, x2: 6.01, y1: 6, y2: 6 }),
      svgEl("line", { x1: 6, x2: 6.01, y1: 18, y2: 18 })
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
  toastTimer = setTimeout(() => { item.dataset.visible = "false"; }, 3400);
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  return numbers.format(bytes / 1024) + " KiB";
}

function formatMem(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes >= 1024 ** 3) return numbers.format(bytes / (1024 ** 3)) + " GiB";
  if (bytes >= 1024 ** 2) return numbers.format(bytes / (1024 ** 2)) + " MiB";
  if (bytes >= 1024) return numbers.format(bytes / 1024) + " KiB";
  return bytes + " B";
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "p " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "g " + (m % 60) + "p";
  const d = Math.floor(h / 24);
  return d + "ng " + (h % 24) + "g";
}

function formatCpu(proc) {
  if (typeof proc.cpuPercent === "number" && Number.isFinite(proc.cpuPercent)) return numbers.format(proc.cpuPercent) + "%";
  if (typeof proc.cpuSeconds === "number" && Number.isFinite(proc.cpuSeconds) && proc.cpuSeconds > 0) return formatDuration(proc.cpuSeconds);
  return "—";
}

function procRamPct(bytes, maxBytes) {
  const ref = Math.max(maxBytes || 0, 256 * 1024 * 1024);
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.max(4, Math.min(100, (bytes / ref) * 100));
}

function processMark(proc) {
  const agent = proc.agent;
  if (agent && agentIcons[agent]) return brandImg(agentIcons[agent], "proc-brand-icon");
  const name = String(proc.name || "");
  if (/^claude/i.test(name)) return brandImg("/icons/claude.svg", "proc-brand-icon");
  if (/^codex/i.test(name)) return brandImg("/icons/codex.svg", "proc-brand-icon");
  if (/^(?:antigravity|language_server)/i.test(name)) return brandImg("/icons/antigravity.svg", "proc-brand-icon");
  if (/^git$/i.test(name)) return brandImg("/icons/git.svg", "proc-brand-icon");
  const iconName = proc.category === "agent" ? "sessions" : proc.category === "ci" ? "play"
    : proc.category === "server" ? "globe" : proc.category === "mcp" ? "layers" : "terminal";
  const elIcon = icon(iconName, 14);
  elIcon.classList.add("proc-cat-icon");
  return elIcon;
}

function groupCodeProcesses(rows) {
  const groups = new Map();
  for (const proc of rows) {
    const label = proc.label || proc.name;
    const key = (proc.host?.id || "") + "\0" + proc.category + "\0" + label;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...proc,
        label,
        count: 1,
        pids: [proc.pid],
        memoryBytes: proc.memoryBytes || 0,
        cpuPercent: proc.cpuPercent,
        cpuSeconds: proc.cpuSeconds,
        uptimeSeconds: proc.uptimeSeconds ?? null,
      });
    } else {
      existing.count += 1;
      existing.pids.push(proc.pid);
      existing.memoryBytes += proc.memoryBytes || 0;
      if (typeof proc.cpuPercent === "number") existing.cpuPercent = (existing.cpuPercent || 0) + proc.cpuPercent;
      if (typeof proc.cpuSeconds === "number") existing.cpuSeconds = Math.round(((existing.cpuSeconds || 0) + proc.cpuSeconds) * 10) / 10;
      if (typeof proc.uptimeSeconds === "number" && (existing.uptimeSeconds == null || proc.uptimeSeconds > existing.uptimeSeconds)) {
        existing.uptimeSeconds = proc.uptimeSeconds;
      }
      if (!existing.agent && proc.agent) existing.agent = proc.agent;
      if (!existing.role && proc.role) existing.role = proc.role;
    }
  }
  return [...groups.values()];
}

function hostInline(host) {
  const wrap = node("span", "host-inline");
  const platformKey = host?.platform || "server";
  if (platformIcons[platformKey]) {
    const img = brandImg(platformIcons[platformKey], "mini-os-icon");
    img.dataset.platform = platformKey;
    wrap.append(img);
  } else {
    wrap.append(icon("server", 13));
  }
  wrap.append(node("span", "", host?.hostname || host?.id || "—"));
  return wrap;
}

function syncNotifyButton() {
  const active = notifyEnabled && typeof Notification !== "undefined" && Notification.permission === "granted";
  const button = el("notify-toggle");
  button.setAttribute("aria-pressed", String(active));
  const label = active ? "Đang bật thông báo máy tính khi xong việc" : "Bật thông báo máy tính khi công việc hoàn tất";
  button.setAttribute("aria-label", label);
  button.title = label;
}

syncNotifyButton();

function notifyJobChanges(jobs) {
  if (!hasBaseline) {
    previousStatuses = new Map(jobs.map(job => [job.id, job.status]));
    hasBaseline = true;
    return;
  }
  for (const job of jobs) {
    const prev = previousStatuses.get(job.id);
    if (!prev || prev === job.status) continue;
    if (["completed", "failed", "uncertain"].includes(job.status)) {
      const headline = statusNames[job.status] + ": " + job.title;
      showToast(headline);
      if (notifyEnabled && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification("Codex Bridge · " + statusNames[job.status], { body: job.title });
        } catch {}
      }
    }
  }
  previousStatuses = new Map(jobs.map(job => [job.id, job.status]));
}

async function copyText(text, button, message) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button?.querySelector(".copy-label");
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
  if (response.status === 401) throw Object.assign(new Error("Phiên đã hết hạn. Chạy lại worker-relay dashboard để mở bảng điều phối."), { status: 401 });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "Không thể thực hiện yêu cầu."), { status: response.status });
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

function fillAgentChip(chip, agent) {
  const sig = String(agent || "");
  if (chip.dataset.agent === sig && chip.childNodes.length) return;
  chip.dataset.agent = sig;
  const mark = agentIcons[agent] ? brandImg(agentIcons[agent], "agent-brand-icon") : icon("sessions", 13);
  chip.replaceChildren(mark, node("span", "", agentNames[agent] || agent));
}

function agentChip(agent) {
  const chip = node("span", "agent-chip");
  fillAgentChip(chip, agent);
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

function sessionGroup(title, rows, onRefresh) {
  const group = node("div", "session-group");
  const head = node("div", "session-group-head");
  const meta = node("div", "session-group-meta");
  meta.append(node("span", "count-pill", String(rows.length)));
  if (onRefresh) {
    const refreshBtn = node("button", "inspector-refresh");
    refreshBtn.type = "button";
    refreshBtn.append(icon("refresh", 12), node("span", "", "Tải lại"));
    refreshBtn.addEventListener("click", onRefresh);
    meta.append(refreshBtn);
  }
  head.append(node("span", "session-group-title", title), meta);
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

function inspectorView(id, sessionsBtn, windowsBtn, processesBtn) {
  const region = node("div", "session-region");
  region.id = "inspector-" + id;
  region.hidden = true;
  sessionsBtn.setAttribute("aria-controls", region.id);
  sessionsBtn.setAttribute("aria-expanded", "false");
  windowsBtn.setAttribute("aria-controls", region.id);
  windowsBtn.setAttribute("aria-expanded", "false");
  processesBtn.setAttribute("aria-controls", region.id);
  processesBtn.setAttribute("aria-expanded", "false");

  let mode = null;
  let timer;
  let requestSeq = 0;
  let signature;
  let windowQuery = "";
  let processQuery = "";
  let cachedWindows = null;

  function updateButtons() {
    sessionsBtn.setAttribute("aria-expanded", String(mode === "sessions"));
    windowsBtn.setAttribute("aria-expanded", String(mode === "windows"));
    processesBtn.setAttribute("aria-expanded", String(mode === "processes"));
    const sessionLabel = sessionsBtn.querySelector(".action-label");
    if (sessionLabel) setText(sessionLabel, mode === "sessions" ? "Ẩn phiên AI" : "Phiên AI");
    const winLabel = windowsBtn.querySelector(".action-label");
    if (winLabel) setText(winLabel, mode === "windows" ? "Ẩn cửa sổ" : "Cửa sổ");
    const procLabel = processesBtn.querySelector(".action-label");
    if (procLabel) setText(procLabel, mode === "processes" ? "Ẩn chạy ngầm" : "Chạy ngầm");
  }

  function paintWindowItems(list, rows) {
    list.replaceChildren(...rows.map(item => {
      const row = node("li", "session-item");
      const main = node("div", "session-main");
      const app = node("span", "app-chip", item.app);
      app.title = item.app;
      main.append(app, node("span", "session-title", item.title || "(Không tiêu đề)"));
      row.append(main);
      return row;
    }));
  }

  function paintProcessItems(list, rows, totalBytes) {
    const grouped = groupCodeProcesses(rows).slice(0, 30);
    const maxBytes = grouped.reduce((max, item) => Math.max(max, item.memoryBytes || 0), 0);
    list.replaceChildren(...grouped.map(proc => {
      const row = node("li", "inspector-proc-row");
      const left = node("div", "proc-name-cell");
      left.append(processMark(proc), node("span", "proc-name-text", proc.label || proc.name));
      if (proc.count > 1) left.append(node("span", "proc-count-badge", "×" + proc.count));
      const pidText = proc.count > 1
        ? (proc.uptimeSeconds != null ? formatDuration(proc.uptimeSeconds) : proc.count + " luồng")
        : "PID " + proc.pid + (proc.uptimeSeconds != null ? " · " + formatDuration(proc.uptimeSeconds) : "");
      const pidEl = node("span", "proc-pid", pidText);
      if (proc.count > 1) pidEl.title = "PID: " + proc.pids.join(", ");
      const ramCell = node("span", "proc-ram-cell");
      const bar = node("span", "proc-bar");
      const pct = procRamPct(proc.memoryBytes, maxBytes);
      const fill = node("span", "proc-bar-fill");
      fill.style.setProperty("--proc-pct", pct.toFixed(1) + "%");
      bar.append(fill);
      if (totalBytes > 0) ramCell.title = numbers.format((proc.memoryBytes / totalBytes) * 100) + "% RAM máy";
      ramCell.append(bar, node("span", "", formatMem(proc.memoryBytes)));
      row.append(left, pidEl, ramCell);
      return row;
    }));
  }

  function renderProcessesView(result, failure) {
    const content = [];
    const rows = result?.processes || [];
    const totalCount = result?.totalProcesses || rows.length;
    const hostInfo = state.hosts.find(item => item.id === id);
    const totalBytes = hostInfo?.totalBytes || 0;
    const q = processQuery.trim().toLowerCase();
    const filtered = q ? rows.filter(p => (p.label || p.name).toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || String(p.pid).includes(q)) : rows;

    const head = node("div", "session-group-head");
    const meta = node("div", "session-group-meta");
    meta.append(node("span", "count-pill", q ? filtered.length + "/" + totalCount : String(totalCount)));
    const refreshBtn = node("button", "inspector-refresh");
    refreshBtn.type = "button";
    refreshBtn.append(icon("refresh", 12), node("span", "", "Tải lại"));
    refreshBtn.addEventListener("click", () => { void loadProcesses(true); });
    meta.append(refreshBtn);
    head.append(node("span", "session-group-title", "Agent & Phiên code chạy ẩn"), meta);
    content.push(head);

    if (failure) {
      content.push(node("p", "notice error", "Chưa tải được phiên chạy ngầm. " + failure));
    } else {
      if (result?.relay) {
        const bar = node("div", "inspector-relay-bar");
        const relayState = result.relay.online
          ? "Worker Relay v" + (result.relay.version || "?") + " · PID " + (result.relay.pid || "—") + " · Chạy " + result.relay.active + " · Chờ " + result.relay.queued
          : "Worker Relay ngoại tuyến";
        bar.append(node("span", "", relayState));
        if (result.relay.workers?.length) {
          const workersWrap = node("div", "inspector-workers");
          for (const w of result.relay.workers) {
            const chip = agentChip(w.agent);
            const st = node("span", "worker-state", workerReadinessLabels[w.readiness] || w.readiness);
            st.dataset.tone = workerReadinessTones[w.readiness] || "gray";
            workersWrap.append(chip, st);
          }
          bar.append(workersWrap);
        }
        content.push(bar);
      }
      if (rows.length > 5) {
        const input = node("input", "window-filter");
        input.type = "search";
        input.value = processQuery;
        input.placeholder = "Lọc theo Agent, CI, script hoặc PID…";
        input.setAttribute("aria-label", "Lọc phiên code chạy ẩn trên máy này");
        input.addEventListener("input", () => {
          processQuery = input.value;
          const list = region.querySelector(".session-list");
          const pill = region.querySelector(".count-pill");
          const empty = region.querySelector(".window-empty");
          const query = processQuery.trim().toLowerCase();
          const next = query ? rows.filter(p => (p.label || p.name).toLowerCase().includes(query) || p.name.toLowerCase().includes(query) || String(p.pid).includes(query)) : rows;
          if (pill) setText(pill, query ? next.length + "/" + totalCount : String(totalCount));
          if (list) paintProcessItems(list, next, totalBytes);
          if (empty) empty.hidden = next.length > 0;
        });
        content.push(input);
      }
      const list = node("ul", "session-list");
      paintProcessItems(list, filtered, totalBytes);
      const empty = node("p", "hint window-empty", rows.length ? "Không có phiên chạy ẩn khớp từ khóa lọc." : "Chưa ghi nhận tiến trình Agent hay phiên code chạy ẩn nào.");
      empty.hidden = filtered.length > 0;
      content.push(list, empty);
    }
    if (result?.note) content.push(sessionNote(result.note));
    region.replaceChildren(...content);
  }

  async function loadProcesses(manual = false) {
    if (mode !== "processes" || !region.isConnected) return;
    const seq = ++requestSeq;
    const existing = hostActivity.get(id);
    if (manual || !existing) region.replaceChildren(node("p", "hint", "Đang đọc tiến trình và dịch vụ chạy ngầm…"));
    else renderProcessesView(existing, null);
    let result, failure;
    try {
      result = await api("/api/hosts/" + encodeURIComponent(id) + "/activity", {});
      hostActivity.set(id, result);
      renderActivity();
    } catch (error) {
      failure = error.message;
    }
    if (seq !== requestSeq || mode !== "processes" || !region.isConnected) return;
    renderProcessesView(result, failure);
  }

  function renderWindowsView(result, failure) {
    const content = [];
    const rows = result?.windows || [];
    const q = windowQuery.trim().toLowerCase();
    const filtered = q ? rows.filter(item => item.app.toLowerCase().includes(q) || item.title.toLowerCase().includes(q)) : rows;

    const head = node("div", "session-group-head");
    const meta = node("div", "session-group-meta");
    meta.append(node("span", "count-pill", q ? filtered.length + "/" + rows.length : String(rows.length)));
    const refreshBtn = node("button", "inspector-refresh");
    refreshBtn.type = "button";
    refreshBtn.append(icon("refresh", 12), node("span", "", "Tải lại"));
    refreshBtn.addEventListener("click", () => {
      signature = undefined;
      void loadWindows(true);
    });
    meta.append(refreshBtn);
    head.append(node("span", "session-group-title", "Cửa sổ đang mở"), meta);
    content.push(head);

    if (failure) {
      content.push(node("p", "notice error", "Chưa tải được cửa sổ. " + failure));
    } else {
      if (rows.length > 5) {
        const input = node("input", "window-filter");
        input.type = "search";
        input.value = windowQuery;
        input.placeholder = "Lọc theo ứng dụng hoặc tiêu đề…";
        input.setAttribute("aria-label", "Lọc cửa sổ đang mở");
        input.addEventListener("input", () => {
          windowQuery = input.value;
          const list = region.querySelector(".session-list");
          const pill = region.querySelector(".count-pill");
          const empty = region.querySelector(".window-empty");
          const query = windowQuery.trim().toLowerCase();
          const next = query ? rows.filter(item => item.app.toLowerCase().includes(query) || item.title.toLowerCase().includes(query)) : rows;
          if (pill) setText(pill, query ? next.length + "/" + rows.length : String(rows.length));
          if (list) paintWindowItems(list, next);
          if (empty) empty.hidden = next.length > 0;
        });
        content.push(input);
      }
      const list = node("ul", "session-list");
      paintWindowItems(list, filtered);
      const empty = node("p", "hint window-empty", rows.length ? "Không có cửa sổ khớp từ khóa lọc." : "Lần kiểm tra này chưa ghi nhận cửa sổ nào đang mở.");
      empty.hidden = filtered.length > 0;
      content.push(list, empty);
    }
    if (result?.note) content.push(sessionNote(result.note));
    region.replaceChildren(...content);
  }

  async function loadWindows(manual = false) {
    if (mode !== "windows" || !region.isConnected) return;
    const seq = ++requestSeq;
    if (manual || !cachedWindows) region.replaceChildren(node("p", "hint", "Đang đọc danh sách cửa sổ…"));
    let result, failure;
    try {
      result = await api("/api/hosts/" + encodeURIComponent(id) + "/windows", {});
      cachedWindows = result;
    } catch (error) {
      failure = error.message;
    }
    if (seq !== requestSeq || mode !== "windows" || !region.isConnected) return;
    renderWindowsView(result, failure);
  }

  async function refreshSessions() {
    if (mode !== "sessions" || !region.isConnected) return;
    const seq = ++requestSeq;
    let result, failure;
    try {
      result = await api("/api/hosts/" + encodeURIComponent(id) + "/sessions", {});
      if (result) {
        hostSessions.set(id, result);
        renderActivity();
      }
    } catch (error) {
      failure = error.message;
    }
    if (seq !== requestSeq || mode !== "sessions" || !region.isConnected) return;
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
      const triggerReload = () => {
        clearTimeout(timer);
        signature = undefined;
        void refreshSessions();
      };
      const content = [];
      if (jobs.length) content.push(sessionGroup("Việc đang chạy qua bộ điều phối", jobs));
      if (sessions.length) content.push(sessionGroup("Phiên AI trong dự án", sessions, triggerReload));
      if (failure) content.push(node("p", "notice error", "Chưa tải được phiên AI. " + failure));
      else if (!sessions.length) {
        const head = node("div", "session-group-head");
        const refreshBtn = node("button", "inspector-refresh");
        refreshBtn.type = "button";
        refreshBtn.append(icon("refresh", 12), node("span", "", "Tải lại"));
        refreshBtn.addEventListener("click", triggerReload);
        head.append(node("span", "session-group-title", "Phiên AI trong dự án"), refreshBtn);
        content.push(head, node("p", "hint", "Lần kiểm tra này chưa ghi nhận phiên AI nào của dự án trên máy này."));
      }
      if (result?.note) content.push(sessionNote(result.note));
      region.replaceChildren(...content);
      signature = next;
    }
    timer = setTimeout(refreshSessions, 10000);
  }

  function toggleMode(nextMode) {
    clearTimeout(timer);
    requestSeq++;
    if (mode === nextMode) {
      mode = null;
      region.hidden = true;
      updateButtons();
      return;
    }
    mode = nextMode;
    region.hidden = false;
    signature = undefined;
    windowQuery = "";
    processQuery = "";
    updateButtons();
    if (mode === "sessions") {
      region.replaceChildren(node("p", "hint", "Đang tải phiên AI…"));
      void refreshSessions();
    } else if (mode === "windows") {
      void loadWindows(true);
    } else {
      void loadProcesses(true);
    }
  }

  sessionsBtn.addEventListener("click", () => toggleMode("sessions"));
  windowsBtn.addEventListener("click", () => toggleMode("windows"));
  processesBtn.addEventListener("click", () => toggleMode("processes"));
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
  const runningChip = node("span", "host-running-chip");
  runningChip.hidden = true;
  subRow.append(roleChip, platformText, gitPill, runningChip);
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
  const dispatchBtn = node("button", "host-action accent-action dispatch-btn");
  dispatchBtn.type = "button";
  dispatchBtn.append(icon("send", 13), node("span", "", "Giao việc"));
  dispatchBtn.addEventListener("click", () => {
    const current = state.hosts.find(item => item.id === host.id);
    openJobDialog({ target: host.id, agent: current?.agents?.[0] || "codex" });
  });
  const sessions = node("button", "host-action");
  sessions.type = "button";
  sessions.append(icon("sessions", 14), node("span", "action-label", "Phiên AI"), icon("chevron-down", 13));
  const windows = node("button", "host-action");
  windows.type = "button";
  windows.append(icon("windows", 14), node("span", "action-label", "Cửa sổ"), icon("chevron-down", 13));
  const processes = node("button", "host-action");
  processes.type = "button";
  processes.append(icon("activity", 14), node("span", "action-label", "Chạy ngầm"), icon("chevron-down", 13));
  const region = inspectorView(host.id, sessions, windows, processes);
  links.append(dispatchBtn, sessions, windows, processes);
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
    const mark = platformIcons[platformKey]
      ? brandImg(platformIcons[platformKey], "platform-brand-icon")
      : icon("server", 18);
    platformBox.replaceChildren(mark);
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
      gitPill.replaceChildren(brandImg("/icons/git.svg", "git-brand-icon"), node("span", "", cleanText ? shortRev + " · " + cleanText : shortRev));
      gitPill.title = "Commit " + shortRev + (cleanText ? " (" + cleanText + ")" : "");
    }
    gitPill.hidden = false;
  } else {
    gitPill.hidden = true;
  }

  const runningOnHost = state.jobs.filter(job => job.hostId === host.id && job.status === "running").length;
  const runningChip = card.querySelector(".host-running-chip");
  runningChip.hidden = runningOnHost === 0;
  if (runningOnHost > 0 && runningChip.dataset.count !== String(runningOnHost)) {
    runningChip.dataset.count = String(runningOnHost);
    runningChip.replaceChildren(icon("play", 11), node("span", "", "Đang chạy " + runningOnHost + " việc"));
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

  const dispatchBtn = card.querySelector(".dispatch-btn");
  dispatchBtn.disabled = !online || !host.online || !host.agents.length;

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
  select.value = Array.from(select.options).some(opt => opt.value === value) ? value : "auto";
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
  if (!jobs.length && activeFilter === "all") {
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
  let liveAiCount = 0;
  let bgActiveCount = 0;
  for (const host of hosts) {
    const sess = hostSessions.get(host.id)?.sessions || [];
    liveAiCount += sess.filter(item => item.status === "running" || item.status === "waiting").length;
    const act = hostActivity.get(host.id);
    if (act?.relay) bgActiveCount += (act.relay.active || 0) + (act.relay.queued || 0);
  }
  const activeCount = runningCount + queuedCount + uncertainCount + bgActiveCount;
  setText(el("stat-active"), String(activeCount));
  const activeParts = [];
  if (runningCount) activeParts.push(runningCount + " đang chạy");
  if (queuedCount) activeParts.push(queuedCount + " chờ phân công");
  if (uncertainCount) activeParts.push(uncertainCount + " chờ xác minh");
  if (bgActiveCount) activeParts.push(bgActiveCount + " việc ngầm");
  if (liveAiCount) activeParts.push(liveAiCount + " phiên AI đang làm");
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

function buildMarkdownReport(job) {
  const lines = [
    "# " + job.title,
    "",
    "- **Trạng thái:** " + (statusNames[job.status] || job.status),
    "- **Trợ lý:** " + (agentNames[job.agent] || job.agent),
    "- **Máy nhận:** " + hostName(job.hostId || job.target),
    "- **Thời điểm tạo:** " + dates.format(new Date(job.createdAt)),
    "- **Cập nhật:** " + dates.format(new Date(job.updatedAt || job.createdAt)),
  ];
  if (job.error) lines.push("- **Ghi chú lỗi:** " + job.error);
  lines.push("");
  job.steps.forEach((step, index) => {
    const entry = job.history.find(attempt => attempt.stepIndex === index);
    const status = entry?.status || (index >= job.stepIndex && job.status === "cancelled" ? "cancelled" : "pending");
    const hostSuffix = entry?.hostId ? " · " + hostName(entry.hostId) : "";
    lines.push("## Bước " + (index + 1) + " (" + (statusNames[status] || status) + hostSuffix + ")");
    lines.push("", step, "");
    if (entry?.output) {
      lines.push("```text", entry.output, "```", "");
    }
    if (entry?.status === "uncertain" && entry.requestId) {
      lines.push("Mã biên nhận: `" + entry.requestId + "`", "");
    }
  });
  return lines.join("\n").trim();
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
    else if (status === "uncertain") marker.append(icon("alert", 12));
    else if (status === "failed") marker.append(icon("x", 12));
    else if (status === "cancelled") marker.append(icon("ban", 12));
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
      summaryLeft.append(icon("chevron-right", 13), icon("terminal", 13), node("span", "", label));
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
      const receiptActions = node("div", "receipt-actions");
      const checkBtn = node("button", "secondary receipt-copy");
      checkBtn.type = "button";
      checkBtn.append(icon("refresh", 12), node("span", "", "Kiểm tra lại"));
      checkBtn.addEventListener("click", () => { void forceRefresh(); });
      const copyBtn = node("button", "secondary receipt-copy");
      copyBtn.type = "button";
      copyBtn.append(icon("copy", 12), node("span", "copy-label", "Sao chép mã"));
      copyBtn.addEventListener("click", () => {
        void copyText(entry.requestId, copyBtn, "Đã sao chép mã biên nhận.");
      });
      receiptActions.append(checkBtn, copyBtn);
      receiptRow.append(node("p", "receipt", "Mã biên nhận: " + entry.requestId), receiptActions);
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
  fillAgentChip(el("job-agent"), job.agent);
  setText(el("job-target"), hostName(job.hostId || job.target));
  setText(el("job-created"), dates.format(new Date(job.createdAt)));
  setText(el("job-updated"), dates.format(new Date(job.updatedAt || job.createdAt)));
  notice(el("job-error"), job.error);

  const retry = ["failed", "cancelled"].includes(job.status);
  const cloneBtn = el("clone-job");
  setText(el("clone-job-label"), retry ? "Chạy lại" : "Nhân bản");
  const cloneIconWrap = el("clone-job-icon");
  const nextCloneIcon = retry ? "rotate" : "copy";
  if (cloneIconWrap.dataset.icon !== nextCloneIcon) {
    cloneIconWrap.dataset.icon = nextCloneIcon;
    cloneIconWrap.replaceChildren(icon(nextCloneIcon, 14));
  }
  cloneBtn.disabled = !online || state.hosts.length === 0;

  const deleteBtn = el("delete-job");
  deleteBtn.hidden = !terminalStatuses.has(job.status);
  deleteBtn.disabled = changing || !online;

  const progressWrap = el("step-progress-wrap");
  if (job.steps.length > 1) {
    const doneSteps = job.history.filter(entry => entry.status === "completed").length;
    const pct = Math.round((doneSteps / job.steps.length) * 100);
    progressWrap.hidden = false;
    setText(el("step-progress-text"), doneSteps + " / " + job.steps.length + " bước hoàn tất (" + pct + "%)");
    const bar = el("step-progress-fill");
    bar.style.setProperty("--progress-pct", pct + "%");
    bar.dataset.done = String(doneSteps === job.steps.length);
  } else {
    progressWrap.hidden = true;
  }

  el("job-actions").hidden = job.status !== "queued";
  const key = JSON.stringify([job.target, state.hosts.map(host => [host.id, host.hostname])]);
  if (detailId !== job.id || targetKey !== key) targets(el("new-target"), job.target);
  targetKey = key;
  detailId = job.id;
  el("move-job").disabled = changing || !online || job.target === el("new-target").value;
  el("cancel-job").disabled = changing || !online;
  stepRows(job);
}

function disarmPrune() {
  clearTimeout(pruneTimer);
  pruneArmed = false;
  el("prune-jobs").dataset.armed = "false";
  setText(el("prune-jobs-label"), "Dọn lịch sử");
}

function matchesSearch(job, query) {
  if (!query) return true;
  const haystack = [
    job.title,
    agentNames[job.agent] || job.agent,
    hostName(job.hostId || job.target),
    ...job.steps,
    ...job.history.map(entry => entry.output || ""),
  ].join("\n").toLowerCase();
  return haystack.includes(query);
}

function setActivityTab(nextTab) {
  activeActivityTab = nextTab;
  for (const btn of document.querySelectorAll(".activity-tab")) {
    const active = btn.dataset.tab === nextTab;
    btn.setAttribute("aria-selected", String(active));
  }
  el("panel-live").hidden = nextTab !== "live";
  el("panel-background").hidden = nextTab !== "background";
  el("panel-processes").hidden = nextTab !== "processes";
}

function buildLiveItem({ agent, title, sourceLabel, host, timeText, statusText, tone, onClick }) {
  const row = node(onClick ? "button" : "div", "live-item" + (onClick ? " clickable" : ""));
  if (onClick) {
    row.type = "button";
    row.addEventListener("click", onClick);
  }
  const main = node("div", "live-item-main");
  const copy = node("div", "live-item-copy");
  copy.append(node("span", "live-item-title", title));
  const meta = node("div", "live-item-meta");
  meta.append(node("span", "", sourceLabel));
  if (host) {
    meta.append(node("span", "job-meta-sep", "·"), hostInline(host));
  }
  if (timeText) {
    meta.append(node("span", "job-meta-sep", "·"), node("span", "", timeText));
  }
  copy.append(meta);
  main.append(agentChip(agent), copy);
  const st = node("span", "badge");
  badge(st, statusText, tone);
  row.append(main, st);
  return row;
}

function renderActivity() {
  const allHosts = state.hosts.filter(host => !hostFilter || host.id === hostFilter);
  const hostSelect = el("activity-host-filter");
  hostSelect.hidden = Boolean(hostFilter) || allHosts.length <= 1;
  const hostSig = JSON.stringify(allHosts.map(h => [h.id, h.hostname]));
  if (hostSig !== activityHostKey) {
    const prev = hostSelect.value || "all";
    hostSelect.replaceChildren(new Option("Tất cả máy", "all"), ...allHosts.map(h => new Option(h.hostname || h.id, h.id)));
    hostSelect.value = Array.from(hostSelect.options).some(opt => opt.value === prev) ? prev : "all";
    activityHostKey = hostSig;
  }
  const chosenHostId = hostFilter || (hostSelect.value === "all" ? null : hostSelect.value);
  const scopedHosts = chosenHostId ? allHosts.filter(h => h.id === chosenHostId) : allHosts;
  const hostById = new Map(allHosts.map(h => [h.id, h]));

  el("activity-refresh").disabled = !online || activityScanning || allHosts.length === 0;
  el("activity-refresh").dataset.busy = String(activityScanning);
  if (activityLastScan) {
    setText(el("activity-stamp"), "Quét " + times.format(activityLastScan));
    el("activity-stamp").hidden = false;
  }

  const activeItems = [];
  const passiveItems = [];
  const allBgTasks = [];
  const allProcs = [];
  const hostNotes = [];
  let totalProcCount = 0;

  for (const job of state.jobs) {
    if (!["running", "queued", "uncertain"].includes(job.status)) continue;
    const targetHostId = job.hostId || (job.target !== "auto" ? job.target : null);
    if (chosenHostId && targetHostId !== chosenHostId) continue;
    activeItems.push({
      agent: job.agent,
      title: job.title,
      sourceLabel: "Điều phối · Bước " + (job.stepIndex + 1) + "/" + job.steps.length,
      host: targetHostId ? hostById.get(targetHostId) : null,
      timeText: dates.format(new Date(job.updatedAt || job.createdAt)),
      statusText: statusNames[job.status],
      tone: tones[job.status],
      onClick: () => {
        selected = job.id;
        el("status-filter").value = "all";
        el("agent-filter").value = "all";
        el("job-search").value = "";
        render();
        el("detail-heading").scrollIntoView({ block: "start", behavior: "smooth" });
      },
    });
  }

  for (const host of scopedHosts) {
    const sess = hostSessions.get(host.id)?.sessions || [];
    for (const item of sess) {
      const entry = {
        agent: item.agent,
        title: item.title || "Phiên " + item.id,
        sourceLabel: "Phiên AI",
        host,
        timeText: "",
        statusText: sessionStates[item.status] || sessionStates.unknown,
        tone: sessionTones[item.status] || "gray",
      };
      if (item.status === "running" || item.status === "waiting") activeItems.push(entry);
      else passiveItems.push(entry);
    }

    const act = hostActivity.get(host.id);
    if (!act) continue;
    if (act.note) hostNotes.push({ host, note: act.note });
    totalProcCount += act.totalProcesses || (act.processes?.length || 0);
    for (const task of act.tasks || []) {
      const enrichedTask = { ...task, host };
      allBgTasks.push(enrichedTask);
      if (task.status === "running" || task.status === "queued") {
        activeItems.push({
          agent: task.agent,
          title: task.outputPreview ? task.outputPreview.split(/\r?\n/)[0].slice(0, 120) : "Tác vụ chạy ngầm #" + task.requestId.slice(0, 8),
          sourceLabel: "Worker ngầm",
          host,
          timeText: task.updatedAt ? dates.format(new Date(task.updatedAt)) : "",
          statusText: relayTaskStatuses[task.status] || task.status,
          tone: relayTaskTones[task.status] || "gray",
          onClick: () => {
            openBgTaskIds.add(task.requestId);
            setActivityTab("background");
            renderActivity();
          },
        });
      }
    }
    for (const proc of act.processes || []) {
      allProcs.push({ ...proc, host, hostTotalBytes: host.totalBytes || 0 });
    }
  }

  allBgTasks.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));

  const groupedAllProcs = groupCodeProcesses(allProcs);
  const liveCount = activeItems.length;
  setText(el("tab-count-live"), String(liveCount));
  setText(el("tab-count-bg"), String(allBgTasks.length));
  setText(el("tab-count-proc"), String(groupedAllProcs.length));
  setText(el("live-work-count"), String(liveCount + passiveItems.length));
  setText(el("relay-hosts-count"), String(scopedHosts.length));
  const summaryParts = [
    liveCount + " đang chạy",
    allBgTasks.length + " việc Agent ngầm",
    groupedAllProcs.length + " phiên code & CI ẩn",
  ];
  setText(el("activity-total-pill"), activityLoadedOnce ? summaryParts.join(" · ") : "Đang quét…");

  const liveContainer = el("live-work-list");
  const recentBg = allBgTasks.filter(t => !["running", "queued"].includes(t.status)).slice(0, 3);
  if (!activityLoadedOnce && !activeItems.length && !passiveItems.length && !recentBg.length) {
    liveContainer.replaceChildren(node("p", "hint", "Đang quét phiên AI, việc chạy ngầm và tiến trình trên cụm máy…"));
  } else if (!activeItems.length && !passiveItems.length && !recentBg.length) {
    liveContainer.replaceChildren(node("p", "hint", "Hiện chưa có công việc điều phối, worker ngầm hay phiên AI nào đang mở trên máy đã chọn."));
  } else {
    const nodes = [];
    if (activeItems.length) {
      nodes.push(node("div", "live-group-label", "Đang chạy & chờ xử lý (" + activeItems.length + ")"));
      for (const item of activeItems) nodes.push(buildLiveItem(item));
    }
    if (passiveItems.length) {
      nodes.push(node("div", "live-group-label", "Phiên AI đang mở · Rảnh / Đã kết nối (" + passiveItems.length + ")"));
      for (const item of passiveItems) nodes.push(buildLiveItem(item));
    }
    if (recentBg.length) {
      const head = node("div", "live-group-head");
      head.append(node("div", "live-group-label", "Việc chạy ngầm gần nhất (" + allBgTasks.length + ")"));
      const moreBtn = node("button", "link-btn");
      moreBtn.type = "button";
      moreBtn.append(node("span", "", "Xem tất cả"), icon("chevron-right", 13));
      moreBtn.addEventListener("click", () => {
        setActivityTab("background");
        renderActivity();
      });
      head.append(moreBtn);
      nodes.push(head);
      for (const task of recentBg) {
        const firstLine = (task.outputPreview || "").split(/\r?\n/).find(line => line.trim()) || task.diagnosticReason || "Tác vụ #" + task.requestId.slice(0, 8);
        nodes.push(buildLiveItem({
          agent: task.agent,
          title: firstLine,
          sourceLabel: "Worker ngầm · #" + task.requestId.slice(0, 8),
          host: task.host,
          timeText: task.createdAt ? dates.format(new Date(task.createdAt)) : "",
          statusText: relayTaskStatuses[task.status] || task.status,
          tone: relayTaskTones[task.status] || "gray",
          onClick: () => {
            openBgTaskIds.add(task.requestId);
            setActivityTab("background");
            renderActivity();
          },
        }));
      }
    }
    liveContainer.replaceChildren(...nodes);
  }

  const relayContainer = el("relay-services");
  relayContainer.replaceChildren(...scopedHosts.map(host => {
    const act = hostActivity.get(host.id);
    const card = node("div", "relay-host-card");
    const top = node("div", "relay-host-top");
    const idWrap = node("div", "relay-host-id");
    idWrap.append(hostInline(host));
    const st = node("span", "badge");
    if (!host.online) badge(st, "Ngoại tuyến", "gray");
    else if (!act) badge(st, "Đang quét", "gray");
    else if (act.supported === false) badge(st, "Bản cũ", "amber");
    else if (act.relay?.online) badge(st, act.relay.accepting ? "Hoạt động" : "Đang xả việc", act.relay.accepting ? "green" : "amber");
    else badge(st, "Chưa chạy", "red");
    top.append(idWrap, st);
    card.append(top);

    if (act?.supported === false) {
      card.append(node("p", "hint", act.note || "Cập nhật worker-relay trên máy này để đọc chi tiết dịch vụ ngầm."));
      return card;
    }

    if (act?.relay) {
      const metrics = node("div", "relay-metrics");
      const m1 = node("span");
      m1.append("PID ", node("strong", "", act.relay.pid ? String(act.relay.pid) : "—"));
      const m2 = node("span");
      m2.append("Bản ", node("strong", "", act.relay.version || "—"));
      const m3 = node("span");
      m3.append("Chạy ", node("strong", "", String(act.relay.active || 0)), " · Chờ ", node("strong", "", String(act.relay.queued || 0)));
      metrics.append(m1, m2, m3);
      if (act.system?.cpuCount) {
        const m4 = node("span");
        m4.append(node("strong", "", String(act.system.cpuCount)), " lõi · Uptime ", node("strong", "", formatDuration(act.system.uptimeSeconds)));
        metrics.append(m4);
      }
      card.append(metrics);

      if (act.relay.workers?.length) {
        const list = node("div", "worker-list");
        for (const w of act.relay.workers) {
          const wRow = node("div", "worker-row");
          const ver = node("span", "worker-version", w.version ? "v" + w.version : "—");
          const wSt = node("span", "worker-state", workerReadinessLabels[w.readiness] || w.readiness);
          wSt.dataset.tone = workerReadinessTones[w.readiness] || "gray";
          wRow.append(agentChip(w.agent), ver, wSt);
          list.append(wRow);
        }
        card.append(list);
      }
    } else if (host.online) {
      card.append(node("p", "hint", "Đang đọc trạng thái dịch vụ chạy ngầm…"));
    }
    return card;
  }));

  const topProcContainer = el("top-processes");
  const topSorted = groupedAllProcs.slice().sort((a, b) => {
    const rankDiff = (categoryRank[a.category] ?? 9) - (categoryRank[b.category] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    return b.memoryBytes - a.memoryBytes;
  }).slice(0, 6);
  if (!topSorted.length) {
    topProcContainer.replaceChildren(node("p", "hint", activityLoadedOnce ? "Chưa ghi nhận tiến trình Agent hay phiên code nào đang chạy ẩn." : "Đang quét phiên code chạy ẩn…"));
  } else {
    const maxTopBytes = topSorted.reduce((max, item) => Math.max(max, item.memoryBytes || 0), 0);
    topProcContainer.replaceChildren(...topSorted.map(proc => {
      const row = node("div", "top-proc-row");
      const nameCell = node("div", "proc-name-cell");
      nameCell.append(processMark(proc), node("span", "proc-name-text", proc.label || proc.name));
      if (proc.count > 1) nameCell.append(node("span", "proc-count-badge", "×" + proc.count));
      const pidEl = node("span", "proc-pid", proc.count > 1 ? (categoryLabels[proc.category] || proc.category) : "PID " + proc.pid);
      if (proc.count > 1) pidEl.title = "PID: " + proc.pids.join(", ");
      const ramCell = node("span", "proc-ram-cell");
      const bar = node("span", "proc-bar");
      const pct = procRamPct(proc.memoryBytes, maxTopBytes);
      const fill = node("span", "proc-bar-fill");
      fill.style.setProperty("--proc-pct", pct.toFixed(1) + "%");
      bar.append(fill);
      if (proc.hostTotalBytes > 0) ramCell.title = numbers.format((proc.memoryBytes / proc.hostTotalBytes) * 100) + "% RAM máy";
      ramCell.append(bar, node("span", "", formatMem(proc.memoryBytes)));
      row.append(nameCell, pidEl, ramCell);
      return row;
    }));
  }

  const notesNodes = hostNotes.map(({ host, note }) => sessionNote((host.hostname || host.id) + ": " + note));
  el("bg-notes").hidden = notesNodes.length === 0;
  el("bg-notes").replaceChildren(...notesNodes.map(n => n.cloneNode(true)));
  el("proc-notes").hidden = notesNodes.length === 0;
  el("proc-notes").replaceChildren(...notesNodes);

  const bgQuery = el("bg-search").value.trim().toLowerCase();
  const bgStatus = el("bg-status-filter").value;
  const bgAgent = el("bg-agent-filter").value;
  const filteredBg = allBgTasks.filter(task => {
    if (bgStatus !== "all" && task.status !== bgStatus) return false;
    if (bgAgent !== "all" && task.agent !== bgAgent) return false;
    if (!bgQuery) return true;
    const hay = [task.requestId, agentNames[task.agent] || task.agent, task.host?.hostname || "", task.outputPreview || "", task.diagnosticCode || "", task.diagnosticReason || ""].join(" ").toLowerCase();
    return hay.includes(bgQuery);
  });

  const bgList = el("bg-task-list");
  const nextBgSig = JSON.stringify([filteredBg.map(t => [t.requestId, t.status, t.updatedAt, t.host?.id]), allBgTasks.length]);
  if (nextBgSig !== bgListSig) {
    bgListSig = nextBgSig;
    if (!filteredBg.length) {
      bgList.replaceChildren(node("p", "hint", allBgTasks.length ? "Không có việc chạy ngầm khớp bộ lọc." : "Chưa ghi nhận tác vụ chạy ngầm nào trong Worker Relay."));
    } else {
      bgList.replaceChildren(...filteredBg.map(task => {
        const details = node("details", "bg-task-item");
        details.open = openBgTaskIds.has(task.requestId);
        details.addEventListener("toggle", () => {
          if (details.open) openBgTaskIds.add(task.requestId);
          else openBgTaskIds.delete(task.requestId);
        });
        const summary = node("summary", "bg-task-summary");
        const main = node("div", "bg-task-main");
        const copy = node("div", "bg-task-copy");
        const headline = node("div", "bg-task-headline");
        headline.append(node("span", "bg-task-id", "#" + task.requestId.slice(0, 8)));
        const firstLine = (task.outputPreview || "").split(/\r?\n/).find(line => line.trim()) || task.diagnosticReason || (task.status === "running" ? "Đang thực thi qua background worker…" : "Không có văn bản trả về");
        headline.append(node("span", "bg-task-preview", firstLine));
        const meta = node("div", "bg-task-meta");
        const sourceText = task.sourceKind === "background-worker"
          ? "Ủy quyền từ " + (agentNames[task.sourceAgent] || "worker")
          : "Tác vụ cục bộ";
        meta.append(node("span", "", sourceText), node("span", "job-meta-sep", "·"), hostInline(task.host));
        if (task.createdAt) {
          meta.append(node("span", "job-meta-sep", "·"), node("span", "", dates.format(new Date(task.createdAt))));
        }
        if (task.createdAt && task.updatedAt) {
          const sec = Math.max(0, Math.round((new Date(task.updatedAt) - new Date(task.createdAt)) / 1000));
          if (sec > 0) meta.append(node("span", "job-meta-sep", "·"), node("span", "", formatDuration(sec)));
        }
        copy.append(headline, meta);
        main.append(agentChip(task.agent), copy);
        const right = node("div", "bg-task-right");
        const st = node("span", "badge");
        badge(st, relayTaskStatuses[task.status] || task.status, relayTaskTones[task.status] || "gray");
        right.append(st, icon("chevron-down", 14));
        summary.append(main, right);

        const detail = node("div", "bg-task-detail");
        const kv = node("div", "bg-task-kv");
        const idSpan = node("span");
        idSpan.append("Mã biên nhận: ", node("code", "", task.requestId));
        const copyBtn = node("button", "secondary compact-btn");
        copyBtn.type = "button";
        copyBtn.append(icon("copy", 12), node("span", "copy-label", "Sao chép kết quả"));
        copyBtn.addEventListener("click", () => {
          void copyText(task.outputPreview || task.diagnosticReason || task.requestId, copyBtn, "Đã sao chép nội dung việc chạy ngầm.");
        });
        kv.append(idSpan, copyBtn);
        detail.append(kv);
        if (task.diagnosticReason) {
          detail.append(node("p", "notice error", (task.diagnosticCode ? task.diagnosticCode + ": " : "") + task.diagnosticReason));
        }
        if (task.outputPreview) {
          detail.append(node("pre", "bg-task-output", task.outputPreview + (task.outputTruncated ? "\n…" : "")));
        }
        details.append(summary, detail);
        return details;
      }));
    }
  }

  const procQuery = el("proc-search").value.trim().toLowerCase();
  const procSort = el("proc-sort").value;
  el("proc-group-toggle").setAttribute("aria-pressed", String(procGroupEnabled));
  const baseProcs = procGroupEnabled ? groupedAllProcs : allProcs.map(p => ({ ...p, label: p.label || p.name, count: 1, pids: [p.pid] }));
  const searchMatchedProcs = baseProcs.filter(proc => {
    if (!procQuery) return true;
    const hay = [proc.label, proc.name, categoryLabels[proc.category] || "", proc.role || "", proc.host?.hostname || "", ...proc.pids.map(String)].join(" ").toLowerCase();
    return hay.includes(procQuery);
  });

  const catCounts = new Map([["all", searchMatchedProcs.length]]);
  for (const proc of searchMatchedProcs) {
    catCounts.set(proc.category, (catCounts.get(proc.category) || 0) + 1);
  }
  const pillsData = processCategories.map(item => ({ ...item, count: catCounts.get(item.value) || 0 }));
  const nextPillsSig = JSON.stringify([procCategory, pillsData]);
  if (nextPillsSig !== procPillsSig) {
    procPillsSig = nextPillsSig;
    el("proc-category-pills").replaceChildren(...pillsData.map(item => {
      const btn = node("button", "filter-pill");
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(procCategory === item.value));
      btn.append(node("span", "", item.label), node("span", "filter-pill-count", String(item.count)));
      btn.addEventListener("click", () => {
        procCategory = item.value;
        renderActivity();
      });
      return btn;
    }));
  }

  const filteredProcs = searchMatchedProcs.filter(proc => procCategory === "all" || proc.category === procCategory);

  filteredProcs.sort((a, b) => {
    if (procSort === "memory") return b.memoryBytes - a.memoryBytes || a.pid - b.pid;
    if (procSort === "cpu") return ((b.cpuPercent ?? b.cpuSeconds ?? -1) - (a.cpuPercent ?? a.cpuSeconds ?? -1)) || (b.memoryBytes - a.memoryBytes);
    if (procSort === "uptime") return ((b.uptimeSeconds ?? -1) - (a.uptimeSeconds ?? -1)) || (b.memoryBytes - a.memoryBytes);
    if (procSort === "name") return (a.label || a.name).localeCompare(b.label || b.name);
    return ((categoryRank[a.category] ?? 9) - (categoryRank[b.category] ?? 9)) || (b.memoryBytes - a.memoryBytes) || a.pid - b.pid;
  });

  const tbody = el("proc-table-body");
  el("proc-table-wrap").hidden = filteredProcs.length === 0;
  el("proc-empty").hidden = filteredProcs.length > 0;
  const shownProcs = filteredProcs.slice(0, 120);
  const nextProcSig = JSON.stringify([procGroupEnabled, shownProcs.map(p => [p.host?.id, p.pid, p.count, p.label, p.memoryBytes, p.cpuPercent, p.cpuSeconds, p.uptimeSeconds, p.state])]);
  if (nextProcSig === procTableSig) return;
  procTableSig = nextProcSig;
  const maxShownBytes = shownProcs.reduce((max, item) => Math.max(max, item.memoryBytes || 0), 0);
  tbody.replaceChildren(...shownProcs.map(proc => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    const nameCell = node("div", "proc-name-cell");
    nameCell.append(processMark(proc), node("span", "proc-name-text", proc.label || proc.name));
    if (proc.count > 1) nameCell.append(node("span", "proc-count-badge", "×" + proc.count));
    nameTd.append(nameCell);

    const catTd = document.createElement("td");
    const catSpan = node("span", "proc-cat-label", categoryLabels[proc.category] || proc.category);
    catSpan.dataset.cat = proc.category;
    catTd.append(catSpan);

    const pidTd = node("td", "proc-pid", proc.count > 1 ? proc.pid + " (+" + (proc.count - 1) + ")" : String(proc.pid));
    if (proc.count > 1) pidTd.title = "PID: " + proc.pids.join(", ");

    const hostTd = document.createElement("td");
    hostTd.append(hostInline(proc.host));

    const uptimeTd = node("td", "num", proc.uptimeSeconds != null ? formatDuration(proc.uptimeSeconds) : "—");

    const cpuTd = node("td", "num", formatCpu(proc));

    const ramTd = node("td", "num");
    const ramCell = node("span", "proc-ram-cell");
    const bar = node("span", "proc-bar");
    const pct = procRamPct(proc.memoryBytes, maxShownBytes);
    const fill = node("span", "proc-bar-fill");
    fill.style.setProperty("--proc-pct", pct.toFixed(1) + "%");
    bar.append(fill);
    if (proc.hostTotalBytes > 0) ramCell.title = numbers.format((proc.memoryBytes / proc.hostTotalBytes) * 100) + "% RAM máy";
    ramCell.append(bar, node("span", "", formatMem(proc.memoryBytes)));
    ramTd.append(ramCell);

    const stateTd = document.createElement("td");
    const stateDot = node("span", "proc-state-dot", processStateLabels[proc.state] || proc.state);
    stateDot.dataset.state = proc.state;
    stateTd.append(stateDot);

    tr.append(nameTd, catTd, pidTd, hostTd, uptimeTd, cpuTd, ramTd, stateTd);
    return tr;
  }));
}

async function refreshActivity(manual = false) {
  if (activityScanning || !online) return;
  const targets = state.hosts.filter(host => host.online && (!hostFilter || host.id === hostFilter));
  if (!targets.length) {
    renderActivity();
    return;
  }
  activityScanning = true;
  renderActivity();
  try {
    await Promise.allSettled(targets.flatMap(host => [
      api("/api/hosts/" + encodeURIComponent(host.id) + "/activity", {})
        .then(result => { hostActivity.set(host.id, result); })
        .catch(() => {}),
      api("/api/hosts/" + encodeURIComponent(host.id) + "/sessions", {})
        .then(result => { hostSessions.set(host.id, result); })
        .catch(() => {}),
    ]));
    activityLoadedOnce = true;
    activityLastScan = new Date();
    if (manual) showToast("Đã quét lại việc chạy ngầm và tiến trình.");
  } finally {
    activityScanning = false;
    render();
  }
}

function render() {
  const hosts = state.hosts.filter(host => !hostFilter || host.id === hostFilter);
  const scopedJobs = state.jobs.filter(job => !hostFilter || job.hostId === hostFilter || job.target === hostFilter || job.history.some(entry => entry.hostId === hostFilter));
  const query = el("job-search").value.trim().toLowerCase();
  const agentFilter = el("agent-filter").value;
  const statusFilter = el("status-filter").value;
  const preStatus = scopedJobs.filter(job => (agentFilter === "all" || job.agent === agentFilter) && matchesSearch(job, query));
  const shown = preStatus.filter(job => statusFilter === "all" || job.status === statusFilter);
  visibleJobs = shown;

  if (!shown.some(job => job.id === selected)) selected = shown[0]?.id || null;
  const title = hostFilter ? "Máy " + hostName(hostFilter) : "Điều phối công việc";
  setText(el("page-title"), title);
  setText(el("bar-division"), hostFilter ? hostName(hostFilter) : "Điều phối máy");
  document.title = title + " · Codex Bridge";
  el("all-hosts").hidden = !hostFilter;
  el("new-job").disabled = !online || hosts.length === 0;
  el("edit-memory").disabled = !online;
  el("refresh-now").disabled = !online || refreshingNow;
  setText(el("summary"), hosts.filter(host => host.online).length + "/" + hosts.length + " máy trực tuyến · " + scopedJobs.length + " công việc");
  setText(el("machines-count"), String(hosts.length));
  setText(el("queue-count"), String(shown.length));

  if (lastSyncedAt) {
    setText(el("last-synced"), "Cập nhật " + times.format(lastSyncedAt));
    el("last-synced-wrap").hidden = false;
  }

  const floorGiB = state.minFreeBytes ? (state.minFreeBytes / 1024 ** 3).toLocaleString("vi-VN", { maximumSignificantDigits: 7 }) : "—";
  setText(el("threshold"), "RAM tối thiểu " + floorGiB + " GiB");
  el("setup-hint").hidden = Boolean(hostFilter) || state.hosts.some(host => !host.local);

  const terminalCount = scopedJobs.filter(job => terminalStatuses.has(job.status)).length;
  const pruneBtn = el("prune-jobs");
  pruneBtn.hidden = terminalCount === 0;
  pruneBtn.disabled = changing || !online;
  if (terminalCount === 0 && pruneArmed) disarmPrune();

  el("queue-toolbar").hidden = scopedJobs.length === 0;
  el("clear-search").hidden = el("job-search").value.length === 0;
  el("search-kbd").hidden = el("job-search").value.length > 0 || document.activeElement === el("job-search");

  renderOverview(hosts, scopedJobs);
  reconcile(el("machines"), hosts, machineCard, paintMachine);
  renderActivity();
  renderFilterPills(preStatus, statusFilter);
  reconcile(el("job-list"), shown, jobRow, paintRow);
  el("empty-queue").hidden = shown.length > 0;
  const hasFilters = statusFilter !== "all" || agentFilter !== "all" || Boolean(query);
  setText(el("empty-heading"), scopedJobs.length && hasFilters ? "Không có công việc khớp bộ lọc" : "Chưa có công việc");
  setText(el("empty-description"), scopedJobs.length && hasFilters ? "Thử đổi từ khóa tìm kiếm, trợ lý hoặc trạng thái." : "Công việc đã tạo sẽ xuất hiện ở đây.");
  renderDetail(shown.find(job => job.id === selected));
  if (hostFilter && hosts.length === 0) pollError = "Máy này chưa có trong cấu hình điều phối.";
}

function applyLatestState(latest) {
  state = latest;
  online = true;
  lastSyncedAt = new Date();
  pollError = latest.error || "";
  notifyJobChanges(latest.jobs || []);
  render();
  if (!activityLoadedOnce && !activityScanning && latest.hosts?.some(host => host.online)) {
    void refreshActivity(false);
  }
}

async function refresh() {
  const index = ++requestIndex;
  try {
    const latest = await api("/api/state");
    if (index !== requestIndex) return;
    applyLatestState(latest);
  } catch (error) {
    if (index !== requestIndex) return;
    online = false;
    pollError = error.message;
    el("new-job").disabled = true;
    el("edit-memory").disabled = true;
    el("refresh-now").disabled = true;
    el("move-job").disabled = true;
    el("cancel-job").disabled = true;
    el("delete-job").disabled = true;
    el("prune-jobs").disabled = true;
  }
  el("connection").dataset.online = String(online);
  setText(el("connection"), online ? "Đã kết nối" : "Mất kết nối");
  if (lastSyncedAt) el("connection").title = "Lần đồng bộ gần nhất: " + times.format(lastSyncedAt);
  notice(el("page-error"), pollError || actionError);
}

async function forceRefresh() {
  if (refreshingNow || !online) return;
  refreshingNow = true;
  const button = el("refresh-now");
  button.dataset.busy = "true";
  button.disabled = true;
  const index = ++requestIndex;
  try {
    let latest;
    try {
      latest = await api("/api/refresh", {});
    } catch (error) {
      if (error.status === 404) latest = await api("/api/state");
      else throw error;
    }
    if (index === requestIndex) {
      applyLatestState(latest);
      void refreshActivity(false);
      actionError = "";
      showToast("Đã làm mới trạng thái cụm máy.");
    }
  } catch (error) {
    if (index === requestIndex) {
      actionError = error.message;
      notice(el("page-error"), pollError || actionError);
    }
  } finally {
    refreshingNow = false;
    button.dataset.busy = "false";
    button.disabled = !online;
  }
}

function readCustomTemplates() {
  try {
    const raw = JSON.parse(localStorage.getItem("fleet-templates") || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(item => item && typeof item.id === "string" && typeof item.name === "string"
      && typeof item.title === "string" && Array.isArray(item.steps) && item.steps.length > 0).slice(0, 12);
  } catch {
    return [];
  }
}

function writeCustomTemplates(items) {
  localStorage.setItem("fleet-templates", JSON.stringify(items.slice(0, 12)));
}

function renderTemplates() {
  const list = el("template-list");
  const custom = readCustomTemplates();
  const all = [...builtinTemplates.map(item => ({ ...item, custom: false })), ...custom.map(item => ({ ...item, custom: true }))];
  list.replaceChildren(...all.map(item => {
    const wrap = node("span", "template-chip-wrap");
    const chip = node("button", "template-chip", item.name);
    chip.type = "button";
    chip.addEventListener("click", () => {
      el("title-input").value = item.title;
      if (item.agent) el("agent-input").value = item.agent;
      el("step-fields").replaceChildren();
      for (const step of item.steps) addField(step);
      notice(el("form-error"), "");
      el("title-input").focus();
    });
    wrap.append(chip);
    if (item.custom) {
      const del = node("button", "template-del");
      del.type = "button";
      del.append(icon("x", 12));
      del.setAttribute("aria-label", "Xóa mẫu " + item.name);
      del.addEventListener("click", () => {
        writeCustomTemplates(readCustomTemplates().filter(entry => entry.id !== item.id));
        renderTemplates();
        showToast("Đã xóa mẫu " + item.name + ".");
      });
      wrap.append(del);
    }
    return wrap;
  }));
}

function updateStepBytes(field) {
  const textarea = field.querySelector("textarea");
  const counter = field.querySelector(".step-bytes");
  const bytes = encoder.encode(textarea.value).length;
  setText(counter, formatBytes(bytes) + " / 32 KiB");
  counter.dataset.warn = String(bytes >= 24 * 1024 && bytes <= maxStepBytes);
  counter.dataset.over = String(bytes > maxStepBytes);
}

function numberFields() {
  const fields = Array.from(el("step-fields").children);
  fields.forEach((field, i) => {
    const label = field.querySelector("label");
    label.textContent = "Bước " + (i + 1);
    label.htmlFor = "step-input-" + i;
    field.querySelector("textarea").id = label.htmlFor;
    const up = field.querySelector(".move-up");
    const down = field.querySelector(".move-down");
    const remove = field.querySelector(".step-remove");
    const single = fields.length === 1;
    up.hidden = single;
    down.hidden = single;
    remove.hidden = single;
    up.disabled = i === 0;
    down.disabled = i === fields.length - 1;
    up.setAttribute("aria-label", "Đưa bước " + (i + 1) + " lên");
    down.setAttribute("aria-label", "Đưa bước " + (i + 1) + " xuống");
    remove.setAttribute("aria-label", "Bỏ bước " + (i + 1));
    updateStepBytes(field);
  });
  el("add-step").disabled = fields.length >= 16;
}

function addField(initialValue = "") {
  const field = node("div", "step-field");
  const labelRow = node("div", "step-label");
  const controls = node("div", "step-controls");
  const byteCounter = node("span", "step-bytes", "0 B / 32 KiB");

  const up = node("button", "step-move move-up");
  up.type = "button";
  up.append(icon("arrow-up", 13));
  up.addEventListener("click", () => {
    if (field.previousElementSibling) {
      field.parentElement.insertBefore(field, field.previousElementSibling);
      numberFields();
      up.focus();
    }
  });

  const down = node("button", "step-move move-down");
  down.type = "button";
  down.append(icon("arrow-down", 13));
  down.addEventListener("click", () => {
    if (field.nextElementSibling) {
      field.parentElement.insertBefore(field.nextElementSibling, field);
      numberFields();
      down.focus();
    }
  });

  const remove = node("button", "step-remove");
  remove.type = "button";
  remove.append(icon("trash", 12), node("span", "", "Bỏ bước"));
  remove.addEventListener("click", () => {
    const sibling = field.previousElementSibling || field.nextElementSibling;
    field.remove();
    numberFields();
    sibling?.querySelector("textarea").focus();
  });

  controls.append(byteCounter, up, down, remove);
  labelRow.append(node("label"), controls);
  const input = node("textarea");
  input.required = true;
  input.maxLength = maxStepBytes;
  input.value = initialValue;
  input.placeholder = "Nhập hướng dẫn chi tiết cho bước này…";
  input.addEventListener("input", () => updateStepBytes(field));
  field.append(labelRow, input);
  el("step-fields").append(field);
  numberFields();
  return input;
}

function openJobDialog(prefill = {}) {
  el("job-form").reset();
  el("step-fields").replaceChildren();
  renderTemplates();
  if (prefill.title) el("title-input").value = prefill.title;
  if (prefill.agent && agentNames[prefill.agent]) el("agent-input").value = prefill.agent;
  targets(el("target-input"), prefill.target || hostFilter || "auto");
  const steps = Array.isArray(prefill.steps) && prefill.steps.length ? prefill.steps : [""];
  for (const step of steps) addField(step);
  notice(el("form-error"), "");
  el("job-dialog").showModal();
  el("title-input").focus();
}

function syncMemoryPresets() {
  const value = el("memory-input").valueAsNumber;
  for (const button of el("memory-presets").querySelectorAll(".preset-chip")) {
    button.dataset.active = String(Number(button.dataset.gib) === value);
  }
}

async function changeJob(action, data, successMessage) {
  if (changing || !online || !selected) return;
  changing = true;
  renderDetail(state.jobs.find(job => job.id === selected));
  try {
    await api("/api/jobs/" + encodeURIComponent(selected) + "/" + action, data);
    actionError = "";
    showToast(successMessage);
  } catch (error) {
    actionError = error.message;
  } finally {
    changing = false;
    await refresh();
  }
}

async function pruneJobs() {
  if (changing || !online) return;
  changing = true;
  disarmPrune();
  render();
  try {
    const result = await api("/api/jobs/prune", {});
    actionError = "";
    showToast("Đã dọn " + result.removed + " công việc đã kết thúc.");
  } catch (error) {
    actionError = error.message;
  } finally {
    changing = false;
    await refresh();
  }
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("fleet-theme", next);
  applyTheme(next);
}

el("theme-toggle").addEventListener("click", toggleTheme);
el("refresh-now").addEventListener("click", () => { void forceRefresh(); });

el("notify-toggle").addEventListener("click", async () => {
  if (typeof Notification === "undefined") {
    showToast("Trình duyệt này không hỗ trợ thông báo máy tính.");
    return;
  }
  if (notifyEnabled && Notification.permission === "granted") {
    notifyEnabled = false;
    localStorage.setItem("fleet-notify", "0");
    syncNotifyButton();
    showToast("Đã tắt thông báo máy tính.");
    return;
  }
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission === "granted") {
    notifyEnabled = true;
    localStorage.setItem("fleet-notify", "1");
    syncNotifyButton();
    showToast("Đã bật thông báo khi công việc hoàn tất.");
  } else {
    notifyEnabled = false;
    localStorage.setItem("fleet-notify", "0");
    syncNotifyButton();
    showToast("Trình duyệt chưa cấp quyền thông báo.");
  }
});

el("shortcuts-btn").addEventListener("click", () => el("shortcuts-dialog").showModal());
el("close-shortcuts").addEventListener("click", () => el("shortcuts-dialog").close());
el("shortcuts-dialog").addEventListener("click", event => {
  if (event.target === el("shortcuts-dialog")) el("shortcuts-dialog").close();
});

el("status-filter").addEventListener("change", render);
el("agent-filter").addEventListener("change", render);
el("job-search").addEventListener("input", render);
el("job-search").addEventListener("focus", render);
el("job-search").addEventListener("blur", render);
el("clear-search").addEventListener("click", () => {
  el("job-search").value = "";
  render();
  el("job-search").focus();
});

el("prune-jobs").addEventListener("click", () => {
  if (!online || changing) return;
  if (!pruneArmed) {
    const count = state.jobs.filter(job => terminalStatuses.has(job.status)).length;
    if (!count) return;
    pruneArmed = true;
    el("prune-jobs").dataset.armed = "true";
    setText(el("prune-jobs-label"), "Xác nhận xóa " + count + " việc?");
    clearTimeout(pruneTimer);
    pruneTimer = setTimeout(disarmPrune, 4000);
    return;
  }
  void pruneJobs();
});

el("clone-job").addEventListener("click", () => {
  const job = state.jobs.find(item => item.id === selected);
  if (!job) return;
  openJobDialog({ title: job.title, agent: job.agent, target: job.target, steps: job.steps });
});

el("copy-report").addEventListener("click", () => {
  const job = state.jobs.find(item => item.id === selected);
  if (!job) return;
  void copyText(buildMarkdownReport(job), null, "Đã sao chép báo cáo công việc dạng Markdown.");
});

el("delete-job").addEventListener("click", () => {
  void changeJob("delete", {}, "Đã xóa công việc khỏi lịch sử.");
});

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
el("move-job").addEventListener("click", () => changeJob("target", { target: el("new-target").value }, "Đã đổi máy nhận."));
el("cancel-job").addEventListener("click", () => changeJob("cancel", {}, "Đã hủy công việc."));
el("add-step").addEventListener("click", () => addField().focus());
el("new-job").addEventListener("click", () => openJobDialog());

el("save-template").addEventListener("click", () => {
  const title = el("title-input").value.trim();
  const steps = Array.from(el("step-fields").querySelectorAll("textarea"), input => input.value.trim()).filter(Boolean);
  if (!title || !steps.length) {
    notice(el("form-error"), "Nhập tên công việc và ít nhất một bước để lưu mẫu.");
    return;
  }
  const existing = readCustomTemplates();
  const name = title.length > 28 ? title.slice(0, 27) + "…" : title;
  const next = [{ id: "tpl-" + Date.now(), name, title, agent: el("agent-input").value, steps }, ...existing.filter(item => item.title !== title)];
  writeCustomTemplates(next);
  renderTemplates();
  notice(el("form-error"), "");
  showToast("Đã lưu mẫu công việc.");
});

for (const id of ["dismiss", "back"]) {
  el(id).addEventListener("click", () => {
    if (!el("submit-job").disabled) el("job-dialog").close();
  });
}

el("job-dialog").addEventListener("click", event => {
  if (event.target === el("job-dialog") && !el("submit-job").disabled) el("job-dialog").close();
});

el("job-form").addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    el("job-form").requestSubmit();
  }
});

el("job-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (el("submit-job").disabled) return;
  el("submit-job").disabled = true;
  try {
    const steps = Array.from(el("step-fields").querySelectorAll("textarea"), input => input.value.trim());
    if (steps.some(step => !step || encoder.encode(step).length > maxStepBytes)) throw new Error("Mỗi bước cần có nội dung và dài tối đa 32 KiB.");
    const title = el("title-input").value.trim();
    if (!title) throw new Error("Nhập tên công việc.");
    const job = await api("/api/jobs", { title, agent: el("agent-input").value, target: el("target-input").value, steps });
    selected = job.id;
    actionError = "";
    el("status-filter").value = "all";
    el("agent-filter").value = "all";
    el("job-search").value = "";
    el("job-dialog").close();
    showToast("Đã thêm công việc vào hàng chờ.");
    await refresh();
  } catch (error) {
    notice(el("form-error"), error.message);
  } finally {
    el("submit-job").disabled = false;
  }
});

document.addEventListener("keydown", event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || event.target?.isContentEditable) return;
  const openDialog = document.querySelector("dialog[open]");
  if (openDialog) {
    if (event.key === "?" && openDialog === el("shortcuts-dialog")) {
      event.preventDefault();
      openDialog.close();
    }
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "n" && !el("new-job").disabled) {
    event.preventDefault();
    openJobDialog();
  } else if (key === "r" && !el("refresh-now").disabled) {
    event.preventDefault();
    void forceRefresh();
  } else if (event.key === "/" && !el("queue-toolbar").hidden) {
    event.preventDefault();
    el("job-search").focus();
  } else if (key === "d") {
    event.preventDefault();
    toggleTheme();
  } else if (event.key === "?") {
    event.preventDefault();
    el("shortcuts-dialog").showModal();
  } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && visibleJobs.length) {
    event.preventDefault();
    const currentIndex = visibleJobs.findIndex(job => job.id === selected);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0 ? 0 : Math.max(0, Math.min(visibleJobs.length - 1, currentIndex + delta));
    selected = visibleJobs[nextIndex].id;
    render();
    el("job-list").children[nextIndex]?.scrollIntoView({ block: "nearest" });
  }
});

window.addEventListener("hashchange", () => {
  if (consumeSessionHash()) void refresh();
});

window.addEventListener("storage", event => {
  if (event.key === "fleet-session") void refresh();
});

for (const btn of document.querySelectorAll(".activity-tab")) {
  btn.addEventListener("click", () => {
    setActivityTab(btn.dataset.tab);
    renderActivity();
  });
}

el("view-all-procs").addEventListener("click", () => {
  setActivityTab("processes");
  renderActivity();
});

el("activity-refresh").addEventListener("click", () => { void refreshActivity(true); });
el("activity-host-filter").addEventListener("change", renderActivity);
el("bg-search").addEventListener("input", renderActivity);
el("bg-status-filter").addEventListener("change", renderActivity);
el("bg-agent-filter").addEventListener("change", renderActivity);
el("proc-search").addEventListener("input", renderActivity);
el("proc-sort").addEventListener("change", renderActivity);
el("proc-group-toggle").addEventListener("click", () => {
  procGroupEnabled = !procGroupEnabled;
  renderActivity();
});

async function poll() {
  await refresh();
  setTimeout(poll, 4000);
}
poll();

setInterval(() => {
  if (!document.hidden && online && activityLoadedOnce) void refreshActivity(false);
}, 15000);
