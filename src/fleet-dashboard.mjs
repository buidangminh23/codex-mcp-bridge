import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { readRegularConfigFile } from "./project-policy.mjs";
import { relayPaths, privateRelayDirectory, writeRelayJson } from "./background-relay-config.mjs";
import { assertPrivateRelayFile } from "./background-relay-storage.mjs";
import { readRemoteProfile } from "./remote-codex.mjs";
import { createFleetQueue } from "./fleet-queue.mjs";
import { createFleetHostClient, fleetSshArgs } from "./fleet-host.mjs";
import { attachFleetScreens } from "./fleet-screen.mjs";

const ui = fileURLToPath(new URL("./fleet-ui/", import.meta.url));
const vendor = path.resolve(path.dirname(fileURLToPath(import.meta.resolve("@novnc/novnc"))), "..");
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function fleetOptions(args) {
  const { values } = parseArgs({ args, options: {
    host: { type: "string", multiple: true }, config: { type: "string" }, cwd: { type: "string" },
    port: { type: "string" }, "min-free-gib": { type: "string" }, "no-open": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) return { help: true };
  const cwd = fs.realpathSync.native(values.cwd ?? process.cwd());
  const remotes = (values.host ?? []).map(id => {
    const profile = readRemoteProfile(id);
    if (fs.realpathSync.native(profile.localCwd) !== cwd) throw fail("The SSH profile belongs to a different local project");
    const runtime = path.posix.basename(profile.receiver) === "remote-codex-receiver.mjs" && path.posix.basename(path.posix.dirname(profile.receiver)) === "src"
      ? { node: profile.node, cli: path.posix.resolve(path.posix.dirname(profile.receiver), "../scripts/worker-relay.mjs") } : undefined;
    return { id, sshHost: profile.sshHost, cwd: profile.remoteCwd, platform: profile.remoteCwd.startsWith("/Users/") ? "darwin" : "linux", runtime };
  });
  if (values.config) {
    const config = JSON.parse(readRegularConfigFile(path.resolve(values.config), { maxBytes: 65536 }));
    if (config.version !== 1 || !Array.isArray(config.hosts)) throw fail("Fleet configuration needs version 1 and a hosts array");
    for (const host of config.hosts) {
      if (host?.runtime !== undefined) throw fail("Custom host mappings use the installed worker-relay command");
      remotes.push(host);
    }
  }
  const hosts = [{ id: "local", cwd, platform: process.platform }];
  const ids = new Set(["auto", "local"]);
  const aliases = new Set();
  for (const host of remotes) {
    if (!host || !idPattern.test(host.id) || ids.has(host.id) || !["darwin", "linux", "win32"].includes(host.platform)
      || typeof host.cwd !== "string" || /[\r\n\0]/.test(host.cwd)
      || !(host.platform === "win32" ? path.win32 : path.posix).isAbsolute(host.cwd)) throw fail("Invalid or duplicate fleet host mapping");
    fleetSshArgs(host);
    const alias = host.sshHost.toLowerCase();
    if (aliases.has(alias)) throw fail("Duplicate SSH host");
    ids.add(host.id); aliases.add(alias);
    hosts.push({ id: host.id, cwd: host.cwd, platform: host.platform, sshHost: host.sshHost, runtime: host.runtime });
  }
  const minFreeBytes = Math.round(Number(values["min-free-gib"] ?? 2) * 1024 ** 3);
  const port = Number(values.port ?? 47321);
  if (hosts.length > 32 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw fail("Choose up to 32 machines, a positive RAM floor and a valid TCP port");
  }
  return { cwd, hosts, port, minFreeBytes, open: !values["no-open"] };
}

async function readBody(request) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw fail("Expected application/json", 415);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 768 * 1024) throw fail("Request is too large", 413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {}
  throw fail("Expected a JSON object");
}

export function createFleetServer({ hosts, queue, client, token, desktopConnect, health = () => null, refresh }) {
  const auth = Buffer.from("Bearer " + token);
  const origin = () => "http://127.0.0.1:" + server.address().port;
  const server = http.createServer(async (request, response) => {
    const json = (code, value) => {
      response.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:${server.address().port}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    try {
      if ("http://" + request.headers.host !== origin() || request.headers.origin && request.headers.origin !== origin()) throw fail("Untrusted browser origin", 403);
      const pathname = new URL(request.url, origin()).pathname;
      const challenge = /^\/session-check\/([a-f0-9]{64})$/.exec(pathname);
      if (request.method === "GET" && challenge) return json(200, { proof: createHmac("sha256", token).update(challenge[1]).digest("hex") });
      if (!pathname.startsWith("/api/")) {
        let file;
        if (pathname === "/") file = path.join(ui, "index.html");
        else if (/^\/(?:app\.js|style\.css|screen\.(?:js|html))$/.test(pathname)) file = path.join(ui, pathname.slice(1));
        else if (/^\/icons\/[a-z0-9-]+\.svg$/.test(pathname)) file = path.join(ui, pathname.slice(1));
        else if (/^\/novnc\/(?:core|vendor)\/(?:[\w-]+\/)*[\w.-]+\.js$/.test(pathname)) file = path.join(vendor, pathname.slice(7));
        if (request.method !== "GET" || !file || !fs.existsSync(file)) throw fail("Page not found", 404);
        response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" })[path.extname(file)] + "; charset=utf-8");
        response.end(await fs.promises.readFile(file));
        return;
      }
      const provided = Buffer.from(request.headers.authorization ?? "");
      if (auth.length !== provided.length || !timingSafeEqual(auth, provided)) throw fail("Mở lại liên kết đăng nhập từ máy điều phối.", 401);
      if (request.method === "GET" && pathname === "/api/state") return json(200, { ...queue.snapshot(), error: health() });
      if (request.method !== "POST" || request.headers.origin !== origin()) throw fail("Expected same-origin POST", 403);
      const body = await readBody(request);
      if (pathname === "/api/refresh") {
        await (refresh ? refresh() : queue.tick());
        return json(200, { ...queue.snapshot(), error: health() });
      }
      if (pathname === "/api/settings/memory") return json(200, queue.setMemoryFloor(body.minFreeGiB));
      if (pathname === "/api/jobs") return json(201, queue.submit(body));
      if (pathname === "/api/jobs/prune") return json(200, queue.prune());
      const job = /^\/api\/jobs\/([\da-f-]+)\/(cancel|target|delete)$/.exec(pathname);
      if (job) {
        if (job[2] === "cancel") return json(200, queue.cancel(job[1]));
        if (job[2] === "delete") return json(200, queue.remove(job[1]));
        return json(200, queue.retarget(job[1], body.target));
      }
      const target = /^\/api\/hosts\/([\w-]+)\/(sessions|windows|screen|rdp)$/.exec(pathname);
      const host = target && hosts.find(item => item.id === target[1]);
      if (!host) throw fail("Unknown endpoint or machine", 404);
      if (target[2] === "sessions") return json(200, await client.sessions(host));
      if (target[2] === "windows") return json(200, await client.windows(host));
      if (!host.sshHost) throw fail("Choose a remote machine");
      if (target[2] === "rdp" && host.platform !== "win32") throw fail("RDP is available for Windows machines");
      return json(200, target[2] === "rdp" ? await screens.rdp(host) : screens.issue(host));
    } catch (error) {
      json(error.statusCode ?? 503, { error: error.message });
    }
  });
  const screens = attachFleetScreens(server, { origin, connect: desktopConnect });
  return { server, origin, close: () => { screens.close(); server.close(); } };
}

function launchBrowser(url) {
  const [tool, args, options] = process.platform === "win32"
    ? [path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:FLEET_OPEN_URL"],
      { env: { ...process.env, FLEET_OPEN_URL: url } }]
    : ["/bin/sh", ["-c", process.platform === "darwin" ? 'exec open "$FLEET_OPEN_URL"' : 'exec xdg-open "$FLEET_OPEN_URL"'],
      { env: { ...process.env, FLEET_OPEN_URL: url } }];
  const child = spawn(tool, args, { stdio: "ignore", detached: true, windowsHide: true, ...options });
  child.on("error", () => process.stderr.write("Use the local sign-in link printed in this terminal.\n"));
  child.unref();
}

export async function runFleetDashboard(args) {
  const settings = fleetOptions(args);
  if (settings.help) {
    process.stdout.write("worker-relay dashboard [--cwd <project>] [--host <profile>]... [--config <file>] [--min-free-gib 2] [--port 47321] [--no-open]\n");
    return;
  }
  if (process.env.AGENT_RELAY_TOKEN || process.env.AGENT_RELAY_WORKER_ID || process.env.AGENT_RELAY_ENDPOINT) throw fail("Launch the dashboard as the local operator");
  const { DatabaseSync } = await import("node:sqlite");
  const { cwd, hosts, port, minFreeBytes } = settings;
  const project = createHash("sha256").update(process.platform === "win32" ? cwd.toLowerCase() : cwd).digest("hex");
  const directory = path.join(relayPaths().root, "fleet", project);
  privateRelayDirectory(directory);
  const sessionFile = path.join(directory, "dashboard.json");
  const optionsHash = createHash("sha256").update(JSON.stringify([hosts, port, minFreeBytes])).digest("hex");
  const lock = new DatabaseSync(path.join(directory, "owner.db"));
  try { lock.exec("BEGIN EXCLUSIVE"); }
  catch {
    lock.close();
    assertPrivateRelayFile(sessionFile);
    const saved = JSON.parse(readRegularConfigFile(sessionFile));
    if (saved.optionsHash !== optionsHash || !/^[\w-]{43}$/.test(saved.token)) throw fail("A dashboard is already running for this project with different settings.");
    const nonce = randomBytes(32).toString("hex");
    const origin = "http://127.0.0.1:" + port;
    const result = await fetch(origin + "/session-check/" + nonce, { redirect: "error", signal: AbortSignal.timeout(3000) });
    if ((await result.json()).proof !== createHmac("sha256", saved.token).update(nonce).digest("hex")) throw fail("Could not verify the running dashboard");
    const url = origin + "/#session=" + saved.token;
    if (settings.open) launchBrowser(url);
    else process.stdout.write("Fleet dashboard sign-in (private): " + url + "\n");
    return;
  }
  const db = new DatabaseSync(path.join(directory, "queue.db"));
  let timer, app;
  try {
    db.exec("CREATE TABLE IF NOT EXISTS fleet_state (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)");
    const load = () => JSON.parse(db.prepare("SELECT state FROM fleet_state WHERE id=1").get()?.state ?? "null");
    const save = state => db.prepare("INSERT OR REPLACE INTO fleet_state VALUES (1,?)").run(JSON.stringify(state));
    const client = createFleetHostClient({ hosts, cwd });
    const queue = createFleetQueue({ hosts, client, load, save, minFreeBytes });
    const token = randomBytes(32).toString("base64url");
    let error = null;
    let activeTick;
    const tick = () => {
      activeTick = queue.tick().then(() => { error = null; }, failure => { error = failure.message; });
      return activeTick;
    };
    app = createFleetServer({ hosts, client, queue, token, health: () => error, refresh: tick });
    await new Promise((resolve, reject) => app.server.once("error", reject).listen(port, "127.0.0.1", resolve));
    writeRelayJson(sessionFile, { token, optionsHash });
    const url = app.origin() + "/#session=" + token;
    if (settings.open) launchBrowser(url);
    else process.stdout.write("Fleet dashboard sign-in (private): " + url + "\n");
    void tick();
    timer = setInterval(tick, 10000);
    const close = () => { clearInterval(timer); app.close(); };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    await new Promise(resolve => app.server.once("close", resolve));
    clearInterval(timer);
    await activeTick;
    process.off("SIGTERM", close);
    process.off("SIGINT", close);
  } finally {
    clearInterval(timer);
    if (app?.server.listening) app.close();
    db.close(); lock.close();
  }
}
