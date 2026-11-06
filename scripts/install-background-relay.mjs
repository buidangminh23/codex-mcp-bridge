import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callBackgroundRelay } from "../src/background-relay-client.mjs";
import { readRelayConfiguration, writeRelayJson } from "../src/background-relay-config.mjs";
import { RELAY_SERVICE_OWNER, relayServiceRuntimeId } from "../src/background-relay-service.mjs";
import { relayClaudeDataPin } from "../src/claude-data-pin.mjs";
import { isMainModule, stableNodeBin } from "../src/install-paths.mjs";
import { readRegularConfigFile } from "../src/project-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_ENVIRONMENT_KEYS = ["HOME", "PATH", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"];
const TASK_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$relayRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
try {
  $relayScheduler = New-Object -ComObject Schedule.Service
  $relayScheduler.Connect()
  $relayFolder = $relayScheduler.GetFolder('\')
  if ($relayRequest.action -eq 'register') {
    $null = $relayFolder.RegisterTask($relayRequest.name, $relayRequest.xml, 6, $null, $null, 3, $null)
  }
  $relayTask = $null
  try { $relayTask = $relayFolder.GetTask($relayRequest.name) }
  catch {
    $relayException = $_.Exception
    $relayMissing = $false
    while ($null -ne $relayException) {
      if ($relayException.HResult -eq -2147024894) { $relayMissing = $true }
      $relayException = $relayException.InnerException
    }
    if (-not $relayMissing) { throw }
  }
  if ($relayRequest.action -eq 'start') {
    if ($null -eq $relayTask) { throw 'Missing task' }
    $null = $relayTask.Run($null)
  }
  $relayUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if ($null -eq $relayTask) {
    @{ exists = $false; user = $relayUser } | ConvertTo-Json -Compress
  } else {
    $relayDefinition = $relayTask.Definition
    $relayAction = $relayDefinition.Actions.Item(1)
    $relayPrincipalId = [string]$relayDefinition.Principal.UserId
    $relayPrincipalSid = $null
    try {
      if ($relayPrincipalId -match '^S-\d+(?:-\d+)+$') {
        $relayPrincipalSid = [Security.Principal.SecurityIdentifier]::new($relayPrincipalId).Value
      } else {
        $relayPrincipalSid = [Security.Principal.NTAccount]::new($relayPrincipalId).Translate([Security.Principal.SecurityIdentifier]).Value
      }
    } catch {}
    @{ exists = $true; user = $relayUser; enabled = [bool]$relayTask.Enabled; state = [int]$relayTask.State;
       description = [string]$relayDefinition.RegistrationInfo.Description;
       command = [string]$relayAction.Path; arguments = [string]$relayAction.Arguments;
       actions = [int]$relayDefinition.Actions.Count; logonType = [int]$relayDefinition.Principal.LogonType;
       principalId = $relayPrincipalId; principalSid = $relayPrincipalSid; userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
       runLevel = [int]$relayDefinition.Principal.RunLevel; hidden = [bool]$relayDefinition.Settings.Hidden;
       executionTimeLimit = [string]$relayDefinition.Settings.ExecutionTimeLimit;
       multipleInstances = [int]$relayDefinition.Settings.MultipleInstances } | ConvertTo-Json -Compress
  }
} catch {
  @{ error = 'TASK_SCHEDULER_UNAVAILABLE' } | ConvertTo-Json -Compress
  exit 1
}`;

function execute(command, args, options) {
  try { return { status: 0, stdout: execFileSync(command, args, options), stderr: "" }; }
  catch (error) { return { status: Number.isInteger(error.status) ? error.status : 1, stdout: error.stdout ?? "", stderr: "" }; }
}

function installFailure(code) { return Object.assign(new Error(code), { code }); }
const escapeXml = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const quoteWindows = (value) => `"${String(value).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1")}"`;
const quoteSystemd = (value, expandDollar = true) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, () => expandDollar ? "$$" : "$")}"`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startupLocation(input, segments) {
  if (typeof input !== "string" || !path.isAbsolute(input) || /[\u0000-\u001f\u007f]/.test(input)) throw installFailure("SERVICE_STORAGE_UNSAFE");
  let ancestor = path.resolve(input);
  const suffix = [];
  while (true) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT" || ancestor === path.dirname(ancestor)) throw installFailure("SERVICE_STORAGE_UNSAFE");
      suffix.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  ancestor = fs.realpathSync.native(ancestor);
  const root = path.resolve(ancestor, ...suffix);
  const file = path.resolve(root, ...segments);
  if (!file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)) throw installFailure("SERVICE_STORAGE_UNSAFE");
  const location = { root, file, ancestor, identities: new Map() };
  startupDirectories(location);
  return location;
}

