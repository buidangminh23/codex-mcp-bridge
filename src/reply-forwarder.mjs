import { cloneReloadState } from "./reload-control.mjs";

const KNOWN_UNSENT_CODES = new Set([
  "RELAY_UNREACHABLE",
  "RELAY_MESSAGE_TOO_LARGE",
  "RELAY_THREAD_UNCONFIGURED",
  "RELAY_BAD_REQUEST",
]);

function validIdentity(value) {
  return typeof value === "string" && value.length > 0 && !/\s/.test(value);
}

function identityError(message) {
  return Object.assign(new Error(message), { code: "INVALID_REPLY_IDENTITY" });
}

function failureState(error) {
  const code = typeof error?.code === "string" ? error.code : "FORWARD_OUTCOME_UNKNOWN";
  const uncertain = error?.reachedCompanion === true || error?.deliveryUncertain === true
    || /TIMEOUT|TIMEDOUT/.test(code) || error?.name === "TimeoutError";
  const unsent = error?.sent === false || error?.dispatched === false
    || error?.preflight?.sent === false || KNOWN_UNSENT_CODES.has(code);
  return {
    status: !uncertain && unsent ? "failed" : "unknown",
    reasonCode: code,
    reason: error?.message ?? String(error),
  };
}

export class ReplyForwarder {
  constructor({
    deliver,
    minIntervalMs = 5000,
    maxPerSession = 50,
    now = Date.now,
    schedule = (callback, delay) => setTimeout(callback, delay),
    cancel = clearTimeout,
    beforeForward,
  } = {}) {
    if (typeof deliver !== "function") throw new TypeError("Reply forwarding requires a delivery function");
    if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new TypeError("Invalid reply forwarding interval");
    if (!Number.isSafeInteger(maxPerSession) || maxPerSession < 1) throw new TypeError("Invalid reply forwarding limit");
    if (![now, schedule, cancel].every((value) => typeof value === "function")
      || (beforeForward !== undefined && typeof beforeForward !== "function")) {
      throw new TypeError("Invalid reply forwarding callbacks");
    }
    this.deliver = deliver;
    this.minIntervalMs = minIntervalMs;
    this.maxPerSession = maxPerSession;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.beforeForward = beforeForward;
    this.records = new Map();
    this.queue = [];
    this.timer = null;
    this.active = null;
    this.lastAt = null;
    this.attempts = 0;
    this.closed = false;
  }

  enqueue(record, threadId) {
    const msgId = record?.inReplyTo ?? record?.msgId;
    if (!validIdentity(msgId) || !validIdentity(threadId) || typeof record?.text !== "string" || !record.text.trim()) {
      throw identityError("Reply forwarding requires an original message ID, exact destination task ID, and nonempty text");
    }
    if (record.replyThreadId != null && record.replyThreadId !== threadId) {
      throw identityError("The reply destination differs from the original sending task");
    }
    const existing = this.records.get(msgId);
    if (existing) {
      if (existing.receipt.threadId !== threadId) throw identityError("An existing reply cannot be redirected to another task");
      return this.read(msgId);
    }
    const entry = {
      record: Object.freeze({ ...record, text: record.text, replyThreadId: threadId }),
      receipt: { msgId, threadId, status: "queued", reasonCode: null, reason: null, queuedAt: this.now() },
    };
    this.records.set(msgId, entry);
    if (this.closed) this.#block(entry, "FORWARDER_CLOSED", "Reply forwarding is closed; this reply was not dispatched");
    else if (this.attempts >= this.maxPerSession) this.#block(entry, "SESSION_LIMIT_REACHED", "The per-session reply forwarding limit was reached; this reply was not dispatched");
    else {
      this.queue.push(entry);
      this.#scheduleNext();
    }
    return this.read(msgId);
  }

  read(msgId) {
    const entry = this.records.get(msgId);
    return entry ? { ...entry.receipt } : null;
  }

  status() {
    const counts = { total: this.records.size, queued: 0, sending: 0, forwarded: 0, failed: 0, unknown: 0, blocked: 0 };
    for (const { receipt } of this.records.values()) counts[receipt.status] += 1;
    return { ...counts, attempts: this.attempts, maxPerSession: this.maxPerSession, closed: this.closed };
  }

  reloadReason() {
    if (this.active || this.queue.length || this.timer !== null) return "Reply forwarding is still active or queued";
    if ([...this.records.values()].some(({ receipt }) => ["queued", "sending", "unknown"].includes(receipt.status))) {
      return "A reply forwarding outcome remains unconfirmed";
    }
    return null;
  }

