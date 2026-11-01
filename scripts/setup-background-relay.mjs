#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/install-paths.mjs";
import { backgroundAdapters } from "../src/background-relay.mjs";
import { BACKGROUND_AGENTS, canStartBackgroundWorker, configureRelay, readRelayConfiguration, relayFailure } from "../src/background-relay-config.mjs";
import { configureBackgroundWorkerMcp } from "../src/background-relay-registration.mjs";
import { installBackgroundRelay } from "./install-background-relay.mjs";
import { diagnosticText, withBridgeDiagnostic } from "../src/recipient-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function setupBackgroundRelay({ env = process.env, platform = process.platform, root = ROOT, check = false, dryRun = false,
  adapters, readConfig = readRelayConfiguration, configure = configureRelay, registration = configureBackgroundWorkerMcp, service = installBackgroundRelay } = {}) {
  if (dryRun) return { configured: false, dryRun: true, liveVerified: false,
    planned: ["Independent relay configuration", "Scoped worker MCP communication", "Per-user background service"], opensApps: false, opensChats: false };
  const workers = adapters ?? await backgroundAdapters();
  const saved = readConfig({ env, platform, missing: true });
  const readiness = await Promise.all(BACKGROUND_AGENTS.map(async agent => {
    try { return { agent, ...await workers[agent].inspect({ env, platform, executable: saved?.providers[agent]?.executable ?? undefined }) }; }
    catch (error) { return { agent, available: false, authenticated: null, ready: false, code: error.code ?? "WORKER_INSPECTION_FAILED" }; }
  }));
  const config = check ? saved
    : configure({ env, platform });
  if (!config) throw relayFailure("WORKER_RELAY_NOT_CONFIGURED", "The independent relay has not been configured; rerun the package setup command");
  const mcp = registration({ env, platform, root, check });
  const installed = await service({ env, platform, root, check });
  const notices = [
    "Background tasks have separate CLI identities and receipts; they never resume Desktop chats.",
    ...(!fs.existsSync(config.projectPolicy) ? ["No shared project policy is saved yet. Explicitly authorize a selected project with bridge-projects allow-project before sending background work."] : []),
    ...(mcp.blocked ? [mcp.reason ?? "An existing permission or disabled-server choice blocks worker MCP communication; that choice was preserved."] : []),
    ...readiness.filter(item => !item.available || item.authenticated === false).map(item => `${item.agent}: ${item.code ?? "WORKER_NOT_READY"}; CLI authentication and installation remain separate from Desktop sign-in.`),
    ...(installed.code ? [diagnosticText(`${installed.code}: ${installed.notice ?? installed.reason ?? "Inspect worker-relay status for service readiness."}`)]
      : installed.notice ? [diagnosticText(installed.notice)] : []),
  ];
  return { configured: mcp.configured === true && installed.configured === true, enabled: config.enabled,
    liveVerified: installed.liveVerified === true, transportReady: installed.ready === true,
    desktopRequired: false, opensApps: false, opensChats: false, notices,
    workerReadiness: readiness.map(({ agent, available, authenticated, ready, version, code }) => ({ agent, available, authenticated, ready, version, code,
      canAcceptWork: config.enabled && config.providers[agent].enabled && canStartBackgroundWorker(agent, { available, authenticated, ready, code }) })),
    permissions: { blocked: mcp.blocked === true, ...(mcp.code ? { code: mcp.code } : {}) },
    service: { configured: installed.configured, started: installed.started, activationPending: installed.activationPending, code: installed.code, version: installed.version } };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.some(arg => !["--check", "--dry-run", "--json"].includes(arg))) throw relayFailure("WORKER_SETUP_ARGUMENT_INVALID", "Unsupported background relay setup argument");
    const result = await setupBackgroundRelay({ check: args.includes("--check"), dryRun: args.includes("--dry-run") });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.configured && !result.dryRun) process.exitCode = 1;
  } catch (error) {
    const result = withBridgeDiagnostic({ isError: true, content: [] }, error, { component: "background-relay", operation: "setup" });
    process.stderr.write(result.content.map(item => item.text ?? "").join("\n") + "\n");
    process.exitCode = 1;
  }
}
