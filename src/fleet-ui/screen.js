import RFB from "/novnc/core/rfb.js";

const el = id => document.getElementById(id);
const svgNs = "http://www.w3.org/2000/svg";
const hostId = new URLSearchParams(location.search).get("host");
let host, session, connected = false;

function svgEl(tag, attrs = {}) {
  const item = document.createElementNS(svgNs, tag);
  for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
  return item;
}

function screenIcon(name) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24", width: 15, height: 15, fill: "none",
    stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true"
  });
  if (name === "plug") {
    svg.append(
      svgEl("path", { d: "M12 22v-5" }),
      svgEl("path", { d: "M9 8V2" }),
      svgEl("path", { d: "M15 8V2" }),
      svgEl("path", { d: "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" })
    );
  } else if (name === "unplug") {
    svg.append(
      svgEl("path", { d: "m19 5 3-3" }),
      svgEl("path", { d: "m2 22 3-3" }),
      svgEl("path", { d: "M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" }),
      svgEl("path", { d: "M7.5 13.5 10 11" }),
      svgEl("path", { d: "M10.5 16.5 13 14" }),
      svgEl("path", { d: "m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" })
    );
  } else if (name === "pointer") {
    svg.append(
      svgEl("path", { d: "M14 4.1 12 6" }),
      svgEl("path", { d: "m5.1 8-2.9-.8" }),
      svgEl("path", { d: "m6 12-1.9 2" }),
      svgEl("path", { d: "M7.2 2.2 8 5.1" }),
      svgEl("path", { d: "M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" })
    );
  } else if (name === "eye") {
    svg.append(
      svgEl("path", { d: "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" }),
      svgEl("circle", { cx: 12, cy: 12, r: 3 })
    );
  } else if (name === "minimize") {
    svg.append(
      svgEl("polyline", { points: "4 14 10 14 10 20" }),
      svgEl("polyline", { points: "20 10 14 10 14 4" }),
      svgEl("line", { x1: 14, x2: 21, y1: 10, y2: 3 }),
      svgEl("line", { x1: 3, x2: 10, y1: 21, y2: 14 })
    );
  } else {
    svg.append(
      svgEl("polyline", { points: "15 3 21 3 21 9" }),
      svgEl("polyline", { points: "9 21 3 21 3 15" }),
      svgEl("line", { x1: 21, x2: 14, y1: 3, y2: 10 }),
      svgEl("line", { x1: 3, x2: 10, y1: 21, y2: 14 })
    );
  }
  return svg;
}

function setBtn(iconId, labelId, iconName, text) {
  el(iconId).replaceChildren(screenIcon(iconName));
  el(labelId).textContent = text;
}

setBtn("control-icon", "control-label", "pointer", "Bật điều khiển");
setBtn("fullscreen-icon", "fullscreen-label", "maximize", "Toàn màn hình");
setBtn("connect-icon", "connect-label", "plug", "Kết nối");

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

el("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("fleet-theme", next);
  applyTheme(next);
});

function setScreenBadge(text, tone) {
  const item = el("screen-state");
  item.dataset.tone = tone || "gray";
  item.textContent = text;
}

const status = text => { el("status").textContent = text; };

