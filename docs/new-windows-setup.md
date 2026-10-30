# Windows setup and initial permissions

Install Node.js 22.13+ and sign in to the apps you intend to use. For native
handoffs, save the local project in Codex Desktop and open the same directory
in Claude Desktop's **Code tab**. Run one PowerShell command:

```powershell
npm.cmd install -g @minhspark/codex-mcp-bridge@latest --allow-scripts=@minhspark/codex-mcp-bridge
```

The `--allow-scripts` value permits only this package's setup hook. npm versions
that block install scripts by default need it; a plain install runs setup only
when scripts are allowed. Add `--foreground-scripts` to see setup progress. If
npm reports `1 package had install scripts blocked`, run the recommended command
again or run `codex-bridge-setup.cmd` explicitly.

The global installation configures the bridges and verifies their saved
registrations. It reuses an available native Codex CLI, or installs a pinned
official package in the current user's `.config\GptClaudeBridge\tools`
directory. It also configures native pipe forwarding and bootstraps the relay
executor. A failed component is reported as incomplete rather than ready. The
package stays installed when an app configuration step fails, so the setup
command remains available for repair. npm success alone does not verify setup.

## Installed entries

| Client | Entry | Purpose |
| --- | --- | --- |
| Codex | `claude-bridge` | Send to Claude and observe replies |
| Codex | `codex-native-relay` | Deliver Claude requests through the Desktop host |
| Claude Code, user scope | `codex-bridge` | Send to Codex and continue reply observation |
| Claude Desktop shared connectors | `codex-bridge-desktop` | Connect ordinary chat to local Codex app-server sessions |
| Codex and Claude Code | `antigravity-bridge` | Send to Antigravity App or bridge-owned CLI sessions |
| Antigravity | `agent-bridge` and `codex-bridge` sidecar | Outbound agent messages and native App connectivity |

The shared `codex-bridge-desktop` connector does not establish a native Code
sender identity. Use the actual Code session for native Codex Desktop work.
Existing project restrictions, permission modes, and custom settings are
preserved. Setup does not sign in, grant workspace trust, or close applications.

After active work finishes, open or reconnect the affected apps so they load
the entries. A conversation refresh may leave the previous MCP process loaded.
Check `codex_bridge_status` inside the sending Claude Code task,
`claude_bridge_status` and `native_relay_status` in Codex, and
`agent_bridge_status` in Antigravity. Configuration verification is separate
from a completed live exchange.

## Checks and recovery

```powershell
codex-bridge-setup.cmd --check
codex-bridge-setup.cmd --dry-run
codex-bridge-setup.cmd
```

The first command inspects configuration; the second previews components and
paths without writes or downloads; the third applies setup again. Add `--json`
for structured output or `--no-download` to require an existing Codex CLI.
Explicit setup and `--check` return a nonzero exit status if configuration is
incomplete.
`codex-mcp-bridge.cmd setup` is an equivalent setup entry point. If Claude Code
has no bridge tools, inspect and reconnect `codex-bridge` using `/mcp` before
attempting delivery.

Local `npm install` and `npm ci` do not configure apps. To opt out during a
global install, set `CODEX_BRIDGE_SKIP_SETUP=1` or use `--ignore-scripts`.
The optional card extension, hosted ChatGPT pairing, and VS Code preview have
separate installation steps.

## If startup still fails

Check the version reported by `codex_bridge_status` in the actual Claude Code
session against the installed package:

```powershell
npm.cmd list -g @minhspark/codex-mcp-bridge --depth=0
```

Also inspect the session's MCP command and script path. A source checkout can
keep an older version running even after npm updates the global package. If
the tool is unavailable, the startup log and configured path identify which
installation Claude tried to load. Rerun setup and reconnect the affected
client after active work finishes before comparing another result.

Setup prepares runtime snapshots in advance. However, a startup message such
as `prepared ... (reused)` means only that the runtime directory already
existed; missing or invalid integrity metadata can still require verification
work. If a 30-second connection timeout persists after the intended global
installation is loaded, collect the runtime version, startup log and exact
timeout. Configuration repair and a reused directory do not prove that the
reported startup delay has been resolved.

Claude may label ordinary startup diagnostics as `Server stderr`, including
`preparing`, `prepared`, and `ready` lines. Check the real connection status and
error rather than treating that label alone as failure. Keep diagnostics off
stdout: MCP uses stdout for protocol messages.

## Optional source installation and project policy

For a pinned source checkout in a stable directory, `node scripts/setup.mjs`
runs the same setup. The individual installers remain available for deliberate
manual configuration. For example, with an available Codex CLI and an explicitly
selected test project:

```powershell
node scripts/bridge-projects.mjs allow-project 'C:\Projects\BridgeTest'
$env:CODEX_BIN = (Get-Command codex.exe).Source
$env:CODEX_EXE = $env:CODEX_BIN
$env:CODEX_BRIDGE_PROJECT_POLICY = Join-Path $env:USERPROFILE '.config\GptClaudeBridge\projects.json'
$env:CODEX_BRIDGE_DESKTOP_TASKS = '1'
$env:CODEX_BRIDGE_AUTOSTART = '0'
node scripts/install-claude-code.mjs --install
node scripts/install-native-relay.mjs
node scripts/install-codex-mcp.mjs
```

`--install` creates a missing Code entry or updates a recognized one;
`--install --dry-run` previews it. For an existing entry with a different scope,
use the explicit policy migration in [project onboarding](project-onboarding.md).
`--check` on that helper checks the optional shared policy arrangement; it is
not the general setup check. Keep CC Switch or another configuration manager
consistent with the saved entries so it does not restore an obsolete copy.

Do not copy login caches, session identities, unfinished receipts or
directory-identity grants from another machine. This guide is not evidence
that a particular second machine or client build has passed live verification.

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
