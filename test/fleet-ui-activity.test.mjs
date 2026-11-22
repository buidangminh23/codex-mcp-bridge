import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as settle } from "node:timers/promises";

const host = { id: "local", hostname: "Local", online: true, agents: [] };
const task = { requestId: "example", agent: "codex", status: "running" };

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.value = "";
    this.style = { setProperty() {} };
  }
  get options() { return this.children; }
  get childNodes() { return this.children; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(key, value) { this[key] = value; }
  cloneNode() { return new Element(this.tag); }
  querySelector(selector) {
    const [first, ...rest] = selector.split(" ");
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      const matches = first === child.tag || (first.startsWith(".") && child.className?.split(" ").includes(first.slice(1)));
      if (matches && !rest.length) return child;
      const found = child.querySelector(matches ? rest.join(" ") : selector);
      if (found) return found;
    }
    return null;
  }
  insertBefore(item, next) { this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, item); }
  querySelectorAll() { return []; }
  focus() { this.focused = true; }
}

async function dashboard(t, load) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const failed = new Set();
  for (const id of ["bg-agent-filter", "bg-status-filter"]) el(id).value = "all";
  const state = { hosts: [{ ...host }], jobs: [] };
  let poll;
  const globals = {
    location: new URL("http://localhost/"),
    localStorage: { getItem() { return null; } },
    document: {
      documentElement: el("html"), getElementById: el, createElement: tag => new Element(tag),
      createElementNS: (_ns, tag) => new Element(tag), addEventListener() {}, querySelectorAll() { return []; },
    },
    window: { addEventListener() {} }, setInterval() {}, clearTimeout() {},
    setTimeout(callback, ms) { if (ms === 4000) poll = callback; },
    Option: class { constructor(_title, value) { this.value = value; } },
    fetch: async url => {
      if (url === "/api/state") return { ok: true, json: async () => state };
      const part = url.split("/").at(-1);
      const ok = !failed.has(part);
      const data = part === "activity" ? { tasks: [task], processes: [] }
        : { sessions: [{ id: "local-ai", agent: "codex", status: "running" }] };
      return { ok, status: ok ? 200 : 503, json: async () => ok ? data : { error: "Unavailable" } };
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
  await load();
  await settle();
  assert.equal(el("connection").dataset.online, "true", el("page-error").textContent);
  return { el, failed, state, poll: () => poll(), scan: async () => { el("activity-refresh").listeners.click(); await settle(); } };
}

test("failed activity scans discard only unavailable live data and offline hosts discard all snapshots", async t => {
  const box = await dashboard(t, () => import("../src/fleet-ui/app.js?scans"));
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "2");
  const success = box.el("activity-stamp").textContent;
  box.failed.add("sessions");
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "1");
  assert.equal(box.el("bg-notes").hidden, false);
  assert.equal(box.el("activity-stamp").textContent, success);
  box.failed.add("activity");
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "0");
  assert.match(box.el("toast").textContent, /0\/1/);
  box.failed.clear();
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "2");
  assert.equal(box.el("bg-notes").hidden, true);
  box.state.hosts[0].online = false;
  await box.poll();
  assert.equal(box.el("tab-count-live").textContent, "0");
  assert.equal(box.el("activity-refresh").disabled, true);
});

test("opening a live worker reveals its rendered details even under an incompatible background filter", async t => {
  const box = await dashboard(t, () => import("../src/fleet-ui/app.js?navigation"));
  await box.scan();
  const list = box.el("bg-task-list");
  for (const query of ["", "another task"]) {
    box.el("bg-search").value = query;
    box.el("bg-search").listeners.input();
    if (query) assert.equal(list.children[0].tag, "p");
    const button = box.el("live-work-list").children.find(child => child.tag === "button");
    button.listeners.click();
    const details = list.children[0];
    assert.equal(box.el("panel-background").hidden, false);
    assert.equal(box.el("bg-search").value, "");
    assert.equal(details.dataset.requestId, task.requestId);
    assert.equal(details.open, true);
    assert.equal(details.querySelector("summary").focused, true);
  }
});