async function api(path, post = false) {
  const headers = { Authorization: "Bearer " + (localStorage.getItem("fleet-session") ?? "") };
  const response = await fetch(path, post ? { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" } : { headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function hostApi(action) { return api("/api/hosts/" + encodeURIComponent(host.id) + "/" + action, true); }

function credentials(types) {
  const fields = el("fields");
  fields.replaceChildren();
  for (const key of types) {
    const label = document.createElement("label");
    label.textContent = { username: "Tài khoản", password: "Mật khẩu", target: "Đích" }[key] ?? key;
    const input = document.createElement("input");
    input.name = key;
    input.type = key === "password" ? "password" : "text";
    input.autocomplete = key === "password" ? "current-password" : "username";
    input.required = true;
    label.append(input);
    fields.append(label);
  }
  if (!el("credentials").open) el("credentials").showModal();
}

el("signin").onsubmit = event => {
  event.preventDefault();
  session?.sendCredentials(Object.fromEntries(new FormData(event.target)));
  el("fields").replaceChildren();
  el("credentials").close();
};

function abort() { session?.disconnect(); el("credentials").close(); }
el("abort").onclick = abort;
el("credentials").oncancel = abort;

el("control").onclick = () => {
  if (!session || !connected) return;
  session.viewOnly = !session.viewOnly;
  setBtn("control-icon", "control-label", session.viewOnly ? "pointer" : "eye", session.viewOnly ? "Bật điều khiển" : "Chuyển sang chỉ xem");
  setScreenBadge(session.viewOnly ? "Chỉ xem" : "Đang điều khiển", session.viewOnly ? "green" : "amber");
  status(session.viewOnly ? "Đã kết nối · Chỉ xem" : "Đã kết nối · Đang điều khiển");
  if (!session.viewOnly) session.focus();
};

el("fullscreen").onclick = async () => {
  const frame = el("display-frame");
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await frame.requestFullscreen();
  } catch {}
};

document.addEventListener("fullscreenchange", () => {
  const active = Boolean(document.fullscreenElement);
  setBtn("fullscreen-icon", "fullscreen-label", active ? "minimize" : "maximize", active ? "Thoát toàn màn hình" : "Toàn màn hình");
});

async function connect() {
  if (session) { session.disconnect(); return; }
  el("connect").disabled = true;
  setScreenBadge("Đang kết nối…", "blue");
  status("Đang kết nối tới dịch vụ chia sẻ màn hình qua SSH…");
  try {
    const { path } = await hostApi("screen");
    el("display-placeholder").hidden = true;
    session = new RFB(el("display"), "ws://" + location.host + path, { shared: true });
    session.scaleViewport = true;
    session.viewOnly = true;
    setBtn("connect-icon", "connect-label", "unplug", "Ngắt kết nối");
    el("connect").disabled = false;
    let failure = "";
    session.addEventListener("connect", () => {
      connected = true;
      el("control").disabled = false;
      el("fullscreen").disabled = false;
      setScreenBadge("Chỉ xem", "green");
      status("Đã kết nối · Chỉ xem");
    });
    session.addEventListener("credentialsrequired", event => credentials(event.detail.types));
    session.addEventListener("securityfailure", event => { failure = event.detail.reason || "Máy đích từ chối xác thực."; });
    session.addEventListener("serververification", () => {
      failure = "Máy đích yêu cầu xác minh khóa máy chủ. Hãy dùng ứng dụng VNC đã ghép nối.";
      session.disconnect();
    });
    session.addEventListener("disconnect", event => {
      session = null;
      connected = false;
      if (el("credentials").open) el("credentials").close();
      el("fields").replaceChildren();
      el("control").disabled = true;
      setBtn("control-icon", "control-label", "pointer", "Bật điều khiển");
      el("fullscreen").disabled = true;
      setBtn("connect-icon", "connect-label", "plug", "Kết nối lại");
      el("display-placeholder").hidden = false;
      setScreenBadge("Đã ngắt kết nối", failure || !event.detail.clean ? "amber" : "gray");
      status(failure || (event.detail.clean ? "Đã ngắt kết nối." : "Không kết nối được. Kiểm tra SSH và dịch vụ chia sẻ màn hình VNC trên máy đích."));
    });
  } catch (error) {
    el("display-placeholder").hidden = false;
    setScreenBadge("Lỗi kết nối", "red");
    status(error.message);
    el("connect").disabled = false;
  }
}

el("connect").onclick = connect;

el("rdp").onclick = async () => {
  try {
    const { file } = await hostApi("rdp");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([file], { type: "application/x-rdp" }));
    link.download = host.id + ".rdp";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    status("Mở tệp .rdp trong 90 giây, rồi đăng nhập Windows trên máy đích.");
  } catch (error) {
    status(error.message);
  }
};

try {
  const data = await api("/api/state");
  host = data.hosts.find(item => item.id === hostId && !item.local);
  if (!host) throw new Error("Chọn một máy từ xa trong bảng điều phối.");
  el("label").textContent = host.hostname;
  document.title = host.hostname + " · Màn hình từ xa";
  el("machine").href = "/?host=" + encodeURIComponent(host.id);
  el("machine-label").textContent = "Quản lý máy";
  el("rdp").hidden = host.platform !== "win32";
  status("Sử dụng dịch vụ chia sẻ màn hình và tài khoản của máy đích.");
  el("connect").disabled = false;
} catch (error) {
  status(error.message);
}

window.addEventListener("pagehide", () => session?.disconnect());
