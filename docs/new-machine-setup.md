# New-machine setup and initial permissions

This is a Windows local Desktop source-install guide, not evidence of testing
on a second machine. Use a pinned source revision containing these scripts;
published npm versions may not yet include this branch. The optional card
extension is distributed separately. Keep the source in a stable directory.

Install/sign in to Codex Desktop and Claude Desktop; install Node 22+ and Git,
and make the Codex CLI available. Record the source revision and optional MCPB
version/hash. Do not copy login caches, old session identities, unfinished
receipts or directory-identity grants from another machine.

## Three messaging entries

| Client | Entry | Purpose |
| --- | --- | --- |
| Codex | `claude-bridge` | Send to Claude and observe replies |
| Codex | `codex-native-relay` | Deliver Claude requests through the Desktop host |
| Claude Code, user scope | `codex-bridge` | Send to Codex and continue reply observation |

Begin with one dedicated test directory and explicitly grant it:

```powershell
node scripts/bridge-projects.mjs allow-project 'C:\Projects\BridgeTest'
```

Merge a user-level Claude Code entry, replacing placeholder paths with actual
absolute paths and preserving unrelated settings:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "C:/Tools/nodejs/node.exe",
      "args": ["C:/Tools/GptClaudeBridge/src/mcp-supervisor.mjs", "index.mjs"],
      "env": {
        "CODEX_BIN": "C:/Tools/Codex/codex.exe",
        "CODEX_BRIDGE_DESKTOP_TASKS": "1",
        "CODEX_BRIDGE_AUTOSTART": "0",
        "CODEX_BRIDGE_PROJECT_POLICY": "C:/Users/<user>/.config/GptClaudeBridge/projects.json",
        "CODEX_BRIDGE_ALLOWED_ROOTS": "C:/Projects/BridgeTest",
        "CODEX_BRIDGE_THREAD_POLICY": "roots",
        "CODEX_BRIDGE_APPROVAL_POLICY": "on-request",
        "CODEX_BRIDGE_SANDBOX": "workspace-write"
      }
    }
  }
}
```

Then run `node scripts/install-claude-code.mjs --check`. That helper migrates or
checks an existing supervised entry; it does not create a first entry from
nothing. See [project onboarding](project-onboarding.md) for migration.

Configure the same policy for Codex using the repository installers:

```powershell
$env:CODEX_BRIDGE_PROJECT_POLICY = Join-Path $env:USERPROFILE '.config\GptClaudeBridge\projects.json'
$env:CODEX_BRIDGE_DESKTOP_TASKS = '1'
node scripts/install-native-relay.mjs
node scripts/install-codex-mcp.mjs
```

If discovery fails, set `CODEX_EXE` to the real CLI executable. Relay setup may
create an initial relay task. Do not add a permission-bypass mode. If CC Switch
manages the entries, save the same configuration there. Reload affected clients
and inspect the tools inside the actual Code/dispatch conversations.

## Permissions are separate

- Prepare workspace trust for the explicitly selected project using
  `prepare_bridge_project`; verify with `inspect_bridge_project`.
- Grant specific communication projects or parents, not all local projects by
  default. A card extension's grants are separate. Denials take precedence.
- If the user opts into automatic messaging, preview and apply
  `configure-message-automation.mjs` as described in the onboarding guide. It
  permits only the exact send/wait tools and preserves other host checks.

If card management is wanted, select its precise tools independently in the
actual Code permission configuration. Do not assume ordinary-chat connector
settings apply to Code, or that a query/authorization allow rule includes card
startup, cleanup or permanent deletion. `ready=true` is not host approval.

For a compatible optional card extension, install its MCPB and run
`node scripts/bridge-projects.mjs register-card-settings`. Verify separate card
and communication lists in its original settings page. Do not edit Claude's
private settings file to force a UI refresh. A local launcher using
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`
helped background card redraw on the measured machine, but must be retested on
each client build. Remote Control is not required.

## One small end-to-end acceptance

Create one Claude collaboration parent from the intended Code project sidebar
and verify its real cwd first; see [daily handoffs](daily-handoffs.md).

1. Check both identities, target projects and normal tool permissions.
2. Send Codex-to-Claude and automatically receive the exact complete answer.
3. Send Claude-to-Codex; also test one accepted timeout followed by automatic
   continuation with the same receipt and no second send.
4. In the authorized test directory, create, read back and delete one clearly
   named test file. Respect normal file-operation approval.
5. If using cards, verify local and worktree startup, parent/child identity,
   directory, branch, Remote Control off and no duplicate on repeated startup.
6. Revoke and restore test-only card authorization, checking UI and effective
   state while communication grants remain unchanged. Run another normal task.

Record incomplete steps instead of calling tool discovery a full pass. Before
upgrading, back up configuration and receipts without publishing personal data.
Archive historical files with an inventory; verify dependencies and unique
worktree changes before deletion. Conversation archival does not prove that
its checkout or branch was removed.
