# Daily Desktop handoffs

Install the messaging MCP entries first. Local Card Bridge Desktop is optional
and is needed only for automatic task-card startup and its settings UI. Neither
component uploads an entire local project. For initial installation see
[Windows setup](new-windows-setup.md) or [macOS setup](new-macos-setup.md); for grants see
[project onboarding](project-onboarding.md).

Workspace trust, project authorization and host tool permission are separate.
Inspect the actual caller and destination with the status/onboarding tools.
Seeing a tool in a list is not proof that it can send. Claude-to-Codex delivery
also requires both tasks to belong to the same directory or registered Git
repository, even when two unrelated projects are both authorized.

## Establish one collaboration conversation

When the user authorizes a new Claude conversation, prefer the plus button next
to its project in the Code sidebar. On some observed Windows builds, a
`claude://code/new?folder=...` prefilled link displays the intended project but
creates the conversation in a scratch directory. This branch does not repair
Claude's client. See the [link documentation](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link)
and [reported directory behavior](https://github.com/anthropics/claude-code/issues/92210).

Wait for project/branch selection to finish. First request only the actual cwd,
session identity, Git root if applicable, and Remote Control state. Compare
`list_claude_sessions` with the native task ID, CLI session ID, account and cwd.
Pin `expectedCwd` and `expectedTaskId` before dispatching production work.
Reuse this verified parent for subsequent handoffs.

If a saved Claude project's directory has moved, discovery reports a separate
`relocatedProjects` candidate when the old directory is missing and the workspace
resolver finds one writable replacement authorized by the shared project policy.
Revoked original paths, revoked targets, ambiguous replacements and existing old
directories do not qualify. Hardened deployments do not remap projects.

The candidate can establish the project for an explicitly authorized new Code
conversation. It cannot resume the old task or authorize a live session: the
new native task, account, process, actual cwd and initial message must still match.
Discovery does not rewrite Claude metadata, create grants or clear revocations.
The saved source and its authorization are rechecked before opening, trusting and
submitting, including after a pending request is restored.

Native composer creation submits an initial user prompt; it is not a peer
message and does not establish a native sender label. If a handoff requires the
recipient's peer sender attribution, use `send_to_claude_session` with a verified
live task. Do not substitute composer submission or a text header for that route.

Peer messages include the bridge's advertised name through Claude's supported
`from-name` envelope field. Claude determines the native wording and verifies
the peer; the bridge does not set trusted-origin flags. Codex Desktop currently
uses its own fixed `Sent by ... from another chat` label and exposes no sender-name
override. Keep the actual `[From Claude ...]` or `[From Codex ...]` author header
in the message. A body header does not rename a native badge, and applications'
private data must not be patched to make that claim.

If a link was already opened, retain its requestId and inspect its receipt.
`promptSubmitted=false` with `submissionStatus=not_observed` means submission
was not verified, not that nothing was delivered. A wrong-directory task can
be outside the authorized search scope. Inspect existing conversations before
canceling a pending creation or starting again. Do not broaden grants to make
an accidental scratch conversation fit. `awaiting_project_confirmation` means
submission was seen but the workspace does not match; `created` requires the
new task, account, process, prompt and directory to match.

## Send, execute, receive

1. Send a narrow goal, necessary context, file scope and acceptance criteria.
   Reference longer local documents rather than copying entire conversations.
2. Reuse existing execution tasks. For a new sidebar task, preserve its parent
   session ID, task ID, title and local/worktree mode. Display its parent inside
   Claude before using `start_desktop_card`, then verify the resulting child.
3. Claude may report progress, request help and return results through the
   messaging MCP within the user's authorized collaboration. Acknowledgment is
   not task completion; check the actual result.
4. For a Claude-to-Codex creation/send timeout with a deliveryId, call `wait_codex_reply` with the same
   deliveryId. For Codex-to-Claude, retain the original msgId and inspect its
   receipt. An unconfirmed acknowledgement is not proof of delivery; observe
   the original receipt instead of resending an uncertain task.
   Confirmed native acceptance is retained across reconnects. A message injected
   into an active Codex turn can return that turn's final answer with
   `responseScope: same_turn_final`; it may cover other peer messages in that
   turn. The exact dispatch must occur after the saved watermark, and commentary
   alone is never a final reply. Receipt observation resolves that exact dispatch
   even after newer turns start; it does not substitute the latest turn's answer.
5. An `interrupted` receipt ends observation only: task outcome is unknown and
   background work may continue. Inspect the existing task before a scoped
   follow-up; do not repeat card creation or file operations.

Use native session/event tools for child completion and bounded waits. Avoid
infinite watcher scripts or regular expressions that depend on JSON field
order. Native background notifications and image companions are correlated by
identity and ancestry, not their visible wording.

Local children share a working directory; assign disjoint file scopes.
Worktree children have separate checkout directories and branches within the
same repository. Switching branches alone does not move a directory. A native
Desktop `create_thread` dispatcher, including one in a worktree, uses its own
verified permissions; it does not inherit the parent's authority.

## Troubleshooting and cleanup

Report the actual failed layer: project grant, host approval, sender identity,
transport/authentication, or reply observation. Preserve real denials; do not
switch identities or routes to bypass them. A configured tool allow rule does
not guarantee every host will permit every call.

Messaging does not require selecting the destination in Claude. Task-card
startup requires the corresponding parent to be displayed. Background redraw
behavior depends on the client; Remote Control is not required.

If an old worker is stuck on an unrecognized pending transcript record, it may
defer hot reload. Save the original receipt and any verified historical reply
before reconnecting. An unknown ID after reconnecting is not evidence of
non-delivery. Verify recovery with one harmless message, not by resending work.

Card revocation and communication revocation are independent. Archiving a
conversation does not guarantee worktree/branch removal. Check running work,
uncommitted files and unique commits before cleanup; preserve configuration,
receipts and recent validation evidence.

## Brief for a project coordinator

> Use the installed messaging bridge for this project's authorized GPT/Claude
> collaboration. Read this guide, verify the actual caller and target, and
> reuse the corresponding Claude parent. Send bounded tasks, retain message and
> card IDs, continue timed-out observations without resending, and verify the
> complete result before reporting completion. Use the optional card extension
> only when a separate child is needed. Respect the user's existing scope and
> normal host approvals; do not enable Remote Control.

This brief supplies a workflow, not new project or tool authorization.


After an uncertain Desktop creation, keep its `deliveryId` even when `threadId`
is still null. Continue with `wait_codex_reply`; do not create again to obtain the
ID. The updated companion retains late creation acknowledgements. If it reports
unsupported `get_creation_receipt`, reload both bridge workers after installing
the update; that compatibility check occurs before any new task is dispatched.