function startupDirectories(location, create = false) {
  const relative = path.relative(location.ancestor, path.dirname(location.file));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw installFailure("SERVICE_STORAGE_UNSAFE");
  let current = location.ancestor;
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    let entry;
    try { entry = fs.lstatSync(current, { bigint: true }); }
    catch (error) {
      if (error.code !== "ENOENT" || location.identities.has(current)) throw installFailure("SERVICE_CONFIGURATION_CHANGED");
      if (!create) return;
      fs.mkdirSync(current, { mode: 0o700 });
      entry = fs.lstatSync(current, { bigint: true });
    }
    const identity = `${entry.dev}:${entry.ino}:${entry.birthtimeNs}`;
    if (!entry.isDirectory() || entry.isSymbolicLink() || path.relative(current, fs.realpathSync.native(current))) throw installFailure("SERVICE_STORAGE_UNSAFE");
    if (location.identities.has(current) && location.identities.get(current) !== identity) throw installFailure("SERVICE_CONFIGURATION_CHANGED");
    location.identities.set(current, identity);
  }
}

function startupText(location) {
  startupDirectories(location);
  return readRegularConfigFile(location.file, { missing: true, maxBytes: 128 * 1024 });
}

function sameStartupFile(location, candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || path.basename(candidate) !== path.basename(location.file)) return false;
  try {
    const entry = fs.lstatSync(candidate);
    return entry.isFile() && !entry.isSymbolicLink() && path.relative(location.file, fs.realpathSync.native(candidate)) === "";
  } catch { return false; }
}

