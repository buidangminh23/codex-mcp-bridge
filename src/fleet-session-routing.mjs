import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BACKGROUND_AGENTS, RELAY_UUID } from "./background-relay-config.mjs";
import { authorizedProject, fleetSshArgs } from "./fleet-host.mjs";
import { readRemoteHostsConfig, readRemoteProfile, repositoryIdentity } from "./remote-codex.mjs";
import { captureProjectScope, recheckProjectScope } from "./project-scope.mjs";
import { fail, hash, publicResult, senderIdentity, SessionReceipts, targetIdentity, terminal, validName, validText } from "./fleet-session-protocol.mjs";

export function sessionHostConfiguration(cwd) {
  const config = readRemoteHostsConfig();
  if (config?.version !== 1 || !config.hosts || typeof config.hosts !== "object" || Array.isArray(config.hosts)
    || Object.keys(config.hosts).length > 32) throw fail("CONFIG", "Configure up to 32 SSH host profiles");
  const floor = config.sessionMinFreeGiB ?? 2;
  const minFreeBytes = Math.round(floor * 1024 ** 3);
  if (typeof floor !== "number" || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 1) throw fail("CONFIG", "Invalid sessionMinFreeGiB");
  const hosts = [];
  for (const [id, entry] of Object.entries(config.hosts)) {
    if (!validName(id) || ["auto", "local"].includes(id) || !validText(entry?.localCwd, 4096) || !path.isAbsolute(entry.localCwd)) throw fail("CONFIG", "Invalid session host mapping");
    if (path.relative(cwd, path.resolve(entry.localCwd)) !== "") continue;
    let host;
    if (entry.platform) {
      const style = entry.platform === "win32" ? path.win32 : path.posix;
      if (!["win32","darwin","linux"].includes(entry.platform) || !validText(entry.remoteCwd, 4096) || !style.isAbsolute(entry.remoteCwd)
        || Object.keys(entry).some(key => !["platform","sshHost","localCwd","remoteCwd"].includes(key))) throw fail("CONFIG", "Invalid cross-platform session host mapping");
      host = { id, sshHost: entry.sshHost, cwd: entry.remoteCwd, platform: entry.platform };
    } else {
      const profile = readRemoteProfile(id);
      if (path.relative(cwd, fs.realpathSync.native(profile.localCwd)) !== "") throw fail("CONFIG", "The remote project profile changed");
      const src = path.posix.dirname(profile.receiver);
      const runtime = path.posix.basename(profile.receiver) === "remote-codex-receiver.mjs" && path.posix.basename(src) === "src"
        ? { node: profile.node, cli: path.posix.resolve(src, "../scripts/worker-relay.mjs") } : undefined;
      host = { id, sshHost: profile.sshHost, cwd: profile.remoteCwd, platform: profile.remoteCwd.startsWith("/Users/") ? "darwin" : "linux", runtime };
    }
    fleetSshArgs(host, "fleet-session-host");
    if (hosts.some(previous => previous.sshHost.toLowerCase() === host.sshHost.toLowerCase())) throw fail("CONFIG", "Duplicate session SSH host aliases");
    hosts.push(host);
  }
  return { hosts, minFreeBytes };
}

