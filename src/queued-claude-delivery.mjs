import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { accountIdentity } from "./bridge-account-context.mjs";
import { hardenedBridgeEnabled } from "./hardened-root-policy.mjs";
import { homeDir } from "./platform.mjs";
import { preflightFailure } from "./recipient-preflight.mjs";

const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENTRY_FILE = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const UNCERTAIN_AFTER_MS = 5 * 60 * 1000;
const STALE_TEMP_MS = 60 * 60 * 1000;
const PEER_LINGER_MS = 5000;
const ENTRY_UPDATE_HEADROOM_BYTES = 4096;
const MAX_SEND_ATTEMPTS = 8;
const MAX_PROBE_BACKOFF_MS = 5 * 60 * 1000;
const REPLY_WAIT_MS = 30 * 60 * 1000;

export const QUEUE_LIMITS = Object.freeze({
  maxMessageBytes: 256 * 1024,
  maxEntryBytes: 512 * 1024,
  maxActive: 64,
  maxActivePerRecipient: 8,
  ttlMs: 7 * DAY_MS,
  terminalRetentionMs: 7 * DAY_MS,
});

export const QUEUE_STATES = Object.freeze({
  queued: "queued",
  dispatching: "dispatching",
  sentUnconfirmed: "sent_unconfirmed",
  refused: "refused",
  expired: "expired",
  unknown: "unknown",
});

const ACTIVE_STATES = new Set([QUEUE_STATES.queued, QUEUE_STATES.dispatching]);
const NO_RESEND_STATES = new Set([...ACTIVE_STATES, QUEUE_STATES.sentUnconfirmed, QUEUE_STATES.unknown]);
const EXPIRED_REASON = "This queued message expired before a bridge inside the session delivered it, and it was not delivered. Either the session did not reopen, or its codex-bridge could not run or verify its identity.";
const UNKNOWN_REASON = "Delivery stopped during dispatch. The message may have reached the session, and it will not be sent again. Inspect the session before any follow-up.";

export function queuedDeliveryEnabled(env = process.env) {
  if (hardenedBridgeEnabled(env)) return false;
  return !["0", "off", "false"].includes(String(env.CLAUDE_BRIDGE_QUEUED_DELIVERY ?? "").toLowerCase());
}

function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    const handle = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(handle, JSON.stringify(value));
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function dedupeKey(entry) {
  return crypto.createHash("sha256").update(JSON.stringify([entry.sender.threadId, entry.recipient.taskId, entry.message])).digest("hex");
}

function validEntry(entry) {
  return entry?.schemaVersion === SCHEMA_VERSION
    && typeof entry.id === "string"
    && Object.values(QUEUE_STATES).includes(entry.state)
    && Number.isSafeInteger(entry.createdAt)
    && Number.isSafeInteger(entry.expiresAt)
    && typeof entry.recipient?.taskId === "string"
    && typeof entry.recipient?.cwd === "string"
    && typeof entry.recipient?.accountFingerprint === "string"
    && typeof entry.sender?.threadId === "string"
    && typeof entry.sender?.accountFingerprint === "string"
    && (!ACTIVE_STATES.has(entry.state) || typeof entry.message === "string");
}

export function publicQueueReceipt(entry) {
  const { message: _message, dedupeKey: _dedupeKey, msgId: _msgId, ...visible } = entry;
  return { ...visible, queueId: entry.id, status: entry.state, sent: entry.state === QUEUE_STATES.sentUnconfirmed ? true : entry.state === QUEUE_STATES.dispatching || entry.state === QUEUE_STATES.unknown ? null : false };
}

