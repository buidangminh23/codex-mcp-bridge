import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../src/fleet-ui/app.js", import.meta.url), "utf8");
const host = { id: "local", hostname: "Local", online: true };
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
  querySelector(tag) { return this.children.find(child => child.tag === tag); }
  querySelectorAll() { return []; }
  focus() { this.focused = true; }
}

function dashboard() {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const failed = new Set();
  for (const id of ["bg-agent-filter", "bg-status-filter"]) el(id).value = "all";
  const run = vm.createContext({
    URLSearchParams, TextEncoder, host, location: { hash: "", search: "" },
    localStorage: { getItem() { return null; } },
    document: {
      documentElement: el("html"), getElementById: el, createElement: tag => new Element(tag),
      createElementNS: (_ns, tag) => new Element(tag), addEventListener() {}, querySelectorAll() { return []; },
    },
    window: { addEventListener() {} }, setInterval() {}, setTimeout() {}, clearTimeout() {},
    Option: class { constructor(_title, value) { this.value = value; } },
    fetch: async url => {
      if (url === "/api/state") return new Promise(() => {});
      const part = url.split("/").at(-1);
      const ok = !failed.has(part);
      const data = part === "activity" ? { tasks: [task], processes: [] }
        : { sessions: [{ id: "local-ai", agent: "codex", status: "running" }] };
      return { ok, status: ok ? 200 : 503, json: async () => ok ? data : { error: "Unavailable" } };
    },
  });
  vm.runInContext(source, run);
  const evaluate = script => vm.runInContext(script, run);
  evaluate("online = true; state = { hosts: [host], jobs: [] }; render = renderActivity");
  return { el, failed, evaluate, scan: () => evaluate("refreshActivity(true)") };
}

test("failed activity scans discard only unavailable live data and offline hosts discard all snapshots", async () => {
  const box = dashboard();
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "2");
  const success = box.evaluate("activityLastScan");
  box.failed.add("sessions");
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "1");
  assert.equal(box.el("bg-notes").hidden, false);
  assert.equal(box.evaluate("activityLastScan"), success);
  box.failed.add("activity");
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "0");
  assert.match(box.el("toast").textContent, /0\/1/);
  box.failed.clear();
  await box.scan();
  assert.equal(box.el("tab-count-live").textContent, "2");
  assert.equal(box.el("bg-notes").hidden, true);
  box.evaluate("applyLatestState({ hosts: [{ ...host, online: false }], jobs: [] })");
  assert.equal(box.el("tab-count-live").textContent, "0");
  assert.equal(box.el("activity-refresh").disabled, true);
  assert.equal(box.evaluate("hostActivity.size + hostSessions.size"), 0);
});

test("opening a live worker reveals its rendered details even under an incompatible background filter", async () => {
  const box = dashboard();
  await box.scan();
  const list = box.el("bg-task-list");
  for (const query of ["", "another task"]) {
    box.el("bg-search").value = query;
    box.evaluate("renderActivity()");
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
