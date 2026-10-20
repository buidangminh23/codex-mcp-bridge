import fs from "node:fs";
import path from "node:path";
import { retargetMcpServerToml } from "./codex-mcp-toml.mjs";

const PRESERVED_FIELDS = ["enabled", "disabled_reason", "enabled_tools", "disabled_tools", "startup_timeout_sec", "tool_timeout_sec"];

function sameEnvironment(left = {}, right = {}) {
  const keys = (value) => Object.keys(value ?? {}).sort();
  return JSON.stringify(keys(left)) === JSON.stringify(keys(right)) && keys(left).every((key) => left[key] === right[key]);
}

function addLosesSettings(existing) {
  const customized = ["enabled_tools", "disabled_tools", "startup_timeout_sec", "tool_timeout_sec", "disabled_reason"]
    .some((key) => existing[key] != null && (!Array.isArray(existing[key]) || existing[key].length > 0));
  return existing.enabled === false || customized || Boolean(existing.transport?.cwd) || Boolean(existing.transport?.env_vars?.length);
}

export function stdioMcpRegistration({ name, existing, node, entry, entryArgs = [], envOverrides = {} }) {
  const values = { ...existing?.transport?.env, ...envOverrides };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string") throw new Error(`MCP environment value ${key} must be a string`);
  }
  const commandArgs = [entry, ...entryArgs];
  const manual = `Keep those settings and update only command=${JSON.stringify(node)} and args=${JSON.stringify(commandArgs)} in the existing entry, then restart Codex Desktop once.`;
  const plan = { command: node, commandArgs, environment: values, environmentKeys: Object.keys(values).sort(), manual };
  const addIsSafe = !existing || existing.transport?.type === "stdio" && !addLosesSettings(existing);
  const addArgs = ["mcp", "add", name];
  for (const [key, value] of Object.entries(values).sort(([a], [b]) => a.localeCompare(b))) addArgs.push("--env", `${key}=${value}`);
  const add = addIsSafe ? { args: [...addArgs, "--", node, ...commandArgs] } : {};
  if (existing?.transport?.type === "stdio" && sameEnvironment(existing.transport.env, values)) return { ...plan, ...add, mode: "retarget" };
  if (!addIsSafe) throw new Error(`The existing MCP entry has custom access, timeout, or transport settings. The installer will not remove or reset it. ${manual}`);
  return { ...plan, ...add, mode: "add" };
}

export function codexMcpRegistration({ name, existing, node, entry, entryArgs = [], env, desktopOnly }) {
  const values = { ...existing?.transport?.env };
  for (const key of ["CLAUDE_BRIDGE_PEER_NAME", "CLAUDE_BRIDGE_PERMISSION_MODE", "CODEX_BRIDGE_DESKTOP_TASKS", "CLAUDE_DESKTOP_USER_DATA", "CODEX_BRIDGE_PROJECT_POLICY"]) {
    if (env[key] !== undefined) values[key] = env[key];
  }
  values.CODEX_BRIDGE_DESKTOP_TASKS ??= desktopOnly ? "1" : "0";
  if (!["0", "1"].includes(values.CODEX_BRIDGE_DESKTOP_TASKS)) throw new Error("CODEX_BRIDGE_DESKTOP_TASKS must be 0 or 1");
  if (values.CLAUDE_BRIDGE_PERMISSION_MODE !== undefined && !["bypass", "prompting"].includes(values.CLAUDE_BRIDGE_PERMISSION_MODE)) {
    throw new Error("CLAUDE_BRIDGE_PERMISSION_MODE must be bypass or prompting; never infer it from the recipient");
  }
  if (values.CODEX_BRIDGE_DESKTOP_TASKS === "1") values.CODEX_BRIDGE_AUTOSTART = "0";
  return stdioMcpRegistration({ name, existing, node, entry, entryArgs, envOverrides: values });
}

function writeConfigAtomically(configPath, expected, next) {
  const target = fs.realpathSync.native(configPath);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.bridge-${process.pid}.tmp`);
  fs.writeFileSync(temporary, next, { encoding: "utf8", mode: fs.statSync(target).mode & 0o777, flag: "wx" });
  try {
    if (fs.readFileSync(target, "utf8") !== expected) throw new Error("The Codex configuration changed while the installer was updating it; nothing was changed. Run the installer again.");
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function verificationErrors(before, after, registration, ensureEnvVars) {
  const errors = [];
  const transport = after?.transport ?? {};
  if (transport.type !== "stdio") errors.push("transport is no longer stdio");
  if (transport.command !== registration.command) errors.push(`command is ${JSON.stringify(transport.command)}`);
  if (JSON.stringify(transport.args ?? []) !== JSON.stringify(registration.commandArgs)) errors.push(`args are ${JSON.stringify(transport.args)}`);
  if (!sameEnvironment(transport.env, registration.environment)) errors.push("the environment block changed");
  const envVars = transport.env_vars ?? [];
  for (const variable of [...(before?.transport?.env_vars ?? []), ...ensureEnvVars]) {
    if (!envVars.includes(variable)) errors.push(`env_vars lost ${variable}`);
  }
  if (before) {
    if ((transport.cwd ?? null) !== (before.transport?.cwd ?? null)) errors.push("cwd changed");
    for (const field of PRESERVED_FIELDS) {
      if (JSON.stringify(after[field] ?? null) !== JSON.stringify(before[field] ?? null)) errors.push(`${field} changed`);
    }
  }
  return errors;
}

export function applyStdioMcpRegistration({ name, registration, existing, run, configPath, ensureEnvVars = [] }) {
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  const target = { command: registration.command, args: registration.commandArgs, ensureEnvVars };
  const editInPlace = () => {
    const current = fs.readFileSync(configPath, "utf8");
    const next = retargetMcpServerToml(current, name, target);
    if (next === current) return false;
    writeConfigAtomically(configPath, current, next);
    return true;
  };
  let mode = registration.mode;
  let mutated = false;
  let edited = false;
  let envVarsAdded = ensureEnvVars.length === 0;
  let notice = null;
  try {
    if (mode === "retarget") {
      try {
        edited = editInPlace();
        mutated = edited;
        envVarsAdded = true;
      } catch (error) {
        if (!registration.args) throw new Error(`${error.message}. ${registration.manual}`);
        mode = "add";
      }
    }
    if (mode === "add") {
      run(registration.args);
      mutated = true;
      if (!envVarsAdded) {
        try {
          edited = editInPlace() || edited;
          envVarsAdded = true;
        } catch (error) {
          notice = `Add env_vars = ${JSON.stringify(ensureEnvVars)} to the ${name} entry by hand (${error.message}).`;
        }
      }
    }
    const errors = verificationErrors(existing, JSON.parse(run(["mcp", "get", name, "--json"])), registration, envVarsAdded ? ensureEnvVars : []);
    if (errors.length) throw new Error(`Codex did not read back the expected ${name} entry (${errors.join("; ")})`);
  } catch (error) {
    if (!mutated) throw error;
    if (original === null) fs.rmSync(configPath, { force: true });
    else writeConfigAtomically(configPath, fs.readFileSync(configPath, "utf8"), original);
    throw new Error(`${error.message}; the previous Codex configuration was restored`);
  }
  return { mode, edited, envVarsAdded, notice };
}
