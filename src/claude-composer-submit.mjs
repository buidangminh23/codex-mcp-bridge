import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);
const helperPath = fileURLToPath(new URL("./claude-composer-submit.ps1", import.meta.url));

export async function trustClaudeCodeComposer({ cwd, prompt }, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { status: "blocked", reason: "native_workspace_trust_unsupported", platform };
  if (typeof cwd !== "string" || !path.win32.isAbsolute(cwd)) return { status: "blocked", reason: "absolute_project_path_required" };
  const payload = Buffer.from(JSON.stringify({ cwd, prompt }), "utf8").toString("base64");
  try {
    const result = await (options.run ?? execute)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath, "-PayloadBase64", payload, "-Action", "Trust", "-WaitMilliseconds", "8000"], { windowsHide: true, timeout: 12000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    const trusted = JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
    if (!["trusted", "absent", "blocked", "uncertain"].includes(trusted?.status)) return { status: "uncertain", reason: "native_workspace_trust_outcome_unknown" };
    return trusted;
  } catch { return { status: "uncertain", reason: "native_workspace_trust_outcome_unknown" }; }
}

export function assessClaudeCodeComposer(snapshot, { prompt, cwd }) {
  const block = (reason) => ({ status: "blocked", reason });
  if (!snapshot || !Array.isArray(snapshot.windows) || snapshot.windows.length !== 1) {
    return block("desktop_window_ambiguous_or_missing");
  }
  const window = snapshot.windows[0];
  if (window.installedDesktop !== true) return block("desktop_process_not_verified");
  if (snapshot.dialogs?.length) return block("desktop_dialog_requires_attention");
  if (snapshot.codeSelected !== true) return block("code_mode_not_selected");
  if (!Array.isArray(snapshot.composers) || snapshot.composers.length !== 1) {
    return block("composer_ambiguous_or_missing");
  }
  const composerText = (text) => typeof text === "string" ? text.replace(/\r\n/g, "\n").split("\n").filter((line) => line !== "").join("\n") : null;
  if (composerText(snapshot.composers[0].text) !== composerText(prompt)) return block("composer_prompt_mismatch");
  if (snapshot.worktreeEnabled !== false) return block("original_project_folder_not_verified");
  if (snapshot.folderCount !== 1 || snapshot.localMode !== true) return block("project_folder_ambiguous_or_remote");
  if (!Array.isArray(snapshot.selectedFolderPaths) || snapshot.selectedFolderPaths.length !== 1) {
    return block("selected_project_path_not_verified");
  }
  const normalize = (value) => path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
  if (typeof snapshot.selectedFolderPaths[0] !== "string" || !path.win32.isAbsolute(snapshot.selectedFolderPaths[0]) || normalize(snapshot.selectedFolderPaths[0]) !== normalize(cwd)) {
    return block("selected_project_path_mismatch");
  }
  if (snapshot.sendButtons?.length !== 1 || snapshot.sendButtons[0].enabled !== true || snapshot.sendButtons[0].invokable !== true) {
    return block("send_button_ambiguous_disabled_or_unavailable");
  }
  return { status: "ready", reason: "exact_composer_and_project_verified", windowId: window.id };
}

export async function submitClaudeCodeComposer({ prompt, cwd, beforeSubmit }, options = {}) {
  const platform = options.platform ?? process.platform;
  if (typeof prompt !== "string" || !prompt.length || typeof cwd !== "string" || !cwd.length) {
    return { status: "blocked", reason: "prompt_and_project_required" };
  }
  if (platform !== "win32") {
    return { status: "blocked", reason: "native_composer_submission_unsupported", platform };
  }
  if (!path.win32.isAbsolute(cwd)) return { status: "blocked", reason: "absolute_project_path_required" };
  const run = options.run ?? execute;
  const requestedBudget = options.timeoutMs ?? 20000;
  const budget = Number.isFinite(requestedBudget) ? Math.max(1000, Math.min(20000, requestedBudget)) : 20000;
  const started = Date.now();
  const payload = Buffer.from(JSON.stringify({ prompt, cwd }), "utf8").toString("base64");
  let attempted = false;
  try {
    const call = async (action, windowId) => {
      const remaining = budget - (Date.now() - started);
      if (remaining <= 0) throw new Error("Native composer deadline exceeded");
      const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath,
        "-PayloadBase64", payload, "-Action", action, "-WaitMilliseconds", String(Math.min(8000, remaining - 250))];
      if (windowId != null) args.push("-ExpectedWindowId", String(windowId));
      const result = await run("powershell.exe", args, {
        windowsHide: true, timeout: remaining, maxBuffer: 1024 * 1024, encoding: "utf8",
      });
      return JSON.parse(result.stdout.trim().replace(/^\uFEFF/, ""));
    };
    const inspection = await call("Inspect");
    if (inspection.status === "blocked") return { ...inspection, submissionAttempted: false };
    const assessment = assessClaudeCodeComposer(inspection.snapshot, { prompt, cwd });
    if (assessment.status !== "ready") return { ...assessment, submissionAttempted: false };
    if (beforeSubmit) await beforeSubmit();
    const selection = await call("SelectFolder", assessment.windowId);
    if (selection.status !== "selected") return { status: "blocked", reason: selection.reason ?? "native_folder_selection_not_confirmed", submissionAttempted: false };
    await (options.sleep ?? delay)(2000);
    if (beforeSubmit) await beforeSubmit();
    attempted = true;
    const result = await call("Submit", assessment.windowId);
    if (!["submitted", "blocked", "uncertain"].includes(result.status)) {
      return { status: "uncertain", reason: "native_submit_result_invalid", submissionAttempted: true };
    }
    return { ...result, submissionAttempted: result.status !== "blocked" };
  } catch (error) {
    return {
      status: attempted ? "uncertain" : "blocked",
      reason: attempted ? "native_submit_outcome_unknown" : "native_accessibility_unavailable",
      submissionAttempted: attempted,
      error: error.code ?? error.name ?? "Error",
    };
  }
}
