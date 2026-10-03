import path from "node:path";

function worker(entry) {
  return entry?.args?.length === 2 && path.basename(entry.args[0]) === "mcp-supervisor.mjs" && entry.args[1] === "index.mjs";
}
const stable = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());

export function planCodeRegistration({ code, desktop, policyFile, name = "codex-bridge" }) {
  if (!path.isAbsolute(policyFile)) throw new Error("Shared project policy path must be absolute");
  const source = code.mcpServers?.[name];
  if (!worker(source)) throw new Error(`Expected an existing supervised ${name} Code registration; no configuration was changed`);
  if (source.env?.CODEX_BRIDGE_HARDENED === "1") throw new Error("Keep the hardened installation's pinned roots; automatic policy migration is not supported");
  const updated = structuredClone(code);
  const updatedDesktop = structuredClone(desktop);
  const replacement = { ...source, env: { ...source.env, CODEX_BRIDGE_PROJECT_POLICY: policyFile } };
  // The explicitly selected shared policy becomes the scope authority. Keep legacy
  // roots intact for rollback, and preserve every other setting and restriction.
  updated.mcpServers[name] = replacement;
  const changes = [{ kind: "user-code-entry", name }];
  const comparable = (entry) => {
    const normalized = structuredClone(entry);
    delete normalized.env?.CODEX_BRIDGE_ALLOWED_ROOTS;
    delete normalized.env?.CODEX_BRIDGE_PROJECT_POLICY;
    return JSON.stringify({ ...normalized, env: stable(normalized.env) });
  };
  for (const [project, config] of Object.entries(updated.projects ?? {})) {
    for (const [alias, entry] of Object.entries(config.mcpServers ?? {})) {
      if (!worker(entry) || path.resolve(entry.args[0]) !== path.resolve(source.args[0])) continue;
      if (comparable(entry) !== comparable(source)) throw new Error(`Project ${project} has a customized ${alias} entry; review its settings instead of replacing it`);
      delete config.mcpServers[alias];
      changes.push({ kind: "remove-duplicate-project-entry", project, name: alias });
    }
  }
  for (const [alias, entry] of Object.entries(updatedDesktop.mcpServers ?? {})) {
    if (!worker(entry) || path.resolve(entry.args[0]) !== path.resolve(source.args[0])) continue;
    if (comparable(entry) !== comparable(source)) throw new Error(`Shared Desktop entry ${alias} has customized settings; review it before migration`);
    delete updatedDesktop.mcpServers[alias];
    changes.push({ kind: "remove-shared-desktop-entry", name: alias });
  }
  return { code: updated, desktop: updatedDesktop, entry: replacement, changes };
}

export function checkCodeRegistration({ code, desktop, name = "codex-bridge" }) {
  const entry = code.mcpServers?.[name];
  const issues = [];
  if (!worker(entry)) issues.push("User-level Claude Code bridge is missing or does not use the supervisor");
  const shared = Object.keys(desktop.mcpServers ?? {}).filter((key) => worker(desktop.mcpServers[key]));
  if (shared.length) issues.push(`Shared Desktop bridge entries can hide the Code caller identity: ${shared.join(", ")}`);
  const overrides = Object.entries(code.projects ?? {}).flatMap(([project, config]) => Object.entries(config.mcpServers ?? {})
    .filter(([, item]) => worker(item)).map(([alias]) => ({ project, alias })));
  if (overrides.length) issues.push("Project-specific bridge entries override or duplicate the user-level registration");
  if (!entry?.env?.CODEX_BRIDGE_PROJECT_POLICY) issues.push("No shared live project policy configured");
  return { ready: issues.length === 0, issues, shared, overrides, policyFile: entry?.env?.CODEX_BRIDGE_PROJECT_POLICY ?? null };
}
