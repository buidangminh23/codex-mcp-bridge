import { randomUUID } from "node:crypto";
import { BACKGROUND_AGENTS, RELAY_UUID } from "./background-relay-config.mjs";
import { diagnosticText } from "./recipient-preflight.mjs";

const active = new Set(["running", "uncertain"]);
const statuses = new Set(["queued", ...active, "completed", "failed", "cancelled"]);
const relayStatuses = new Set(["queued", "running", "completed", "failed", "unknown"]);
const maxSteps = 16;
const maxStepBytes = 32 * 1024;

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function validSteps(steps) {
  return Array.isArray(steps) && steps.length > 0 && steps.length <= maxSteps
    && steps.every(step => typeof step === "string" && step.trim() && Buffer.byteLength(step) <= maxStepBytes);
}

function validateState(state) {
  if (state?.version !== 1 || !Array.isArray(state.jobs)) throw invalid("Unsupported fleet queue state", 500);
  const ids = new Set();
  for (const job of state.jobs) {
    if (!RELAY_UUID.test(job?.id) || ids.has(job.id) || !BACKGROUND_AGENTS.includes(job.agent)
      || typeof job.title !== "string" || typeof job.target !== "string" || !statuses.has(job.status)
      || !validSteps(job.steps) || !Number.isInteger(job.stepIndex) || job.stepIndex < 0 || job.stepIndex >= job.steps.length
      || !Array.isArray(job.history)) throw invalid("Invalid stored fleet job", 500);
    ids.add(job.id);
    for (const [index, entry] of job.history.entries()) {
      if (!RELAY_UUID.test(entry?.requestId) || ids.has(entry.requestId) || entry.stepIndex !== index
        || index > job.stepIndex || typeof entry.hostId !== "string" || typeof entry.binding !== "string"
        || typeof entry.output !== "string" || !statuses.has(entry.status)
        || index < job.stepIndex && entry.status !== "completed") throw invalid("Invalid stored fleet step", 500);
      ids.add(entry.requestId);
    }
    const last = job.history.at(-1);
    if (["queued", "cancelled"].includes(job.status) ? job.history.length !== job.stepIndex || job.hostId !== null
      : last?.stepIndex !== job.stepIndex || last.hostId !== job.hostId || last.status !== job.status) {
      throw invalid("Inconsistent stored fleet step", 500);
    }
  }
  return state.jobs;
}

function jobPrompt(job) {
  const step = job.steps[job.stepIndex];
  if (job.steps.length === 1) return step;
  const heading = `Task: ${job.title}\nStep ${job.stepIndex + 1} of ${job.steps.length}\n`;
  const handoff = job.stepIndex + 1 < job.steps.length
    ? "\nThe next step may run on another machine. In your final answer, include results and any shared file or revision references it needs."
    : "";
  const previous = job.history.filter(entry => entry.status === "completed").map(entry =>
    `Step ${entry.stepIndex + 1} on ${entry.hostId}\n${job.steps[entry.stepIndex]}\nResult:\n${entry.output}${entry.outputTruncated ? "\n[Worker output truncated]" : ""}`);
  let context = previous.join("\n\n");
  if (Buffer.byteLength(context) > 156 * 1024) {
    const bytes = Buffer.from(context);
    context = "[Earlier handoff text truncated]\n" + bytes.subarray(-156 * 1024).toString("utf8");
  }
  return heading + (context ? `\nPrevious step handoffs:\n${context}\n` : "") + `\nCurrent instructions:\n${step}${handoff}`;
}

