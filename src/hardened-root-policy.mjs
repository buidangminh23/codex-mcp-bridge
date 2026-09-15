import fs from "node:fs";
import path from "node:path";

const enabled = (env) => env.CODEX_BRIDGE_HARDENED === "1";

function directoryIdentity(resolved) {
  const stat = fs.statSync(resolved, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Path is not a directory");
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs ?? stat.birthtimeMs}`;
}

function canonicalDirectory(value, label) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute existing directory`);
  let resolved;
  try { resolved = fs.realpathSync.native(value); } catch { throw new Error(`${label} does not resolve`); }
  return { path: resolved, identity: directoryIdentity(resolved) };
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertStrictProfile(env) {
  for (const [name, expected] of [
    ["CODEX_BRIDGE_DESKTOP_TASKS", "1"],
    ["CODEX_BRIDGE_THREAD_POLICY", "roots"],
    ["CODEX_BRIDGE_REMAP", "0"],
    ["CODEX_BRIDGE_AUTOSTART", "0"],
  ]) {
    if (env[name] !== expected) throw new Error(`CODEX_BRIDGE_HARDENED=1 requires ${name}=${expected}`);
  }
  if (typeof env.CODEX_BRIDGE_PATH_MAP === "string" && env.CODEX_BRIDGE_PATH_MAP.trim()) {
    throw new Error("CODEX_BRIDGE_HARDENED=1 requires CODEX_BRIDGE_PATH_MAP to be unset");
  }
  const threadOverrides = String(env.CODEX_BRIDGE_ALLOWED_THREADS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (threadOverrides.includes("*")) throw new Error("CODEX_BRIDGE_HARDENED=1 rejects wildcard thread ownership overrides");
}

/** The deployment profile deliberately has no permissive default. */
export function createHardenedRootPolicy(env = process.env) {
  if (!enabled(env)) return {
    enabled: false,
    assert: (candidate) => candidate,
    allows: () => true,
    capture: (candidate) => Object.freeze({ path: candidate, identity: null }),
    recheck: (binding) => binding?.path,
    same: (left, right) => path.resolve(left) === path.resolve(right),
  };
  assertStrictProfile(env);
  const raw = env.CODEX_BRIDGE_ALLOWED_ROOTS;
  if (typeof raw !== "string" || !raw.trim() || raw.includes("*")) throw new Error("CODEX_BRIDGE_HARDENED=1 requires explicit CODEX_BRIDGE_ALLOWED_ROOTS");
  const inputs = raw.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  const configured = inputs.map((item) => {
    const root = canonicalDirectory(item, "Allowed root");
    if (path.parse(root.path).root === root.path) throw new Error("An allowed root cannot be a drive or filesystem root");
    return Object.freeze({ input: item, ...root });
  });
  if (!configured.length) throw new Error("CODEX_BRIDGE_HARDENED=1 requires at least one allowed root");
  if (new Set(configured.map((root) => root.path.toLowerCase())).size !== configured.length) throw new Error("Allowed roots must resolve to distinct directories");

  const assertRootsCurrent = () => {
    for (const root of configured) {
      const current = canonicalDirectory(root.input, "Allowed root");
      if (current.path !== root.path || current.identity !== root.identity) throw new Error("An allowed root was retargeted or replaced after startup");
    }
  };
  const capture = (candidate, label = "Working directory") => {
    assertRootsCurrent();
    const current = canonicalDirectory(candidate, label);
    if (!configured.some((root) => contains(root.path, current.path))) throw new Error(`${label} is outside CODEX_BRIDGE_ALLOWED_ROOTS`);
    return Object.freeze(current);
  };
  const recheck = (binding, label = "Working directory") => {
    if (!binding || typeof binding.path !== "string" || typeof binding.identity !== "string") throw new Error(`${label} has no captured directory identity`);
    const current = capture(binding.path, label);
    if (current.path !== binding.path || current.identity !== binding.identity) throw new Error(`${label} was retargeted or replaced while the operation was pending`);
    return current.path;
  };
  return Object.freeze({
    enabled: true,
    roots: Object.freeze(configured.map((root) => root.path)),
    allows(candidate) {
      try { capture(candidate); return true; } catch { return false; }
    },
    assert(candidate, label = "Working directory") { return capture(candidate, label).path; },
    capture,
    recheck,
    same(left, right) {
      try { return capture(left).path === capture(right).path; } catch { return false; }
    },
  });
}

export function hardenedBridgeEnabled(env = process.env) { return enabled(env); }
