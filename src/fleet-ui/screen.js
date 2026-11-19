import RFB from "/novnc/core/rfb.js";

const el = id => document.getElementById(id);
const hostId = new URLSearchParams(location.search).get("host");
let host, session, connected = false;
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
  el("control").textContent = session.viewOnly ? "Bật điều khiển" : "Chuyển sang chỉ xem";
  status(session.viewOnly ? "Đã kết nối · Chỉ xem" : "Đã kết nối · Đang điều khiển");
  if (!session.viewOnly) session.focus();
};
async function connect() {
  if (session) { session.disconnect(); return; }
  el("connect").disabled = true;
  status("Đang kết nối tới dịch vụ chia sẻ màn hình qua SSH…");
  try {
    const { path } = await hostApi("screen");
    session = new RFB(el("display"), "ws://" + location.host + path, { shared: true });
    session.scaleViewport = true;
    session.viewOnly = true;
    el("connect").textContent = "Ngắt kết nối";
    el("connect").disabled = false;
    let failure = "";
    session.addEventListener("connect", () => {
      connected = true; el("control").disabled = false; status("Đã kết nối · Chỉ xem");
    });
    session.addEventListener("credentialsrequired", event => credentials(event.detail.types));
    session.addEventListener("securityfailure", event => { failure = event.detail.reason || "Máy đích từ chối xác thực."; });
    session.addEventListener("serververification", () => {
      failure = "Máy đích yêu cầu xác minh khóa máy chủ. Hãy dùng ứng dụng VNC đã ghép nối.";
      session.disconnect();
    });
    session.addEventListener("disconnect", event => {
      session = null; connected = false;
      if (el("credentials").open) el("credentials").close();
      el("fields").replaceChildren();
      el("control").disabled = true; el("control").textContent = "Bật điều khiển";
      el("connect").textContent = "Kết nối lại";
      status(failure || (event.detail.clean ? "Đã ngắt kết nối." : "Không kết nối được. Kiểm tra SSH và dịch vụ chia sẻ màn hình VNC trên máy đích."));
    });
  } catch (error) { status(error.message); el("connect").disabled = false; }
}
el("connect").onclick = connect;
el("rdp").onclick = async () => {
  try {
    const { file } = await hostApi("rdp");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([file], { type: "application/x-rdp" }));
    link.download = host.id + ".rdp"; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    status("Mở tệp .rdp trong 90 giây, rồi đăng nhập Windows trên máy đích.");
  } catch (error) { status(error.message); }
};
try {
  const data = await api("/api/state");
  host = data.hosts.find(item => item.id === hostId && !item.local);
  if (!host) throw new Error("Chọn một máy từ xa trong bảng điều phối.");
  el("label").textContent = host.hostname;
  document.title = host.hostname + " · Màn hình từ xa";
  el("machine").href = "/?host=" + encodeURIComponent(host.id);
  el("machine").textContent = "← Quản lý máy";
  el("rdp").hidden = host.platform !== "win32";
  status("Sử dụng dịch vụ chia sẻ màn hình và tài khoản của máy đích.");
  el("connect").disabled = false;
} catch (error) { status(error.message); }
window.addEventListener("pagehide", () => session?.disconnect());
