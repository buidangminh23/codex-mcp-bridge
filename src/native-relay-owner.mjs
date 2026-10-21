import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RELAY_HOST_ENTRY = "native-relay-host.mjs";
export const RELAY_OWNER_ROLES = Object.freeze(["companion", "host"]);
const MAX_RECORD_BYTES = 4096;
const START_TIME_TOLERANCE_MS = 3000;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

export function relayOwnerPath(socketPath) {
  return `${socketPath}.owner`;
}

export function relayHandoffPath(socketPath) {
  return `${socketPath}.handoff`;
}

function writePrivateRecord(file, record, pid) {
  const temporary = `${file}.${pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  return file;
}

function readPrivateRecord(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function writeRelayOwner(socketPath, role, { pid = process.pid, entry = process.argv[1], startedAt = PROCESS_STARTED_AT } = {}) {
  if (!RELAY_OWNER_ROLES.includes(role)) throw new Error("Invalid native relay owner role");
  return writePrivateRecord(relayOwnerPath(socketPath), { pid, role, socketPath, entry: entry ? path.resolve(entry) : null, startedAt }, pid);
}

export function readRelayOwner(socketPath) {
  const owner = readPrivateRecord(relayOwnerPath(socketPath));
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !RELAY_OWNER_ROLES.includes(owner.role) || owner.socketPath !== socketPath) return null;
  return {
    pid: owner.pid,
    role: owner.role,
    entry: typeof owner.entry === "string" ? owner.entry : null,
    startedAt: Number.isSafeInteger(owner.startedAt) ? owner.startedAt : null,
  };
}

export function removeRelayOwner(socketPath, { pid = process.pid } = {}) {
  if (readRelayOwner(socketPath)?.pid !== pid) return false;
  try { fs.rmSync(relayOwnerPath(socketPath), { force: true }); return true; } catch { return false; }
}

export function markHandoffReady(socketPath, { pid = process.pid } = {}) {
  try { writePrivateRecord(relayHandoffPath(socketPath), { pid, socketPath }, pid); return true; } catch { return false; }
}

export function handoffReady(socketPath, pid) {
  const record = readPrivateRecord(relayHandoffPath(socketPath));
  return record?.pid === pid && record.socketPath === socketPath;
}

export function clearHandoffReady(socketPath, { pid = process.pid } = {}) {
  if (!handoffReady(socketPath, pid)) return false;
  try { fs.rmSync(relayHandoffPath(socketPath), { force: true }); return true; } catch { return false; }
}

export async function waitForHandoffReady(socketPaths, pid, { timeoutMs = 5000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return false;
    if (socketPaths.every((socketPath) => handoffReady(socketPath, pid))) return true;
    await new Promise((resolve) => globalThis.setTimeout(resolve, pollMs));
  }
  return false;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function readProcessIdentity(pid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "args="], {
    timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  const line = stdout.replace(/\n+$/, "");
  const startedAt = Date.parse(line.slice(0, 24));
  return { startedAt: Number.isFinite(startedAt) ? startedAt : null, args: line.slice(24).trim() };
}

export async function isRelayHostProcess(owner, { readIdentity = readProcessIdentity } = {}) {
  const pid = owner?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !processAlive(pid)) return false;
  if (typeof owner.entry !== "string" || path.basename(owner.entry) !== RELAY_HOST_ENTRY || !Number.isSafeInteger(owner.startedAt)) return false;
  try {
    const identity = await readIdentity(pid);
    return identity.args.includes(owner.entry) && identity.startedAt !== null
      && Math.abs(identity.startedAt - owner.startedAt) <= START_TIME_TOLERANCE_MS;
  } catch { return false; }
}

export async function evictRelayHost(socketPath, {
  isLive,
  readIdentity,
  signal = (pid) => process.kill(pid, "SIGTERM"),
  waitMs = 8000,
  pollMs = 50,
} = {}) {
  const owner = readRelayOwner(socketPath);
  if (owner?.role !== "host" || !await isRelayHostProcess(owner, { readIdentity })) return false;
  try { signal(owner.pid); } catch { return false; }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!await isLive()) return true;
    await new Promise((resolve) => globalThis.setTimeout(resolve, pollMs));
  }
  return !await isLive();
}

export function nativePipeReachable(pipePath, { timeoutMs = 1000 } = {}) {
  if (typeof pipePath !== "string" || !pipePath) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = net.connect({ path: pipePath });
    const done = (answer) => {
      globalThis.clearTimeout(timer);
      probe.destroy();
      resolve(answer);
    };
    const timer = globalThis.setTimeout(() => done(false), timeoutMs);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

export function relayHostEntry() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), RELAY_HOST_ENTRY);
}

export function spawnRelayHost({ pipePath, env = process.env, execPath = process.execPath, entry = relayHostEntry(), spawnProcess = spawn } = {}) {
  if (typeof pipePath !== "string" || !path.isAbsolute(pipePath)) throw new Error("A native relay host needs the absolute Codex Desktop pipe path");
  const child = spawnProcess(execPath, [entry], {
    detached: true,
    stdio: "ignore",
    cwd: path.dirname(entry),
    env: { ...env, CODEX_APP_TOOLS_PIPE_PATH: pipePath },
  });
  child.on?.("error", () => {});
  child.unref?.();
  return child.pid;
}
