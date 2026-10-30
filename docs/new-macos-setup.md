# New macOS setup

Connect Claude Desktop's **Code tab** and Codex Desktop through local MCP
processes and sockets. Both apps still authenticate with their providers and
use hosted models; local bridge transport does not mean offline inference.

## One-command local installation

The [ChatGPT plugin setup](../README.md#chatgpt-plugin) uses a hosted Sites
connector. For local Desktop use, install Node.js 22.13+ and sign in to the apps
under the same macOS user. Save the intended local project in Codex Desktop and
open it in Claude's Code tab, then run:

```bash
npm install -g @minhspark/codex-mcp-bridge@latest --allow-scripts=@minhspark/codex-mcp-bridge
```

The script allowance applies only to this package's setup hook. npm versions
that block install scripts by default need it; a plain install is sufficient
only when the hook is allowed. Append `--foreground-scripts` to see progress.
If npm reports `1 package had install scripts blocked`, rerun the command above
or run `codex-bridge-setup` explicitly.

Setup registers the local bridges, adds native pipe forwarding, and bootstraps
the relay executor. It reuses an available Codex CLI or installs a pinned
official package under `~/.config/GptClaudeBridge/tools` (or
`XDG_CONFIG_HOME/GptClaudeBridge/tools`). No separate CLI install command is
required. Run the install under the account that uses the apps, without `sudo`.
The package remains installed if an app configuration step fails, preserving
the setup command for repair. A successful npm exit does not verify that every
component is configured.

| Client | Entry | Route |
| --- | --- | --- |
| Claude Code | `codex-bridge` | Native Codex Desktop handoffs |
| Claude Desktop shared connectors | `codex-bridge-desktop` | Local Codex app-server sessions from ordinary chat |
| Codex | `claude-bridge` | Claude Code messages and replies |
| Codex | `codex-native-relay` | Native Desktop transport |
| Codex and Claude Code | `antigravity-bridge` | Antigravity App and bridge-owned CLI sessions |
| Antigravity | `agent-bridge` and `codex-bridge` sidecar | Outbound messaging and native App connectivity |

The shared `codex-bridge-desktop` connector cannot establish a native Code
sender identity. The native route uses the actual Code session and the same
saved local Codex project. Setup does not pair the hosted ChatGPT connector.

The relay needs the trusted app-bundled Node runtime selected by setup; do not
substitute an arbitrary Homebrew/nvm Node. Pipe forwarding saves only the
`CODEX_APP_TOOLS_PIPE_PATH` variable name, never its temporary value.

Open or reconnect the affected MCP servers in the actual Desktop conversations,
or restart the app after active work finishes. Setup does not restart or kill
apps. Check `codex_bridge_status` inside Claude Code, `claude_bridge_status` and
`native_relay_status` in Codex, and `agent_bridge_status` in Antigravity. Complete
[installation verification](../README.md#verify-the-installation), including
a message and reply in each direction. Saved configuration is not a completed
live exchange or a claim of verification on another Mac.

## Checks, recovery, and manual alternatives

```bash
codex-bridge-setup --check
codex-bridge-setup --dry-run
codex-bridge-setup
```

`--check` inspects registrations; `--dry-run` previews components and paths
without downloads or writes; the plain command applies setup again. Add
`--json` for structured output or `--no-download` to require an existing Codex
CLI. `codex-mcp-bridge setup` runs the same setup. An incomplete result identifies
the component to correct before rerunning. Explicit setup and `--check` return
a nonzero exit status while configuration is incomplete.

Local `npm install` and `npm ci` do not change app settings. Set
`CODEX_BRIDGE_SKIP_SETUP=1` or use `--ignore-scripts` to skip setup during a
global install. For Homebrew, run `codex-bridge-setup` after installing the
formula. A pinned source checkout can use `node scripts/setup.mjs`.

The [manual macOS commands](../README.md#macos-terminal) and
[Claude Code registration commands](../README.md#register-claude-code) remain
available for selective configuration. `codex-bridge-code-install --install`
can create a missing user-level Code entry; its existing policy migration mode
is described in [project onboarding](project-onboarding.md). Use intended
project paths when setting explicit `CODEX_BRIDGE_ALLOWED_ROOTS`; macOS
separates them with `:`.

## Restricted local configuration

Local transport does not require Full Access. Automatic setup preserves the
intended sandbox, approval reviewer, project restrictions, and custom modes. It
does not grant workspace trust or tool approval, sign in, or enable permission
bypass. The older individual installers, when run manually without setup mode,
can still honor `$CODEX_HOME/bridge-full-access.enabled` (normally
`~/.codex/bridge-full-access.enabled`); review that saved preference before using
those advanced commands. `CODEX_BRIDGE_ENFORCE_FULL_ACCESS=0` does not delete the
saved preference.

For a restricted Codex setup, these are top-level configuration settings,
before any `[table]`:

```toml
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
```

Verify the active Desktop task uses the intended restrictions; defaults alone
are not evidence of its effective permissions. To suppress optional reporting,
set `CODEX_BRIDGE_TELEMETRY=0` in the bridge MCP registrations' environments;
see [telemetry controls](../README.md#optional-active-install-statistics).

For workspace trust, shared project grants, and optional messaging automation,
use [project onboarding](project-onboarding.md). For target selection,
permission mismatches, and uncertain deliveries, use
[daily Desktop handoffs](daily-handoffs.md) and the
[technical reference](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md). Tool discovery or a connected socket
alone does not establish a completed exchange.
