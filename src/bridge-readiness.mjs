export function bridgeReadiness({ sender, scope, targetCwd, nativeAvailable = true, verifyTargetProject }) {
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
    catch (error) { target = { cwd: targetCwd, authorized: false }; issues.push({ code: "TARGET_NOT_AUTHORIZED", detail: error.message, action: "Authorize this project or its parent directory once in the shared project policy." }); }
  }
  if (target?.authorized && sender?.status === "verified" && verifyTargetProject) {
    try { verifyTargetProject(sender.cwd, target.cwd); target.sameProject = true; }
    catch (error) {
      target.sameProject = false;
      issues.push({ code: error.code ?? "PROJECT_SCOPE_UNVERIFIED", detail: error.message, action: "Select a destination in the verified sender's project. A project grant does not authorize cross-project delivery." });
    }
  }
  if (!nativeAvailable) issues.push({ code: "RELAY_UNAVAILABLE", action: "Open Codex Desktop and check native_relay_status in its existing task." });
  return { ready: issues.length === 0, readyScope: "transport-identity-and-project", hostToolPermission: "evaluated-by-client-at-call-time", sender, projectPolicy, target, issues };
}