export function createFleetQueue({ hosts, client, load, save, minFreeBytes = 2 * 1024 ** 3, now = Date.now, maxProbeAgeMs = 60_000 }) {
  const initial = load();
  let jobs = initial == null ? [] : validateState(initial);
  const byId = new Map(hosts.map(host => [host.id, host]));
  const telemetry = new Map();
  const iso = () => new Date(now()).toISOString();
  const binding = host => JSON.stringify([host.sshHost ?? null, host.cwd, host.platform ?? null]);
  let pending;

  function store(next) {
    save({ version: 1, jobs: next });
    jobs = next;
  }

  function change(id, patch) {
    const job = jobs.find(item => item.id === id);
    if (!job) throw invalid("No such fleet job", 404);
    const next = { ...job, ...patch, updatedAt: iso() };
    store(jobs.map(item => item.id === id ? next : item));
    return next;
  }

  function targetCheck(target) {
    if (target !== "auto" && !byId.has(target)) throw invalid("Unknown target machine");
  }

  function submit({ title, agent, steps, target = "auto" } = {}) {
    targetCheck(target);
    if (typeof title !== "string" || !title.trim() || title.trim().length > 160) throw invalid("Supply a task title of 1–160 characters");
    if (!BACKGROUND_AGENTS.includes(agent)) throw invalid("Unknown worker agent");
    if (!validSteps(steps)) throw invalid("Supply 1–16 nonempty steps, each at most 32 KiB");
    const createdAt = iso();
    const job = { id: randomUUID(), title: title.trim(), agent, steps: steps.slice(), target, status: "queued",
      hostId: null, stepIndex: 0, history: [], error: null, createdAt, updatedAt: createdAt };
    store([...jobs, job]);
    return structuredClone(job);
  }

  function editQueued(id, patch) {
    const job = jobs.find(item => item.id === id);
    if (!job) throw invalid("No such fleet job", 404);
    if (job.status !== "queued") throw invalid("Only a step awaiting assignment can be changed", 409);
    return structuredClone(change(id, patch));
  }

  function hostView(host) {
    const sample = telemetry.get(host.id);
    const fresh = sample && now() - sample.time <= maxProbeAgeMs && now() >= sample.time;
    return { id: host.id, cwd: host.cwd, local: !host.sshHost, hostname: sample?.hostname ?? host.sshHost ?? host.id,
      platform: sample?.platform ?? host.platform ?? null, online: Boolean(fresh && !sample.error),
      agents: sample?.agents ?? [], freeBytes: sample?.freeBytes ?? null, totalBytes: sample?.totalBytes ?? null,
      checkedAt: sample ? new Date(sample.time).toISOString() : null, error: sample?.error ?? null, reason: sample?.reason ?? null,
      revision: sample?.revision ?? null, clean: sample?.clean ?? null };
  }

  async function probe(host) {
    const time = now();
    try {
      const sample = await client.probe(host);
      if (!Number.isSafeInteger(sample.freeBytes) || !Number.isSafeInteger(sample.totalBytes) || sample.totalBytes < 1
        || sample.freeBytes < 0 || sample.freeBytes > sample.totalBytes || !Array.isArray(sample.agents)) throw invalid("Invalid host capacity");
      telemetry.set(host.id, { ...sample, time, error: null });
    } catch (error) {
      telemetry.set(host.id, { time, error: diagnosticText(error.message) });
    }
  }

  function record(job, status, output, error, terminalUnknown = false, outputTruncated = false) {
    const entry = job.history.at(-1);
    if (entry.status === status && entry.output === output && entry.error === error && Boolean(entry.terminalUnknown) === terminalUnknown
      && Boolean(entry.outputTruncated) === outputTruncated) return;
    const updated = { ...entry, status, output, error, terminalUnknown, outputTruncated };
    const history = [...job.history.slice(0, -1), updated];
    const more = status === "completed" && job.stepIndex + 1 < job.steps.length;
    change(job.id, more ? { history, status: "queued", stepIndex: job.stepIndex + 1, hostId: null, error: null } : { history, status, error });
  }

  async function contact(job, host, method) {
    const entry = job.history.at(-1);
    let receipt;
    try {
      receipt = await client[method](host, { id: entry.requestId, agent: job.agent, prompt: jobPrompt(job), expectedRevision: entry.expectedRevision });
      if (receipt?.requestId !== entry.requestId || receipt.agent !== job.agent || !relayStatuses.has(receipt.status)
        || receipt.output != null && typeof receipt.output !== "string") {
        throw invalid("The relay returned an unrelated or invalid receipt");
      }
    } catch (error) {
      const unsent = method === "send" && error.deliveryState === "not_sent" && error.code !== "WORKER_REQUEST_CONFLICT";
      record(job, unsent ? "failed" : "uncertain", "", diagnosticText(error.message));
      return;
    }
    const status = ["running", "queued"].includes(receipt.status) ? "running" : receipt.status === "unknown" ? "uncertain" : receipt.status;
    const error = status === "failed" || status === "uncertain" ? diagnosticText(receipt.diagnostic?.reason ?? receipt.diagnostic?.message ?? receipt.diagnostic?.code ?? receipt.status) : null;
    record(job, status, receipt.output ?? "", error, receipt.status === "unknown", receipt.outputTruncated === true);
  }

  function selectHost(job, busy) {
    const eligible = hosts.map(hostView).filter(host => host.online && host.freeBytes >= minFreeBytes && !busy.has(host.id)
      && host.agents.includes(job.agent) && (job.target === "auto" || host.id === job.target));
    const last = job.history.at(-1);
    const previous = last && byId.get(last.hostId);
    const source = previous && binding(previous) === last.binding ? hostView(previous) : null;
    const safe = eligible.filter(host => !last || source && (host.id === source.id || source.online && source.clean === true
      && host.clean === true && typeof source.revision === "string" && source.revision.length && source.revision === host.revision));
    const chosen = safe.sort((a, b) => Number(b.local) - Number(a.local) || b.freeBytes - a.freeBytes)[0];
    if (chosen) return { host: chosen, expectedRevision: last && chosen.id !== last.hostId ? chosen.revision : undefined };
    return { error: last && eligible.length ? "Waiting for the original machine or matching clean Git revisions on both machines."
      : "Waiting for an available machine with enough free RAM and a ready worker." };
  }

  async function cycle() {
    const inspected = await Promise.allSettled(jobs.filter(job => active.has(job.status) && !job.history.at(-1).terminalUnknown).map(async job => {
      const host = byId.get(job.hostId);
      if (!host || binding(host) !== job.history.at(-1).binding) {
        record(job, "uncertain", "", "The assigned machine configuration changed. Restore its original profile to inspect the receipt.");
      } else await contact(job, host, "read");
    }));
    for (const result of inspected) if (result.status === "rejected") throw result.reason;
    await Promise.all(hosts.map(probe));
    const busy = new Set(jobs.filter(job => active.has(job.status) && !job.history.at(-1).terminalUnknown).map(job => job.hostId));
    for (const id of jobs.filter(job => job.status === "queued").map(job => job.id)) {
      const job = jobs.find(item => item.id === id);
      if (job.status !== "queued") continue;
      const { host, expectedRevision } = selectHost(job, busy);
      if (!host) continue;
      busy.add(host.id);
      const entry = { requestId: randomUUID(), hostId: host.id, binding: binding(byId.get(host.id)), expectedRevision, stepIndex: job.stepIndex, status: "running", output: "", error: null };
      const assigned = change(job.id, { hostId: host.id, status: "running", error: null, history: [...job.history, entry] });
      await contact(assigned, byId.get(host.id), "send");
    }
  }

  function snapshot() {
    const busy = new Set(jobs.filter(job => active.has(job.status) && !job.history.at(-1).terminalUnknown).map(job => job.hostId));
    return structuredClone({ hosts: hosts.map(hostView), jobs: jobs.map(job =>
      job.status === "queued" ? { ...job, error: selectHost(job, busy).error ?? null } : job).reverse(), minFreeBytes });
  }

  return {
    tick() {
      if (!pending) pending = cycle().finally(() => { pending = undefined; });
      return pending;
    },
    snapshot,
    submit,
    setMemoryFloor(gib) {
      const bytes = Math.round(gib * 1024 ** 3);
      if (typeof gib !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) throw invalid("Enter a positive RAM threshold in GiB");
      minFreeBytes = bytes;
      return { minFreeBytes };
    },
    cancel: id => editQueued(id, { status: "cancelled" }),
    retarget(id, target) { targetCheck(target); return editQueued(id, { target }); },
  };
}
