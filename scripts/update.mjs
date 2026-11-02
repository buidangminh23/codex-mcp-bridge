#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installBackgroundRelay } from "./install-background-relay.mjs";
import { readRelayConfiguration } from "../src/background-relay-config.mjs";
import { readRelayServiceRuntime, RELAY_SERVICE_OWNER } from "../src/background-relay-service.mjs";
import { assertPrivateRelayFile } from "../src/background-relay-storage.mjs";
import { isMainModule } from "../src/install-paths.mjs";
import { readRegularConfigFile } from "../src/project-policy.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { bridgeDiagnostic, withBridgeDiagnostic } from "../src/recipient-preflight.mjs";

const PACKAGE = "@minhspark/codex-mcp-bridge";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANAGED_ENV = new Set(["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]);
const RETRY = "Run the same codex-bridge-update command again after inspecting this report. Existing work and receipts were preserved.";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function failure(code, message, phase, cause) {
  return Object.assign(new Error(message), { code, phase, deliveryState: "not_applicable", ...(cause ? { cause } : {}) });
}

function packageVersion(root, missing = false) {
  const raw = readRegularConfigFile(path.join(root, "package.json"), { missing, maxBytes: 128 * 1024 });
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch {}
  if (value?.name !== PACKAGE || typeof value.version !== "string" || value.version.length > 96 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(value.version)) {
    throw failure("UPDATE_PACKAGE_INVALID", "The bridge package identity or version could not be verified.", "preflight");
  }
  return value.version;
}

function newerVersion(left, right) {
  const split = value => { const [core, ...suffix] = value.split("+")[0].split("-"); return { core: core.split(".").map(BigInt), suffix: suffix.join("-") }; };
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index];
  if (!a.suffix || !b.suffix) return !a.suffix && Boolean(b.suffix);
  const parts = [a.suffix.split("."), b.suffix.split(".")];
  for (let index = 0; index < Math.max(...parts.map(part => part.length)); index++) {
    const [x, y] = parts.map(part => part[index]);
    if (x === y) continue;
    if (x === undefined || y === undefined) return y === undefined;
    const numeric = [x, y].map(value => /^\d+$/.test(value));
    return numeric.every(Boolean) ? BigInt(x) > BigInt(y) : numeric[0] !== numeric[1] ? numeric[1] : x > y;
  }
  return false;
}

export function resolveUpdateNpm(env = process.env) {
  for (const candidate of [env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]) {
    try {
      if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
      const resolved = fs.realpathSync.native(candidate);
      if (!/^(?:npm-cli|npm)\.js$/.test(path.basename(resolved)) || !fs.statSync(resolved).isFile()) continue;
      const metadata = JSON.parse(readRegularConfigFile(path.resolve(path.dirname(resolved), "..", "package.json"), { maxBytes: 128 * 1024 }));
      if (metadata.name === "npm") return resolved;
    } catch {}
  }
  throw failure("UPDATE_NPM_NOT_FOUND", "A supported npm CLI could not be located. Run this updater through npm exec.", "preflight");
}

function execute(command, args, options) {
  return new Promise(resolve => {
    execFile(command, args, options, (error, stdout, stderr) => resolve({ status: error ? 1 : 0, error, stdout, stderr }));
  });
}

function inside(directory, root) {
  const relative = path.relative(root, directory);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function neutralDirectory(roots, env) {
  for (const candidate of [os.tmpdir(), env.USERPROFILE, env.HOME, os.homedir()]) {
    try {
      if (typeof candidate !== "string" || !path.isAbsolute(candidate)) continue;
      const directory = fs.realpathSync.native(candidate);
      if (fs.statSync(directory).isDirectory() && roots.every(root => !inside(directory, root))) return directory;
    } catch {}
  }
  throw failure("UPDATE_DIRECTORY_UNAVAILABLE", "No working directory outside the package installation is available.", "preflight");
}

function childFailure(result, phase) {
  const match = /npm\s+(?:ERR!|error)\s+code\s+([A-Z][A-Z0-9_]{0,79}|\d{1,10})\b/.exec(String(result?.stderr ?? ""));
  const signal = result?.error?.signal ?? result?.signal;
  const value = match?.[1] ?? result?.error?.code ?? (signal ? null : result?.status ?? result?.exitCode);
  const timedOut = value === "ETIMEDOUT" || result?.error?.killed === true && signal === "SIGTERM";
  const code = timedOut ? "ETIMEDOUT" : /^\d{1,10}$/.test(String(value)) ? `EXIT_${value}`
    : /^[A-Z][A-Z0-9_]{0,79}$/.test(value ?? "") ? value
    : /^SIG[A-Z0-9]{1,20}$/.test(signal ?? "") ? `SIGNAL_${signal}` : null;
  const cause = code ? Object.assign(new Error("The child command reported a failure."), { code }) : undefined;
  const permissionDenied = phase === "installation" && ["EPERM", "EACCES"].includes(code);
  return failure(permissionDenied ? "UPDATE_INSTALL_PERMISSION" : code === "EBUSY" ? "UPDATE_PACKAGE_BUSY" : timedOut ? "UPDATE_COMMAND_TIMEOUT" : phase === "verification" ? "UPDATE_SETUP_INCOMPLETE" : "UPDATE_NPM_FAILED",
    permissionDenied ? "npm could not write to the installation directory. Run codex-bridge-update --user to install and configure the bridge in your user account without administrator rights. Existing work and receipts were preserved."
      : timedOut ? `The update command exceeded its deadline. ${RETRY}`
      : code === "EBUSY" ? `The installed package is still held open by another process. No process was stopped. ${RETRY}`
      : `The ${phase === "verification" ? "installed setup verification" : "npm command"} did not complete. ${RETRY}`, phase, cause);
}

function serviceQuiescent(config) {
  for (const name of ["service.lock", "service-status.json"]) {
    const file = path.join(config.paths.root, name);
    if (!assertPrivateRelayFile(file, { missing: true })) continue;
    let state;
    try { state = JSON.parse(readRegularConfigFile(file, { maxBytes: 64 * 1024 })); } catch { return false; }
    if (state?.schemaVersion !== 1 || state.owner !== RELAY_SERVICE_OWNER || !Number.isSafeInteger(state.pid) || state.pid < 1) return false;
    if (state.status === "running" && (!Number.isSafeInteger(state.daemonPid) || state.daemonPid < 1)) return false;
    for (const pid of [state.pid, state.daemonPid].filter(Number.isSafeInteger)) {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code !== "ESRCH") return false; }
    }
  }
  return true;
}