  exportReloadState() {
    const reason = this.reloadReason();
    if (reason) throw new Error(reason);
    return cloneReloadState({ records: [...this.records], attempts: this.attempts, lastAt: this.lastAt, closed: this.closed,
      maxPerSession: this.maxPerSession, minIntervalMs: this.minIntervalMs });
  }

  restoreReloadState(input) {
    if (this.records.size || this.active || this.queue.length || this.timer !== null) throw new Error("Reply forwarding state is not empty");
    const state = cloneReloadState(input);
    if (!state || !Array.isArray(state.records) || !Number.isSafeInteger(state.attempts) || state.attempts < 0
      || !Number.isSafeInteger(state.maxPerSession) || state.maxPerSession < 1 || state.attempts > state.maxPerSession
      || !Number.isFinite(state.minIntervalMs) || state.minIntervalMs < 0 || typeof state.closed !== "boolean"
      || state.lastAt !== null && (!Number.isFinite(state.lastAt) || state.lastAt < 0)) throw new Error("Invalid reply forwarding reload state");
    const records = new Map();
    for (const pair of state.records) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error("Invalid reply forwarding record");
      const [id, entry] = pair;
      if (!validIdentity(id) || records.has(id) || !entry?.record || !entry.receipt
        || entry.receipt.msgId !== id || !validIdentity(entry.receipt.threadId)
        || entry.record.replyThreadId !== entry.receipt.threadId || (entry.record.inReplyTo ?? entry.record.msgId) !== id
        || typeof entry.record.text !== "string" || !entry.record.text.trim()
        || !["forwarded", "failed", "blocked"].includes(entry.receipt.status)) throw new Error("Invalid or unconfirmed reply forwarding record");
      records.set(id, { record: Object.freeze(entry.record), receipt: entry.receipt });
    }
    this.records = records;
    this.attempts = state.attempts;
    this.lastAt = state.lastAt;
    this.closed = state.closed;
    this.maxPerSession = Math.min(this.maxPerSession, state.maxPerSession);
    this.minIntervalMs = Math.max(this.minIntervalMs, state.minIntervalMs);
  }

  close() {
    this.closed = true;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    for (const entry of this.queue.splice(0)) {
      this.#block(entry, "FORWARDER_CLOSED", "Reply forwarding closed before this reply was dispatched");
    }
    if (this.active?.receipt.status === "queued") {
      this.#block(this.active, "FORWARDER_CLOSED", "Reply forwarding closed before this reply was dispatched");
    }
    return this.status();
  }

  #block(entry, reasonCode, reason) {
    Object.assign(entry.receipt, { status: "blocked", reasonCode, reason, completedAt: this.now() });
  }

  #scheduleNext() {
    if (this.closed || this.active || this.timer !== null || !this.queue.length) return;
    if (this.attempts >= this.maxPerSession) {
      for (const entry of this.queue.splice(0)) {
        this.#block(entry, "SESSION_LIMIT_REACHED", "The per-session reply forwarding limit was reached; this reply was not dispatched");
      }
      return;
    }
    const delay = this.lastAt === null ? 0 : Math.max(0, this.lastAt + this.minIntervalMs - this.now());
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.#forwardNext();
    }, delay);
  }

  async #forwardNext() {
    if (this.closed || this.active || !this.queue.length) return;
    const entry = this.queue.shift();
    this.active = entry;
    try {
      try {
        await this.beforeForward?.(entry.record, entry.receipt.threadId);
      } catch (error) {
        if (entry.receipt.status !== "blocked") {
          Object.assign(entry.receipt, {
            status: "failed",
            reasonCode: typeof error?.code === "string" ? error.code : "FORWARD_PREFLIGHT_FAILED",
            reason: error?.message ?? String(error),
            completedAt: this.now(),
          });
        }
        return;
      }
      if (this.closed) {
        this.#block(entry, "FORWARDER_CLOSED", "Reply forwarding closed before this reply was dispatched");
        return;
      }
      this.lastAt = this.now();
      this.attempts += 1;
      Object.assign(entry.receipt, { status: "sending", attemptedAt: this.lastAt });
      try {
        const result = await this.deliver(entry.receipt.threadId, entry.record);
        Object.assign(entry.receipt, {
          status: "forwarded",
          completedAt: this.now(),
          ...(typeof result?.backend === "string" ? { backend: result.backend } : {}),
        });
      } catch (error) {
        Object.assign(entry.receipt, failureState(error), { completedAt: this.now() });
      }
    } finally {
      this.active = null;
      this.#scheduleNext();
    }
  }
}
