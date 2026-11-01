import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { setupBackgroundRelay } from "../scripts/setup-background-relay.mjs";

const AGENTS = ["codex", "claude", "antigravity"];
const SECRET = "private-inspection-credential";
const root = path.resolve(import.meta.dirname, "..");

function fixture(overrides = {}) {
  const calls = [];
  const config = { enabled: true, projectPolicy: path.join(root, "package.json"),
    providers: Object.fromEntries(AGENTS.map((agent) => [agent, { enabled: true, executable: path.join(root, "custom-clis", `${agent}.exe`) }])) };
  const state = { saved: config, registration: { configured: true, blocked: false },
    service: { configured: true, enabled: true, liveVerified: true, ready: true, started: false, activationPending: false, version: "1.26.0" } };
  const env = { AGENT_RELAY_DIRECTORY: path.join(root, "fixture-not-created"), AGENT_RELAY_TOKEN: SECRET };
  const adapters = Object.fromEntries(AGENTS.map((agent) => [agent, {
    inspect: async (options) => {
      calls.push({ type: "inspect", agent, options });
      return { agent, available: true, authenticated: true, ready: true, executable: options.executable ?? path.join(root, `${agent}.exe`), version: "1.0.0", reason: SECRET };
    },
    run: () => assert.fail("Setup must never dispatch a model job"),
  }]));
  const options = {
    env, root, platform: "win32", adapters,
    readConfig: (options) => { calls.push({ type: "readConfig", options }); return state.saved; },
    configure: (options) => { calls.push({ type: "configure", options }); return config; },
    registration: (options) => { calls.push({ type: "registration", options }); return state.registration; },
    service: async (options) => { calls.push({ type: "service", options }); return state.service; },
    ...overrides,
  };
  return { calls, config, state, env, adapters, options, setup: (extra = {}) => setupBackgroundRelay({ ...options, ...extra }) };
}

test("dry-run does not inspect workers, read credentials, register MCP or start a service", async () => {
  const f = fixture();
  const result = await f.setup({ dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.liveVerified, false);
  assert.equal(result.opensApps, false);
  assert.equal(result.opensChats, false);
  assert.equal(result.planned.length, 3);
  assert.deepEqual(f.calls, []);
});

test("setup inspects only CLI adapters before configuring scoped communication and the independent service", async () => {
  const f = fixture();
  const result = await f.setup();
  assert.deepEqual(f.calls.map(({ type }) => type), ["readConfig", "inspect", "inspect", "inspect", "configure", "registration", "service"]);
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, true);
  assert.equal(result.transportReady, true);
  assert.equal(result.desktopRequired, false);
  assert.equal(result.opensApps, false);
  assert.equal(result.opensChats, false);
  assert.equal(result.service.version, "1.26.0");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(JSON.stringify(result).includes("custom-clis"), false);
  for (const call of f.calls.filter(({ type }) => type === "registration" || type === "service")) {
    assert.equal(call.options.root, root);
    assert.equal(call.options.env, f.env);
    assert.equal(call.options.check, false);
  }
});

test("saved custom worker executables reach inspections and survive a package setup", async () => {
  const f = fixture();
  await f.setup();
  for (const call of f.calls.filter(({ type }) => type === "inspect")) assert.equal(call.options.executable, f.config.providers[call.agent].executable);
  const configured = f.calls.find(({ type }) => type === "configure").options;
  assert.equal(configured.providers, undefined);
  assert.equal(f.calls.filter(({ type }) => type === "readConfig").length, 1);
});

test("check uses the saved configuration and never invokes the configuration writer", async () => {
  const f = fixture({ configure: () => assert.fail("check must not write configuration") });
  const result = await f.setup({ check: true });
  assert.equal(result.configured, true);
  assert.equal(f.calls.filter(({ type }) => type === "readConfig").length, 1);
  for (const call of f.calls.filter(({ type }) => type === "registration" || type === "service")) assert.equal(call.options.check, true);
});

test("missing check configuration stops before MCP registration or service installation", async () => {
  const f = fixture();
  f.state.saved = null;
  await assert.rejects(f.setup({ check: true }), { code: "WORKER_RELAY_NOT_CONFIGURED" });
  assert.equal(f.calls.some(({ type }) => ["configure", "registration", "service"].includes(type)), false);
});

