# Project onboarding and shared authorization

One command installs or updates the global package, registers the bridges and
configures the independent worker relay automatically:

```sh
npm exec --yes --ignore-scripts --package=@minhspark/codex-mcp-bridge@latest -- codex-bridge-update
```

In Windows PowerShell use `npm.cmd`. npm fetches the latest updater into its
cache with setup disabled there. The updater moves an owned legacy service to
newer code using private relay storage as its working directory when needed,
temporarily using the downloaded updater package. It waits for active work to
drain, then installs its exact resolved version globally with the setup hook
enabled. It verifies the global installation and managed settings. No second
installation command is required. It does not open apps or chats or kill
processes. The setup creates
`codex-bridge` for Claude Code and the separate `codex-bridge-desktop` shared
Claude connector, configures Codex and Antigravity, and initializes the native
relay on Windows/macOS. It also installs the per-user background service and
worker communication settings, including Antigravity's four scoped relay tool
grants. See [installation](../README.md#installation).

Setup preserves existing scope and permission choices. Registration does not
grant workspace trust, authorize cross-project work, or establish a live
connection. The shared Desktop connector uses local app-server sessions;
native Codex Desktop handoffs require a verified Claude Code sender in the
same saved project. Independent CLI workers require their own provider
authentication and project authorization; they can communicate while Desktop
apps are closed or frozen. A frozen UI still cannot accept new user input or
display results. Use a terminal or another responsive client, subject to the
[background worker prerequisites](../README.md#independent-background-workers).

`codex-bridge-setup --check` inspects all saved registrations. Use
`codex-bridge-setup --dry-run` to preview or rerun `codex-bridge-setup` to apply
setup after correcting an incomplete component. Add `.cmd` on Windows and
`--json` for structured output. Local package installs do not run setup.
For a deliberate package-only direct global installation,
`CODEX_BRIDGE_SKIP_SETUP=1` or npm `--ignore-scripts` opts out of setup; this is
separate from the cache-only script suppression in the recommended updater.
Failed setup or update returns a nonzero exit. Inspect the reported component
and installed version, correct the cause, then rerun the same updater command.
npm can roll back package files without restoring settings or command shims.
Explicit setup and `--check` also return a nonzero status until the saved
configuration passes verification.

## Shared project policy

Native Codex/Claude handoffs can read the same optional policy file via
`CODEX_BRIDGE_PROJECT_POLICY`. `bridge-projects` defaults to
`~/.config/GptClaudeBridge/projects.json`. A shared home-directory path avoids
different AppData views in packaged Windows applications. The policy stores
canonical directory identities; do not copy it to a new machine as proof of
authorization there.

Independent background dispatch always requires a matching explicit project
or parent grant from the shared
policy; setup preserves grants and revocations rather than authorizing a new
project. Use `bridge-projects allow-project <absolute-project-path>` for a
selected project (`bridge-projects.cmd` on Windows), or the source commands below.

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

Project grants bind both the project directory and its verified common Git
directory. Revocation preserves repository and registered worktree path
denials even when the original directory or Git metadata disappears or is
replaced. Discovery failures retain saved denials and appear in policy status
as warnings; they cannot leave the original grant enabled. Malformed Git
markers fail closed instead of becoming ordinary folders under parent grants.

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
live communication passed. Project preparation does not approve tools, change
session modes, create conversations or restart clients. The package installer
separately initializes an internal relay executor when needed. Workspace trust
follows Claude's
[documented project settings](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust).

## Correct Code registration

Claude's user-level `codex-bridge` must run under the actual Code session. A
generic shared Desktop process cannot establish that caller's ancestry.
Automatic setup creates or updates the supervised Code entry and safely
renames a recognized shared entry to `codex-bridge-desktop`. Conflicting or
unrecognized entries are reported without overwriting them; custom project
overrides are preserved and reported.

For selective installation, `codex-bridge-code-install --install` creates a
missing Code entry or updates a recognized one. `--install --dry-run` previews
the change. The complete `codex-bridge-setup` command also handles the other
registrations and prerequisites. Neither path copies permissions or login
credentials from another client.

The helper's existing policy migration remains an explicit operation and
previews changes by default. After initializing the desired policy and stopping
Claude and any configuration manager, run:

```sh
codex-bridge-code-install --policy /absolute/path/projects.json
codex-bridge-code-install --policy /absolute/path/projects.json --apply --clients-stopped
codex-bridge-code-install --check
```

Migration backs up and updates an existing supervised entry. This helper's
`--check` diagnoses the optional shared-policy arrangement, including shared or
duplicate entries; use `codex-bridge-setup --check` for the general installation
check. Keep CC Switch or another external configuration manager consistent
with the selected entry so it does not restore an obsolete copy later.

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
