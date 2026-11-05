import { RELAY_DOWN_GUIDANCE } from "./thread-delivery.mjs";

const SAVED_PROJECT_NOT_CHECKED = { status: "not_checked", detail: "The native project list was not available, so the exact saved project required to create a new task was not checked." };
const SAVED_PROJECT_UNVERIFIED = { status: "not_checked", detail: "The saved project is shown only after a verified sender and this destination are confirmed to share a project." };
const UNUSABLE_SAVED_PROJECT = new Set(["absent", "rejected", "ambiguous"]);

function outOfScopeGuidance(scope) {
  return scope?.status
    ? "Authorize this project or its parent directory once in the shared project policy."
    : "This bridge authorizes by CODEX_BRIDGE_ALLOWED_ROOTS. Ask the user whether this directory belongs in scope; never widen scope to work around a refusal.";
}

export function bridgeReadiness({ sender, scope, targetCwd, nativeAvailable = true, nativeDiagnostic, verifyTargetProject, authorizationMode, existingTasks, savedProject }) {
  const issues = [];
  if (sender?.status !== "verified") issues.push({ code: "SENDER_UNVERIFIED", detail: sender?.reason ?? "No current Code session identity", action: "Load the user-level Claude Code bridge entry in this existing task; a shared Desktop entry cannot identify the caller. Run the Code registration check, then reload the affected client." });
  const projectPolicy = scope?.status?.(sender?.status === "verified" ? sender.cwd : undefined) ?? null;
  if (projectPolicy?.error) issues.push({ code: "PROJECT_SCOPE_INVALID", detail: projectPolicy.error, action: "Check the shared project policy. Authorize the intended project once; never change the sending task to work around a refusal." });
  let target = null;
  if (targetCwd) {
    try {
      const binding = scope.capture?.(targetCwd);
      target = { ...(binding ?? {}), cwd: binding?.path ?? scope.assert(targetCwd), authorized: true };
    }
    catch (error) { target = { cwd: targetCwd, authorized: false }; issues.push({ code: "TARGET_NOT_AUTHORIZED", detail: error.message, action: outOfScopeGuidance(scope) }); }
  }
  if (target?.authorized && sender?.status === "verified" && verifyTargetProject) {
    try { verifyTargetProject(sender.cwd, target.cwd); target.sameProject = true; }
    catch (error) {
      target.sameProject = false;
      issues.push({ code: error.code ?? "PROJECT_SCOPE_UNVERIFIED", detail: error.message, action: "Select a destination in the verified sender's project. A project grant does not authorize cross-project delivery." });
    }
  }
  if (target?.authorized) target.savedProject = sender?.status === "verified" && target.sameProject === true ? savedProject ?? SAVED_PROJECT_NOT_CHECKED : SAVED_PROJECT_UNVERIFIED;
  if (authorizationMode === "pinned-roots" && UNUSABLE_SAVED_PROJECT.has(target?.savedProject?.status)) {
    issues.push({ code: "NATIVE_SCOPE_UNVERIFIED", detail: target.savedProject.detail, action: "This hardened deployment requires exactly one saved local project at the task's directory for every native operation. Ask the user to save or correct that project; never change the destination to work around a refusal." });
  }
  if (!nativeAvailable) issues.push({ code: nativeDiagnostic?.code ?? "RELAY_UNAVAILABLE", detail: nativeDiagnostic?.reason, action: RELAY_DOWN_GUIDANCE, ...(nativeDiagnostic ? { diagnostic: nativeDiagnostic } : {}) });
  return { ready: issues.length === 0, readyScope: "transport-identity-and-project", hostToolPermission: "evaluated-by-client-at-call-time", sender, ...(authorizationMode ? { authorizationMode } : {}), ...(existingTasks ? { existingTasks } : {}), projectPolicy, target, issues };
}
