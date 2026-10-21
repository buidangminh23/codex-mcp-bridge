import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RELAY_HOST_ENTRY = "native-relay-host.mjs";
export const RELAY_OWNER_ROLES = Object.freeze(["companion", "host"]);
const MAX_OWNER_BYTES = 4096;

export function relayOwnerPath(socketPath) {
  return `${socketPath}.owner`;
}

export function writeRelayOwner(socketPath, role, { pid = process.pid } = {}) {
  if (!RELAY_OWNER_ROLES.includes(role)) throw new Error("Invalid native relay owner role");
  const file = relayOwnerPath(socketPath);
  const temporary = `${file}.${pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ pid, role, socketPath })}\n`, { mode: 0o600, flag: "w" });
  fs.renameSync(temporary, file);
  return file;
}

export function readRelayOwner(socketPath) {
  const file = relayOwnerPath(socketPath);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_OWNER_BYTES) return null;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || !RELAY_OWNER_ROLES.includes(owner.role) || owner.socketPath !== socketPath) return null;
    return { pid: owner.pid, role: owner.role };
  } catch { return null; }
}

export function removeRelayOwner(socketPath, { pid = process.pid } = {}) {
  if (readRelayOwner(socketPath)?.pid !== pid) return false;
  try { fs.rmSync(relayOwnerPath(socketPath), { force: true }); return true; } catch { return false; }
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function readProcessArguments(pid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="], { timeout: 5000, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

export async function isRelayHostProcess(pid, { readArguments = readProcessArguments } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || !processAlive(pid)) return false;
  try {
    const args = await readArguments(pid);
    return args.split(/\s+/).some((part) => path.basename(part) === RELAY_HOST_ENTRY);
  } catch { return false; }
}

export async function evictRelayHost(socketPath, {
  isLive,
  readArguments,
  signal = (pid) => process.kill(pid, "SIGTERM"),
  waitMs = 8000,
  pollMs = 100,
} = {}) {
  const owner = readRelayOwner(socketPath);
  if (owner?.role !== "host" || !await isRelayHostProcess(owner.pid, { readArguments })) return false;
  try { signal(owner.pid); } catch { return false; }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!processAlive(owner.pid) || !await isLive()) return true;
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
