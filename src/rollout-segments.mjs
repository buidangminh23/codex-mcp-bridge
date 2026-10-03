import fs from "node:fs";
import path from "node:path";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

// Continuations retain session_meta.id but append a second UUID to the filename.
// Filename/mtime ordering is not evidence of which turn is currently active.
export function findRolloutSegments(sessions, threadId) {
  if (!new RegExp(`^${UUID}$`).test(threadId)) throw new Error("The Codex task identity is invalid");
  const root = fs.lstatSync(sessions);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("The Codex sessions path is not a regular directory");
  const canonical = fs.realpathSync.native(sessions);
  const pattern = new RegExp(`^rollout-.+-${threadId}(?:_${UUID})?\\.jsonl$`);
  const queue = [{ directory: canonical, depth: 0 }], matches = [];
  let entries = 0, directories = 0;
  while (queue.length) {
    const { directory, depth } = queue.pop();
    if (++directories > 4096) throw new Error("The bounded Codex sessions scan exceeded its directory limit");
    const children = fs.readdirSync(directory, { withFileTypes: true });
    entries += children.length;
    if (entries > 100000) throw new Error("The bounded Codex sessions scan exceeded its entry limit");
    for (const child of children) {
      const candidate = path.join(directory, child.name);
      if (depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(child.name)) {
        if (child.isSymbolicLink()) throw new Error("The Codex sessions scan encountered a linked date directory");
        if (child.isDirectory()) {
          const resolved = fs.realpathSync.native(candidate);
          const relative = path.relative(canonical, resolved);
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("A Codex date directory escapes the sessions path");
          queue.push({ directory: resolved, depth: depth + 1 });
        }
      }
      if (depth === 3 && pattern.test(child.name)) {
        if (!child.isFile() || child.isSymbolicLink()) throw new Error("The Codex rollout is not a regular file");
        matches.push(candidate);
        if (matches.length > 64) throw new Error("The Codex task exceeds the 64-segment discovery limit");
      }
    }
  }
  if (!matches.length) throw new Error("No rollout matches the calling Codex task");
  return matches.sort();
}

// Only independently retrieved native metadata may be supplied here. Tool
// arguments, process globals, and manual relay bindings are not ownership proof.
export function confirmsDesktopTask(evidence, threadId, cwd, turnId) {
  const thread = evidence?.thread;
  if (thread?.id !== threadId || thread.kind !== "codex" || thread.hostId !== "local"
      || typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd)
      || (turnId !== undefined && evidence.latestTurnId !== turnId)) return false;
  return !path.relative(fs.realpathSync.native(thread.cwd), fs.realpathSync.native(cwd));
}

export function isLegacyCliSession(session) {
  return session?.originator === "codex-tui" && session.source === "cli";
}

export function assertRolloutSetStable(sessions, threadId, snapshots) {
  const files = findRolloutSegments(sessions, threadId);
  if (files.length !== snapshots.length || files.some((file, i) => file !== snapshots[i].file)) throw new Error("The rollout segment set changed while reading");
  for (const { file, version } of snapshots) {
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || Object.entries(version).some(([key, value]) => current[key] !== value)) throw new Error("A rollout segment changed while reading");
  }
}
