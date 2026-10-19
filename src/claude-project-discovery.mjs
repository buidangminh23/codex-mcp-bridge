import fs from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "./platform.mjs";

export function discoverClaudeProject(task, { policy, resolveWorkspace = resolveWorkspacePath }) {
  if (!task || task.isArchived !== false || typeof task.taskId !== "string" || !task.taskId || task.fileTaskId !== task.taskId ||
      typeof task.cwd !== "string" || !path.isAbsolute(task.cwd) || task.cwd.includes("\0")) return null;
  try {
    let cwd;
    let relocated = false;
    try {
      cwd = fs.realpathSync.native(task.cwd);
    } catch (error) {
      if (error.code !== "ENOENT" || policy.mode !== "project-policy") return null;
      try { fs.lstatSync(task.cwd); return null; } catch (missing) { if (missing.code !== "ENOENT") return null; }
      policy.assertDiscoverySource(task.cwd);
      const candidate = resolveWorkspace(task.cwd, { requireUnique: true });
      if (!candidate.remapped || !candidate.writable) return null;
      cwd = fs.realpathSync.native(candidate.path);
      relocated = true;
    }
    const binding = policy.capture(cwd, "Discovered Claude project directory");
    return { cwd: binding.path, originalCwd: task.cwd, relocated, binding };
  } catch { return null; }
}