function atomicText(location, content, previous) {
  startupDirectories(location, true);
  const file = location.file;
  if (startupText(location) !== previous) throw installFailure("SERVICE_CONFIGURATION_CHANGED");
  const directory = path.dirname(file);
  const temporary = path.resolve(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  if (!temporary.startsWith(directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`)) throw installFailure("SERVICE_STORAGE_UNSAFE");
  let descriptor;
  let identity;
  const sameTemporary = (entry) => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1n
    && ["dev", "ino", "birthtimeNs"].every((field) => entry[field] === identity[field]);
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    identity = fs.fstatSync(descriptor, { bigint: true });
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (startupText(location) !== previous || !sameTemporary(fs.lstatSync(temporary, { bigint: true }))) throw installFailure("SERVICE_CONFIGURATION_CHANGED");
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (identity) {
      startupDirectories(location);
      let remaining;
      try { remaining = fs.lstatSync(temporary, { bigint: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (remaining) {
        if (!sameTemporary(remaining)) throw installFailure("SERVICE_CONFIGURATION_CHANGED");
        fs.unlinkSync(temporary);
      }
    }
  }
}

function taskXml({ command, args, user, enabled }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>${escapeXml(RELAY_SERVICE_OWNER)}</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${escapeXml(user)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${escapeXml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>${enabled}</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>${escapeXml(command)}</Command><Arguments>${escapeXml(args)}</Arguments></Exec></Actions>
</Task>\n`;
}

function savedEnvironment(env, config) {
  const result = { AGENT_RELAY_DIRECTORY: config.paths.root, AGENT_RELAY_SERVICE_OWNER: RELAY_SERVICE_OWNER };
  for (const name of RUNTIME_ENVIRONMENT_KEYS) {
    if (typeof env[name] === "string" && env[name] && !/[\u0000-\u001f\u007f]/.test(env[name])) result[name] = env[name];
  }
  return result;
}

function plist(label, node, service, environment, enabled) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapeXml(label)}</string>
<key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>${escapeXml(service)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><${enabled ? "true" : "false"}/><key>Disabled</key><${enabled ? "false" : "true"}/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}

function unit(node, service, environment) {
  return `[Unit]
Description=${RELAY_SERVICE_OWNER}
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${quoteSystemd(node)} ${quoteSystemd(service)}
${Object.entries(environment).map(([name, value]) => `Environment=${quoteSystemd(`${name}=${value}`, false)}`).join("\n")}
Restart=on-failure
RestartSec=10
TimeoutStopSec=infinity
StandardOutput=null
StandardError=null

[Install]
WantedBy=default.target
`;
}

async function installWindows(context) {
  const { env, config, root, node, service, label, invoke, mutate } = context;
  const command = path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "wscript.exe");
  const launcher = path.join(root, "scripts", "background-relay-hidden.vbs");
  if (![node, service, launcher].every((value) => !/["%\r\n\0]/.test(value))) throw installFailure("SERVICE_LAUNCH_PATH_UNSUPPORTED");
  if (!fs.existsSync(launcher)) throw installFailure("SERVICE_RUNTIME_MISSING");
  if (context.nativeRun && !fs.existsSync(command)) throw installFailure("SERVICE_HIDDEN_LAUNCHER_UNAVAILABLE");
  const args = ["//B", "//Nologo", quoteWindows(launcher), quoteWindows(node), quoteWindows(service), quoteWindows(config.paths.root)].join(" ");
  const powershell = path.win32.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const task = async (action, extra = {}) => {
    const response = await invoke(powershell, ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(TASK_SCRIPT, "utf16le").toString("base64")], {
      input: JSON.stringify({ action, name: label, ...extra }),
    });
    let value;
    try { value = JSON.parse(response.stdout); } catch { throw installFailure("TASK_SCHEDULER_UNAVAILABLE"); }
    if (response.status !== 0 || value.error || typeof value.exists !== "boolean") throw installFailure("TASK_SCHEDULER_UNAVAILABLE");
    return value;
  };
  let current = await task("query");
  if (current.exists && current.description !== RELAY_SERVICE_OWNER) throw installFailure("SERVICE_CONFIGURATION_CONFLICT");
  const sameUser = (value) => typeof value.principalSid === "string" && /^S-\d+(?:-\d+)+$/i.test(value.principalSid)
    && typeof value.userSid === "string" && value.principalSid.toLowerCase() === value.userSid.toLowerCase();
  if (current.exists && !sameUser(current)) throw installFailure("SERVICE_CONFIGURATION_CONFLICT");
  const enabled = config.enabled && (!current.exists || current.enabled === true);
  const matches = (value) => value.exists && value.description === RELAY_SERVICE_OWNER && value.command.toLowerCase() === command.toLowerCase()
    && value.arguments === args && value.actions === 1 && value.logonType === 3 && value.runLevel === 0
    && value.hidden === true && value.executionTimeLimit === "PT0S" && value.multipleInstances === 2 && value.enabled === enabled && sameUser(value);
  const changed = !matches(current);
  if (changed && mutate) {
    if (typeof current.user !== "string" || !current.user || /[\r\n\0]/.test(current.user)) throw installFailure("TASK_SCHEDULER_UNAVAILABLE");
    await task("register", { xml: taskXml({ command, args, user: current.user, enabled }) });
    current = await task("query");
  }
  if (mutate && !matches(current)) throw installFailure("SERVICE_READBACK_FAILED");
  if (mutate) await context.prepareRuntime();
  let started = false;
  if (enabled && mutate && current.state !== 4) { await task("start"); started = true; }
  return { configured: matches(current), enabled, changed, started, registration: label, activationPending: changed && current.state === 4 };
}

async function installMac(context) {
  const { env, config, node, service, label, invoke, mutate, uid } = context;
  if (!Number.isSafeInteger(uid) || uid < 0) throw installFailure("SERVICE_USER_UNAVAILABLE");
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const location = startupLocation(home, ["Library", "LaunchAgents", `${label}.plist`]);
  const file = location.file;
  const previous = startupText(location);
  if (previous !== null && !previous.includes(escapeXml(RELAY_SERVICE_OWNER))) throw installFailure("SERVICE_CONFIGURATION_CONFLICT");
  const domain = `gui/${uid}`;
  const disabled = await invoke("/bin/launchctl", ["print-disabled", domain]);
  if (disabled.status !== 0) throw installFailure("LAUNCH_AGENT_UNAVAILABLE");
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const userDisabled = new RegExp(`"${escaped}"\\s*=>\\s*true`).test(disabled.stdout)
    || /<key>Disabled<\/key>\s*<true\s*\/>/.test(previous ?? "");
  const enabled = config.enabled && !userDisabled;
  const wanted = plist(label, node, service, savedEnvironment(env, config), enabled);
  const loaded = await invoke("/bin/launchctl", ["print", `${domain}/${label}`]);
  if (loaded.status === 0 && previous === null) throw installFailure("SERVICE_CONFIGURATION_CONFLICT");
  if (loaded.status !== 0 && loaded.status !== 113) throw installFailure("LAUNCH_AGENT_UNAVAILABLE");
  const changed = previous !== wanted;
  if (changed && mutate) atomicText(location, wanted, previous);
  const configured = startupText(location) === wanted;
  if (mutate && !configured) throw installFailure("SERVICE_READBACK_FAILED");
  if (mutate) await context.prepareRuntime();
  let started = false;
  if (enabled && mutate) {
    const args = loaded.status === 0 ? ["kickstart", `${domain}/${label}`] : ["bootstrap", domain, file];
    if (loaded.status !== 0 || !/\bstate = running\b/.test(loaded.stdout)) {
      if ((await invoke("/bin/launchctl", args)).status !== 0) throw installFailure("SERVICE_START_FAILED");
      started = true;
    }
  }
  return { configured, enabled, changed, started, registration: label, activationPending: changed && loaded.status === 0 };
}

async function installLinux(context) {
  const { env, config, node, service, label, invoke, mutate } = context;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const location = startupLocation(env.XDG_CONFIG_HOME || path.join(home, ".config"), ["systemd", "user", `${label}.service`]);
  const file = location.file;
  const query = async () => {
    const response = await invoke("systemctl", ["--user", "show", `${label}.service`, "--property=LoadState,UnitFileState,ActiveState,FragmentPath", "--no-pager"]);
    const values = Object.fromEntries(response.stdout.split(/\r?\n/).filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (!values.LoadState || response.status !== 0 && values.LoadState !== "not-found") throw installFailure("USER_SYSTEMD_UNAVAILABLE");
    return values;
  };
  const values = await query();
  if (values.UnitFileState === "masked" || values.UnitFileState === "masked-runtime") return { configured: false, enabled: false, changed: false, started: false, registration: label, code: "SERVICE_MASKED" };
  const previous = startupText(location);
  if (previous !== null && !previous.includes(`Description=${RELAY_SERVICE_OWNER}\n`)
      || values.FragmentPath && !sameStartupFile(location, values.FragmentPath)) throw installFailure("SERVICE_CONFIGURATION_CONFLICT");
  const userDisabled = previous !== null && ["disabled", "disabled-runtime"].includes(values.UnitFileState);
  const enabled = config.enabled && !userDisabled;
  const wanted = unit(node, service, savedEnvironment(env, config));
  const changed = previous !== wanted;
  if (changed && mutate) {
    atomicText(location, wanted, previous);
    if ((await invoke("systemctl", ["--user", "daemon-reload"])).status !== 0) throw installFailure("USER_SYSTEMD_UNAVAILABLE");
  }
  if (enabled && mutate && !["enabled", "enabled-runtime"].includes(values.UnitFileState)) {
    if ((await invoke("systemctl", ["--user", "enable", `${label}.service`])).status !== 0) throw installFailure("SERVICE_REGISTRATION_FAILED");
  }
  if (mutate) await context.prepareRuntime();
  let started = false;
  if (enabled && mutate && values.ActiveState !== "active") {
    if ((await invoke("systemctl", ["--user", "start", `${label}.service`])).status !== 0) throw installFailure("SERVICE_START_FAILED");
    started = true;
  }
  const verified = mutate ? await query() : values;
  const configured = startupText(location) === wanted
    && verified.LoadState === "loaded" && sameStartupFile(location, verified.FragmentPath)
    && (!enabled || ["enabled", "enabled-runtime"].includes(verified.UnitFileState));
  if (mutate && !configured) throw installFailure("SERVICE_READBACK_FAILED");
  return { configured, enabled, changed, started, registration: label };
}

async function relayNode(kept, current, engine, invoke) {
  if (typeof kept !== "string" || !path.isAbsolute(kept) || kept === current) return current;
  try { if (!fs.statSync(kept).isFile()) return current; } catch { return current; }
  let reported;
  try {
    const answer = await invoke(kept, ["--version"]);
    if (answer.status !== 0) return current;
    reported = /^v(\d+)\.(\d+)\./.exec(answer.stdout.trim());
  } catch { return current; }
  if (!reported) return current;
  const required = /^>=\s*(\d+)\.(\d+)/.exec(typeof engine === "string" ? engine : "");
  if (!required) return kept;
  const [major, minor, wantedMajor, wantedMinor] = [reported[1], reported[2], required[1], required[2]].map(Number);
  return major > wantedMajor || major === wantedMajor && minor >= wantedMinor ? kept : current;
}

export async function installBackgroundRelay({ env = process.env, platform = process.platform, root = ROOT, run = execute,
  dryRun = false, check = false, health = callBackgroundRelay, sleep = pause, pollAttempts = 15, uid = process.getuid?.() } = {}) {
  const base = { configured: false, enabled: false, started: false, liveVerified: false, ready: false };
  let config;
  try {
    config = readRelayConfiguration({ env, platform, missing: true });
    if (!config) return { ...base, code: "WORKER_RELAY_NOT_CONFIGURED", reason: "Configure the background relay before installing its user service" };
    if (!["win32", "darwin", "linux"].includes(platform)) return { ...base, code: "SERVICE_PLATFORM_UNSUPPORTED", reason: "Background relay user startup is unsupported on this platform" };
    if (!path.isAbsolute(root)) throw installFailure("SERVICE_RUNTIME_MISSING");
    root = fs.realpathSync.native(root);
    const service = path.join(root, "src", "background-relay-service.mjs");
    if (!path.isAbsolute(root) || !fs.existsSync(service) || !fs.existsSync(path.join(root, "src", "background-relay-daemon.mjs"))) throw installFailure("SERVICE_RUNTIME_MISSING");
    let packageVersion;
    let nodeEngine;
    try { ({ version: packageVersion, engines: { node: nodeEngine } = {} } = JSON.parse(readRegularConfigFile(path.join(root, "package.json"), { maxBytes: 128 * 1024 }))); }
    catch { throw installFailure("SERVICE_RUNTIME_INVALID"); }
    if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(packageVersion) || packageVersion.length > 96) throw installFailure("SERVICE_RUNTIME_INVALID");
    if ([root, config.paths.root].some((value) => /[\u0000-\u001f\u007f]/.test(value))) throw installFailure("SERVICE_LAUNCH_PATH_UNSUPPORTED");
    const hash = createHash("sha256").update(platform === "win32" ? config.paths.root.toLowerCase() : config.paths.root).digest("hex").slice(0, 12);
    const label = platform === "win32" ? `MinhSpark Agent Relay ${hash}` : `com.minhspark.agent-relay.${hash}`;
    const invoke = async (command, args, extra = {}) => {
      const result = await run(command, args, { env, encoding: "utf8", windowsHide: true, shell: false, timeout: 15000, maxBuffer: 256 * 1024, stdio: ["pipe", "pipe", "pipe"], ...extra });
      return { status: result?.status ?? result?.exitCode ?? 0, stdout: String(result?.stdout ?? "") };
    };
    const runtimeFile = path.join(config.paths.root, "service-runtime.json");
    const readRuntime = () => {
      const raw = readRegularConfigFile(runtimeFile, { missing: true, maxBytes: 64 * 1024 });
      if (raw === null) return null;
      let value;
      try { value = JSON.parse(raw); } catch { throw installFailure("SERVICE_RUNTIME_INVALID"); }
      if (value?.schemaVersion !== 1 || value.owner !== RELAY_SERVICE_OWNER) throw installFailure("SERVICE_CONFIGURATION_CONFLICT");
      if (value.environment !== undefined && (!value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)
          || Object.entries(value.environment).some(([name, entry]) => !RUNTIME_ENVIRONMENT_KEYS.includes(name)
            || typeof entry !== "string" || !entry || /[\u0000-\u001f\u007f]/.test(entry)))) throw installFailure("SERVICE_RUNTIME_INVALID");
      return value;
    };
    const previousRuntime = readRuntime();
    const node = await relayNode(previousRuntime?.nodeExecutable, stableNodeBin(env), nodeEngine, invoke);
    if (/[\u0000-\u001f\u007f]/.test(node)) throw installFailure("SERVICE_LAUNCH_PATH_UNSUPPORTED");
    const installedEnv = check && previousRuntime ? {
      ...Object.fromEntries(Object.entries(env).filter(([name]) => !RUNTIME_ENVIRONMENT_KEYS.includes(name))),
      ...previousRuntime.environment,
    } : env;
    const claudeDataPin = check && previousRuntime ? previousRuntime.claudeDesktopUserData : relayClaudeDataPin(env, platform);
    const desiredRuntime = { schemaVersion: 1, owner: RELAY_SERVICE_OWNER, packageRoot: root, nodeExecutable: node, packageVersion,
      environment: check && previousRuntime ? previousRuntime.environment ?? {}
        : Object.fromEntries(Object.entries(savedEnvironment(env, config)).filter(([name]) => !name.startsWith("AGENT_RELAY_"))),
      ...(claudeDataPin ? { claudeDesktopUserData: claudeDataPin } : {}) };
    const expectedRuntimeId = relayServiceRuntimeId(desiredRuntime);
    const runtimeChanged = JSON.stringify(previousRuntime) !== JSON.stringify(desiredRuntime);
    const prepareRuntime = async () => {
      if (JSON.stringify(readRuntime()) !== JSON.stringify(previousRuntime)) throw installFailure("SERVICE_CONFIGURATION_CHANGED");
      if (runtimeChanged) writeRelayJson(runtimeFile, desiredRuntime);
      if (JSON.stringify(readRuntime()) !== JSON.stringify(desiredRuntime)) throw installFailure("SERVICE_READBACK_FAILED");
    };
    const context = { env: installedEnv, config, root, node, service, label, invoke, mutate: !dryRun && !check, uid, nativeRun: run === execute, prepareRuntime };
    const installed = await ({ win32: installWindows, darwin: installMac, linux: installLinux })[platform](context);
    installed.configured = installed.configured && JSON.stringify(readRuntime()) === JSON.stringify(desiredRuntime);
    const result = { ...base, ...installed, dryRun, deliveryEnabled: installed.enabled, liveVerified: false,
      expectedVersion: packageVersion, runtimeChanged, activationPending: installed.activationPending === true || runtimeChanged && previousRuntime !== null };
    if (!installed.enabled) {
      result.notice = config.enabled ? "User startup is intentionally disabled; the installer preserved that choice" : "Background relay is intentionally disabled in its configuration";
      return result;
    }
    if (!installed.configured || dryRun) return result;
    const attempts = check ? 1 : Math.max(1, Math.min(30, pollAttempts));
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const status = await health("status", {}, { env, connection: { endpoint: config.endpoint, token: config.token, workerId: null }, timeoutMs: 1000 });
        const serviceState = JSON.parse(readRegularConfigFile(path.join(config.paths.root, "service-status.json"), { maxBytes: 64 * 1024 }));
        const owned = status?.schemaVersion === 1 && status.transportReady === true && status.desktopRequired === false
            && Number.isSafeInteger(status.pid) && status.pid > 0 && serviceState?.owner === RELAY_SERVICE_OWNER
            && serviceState.status === "running" && serviceState.daemonPid === status.pid;
        if (owned && typeof status.version === "string" && /^[A-Za-z0-9.+_-]{1,96}$/.test(status.version)) result.version = status.version;
        if (owned && (serviceState.runtimeId !== expectedRuntimeId || status.runtimeId !== expectedRuntimeId || status.version !== packageVersion)) result.activationPending = true;
        if (owned && serviceState.runtimeId === expectedRuntimeId && status.runtimeId === expectedRuntimeId && status.version === packageVersion) {
          return { ...result, activationPending: false, liveVerified: true, ready: status.accepting === true, pid: status.pid,
            version: typeof status.version === "string" && /^[A-Za-z0-9.+_-]{1,96}$/.test(status.version) ? status.version : null,
            ...(status.accepting === true ? {} : { code: "SERVICE_DRAINING", notice: "The relay is finishing existing work before accepting new jobs" }) };
        }
      } catch {}
      if (attempt + 1 < attempts) await sleep(250);
    }
    return { ...result, code: result.activationPending ? "SERVICE_UPDATE_PENDING" : "SERVICE_NOT_READY",
      reason: result.activationPending ? "User startup is configured; the running service has not yet verified the desired idle runtime update"
        : "User startup is configured, but its owned daemon did not report healthy transport" };
  } catch (error) {
    const allowed = /^(?:SERVICE_[A-Z_]+|TASK_SCHEDULER_UNAVAILABLE|LAUNCH_AGENT_UNAVAILABLE|USER_SYSTEMD_UNAVAILABLE|WORKER_CONFIG_INVALID|WORKER_STORAGE_UNSAFE)$/;
    const code = typeof error.code === "string" && allowed.test(error.code) ? error.code : "SERVICE_INSTALL_FAILED";
    return { ...base, code, reason: "The background relay user service could not be safely configured or verified" };
  }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--check", "--dry-run", "--json"].includes(arg)) || args.includes("--check") && args.includes("--dry-run")) {
    process.stderr.write("Usage: install-background-relay.mjs [--check|--dry-run] [--json]\n");
    process.exitCode = 2;
  } else {
    const result = await installBackgroundRelay({ check: args.includes("--check"), dryRun: args.includes("--dry-run") });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.configured && !args.includes("--dry-run") && result.code !== "SERVICE_MASKED") process.exitCode = 1;
  }
}
