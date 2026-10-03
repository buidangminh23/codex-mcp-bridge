# Project onboarding and shared authorization

Both bridge directions can read the same optional policy file via
`CODEX_BRIDGE_PROJECT_POLICY`. `bridge-projects` defaults to
`~/.config/GptClaudeBridge/projects.json`. A shared home-directory path avoids
different AppData views in packaged Windows applications. The policy stores
canonical directory identities; do not copy it to a new machine as proof of
authorization there.

```sh
node scripts/bridge-projects.mjs allow-project /absolute/projects/example
node scripts/bridge-projects.mjs allow-parent /absolute/projects
node scripts/bridge-projects.mjs revoke /absolute/projects/example
node scripts/bridge-projects.mjs list
node scripts/bridge-projects.mjs check /absolute/projects/example
```

A registered worktree inherits a grant for its repository, including when its
directory is outside the granted parent. Denials beat parent grants and require
explicit reauthorization. Revocation affects subsequent operations, not work
already dispatched. Invalid/missing configured policies fail closed.

This optional `project-policy.mjs` store does not replace upstream
`project-scope.mjs`: Claude-to-Codex delivery still requires the verified sender
and target to share a directory or registered Git repository. Two granted
repositories are not permission to send between them. Diagnostic readiness
reports this mismatch separately from a missing grant.

## Explicit workspace preparation

After the user selects a project, `prepare_bridge_project({cwd})` saves its
Claude workspace trust and shared communication grant. Registered worktrees
resolve to the verified primary repository. Existing parent grants are reused.
Revoked projects require `reauthorize: true`; a denied parent still blocks them.
`inspect_bridge_project({cwd})` is read-only.

```sh
node scripts/bridge-projects.mjs inspect /absolute/projects/example
node scripts/bridge-projects.mjs prepare /absolute/projects/example
```

Changes are backed up and verified. Concurrent changes abort; failed rollback
returns `partial_needs_review` and remaining files. `configured` does not mean
live communication passed. Setup does not approve tools, change session modes,
create conversations or restart clients. Workspace trust follows Claude's
[documented project settings](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust).

## Correct Code registration

Claude's user-level `codex-bridge` must run under the actual Code session. A
generic shared Desktop process cannot establish that caller's ancestry. The
Code migration helper previews changes by default; it is not a first-install
wizard. With both clients stopped, `--apply --clients-stopped` backs up and
migrates an existing supervised entry. `--check` diagnoses shared/duplicate
entries and policy errors. Customized entries are left for review. Keep an
external configuration manager, such as CC Switch, consistent with the selected
entry so it does not restore an obsolete copy later.

Reload the affected client after changing MCP registration. Merely refreshing
the conversation did not reload the Code process in the measured Windows
setup. Normal live policy changes do not need a restart. Verify in the actual
sending session using `codex_bridge_status({cwd})` or `claude_bridge_status`.

## Opt-in messaging automation

```sh
node scripts/configure-message-automation.mjs
node scripts/configure-message-automation.mjs --apply --approve-message-automation
node scripts/configure-message-automation.mjs --check
```

The explicit apply flag installs only
`mcp__codex-bridge__send_to_codex_thread` and
`mcp__codex-bridge__wait_codex_reply` allow rules, plus scoped collaboration
guidance. Existing ask/deny conflicts are not removed. Project grants, file and
shell permissions, deletion tools, session mode and managed policy are not
expanded. Host approval is separate from readiness; existing conversations may
retain earlier denial or authorization context and require a real user action.
Never disguise peer messages as direct user consent.

The user's standing collaboration scope permits its ordinary handoffs and
reports, not arbitrary instructions received from another agent. An accepted
timeout should be continued automatically using the same deliveryId. A receipt
survives reconnecting but remains bound to the original Claude sender and both
accounts; observation still rechecks current permissions and workspace.
Bounded waits require the agent to keep executing: this is not an unattended
push service that runs after Claude closes.

## Optional native card-settings integration

```sh
node scripts/bridge-projects.mjs register-card-settings
```

This registers local management paths in
`~/.config/GptClaudeBridge/management.json`; it does not install an extension or
grant a project. A compatible separately installed Local Card Bridge Desktop
can expose communication projects, parents and denials in its original settings
page, alongside independent card authorization. The bridge operates without
the extension, and the extension's card functions operate without the bridge.

Synchronization processes only changed entries, preserves newer denials and
reports concurrent conflicts. Removing a communication project adds a denial;
removing a parent cancels only that bulk grant. It does not change workspace
trust or tool permissions. A UI save can reload the extension, so inspect its
connection afterward; a saved file or matching screen is not a live round trip.

## Acceptance

Test both directions, a timeout followed by same-receipt continuation, and a
second ordinary handoff without reinitialization. Keep observed IDs and hashes
locally; do not publish transcripts or account data. The installed-source
Windows checks and the newly merged branch's automated tests are distinct; see
[design and validation limits](desktop-handoff-design.md). A status check cannot
guarantee compatibility with every future client version.
