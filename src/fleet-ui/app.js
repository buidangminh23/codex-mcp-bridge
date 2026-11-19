const el = id => document.getElementById(id);
const hostFilter = new URLSearchParams(location.search).get("host");
const params = new URLSearchParams(location.hash.slice(1));
if (params.has("session")) {
  localStorage.setItem("fleet-session", params.get("session"));
  history.replaceState(null, "", location.pathname + location.search);
}
const statusNames = {
  queued: "Chờ phân công", running: "Đang chạy", uncertain: "Chờ xác minh",
  completed: "Hoàn tất", failed: "Thất bại", cancelled: "Đã hủy", pending: "Chưa chạy"
};
const tones = { running: "blue", completed: "green", failed: "red", queued: "amber", uncertain: "amber" };
const agentNames = { codex: "Codex", claude: "Claude", antigravity: "Antigravity" };
const platforms = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const numbers = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
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
let pollError = "";
let actionError = "";

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = value;
  return item;
}

function setText(item, value) {
  if (item.textContent !== value) item.textContent = value;
}

function notice(item, value) {
  setText(item, value || "");
  item.hidden = !value;
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

function hostUrl(path, id) {
  const url = new URL(path, location.origin);
  url.searchParams.set("host", id);
  return url;
}

function externalLink(label, path, id) {
  const link = node("a", "", label);
  link.href = hostUrl(path, id);
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

async function showWindows(id, button, region) {
  button.disabled = true;
  setText(button, "Đang tải…");
  region.hidden = false;
  try {
    const result = await api("/api/hosts/" + encodeURIComponent(id) + "/windows", {});
    const list = node("ul", "window-list");
    for (const item of result.windows) {
      const row = node("li");
      row.append(node("strong", "", item.app), node("span", "", item.title || "Cửa sổ chưa đặt tên"));
      list.append(row);
    }
    region.replaceChildren(result.windows.length ? list : node("p", "hint", "Chưa có cửa sổ hiển thị."));
    if (result.note) region.append(node("p", "hint", result.note));
  } catch (error) {
    region.replaceChildren(node("p", "notice error", error.message));
  } finally {
    button.disabled = false;
    setText(button, "Tải lại cửa sổ");
  }
}

function machineCard(host) {
  const card = node("article", "machine");
  const head = node("div", "host-top");
  head.append(node("h3", "host-title"), node("span", "badge"));
  const meter = node("progress");
  const foot = node("div", "host-foot");
  const links = node("div", "host-links");
  const windows = node("button", "text-button", "Xem cửa sổ");
  const region = node("div", "window-region");
  region.setAttribute("aria-live", "polite");
  region.hidden = true;
  windows.addEventListener("click", () => showWindows(host.id, windows, region));
  links.append(windows);
  if (!host.local) links.append(externalLink("Xem màn hình", "/screen.html", host.id));
  if (!hostFilter) links.append(externalLink("Mở bảng riêng ↗", "/", host.id));
  foot.append(node("span", "agents"), links);
  card.append(head, node("p", "host-sub"), node("p", "ram-text"), meter, foot, node("p", "notice"), region);
  return card;
}

function paintMachine(card, host) {
  setText(card.querySelector("h3"), host.hostname || host.id);
  const low = host.online && host.freeBytes < state.minFreeBytes;
  const health = !host.checkedAt ? "Đang kiểm tra" : !host.online ? "Ngoại tuyến" : low ? "Thiếu RAM" : "Trực tuyến";
  badge(card.querySelector(".badge"), health, host.online ? (low ? "amber" : "green") : "gray");
  setText(card.querySelector(".host-sub"), [host.local ? "Máy này" : host.id, platforms[host.platform] || host.platform].filter(Boolean).join(" · "));
  const text = host.online ? gib(host.freeBytes) + " khả dụng / " + gib(host.totalBytes) : "Chưa có số liệu RAM hiện tại";
  setText(card.querySelector(".ram-text"), text);
  const meter = card.querySelector("progress");
  meter.hidden = !host.online;
  if (host.online) {
    meter.max = host.totalBytes;
    meter.value = host.totalBytes - host.freeBytes;
    meter.dataset.low = String(low);
    meter.setAttribute("aria-label", "RAM đã dùng trên " + host.hostname);
    meter.setAttribute("aria-valuetext", text);
  }
  setText(card.querySelector(".agents"), host.online ? host.agents.map(id => agentNames[id] || id).join(" · ") || "Chưa có trợ lý sẵn sàng" : "");
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
  row.append(node("span", "row-title"), node("span", "badge"), node("span", "job-meta"));
  row.addEventListener("click", () => {
    selected = job.id;
    render();
    if (matchMedia("(max-width: 840px)").matches) el("detail-heading").scrollIntoView({ block: "start" });
  });
  return row;
}

function paintRow(row, job) {
  row.setAttribute("aria-current", String(selected === job.id));
  setText(row.querySelector(".row-title"), job.title);
  badge(row.querySelector(".badge"), statusNames[job.status], tones[job.status]);
  setText(row.querySelector(".job-meta"), [agentNames[job.agent], hostName(job.hostId || job.target), "Bước " + (job.stepIndex + 1) + "/" + job.steps.length].join(" · "));
}

function stepRows(job) {
  const signature = JSON.stringify([job.id, job.status, job.steps, job.history]);
  if (signature === stepHistory) return;
  stepHistory = signature;
  const expanded = new Set(Array.from(el("steps").querySelectorAll("details[open]"), item => item.dataset.receipt));
  const focusReceipt = document.activeElement.closest("details")?.dataset.receipt;
  el("steps").replaceChildren(...job.steps.map((step, index) => {
    const entry = job.history.find(attempt => attempt.stepIndex === index);
    const status = entry?.status || (index >= job.stepIndex && job.status === "cancelled" ? "cancelled" : "pending");
    const row = node("li");
    const meta = node("div", "step-meta");
    const tag = node("span", "badge");
    badge(tag, statusNames[status] || status, tones[status]);
    meta.append(node("strong", "", "Bước " + (index + 1)), tag);
    if (entry?.hostId) meta.append(node("span", "", hostName(entry.hostId)));
    row.append(meta, node("p", "step-prompt", step));
    if (entry?.output) {
      const details = node("details");
      details.dataset.receipt = entry.requestId;
      details.open = expanded.has(entry.requestId);
      const label = entry.outputTruncated ? "Kết quả (đã rút gọn)" : "Kết quả";
      details.append(node("summary", "", label), node("pre", "step-output", entry.output));
      row.append(details);
    }
    if (entry?.status === "uncertain") row.append(node("p", "receipt", "Mã biên nhận: " + entry.requestId));
    return row;
  }));
  if (focusReceipt) Array.from(el("steps").querySelectorAll("details")).find(item => item.dataset.receipt === focusReceipt)?.querySelector("summary")?.focus({ preventScroll: true });
}

function renderDetail(job) {
  el("job-detail").hidden = !job;
  el("empty-detail").hidden = Boolean(job);
  if (!job) { detailId = null; return; }
  setText(el("job-title"), job.title);
  badge(el("job-status"), statusNames[job.status], tones[job.status]);
  setText(el("job-agent"), agentNames[job.agent]);
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
  document.title = title + " · Codex Bridge";
  el("all-hosts").hidden = !hostFilter;
  el("new-job").disabled = !online || hosts.length === 0;
  setText(el("summary"), hosts.filter(host => host.online).length + "/" + hosts.length + " máy trực tuyến · " + jobs.length + " công việc");
  setText(el("threshold"), "RAM khả dụng tối thiểu " + gib(state.minFreeBytes));
  el("setup-hint").hidden = Boolean(hostFilter) || state.hosts.some(host => !host.local);
  reconcile(el("machines"), hosts, machineCard, paintMachine);
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
  const remove = node("button", "text-button", "Bỏ bước");
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
  field.append(label, input);
  el("step-fields").append(field);
  numberFields();
  return input;
}

async function changeJob(action, data) {
  if (changing || !online || !selected) return;
  changing = true;
  renderDetail(state.jobs.find(job => job.id === selected));
  try {
    await api("/api/jobs/" + encodeURIComponent(selected) + "/" + action, data);
    actionError = "";
    setText(el("toast"), action === "target" ? "Đã đổi máy nhận." : "Đã hủy công việc.");
  } catch (error) {
    actionError = error.message;
  } finally {
    changing = false;
    await refresh();
  }
}
el("status-filter").addEventListener("change", render);
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
for (const id of ["dismiss", "back"]) el(id).addEventListener("click", () => el("job-dialog").close());
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
    setText(el("toast"), "Đã thêm công việc vào hàng chờ.");
    await refresh();
  } catch (error) {
    notice(el("form-error"), error.message);
  } finally {
    el("submit-job").disabled = false;
  }
});
async function poll() {
  await refresh();
  setTimeout(poll, 4000);
}
poll();
