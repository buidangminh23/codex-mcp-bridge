/**
 * Every message this bridge carries is a prompt one agent wrote for another.
 * A single paragraph that runs the request into the reply format leaves the
 * recipient guessing where the task ends, so the sending tools all describe
 * one shape. It lives here so the Codex, Claude and VS Code bridges cannot
 * drift apart.
 */
export const PROMPT_SECTIONS = Object.freeze([
  "Goal",
  "Context",
  "Task",
  "Scope",
  "Constraints",
  "Done when",
  "Reply format",
]);

export const AGENT_PROMPT_GUIDANCE =
  "Write every prompt you compose for another agent in English, in this order, omitting sections that do not apply: " +
  "a first line naming the sender, project and purpose, e.g. [From Claude Code · <project> · <purpose>]; " +
  "## Goal, the outcome in one sentence; ## Context, measured facts, paths with line numbers and existing code to reuse; " +
  "## Task, numbered imperative steps; ## Scope, the files that may and must not change; " +
  "## Constraints, conventions and tests, plus: if the current state differs from this description, stop and report instead of reconciling it; " +
  "## Done when, checkable criteria; ## Reply format, the exact shape of the reply. " +
  "A short coordination message needs only Goal, Context, Task and Reply format. " +
  "Send text the user supplied verbatim, and keep file names, identifiers and user-facing strings in their original language.";

export const PROMPT_FIELD_HINT =
  `The prompt for the recipient agent, in English with the sections ${PROMPT_SECTIONS.join(", ")} ` +
  "(omit any that do not apply); text the user supplied is sent verbatim";
