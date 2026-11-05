import fs from "node:fs";
import { sourceRevision } from "./release-snapshot.mjs";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./install-paths.mjs";
import { readRelayConfiguration, relayFailure, writeRelayJson } from "./background-relay-config.mjs";
import { BackgroundRelay, backgroundAdapters, serveBackgroundRelay } from "./background-relay.mjs";
import { bridgeDiagnostic } from "./recipient-preflight.mjs";
import path from "node:path";

async function startDesktopRelay({ env, statusFile }) {
  try {
    const { startDesktopRelayHost } = await import("./desktop-relay-host.mjs");
    return startDesktopRelayHost({ env,
      log: message => process.stderr.write(`[desktop-relay-host] ${message}\n`),
      onState: status => { try { writeRelayJson(statusFile, { schemaVersion: 1, ...status, at: new Date().toISOString() }); } catch {} } });
  } catch (error) {
    process.stderr.write(`[desktop-relay-host] unavailable: ${error.message}\n`);
    return null;
  }
}

export async function runBackgroundDaemon({ env = process.env, exit = code => process.exit(code) } = {}) {
  const config = readRelayConfiguration({ env });
  if (!config.enabled) throw relayFailure("WORKER_RELAY_DISABLED", "The independent background relay is disabled");
  const configuration = JSON.stringify(config);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const revision = sourceRevision(root);
  const relay = new BackgroundRelay({ config, env, adapters: await backgroundAdapters() });
  let transport;
  try { transport = await serveBackgroundRelay(relay); }
  catch (error) {
    if (error.code === "EADDRINUSE") throw relayFailure("WORKER_RELAY_ALREADY_RUNNING", "A relay already owns this endpoint; another daemon was not started");
    throw error;
  }
  try { await relay.initialize(); }
  catch (error) { await transport.close(); throw error; }
  const desktopRelay = await startDesktopRelay({ env, statusFile: path.join(config.paths.root, "desktop-relay-host.json") });
  let stopping = false;
  let requestedExit = null;
  const stop = async code => {
    if (stopping) return;
    stopping = true;
    clearInterval(poll);
    clearInterval(health);
    await transport.close();
    await desktopRelay?.stop().catch(error => process.stderr.write(`native relay host shutdown failed: ${error.message}\n`));
    exit(code);
  };
  const requestStop = code => { requestedExit = code; relay.accepting = false; };
  const poll = setInterval(() => {
    if (stopping) return;
    try {
      if (requestedExit === null && (sourceRevision(root) !== revision || JSON.stringify(readRelayConfiguration({ env })) !== configuration)) requestStop(75);
      if (!relay.accepting && requestedExit === null) requestedExit = 75;
      if (requestedExit !== null && relay.active.size === 0) void stop(requestedExit);
    } catch (error) {
      const diagnostic = bridgeDiagnostic(error, { component: "background-relay", operation: "watch_update", readOnly: true });
      try { writeRelayJson(path.join(config.paths.root, "last-service-error.json"), diagnostic); } catch {}
    }
  }, 2000);
  const health = setInterval(() => { void relay.refreshHealth(); }, 60000);
  process.once("SIGTERM", () => requestStop(0));
  process.once("SIGINT", () => requestStop(0));
  process.stdout.write(JSON.stringify({ event: "relay_ready", pid: process.pid, version: JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, desktopRequired: false }) + "\n");
  return { relay, transport, stop: () => requestStop(0) };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  runBackgroundDaemon().catch(error => {
    const diagnostic = bridgeDiagnostic(error, { component: "background-relay", operation: "startup" });
    process.stderr.write(JSON.stringify({ diagnostic }) + "\n");
    process.exitCode = 1;
  });
}