async function exchange(host, frame) {
  const args = fleetSshArgs(host, "fleet-session-host");
  const data = JSON.stringify(frame);
  if (Buffer.byteLength(data) > 256 * 1024) throw fail("INPUT", "Fleet session frame exceeds its size limit");
  const unavailable = () => fail("TRANSPORT", "SSH did not confirm this session operation. Inspect the original receipt before retrying");
  const response = await new Promise((resolve, reject) => {
    const child = execFile("ssh", args, { encoding: "utf8", shell: false, windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => error ? reject(unavailable()) : resolve(stdout));
    child.stdin.on("error", () => reject(unavailable()));
    child.stdin.end(data + "\n");
  });
  let parsed;
  try { parsed = JSON.parse(response); } catch { throw unavailable(); }
  if (parsed.version !== 1 || parsed.nonce !== frame.nonce) throw unavailable();
  if (parsed.error) {
    const error = new Error(String(parsed.error.message).slice(0, 512));
    error.code = String(parsed.error.code).slice(0, 80);
    throw error;
  }
  return parsed.result;
}

function choose(inspections, { minFreeBytes, agent, sessionId, sender }) {
  const options = [];
  for (const { host, sample } of inspections) {
    if (!Number.isSafeInteger(sample?.freeBytes) || sample.freeBytes < minFreeBytes || !Array.isArray(sample.targets) || sample.targets.length > 100) continue;
    for (const row of sample.targets) {
      if (row?.status !== "idle" || row.id === sender.id && row.agent === sender.agent
        || agent !== "auto" && row.agent !== agent || sessionId && row.id !== sessionId) continue;
      const target = targetIdentity(row);
      options.push({ host, target, freeBytes: sample.freeBytes });
    }
  }
  if (sessionId && options.length > 1) throw fail("AMBIGUOUS", "This session ID matches multiple destinations; specify the exact host and assistant");
  options.sort((a,b) => b.freeBytes - a.freeBytes || a.host.id.localeCompare(b.host.id) || a.target.agent.localeCompare(b.target.agent) || a.target.id.localeCompare(b.target.id));
  if (!options.length) {
    const gib = bytes => (bytes / 1024 ** 3).toFixed(2);
    const details = inspections.map(({ host, sample }) => {
      const count = Array.isArray(sample?.targets) ? sample.targets.filter(row => row?.status === "idle" && (agent === "auto" || agent === row.agent)
        && (!sessionId || row.id === sessionId) && !(row.id === sender.id && row.agent === sender.agent)).length : 0;
      const available = Number.isSafeInteger(sample?.freeBytes) ? gib(sample.freeBytes) + " GiB available" : "RAM unavailable";
      return host.id + " (" + available + ", " + count + " matching idle sessions)";
    });
    throw fail("UNAVAILABLE", "No eligible session at the required " + gib(minFreeBytes) + " GiB floor: " + details.join(", "));
  }
  return options[0];
}

export function createFleetSessionRouter({ config = sessionHostConfiguration, authorize = authorizedProject, identify = repositoryIdentity,
  capture = captureProjectScope, recheck = recheckProjectScope, contact = exchange, receipts = () => new SessionReceipts("source"), env = process.env } = {}) {
  async function run(action, { sender: raw, checkSender, requestId, prompt, host = "auto", agent = "auto", sessionId }) {
    if (env.AGENT_RELAY_TOKEN || env.AGENT_RELAY_WORKER_ID || env.AGENT_RELAY_ENDPOINT) throw fail("SENDER", "A scoped background worker cannot dispatch from a native session");
    const sender = senderIdentity(raw);
    if (typeof checkSender !== "function" || !RELAY_UUID.test(requestId ?? "") || !validName(host) || agent !== "auto" && !BACKGROUND_AGENTS.includes(agent)
      || sessionId !== undefined && !RELAY_UUID.test(sessionId) || action === "send" && (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 128 * 1024)) throw fail("INPUT", "Invalid session delivery parameters");
    await checkSender();
    const cwd = authorize(sender.cwd);
    const repository = identify(cwd);
    const scope = capture(cwd, cwd);
    const owner = hash([sender, repository]);
    const digest = action === "send" ? hash([owner, prompt, host, agent, sessionId ?? null]) : undefined;
    const check = async route => {
      await checkSender();
      recheck(scope);
      if (authorize(sender.cwd) !== cwd || identify(cwd) !== repository) throw fail("PROJECT", "The sending project changed during this delivery");
      if (route && !config(cwd).hosts.some(h => hash(h) === hash(route.host))) throw fail("CONFIG", "The original destination host profile changed");
    };
    const store = receipts();
    try {
      let row = store.get(requestId, owner, digest);
      let dispatch = false;
      if (!row) {
        if (action !== "send") throw fail("MISSING", "No session receipt exists for this caller and request ID");
        const settings = config(cwd);
        const hosts = settings.hosts.filter(h => host === "auto" || h.id === host);
        if (!hosts.length) throw fail("CONFIG", "No configured SSH host matches this project and host selection");
        const samples = await Promise.allSettled(hosts.map(async h => ({ host: h, sample: await contact(h, { version: 1, nonce: randomUUID(), action: "inspect", cwd: h.cwd, repository, sender }) })));
        const viable = samples.flatMap(s => s.status === "fulfilled" ? [s.value] : []);
        if (!viable.length) throw fail("INSPECTION", "Could not inspect configured session hosts: " + samples.map((s,i) => hosts[i].id + " (" + (s.reason?.code ?? "unavailable") + ")").join(", "));
        const choice = choose(viable, { minFreeBytes: settings.minFreeBytes, agent, sessionId, sender });
        const route = { host: choice.host, target: choice.target, minFreeBytes: settings.minFreeBytes };
        await check(route);
        dispatch = store.reserve(requestId, owner, digest, route);
        row = store.get(requestId, owner, digest);
      }
      const route = row.route;
      await check(route);
      if (terminal(row.state)) return publicResult(requestId, route.target, route.host.id, row.result);
      const frame = { version: 1, nonce: randomUUID(), action: dispatch ? "send" : "read", cwd: route.host.cwd, repository,
        sender, target: route.target, requestId, ...(dispatch ? { prompt, minFreeBytes: Math.max(route.minFreeBytes, config(cwd).minFreeBytes) } : {}) };
      let result;
      try { result = await contact(route.host, frame); }
      catch (error) {
        await check(route);
        const declined = dispatch && ["FLEET_SESSION_BUSY", "FLEET_SESSION_MEMORY"].includes(error.code);
        const reply = publicResult(requestId, route.target, route.host.id, { status: declined ? "failed" : "uncertain", output: String(error.message).slice(0,512) });
        if (declined) store.update(requestId, reply.status, reply);
        return reply;
      }
      await check(route);
      if (result?.requestId !== requestId || result.target?.agent !== route.target.agent || result.target?.id !== route.target.id) throw fail("RECEIPT", "The destination returned a different session receipt");
      const reply = publicResult(requestId, route.target, route.host.id, result);
      store.update(requestId, reply.status, reply);
      return publicResult(requestId, route.target, route.host.id, store.get(requestId, owner).result);
    } finally { store.close(); }
  }
  return { send: input => run("send", input), read: input => run("read", input) };
}

export const sendFleetSession = input => createFleetSessionRouter().send(input);
export const readFleetSession = input => createFleetSessionRouter().read(input);