test("a missing or signed-out CLI does not prevent the relay service from being configured", async () => {
  const f = fixture();
  f.adapters.claude.inspect = async () => { throw Object.assign(new Error(SECRET), { code: "CLI_UNAVAILABLE" }); };
  f.adapters.antigravity.inspect = async () => ({ agent: "antigravity", available: true, authenticated: false, ready: false,
    code: "AUTH_REQUIRED", executable: f.config.providers.antigravity.executable, reason: SECRET });
  const result = await f.setup();
  assert.equal(result.configured, true);
  assert.equal(result.transportReady, true);
  assert.equal(result.workerReadiness.find(({ agent }) => agent === "claude").code, "CLI_UNAVAILABLE");
  assert.equal(result.workerReadiness.find(({ agent }) => agent === "antigravity").authenticated, false);
  assert.ok(result.notices.some((notice) => notice.includes("claude: CLI_UNAVAILABLE")));
  assert.ok(result.notices.some((notice) => notice.includes("antigravity: AUTH_REQUIRED")));
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(f.calls.find(({ type }) => type === "configure").options.providers, undefined);
});

test("setup keeps automatic CLI discovery instead of pinning a versioned executable path", async () => {
  const f = fixture();
  f.state.saved = null;
  await f.setup();
  for (const call of f.calls.filter(({ type }) => type === "inspect")) assert.equal(call.options.executable, undefined);
  assert.equal(f.calls.find(({ type }) => type === "configure").options.providers, undefined);
});

test("disabled configuration and existing permission restrictions are reported without enabling them", async () => {
  const f = fixture();
  f.config.enabled = false;
  f.state.registration = { configured: true, blocked: true, code: "WORKER_MCP_DISABLED", reason: "The saved worker connector is disabled" };
  f.state.service = { configured: true, enabled: false, liveVerified: false, ready: false, started: false, notice: "Background relay is intentionally disabled" };
  const result = await f.setup();
  assert.equal(result.configured, true);
  assert.equal(result.enabled, false);
  assert.equal(result.liveVerified, false);
  assert.equal(result.transportReady, false);
  assert.equal(result.permissions.blocked, true);
  assert.equal(result.permissions.code, "WORKER_MCP_DISABLED");
  assert.ok(result.notices.some((notice) => notice.includes("intentionally disabled")));
  assert.ok(result.notices.some((notice) => notice.includes("connector is disabled")));
});

test("pending service updates preserve the loaded version and do not claim live activation", async () => {
  const f = fixture();
  f.state.service = { configured: true, liveVerified: false, ready: false, started: false, activationPending: true,
    code: "SERVICE_UPDATE_PENDING", version: "1.25.3" };
  const result = await f.setup();
  assert.equal(result.configured, true);
  assert.equal(result.liveVerified, false);
  assert.equal(result.transportReady, false);
  assert.equal(result.service.activationPending, true);
  assert.equal(result.service.code, "SERVICE_UPDATE_PENDING");
  assert.equal(result.service.version, "1.25.3");
});

test("service and MCP configuration failures remain distinct and do not become readiness success", async () => {
  const service = fixture();
  service.state.service = { configured: false, liveVerified: false, ready: false, started: false, code: "TASK_SCHEDULER_UNAVAILABLE" };
  const failedService = await service.setup();
  assert.equal(failedService.configured, false);
  assert.equal(failedService.liveVerified, false);
  assert.equal(failedService.service.code, "TASK_SCHEDULER_UNAVAILABLE");
  const registration = fixture();
  registration.state.registration = { configured: false, blocked: true, code: "WORKER_MCP_CONFIG_CONFLICT" };
  const failedRegistration = await registration.setup();
  assert.equal(failedRegistration.configured, false);
  assert.equal(failedRegistration.permissions.code, "WORKER_MCP_CONFIG_CONFLICT");
});

test("missing project policy requires explicit project authorization without creating it", async () => {
  const f = fixture();
  f.config.projectPolicy = path.join(root, "missing-fixture-policy-that-setup-must-not-create.json");
  const result = await f.setup();
  assert.ok(result.notices.some((notice) => notice.includes("bridge-projects allow-project")));
  assert.equal(result.configured, true);
  assert.equal(result.opensApps, false);
  assert.equal(result.opensChats, false);
});