export async function runUpdate({ args = [], env = process.env, platform = process.platform, root = ROOT, run = execute,
  installService = installBackgroundRelay, readConfig = readRelayConfiguration, readRuntime = readRelayServiceRuntime,
  quiescent = serviceQuiescent, now = Date.now, sleep = pause, waitMs = 120000, onProgress = () => {} } = {}) {
  if (args.some(arg => !["--help", "--json", "--user"].includes(arg))) throw failure("UPDATE_ARGUMENT_INVALID", "Usage: codex-bridge-update [--user] [--json] [--help]", "preflight");
  if (args.includes("--help")) return { help: "Usage: codex-bridge-update [--user] [--json]\nSafely update the global bridge and all managed settings. --user selects the per-user npm prefix (Windows: AppData/Roaming/npm; macOS/Linux: ~/.local) without administrator rights. Legacy Windows relays migrate when existing work finishes; pending migrations can be retried with the same command." };
  if (env.CODEX_BRIDGE_SKIP_SETUP === "1") throw failure("UPDATE_SETUP_DISABLED", "CODEX_BRIDGE_SKIP_SETUP=1 disables managed setup. Remove that explicit opt-out before requesting this complete update.", "preflight");
  if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 600000) throw failure("UPDATE_ARGUMENT_INVALID", "The update readiness deadline is invalid.", "preflight");
  root = fs.realpathSync.native(root);
  const version = packageVersion(root);
  const npm = resolveUpdateNpm(env);
  const userPrefix = args.includes("--user") ? platform === "win32"
    ? path.join(env.APPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Roaming"), "npm")
    : path.join(env.HOME || os.homedir(), ".local") : null;
  if (userPrefix && (!path.isAbsolute(userPrefix) || /[\u0000-\u001f\u007f]/.test(userPrefix))) {
    throw failure("UPDATE_GLOBAL_ROOT_INVALID", "The per-user installation directory is invalid.", "preflight");
  }
  const prefixArgs = userPrefix ? ["--prefix", userPrefix] : [];
  let cwd = neutralDirectory([root], env);
  let childEnv = Object.fromEntries(Object.entries(env).filter(([name]) => !/^AGENT_RELAY_(?!DIRECTORY$)/i.test(name)));
  const command = async (arguments_, phase, timeout = 600000, environment = childEnv) => {
    let result;
    try {
      result = await run(process.execPath, arguments_, { env: environment, cwd, encoding: "utf8", windowsHide: true,
        shell: false, timeout, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { throw childFailure({ error, stderr: error.stderr }, phase); }
    if (result?.error || (result?.status ?? result?.exitCode ?? 0) !== 0) throw childFailure(result, phase);
    return String(result?.stdout ?? "");
  };
  const modules = (await command([npm, "root", "--global", ...prefixArgs], "preflight", 30000)).trim();
  if (!path.isAbsolute(modules) || /[\u0000-\u001f\u007f]/.test(modules)) throw failure("UPDATE_GLOBAL_ROOT_INVALID", "npm returned an invalid global installation directory.", "preflight");
  const prefix = (await command([npm, "prefix", "--global", ...prefixArgs], "preflight", 30000)).trim();
  if (!path.isAbsolute(prefix) || /[\u0000-\u001f\u007f]/.test(prefix) || userPrefix && path.relative(userPrefix, prefix) !== ""
      || path.relative(modules, path.join(prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules")) !== "") {
    throw failure("UPDATE_GLOBAL_ROOT_INVALID", "npm returned inconsistent global prefix and installation directories.", "preflight");
  }
  const globalRoot = path.join(modules, "@minhspark", "codex-mcp-bridge");
  cwd = neutralDirectory([root, globalRoot], env);
  const previousVersion = packageVersion(globalRoot, true);
  if (previousVersion && newerVersion(previousVersion, version)) throw failure("UPDATE_DOWNGRADE_REFUSED", "The global bridge is newer than this updater. Run the update command with the latest published package.", "preflight");
  const config = readConfig({ env: childEnv, platform, missing: true });
  let runtime;
  if (config) {
    runtime = readRuntime(config.paths.root, { root: globalRoot, nodeExecutable: process.execPath, allowMissingFiles: true });
    if (runtime.packageVersion && newerVersion(runtime.packageVersion, version)) throw failure("UPDATE_DOWNGRADE_REFUSED", "The owned relay runtime is newer than this updater. Run the update command with the latest published package.", "preflight");
    if (runtime.environment !== undefined) childEnv = { ...Object.fromEntries(Object.entries(childEnv).filter(([name]) => !MANAGED_ENV.has(name.toUpperCase()))), ...runtime.environment };
    childEnv.AGENT_RELAY_DIRECTORY = config.paths.root;
  }
  const awaitService = async (target, mutate, phase, expectedVersion = version) => {
    const deadline = now() + waitMs;
    let check = !mutate;
    for (;;) {
      const service = await installService({ env: childEnv, platform, root: target, check, pollAttempts: 1 });
      check = true;
      if (service.configured !== true) throw failure("UPDATE_SERVICE_UNVERIFIED", `The owned relay service could not be verified. ${RETRY}`, phase,
        service.code ? Object.assign(new Error("The service installer reported a failure."), { code: service.code }) : undefined);
      if (service.enabled === false) {
        if (phase === "migration" && !quiescent(config)) throw Object.assign(failure("UPDATE_RELAY_PENDING", `The disabled relay still has an owned process whose release could not be verified. ${RETRY}`, phase), { pending: true });
        return { enabled: false, ready: false, liveVerified: false };
      }
      if (service.enabled === true && service.liveVerified === true && service.ready === true && service.version === expectedVersion
          && Number.isSafeInteger(service.pid) && service.pid > 0) return { enabled: true, ready: true, liveVerified: true, version: expectedVersion, pid: service.pid };
      if (now() >= deadline) throw Object.assign(failure("UPDATE_RELAY_PENDING", `The relay is still completing its owned runtime transition. ${RETRY}`, phase), { pending: true });
      await sleep(Math.min(1000, Math.max(1, deadline - now())));
    }
  };
  let migrated = false;
  const legacy = value => ["1.26.0", "1.26.1"].includes(value);
  if (platform === "win32" && config && (legacy(previousVersion) || legacy(runtime.packageVersion))) {
    if (config.enabled === false) {
      if (!quiescent(config)) throw Object.assign(failure("UPDATE_RELAY_PENDING", `The disabled relay still has an owned process whose release could not be verified. ${RETRY}`, "migration"), { pending: true });
    } else {
      onProgress("Waiting for the legacy relay to finish existing work and activate the update runtime.");
      const staged = runtime.filesAvailable !== false && runtime.packageVersion && !legacy(runtime.packageVersion) && !newerVersion("1.26.2", runtime.packageVersion);
      const service = await awaitService(staged ? runtime.packageRoot : root, !staged, "migration", staged ? runtime.packageVersion : version);
      migrated = !staged && service.enabled;
    }
  }
  onProgress(`Installing bridge ${version}.`);
  await command([npm, "install", "--global", "--prefix", prefix, `${PACKAGE}@${version}`, "--ignore-scripts"],
    "installation", 600000, { ...childEnv, CODEX_BRIDGE_SKIP_SETUP: "1" });
  if (packageVersion(globalRoot) !== version) throw failure("UPDATE_VERSION_MISMATCH", "The global package version does not match the updater version. Rerun the same update command.", "verification");
  for (const check of [false, true]) {
    onProgress(check ? "Verifying the global bridge settings and owned relay runtime." : "Applying managed settings from the installed bridge.");
    let setup;
    try { setup = JSON.parse(await command([path.join(globalRoot, "scripts", "setup.mjs"), ...(check ? ["--check"] : []), "--json"], "verification")); }
    catch (error) { if (error?.code) throw error; throw failure("UPDATE_SETUP_INCOMPLETE", `Global setup did not return a verifiable result. ${RETRY}`, "verification"); }
    if (setup?.configured !== true) throw failure("UPDATE_SETUP_INCOMPLETE", `The global bridge settings are incomplete. ${RETRY}`, "verification");
  }
  const service = await awaitService(globalRoot, false, "verification");
  return { updated: true, configured: true, version, previousVersion, migrated, service, opensApps: false, opensChats: false };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  exitForVersionRequest(import.meta.url);
  const args = process.argv.slice(2);
  try {
    process.chdir(neutralDirectory([ROOT], process.env));
    const result = await runUpdate({ args, onProgress: message => process.stderr.write(`${message}\n`) });
    process.stdout.write(result.help ? `${result.help}\n` : args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n`
      : `Bridge ${result.version} updated; managed settings verified. Background relay ${result.service.ready ? "ready" : "remains intentionally disabled"}.\n`);
  } catch (error) {
    const options = { component: "bridge-update", operation: "update", deliveryState: "not_applicable" };
    if (args.includes("--json")) process.stdout.write(JSON.stringify({ updated: false, pending: error.pending === true, diagnostic: bridgeDiagnostic(error, options) }, null, 2) + "\n");
    else process.stderr.write(withBridgeDiagnostic({ isError: true, content: [] }, error, options).content.map(item => item.text ?? "").join("\n") + "\n");
    process.exitCode = 1;
  }
}