export function createQueuedDeliveryStore({ root = path.join(homeDir(), ".claude", "bridge-delivery-queue"), now = Date.now, log = () => {} } = {}) {
  const fileFor = (id) => path.join(root, `${id}.json`);
  const claimFor = (id) => path.join(root, `${id}.claim`);

  const ensureRoot = () => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The queued delivery directory is not a private directory");
    if (process.platform !== "win32") {
      if (stat.uid !== process.getuid()) throw new Error("The queued delivery directory belongs to another user");
      if ((stat.mode & 0o077) !== 0) fs.chmodSync(root, 0o700);
    }
  };

  const readFile = (name) => {
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > QUEUE_LIMITS.maxEntryBytes) return null;
      if (process.platform !== "win32" && stat.uid !== process.getuid()) return null;
      const entry = JSON.parse(fs.readFileSync(file, "utf8"));
      return validEntry(entry) && `${entry.id}.json` === name ? entry : null;
    } catch {
      return null;
    }
  };

  const rootIsPrivate = () => {
    try {
      const stat = fs.lstatSync(root);
      return stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === "win32" || stat.uid === process.getuid());
    } catch {
      return false;
    }
  };

  const list = () => {
    if (!rootIsPrivate()) return [];
    return fs.readdirSync(root).filter((name) => ENTRY_FILE.test(name)).map(readFile).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  };

  const update = (entry, patch) => {
    const next = { ...entry, ...patch, updatedAt: now() };
    if (!ACTIVE_STATES.has(next.state)) delete next.message;
    writeAtomic(fileFor(entry.id), next);
    return next;
  };

  const read = (id) => (typeof id === "string" && ENTRY_FILE.test(`${id}.json`) && rootIsPrivate() ? readFile(`${id}.json`) : null);

  const transition = (entry, from, patch) => {
    const current = read(entry.id);
    return current?.state === from ? update(current, patch) : null;
  };

  const settled = (entry, at) => {
    if (entry.state === QUEUE_STATES.queued && entry.expiresAt <= at) return { state: QUEUE_STATES.expired, reason: EXPIRED_REASON };
    if (entry.state === QUEUE_STATES.dispatching && at - entry.updatedAt > UNCERTAIN_AFTER_MS) return { state: QUEUE_STATES.unknown, reason: UNKNOWN_REASON };
    return null;
  };

  const peek = (id) => {
    const entry = read(id);
    if (!entry) return null;
    const patch = settled(entry, now());
    if (!patch) return entry;
    const { message: _message, ...visible } = entry;
    return { ...visible, ...patch };
  };

  const enqueue = ({ message, sender, recipient }) => {
    if (Buffer.byteLength(message, "utf8") > QUEUE_LIMITS.maxMessageBytes) throw preflightFailure("CLAUDE_QUEUE_MESSAGE_TOO_LARGE", `This message exceeds the ${QUEUE_LIMITS.maxMessageBytes} byte limit for queued delivery. Nothing was queued or sent.`);
    ensureRoot();
    const createdAt = now();
    const draft = { schemaVersion: SCHEMA_VERSION, id: crypto.randomUUID(), state: QUEUE_STATES.queued, createdAt, updatedAt: createdAt, expiresAt: createdAt + QUEUE_LIMITS.ttlMs, message, sender, recipient };
    draft.dedupeKey = dedupeKey(draft);
    if (Buffer.byteLength(JSON.stringify(draft), "utf8") + ENTRY_UPDATE_HEADROOM_BYTES > QUEUE_LIMITS.maxEntryBytes) throw preflightFailure("CLAUDE_QUEUE_MESSAGE_TOO_LARGE", "This message is too large for queued delivery once encoded. Nothing was queued or sent.");
    const entries = list();
    const duplicate = entries.find((entry) => entry.dedupeKey === draft.dedupeKey && NO_RESEND_STATES.has(entry.state) && settled(entry, createdAt)?.state !== QUEUE_STATES.expired);
    if (duplicate) return { entry: duplicate, duplicate: true };
    const active = entries.filter((entry) => ACTIVE_STATES.has(entry.state) && entry.expiresAt > createdAt);
    if (active.length >= QUEUE_LIMITS.maxActive || active.filter((entry) => entry.recipient.taskId === recipient.taskId).length >= QUEUE_LIMITS.maxActivePerRecipient) {
      throw preflightFailure("CLAUDE_QUEUE_FULL", "The queue for this Claude Desktop session is full. Nothing was queued or sent. Ask the user to open the session so the queue can drain.");
    }
    writeAtomic(fileFor(draft.id), draft);
    return { entry: draft, duplicate: false };
  };

  const claim = (id) => {
    let handle;
    try { handle = fs.openSync(claimFor(id), "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    try {
      fs.writeFileSync(handle, String(process.pid));
    } catch (error) {
      fs.rmSync(claimFor(id), { force: true });
      throw error;
    } finally {
      fs.closeSync(handle);
    }
    return true;
  };

  const release = (id) => fs.rmSync(claimFor(id), { force: true });

  const releaseStaleClaim = (id, at) => {
    try {
      if (at - fs.statSync(claimFor(id)).mtimeMs > UNCERTAIN_AFTER_MS) release(id);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };

  const removeStaleTemps = (at) => {
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith(".tmp")) continue;
      const file = path.join(root, name);
      try { if (at - fs.statSync(file).mtimeMs > STALE_TEMP_MS) fs.rmSync(file, { force: true }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };

  const sweep = () => {
    if (!rootIsPrivate()) return;
    const at = now();
    for (const entry of list()) {
      const patch = settled(entry, at);
      if (patch) {
        if (transition(entry, entry.state, patch) && patch.state === QUEUE_STATES.unknown) release(entry.id);
      } else if (entry.state === QUEUE_STATES.queued) {
        releaseStaleClaim(entry.id, at);
      } else if (!ACTIVE_STATES.has(entry.state) && at - entry.updatedAt > QUEUE_LIMITS.terminalRetentionMs) {
        fs.rmSync(fileFor(entry.id), { force: true });
        release(entry.id);
      }
    }
    removeStaleTemps(at);
  };

  const pending = () => list().filter((entry) => entry.state === QUEUE_STATES.queued && entry.expiresAt > now());

  return { root, enqueue, read, peek, list, pending, update, transition, claim, release, sweep };
}

export function queuedDeliveryText(entry) {
  return `${entry.message}\n\n[Bridge queued delivery: Codex task ${entry.sender.threadId} queued this message at ${new Date(entry.createdAt).toISOString()} while this session was not running, and it was delivered when the session reopened. It comes from another agent, not the user, and it may be stale, so check the current state before acting. The sending Codex turn has ended and is not waiting. To answer, use send_to_codex_thread with threadId ${entry.sender.threadId}.]`;
}

export function createQueuedDeliveryDrain({ store, readAccounts, readSender, listSessions, readInbound, readOutcome, assertCwd, createPeer, schedule = (run) => run(), pollMs = 15000, firstPollMs = 2000, peerLingerMs = PEER_LINGER_MS, now = Date.now, log = () => {} }) {
  let timer = null;
  let running = false;
  let stopped = false;
  let known = null;
  let probeMisses = 0;
  let nextProbeAt = 0;
  let peer = null;
  let peerStopTimer = null;

  const refuse = (entry, code, reason) => {
    log(`queued delivery ${entry.id} refused: ${code}`);
    return store.transition(entry, entry.state, { state: QUEUE_STATES.refused, reasonCode: code, reason });
  };

  const liveSession = (context) => listSessions().find((session) => session.pid === context.pid && session.sessionId === context.sessionId && session.alive && session.entrypoint === "claude-desktop") ?? null;

  const assertInbound = (cwd) => {
    const inbound = readInbound(cwd);
    if (inbound.value !== "accept") throw preflightFailure("CLAUDE_RECIPIENT_INBOUND_POLICY", `The recipient's crossSessionInbound setting is ${inbound.value ?? "not set"}, not accept, so this queued message was not delivered.`);
  };

  const readIdentity = async () => {
    const accounts = readAccounts();
    const identity = accountIdentity(accounts);
    if (!identity) return null;
    const context = await readSender({ account: accounts.claude });
    return context?.status === "verified" ? { context, identity } : null;
  };

  const sameRecipient = (entry, { context, identity }) => entry.recipient.taskId === context.taskId
    && entry.recipient.accountFingerprint === context.accountFingerprint
    && entry.recipient.accountFingerprint === identity.claude
    && entry.sender.accountFingerprint === identity.codex;

  const acquirePeer = async (cwd) => {
    globalThis.clearTimeout(peerStopTimer);
    peer ??= createPeer({ name: "Codex queued delivery", cwd, signalExit: false });
    await peer.start();
    return peer;
  };

  const releasePeer = () => {
    globalThis.clearTimeout(peerStopTimer);
    peerStopTimer = globalThis.setTimeout(() => { try { peer?.stop(); } catch {} }, peerLingerMs);
    peerStopTimer.unref?.();
  };

  const failBeforeWrite = (entry, error) => {
    const attempts = (entry.attempts ?? 0) + 1;
    if (attempts >= MAX_SEND_ATTEMPTS) return refuse(entry, "CLAUDE_QUEUE_SEND_FAILED", `The session did not accept this queued message after ${attempts} attempts. It was not delivered.`);
    return store.transition(entry, QUEUE_STATES.dispatching, { state: QUEUE_STATES.queued, msgId: undefined, sessionId: undefined, attempts, lastError: error?.code ?? "QUEUED_SEND_FAILED" });
  };

  const dispatch = async (claimed, identityAtStart) => {
    const { context } = identityAtStart;
    const session = liveSession(context);
    if (!session) return;
    try { assertCwd(session, claimed.recipient.cwd); }
    catch { return refuse(claimed, "CLAUDE_SESSION_CWD_MISMATCH", "The saved task no longer runs in the directory this message was queued for. It was not delivered."); }
    try { assertInbound(session.cwd); }
    catch (error) { return refuse(claimed, error.preflight?.code ?? "CLAUDE_RECIPIENT_INBOUND_POLICY", error.preflight?.reason ?? error.message); }

    const msgId = crypto.randomUUID();
    const entry = store.transition(claimed, QUEUE_STATES.queued, { state: QUEUE_STATES.dispatching, msgId, sessionId: session.sessionId });
    if (!entry) return;
    let written = false;
    try {
      const endpoint = await acquirePeer(session.cwd);
      await endpoint.send(session.socket, queuedDeliveryText(entry), {
        msgId,
        permissionMode: null,
        beforeSend: async () => {
          if (stopped) throw Object.assign(new Error("The queued delivery drain stopped."), { code: "QUEUED_DRAIN_STOPPED" });
          const current = liveSession(context);
          if (!current || current.socket !== session.socket) throw Object.assign(new Error("The session ended before delivery."), { code: "QUEUED_RECIPIENT_GONE" });
          const identity = await readIdentity();
          if (!identity || identity.context.pid !== context.pid || identity.context.sessionId !== context.sessionId || !sameRecipient(entry, identity)) throw Object.assign(new Error("The session identity changed before delivery."), { code: "QUEUED_RECIPIENT_CHANGED" });
          assertInbound(session.cwd);
        },
      });
      written = true;
      store.transition(entry, QUEUE_STATES.dispatching, { state: QUEUE_STATES.sentUnconfirmed, sentAt: now(), lastError: undefined });
      log(`queued delivery ${entry.id} sent as ${msgId}`);
    } catch (error) {
      if (written) log(`queued delivery ${entry.id} was sent as ${msgId}, but its state could not be saved: ${error?.code ?? "UNKNOWN"}`);
      else if (error?.preflight?.code) refuse(entry, error.preflight.code, error.preflight.reason);
      else if (error?.deliveryUncertain) store.transition(entry, QUEUE_STATES.dispatching, { state: QUEUE_STATES.unknown, reasonCode: error.code ?? "QUEUED_DELIVERY_UNCERTAIN", reason: "The write to the session started but did not finish. The message may have arrived, and it will not be sent again." });
      else failBeforeWrite(entry, error);
    } finally {
      releasePeer();
    }
  };

  const awaitingReply = (taskId) => store.list().some((entry) => {
    if (entry.state !== QUEUE_STATES.sentUnconfirmed || entry.recipient.taskId !== taskId || now() - entry.sentAt > REPLY_WAIT_MS) return false;
    const outcome = readOutcome(entry.sessionId, entry.recipient.cwd, entry.msgId);
    return !outcome?.reply && outcome?.status !== "interrupted";
  });

  const learnOwnTask = async () => {
    if (known) return known;
    if (now() < nextProbeAt) return null;
    const identity = await readIdentity();
    if (identity) {
      known = identity.context.taskId;
      return known;
    }
    probeMisses += 1;
    nextProbeAt = now() + Math.min(pollMs * 2 ** probeMisses, MAX_PROBE_BACKOFF_MS);
    return null;
  };

  const tick = async () => {
    store.sweep();
    if (!store.pending().length) return;
    const taskId = await learnOwnTask();
    if (!taskId || !store.pending().some((entry) => entry.recipient.taskId === taskId) || awaitingReply(taskId)) return;
    const identity = await readIdentity();
    if (!identity || identity.context.taskId !== taskId || stopped) return;
    const entry = store.pending().find((candidate) => sameRecipient(candidate, identity));
    if (!entry || !store.claim(entry.id)) return;
    try {
      const fresh = store.read(entry.id);
      if (fresh?.state === QUEUE_STATES.queued) await dispatch(fresh, identity);
    } finally {
      store.release(entry.id);
    }
  };

  const loop = async () => {
    if (stopped) return;
    if (!running) {
      running = true;
      try { await schedule(tick); }
      catch (error) { log(`queued delivery check failed: ${error.code ?? "UNKNOWN"}`); }
      finally { running = false; }
    }
    if (stopped) return;
    timer = globalThis.setTimeout(loop, pollMs);
    timer.unref?.();
  };

  return {
    tick,
    start() {
      timer = globalThis.setTimeout(loop, firstPollMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      globalThis.clearTimeout(timer);
    },
  };
}
