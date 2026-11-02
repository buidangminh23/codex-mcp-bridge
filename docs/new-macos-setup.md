# New macOS setup

Connect native Desktop conversations through local MCP processes and sockets,
or use independent Claude, Codex and Antigravity CLI workers. Both routes use
provider authentication and hosted models; local bridge transport does not mean
offline inference.

## One-command local installation

The [ChatGPT plugin setup](../README.md#chatgpt-plugin) uses a hosted Sites
connector. Install Node.js 22.13+ under the macOS account that will use the
bridges. Native handoffs require signed-in apps and the same local project saved
in Codex Desktop and Claude's Code tab. Independent background workers use
separately authenticated provider CLIs and do not require open Desktop apps.
Use the same command for a fresh installation and every update:

```bash
npm exec --yes --ignore-scripts --package=@minhspark/codex-mcp-bridge@latest -- codex-bridge-update
```

npm downloads the latest updater into its cache. `--ignore-scripts` suppresses
setup in that temporary location. The updater installs its exact resolved
version globally with lifecycle scripts disabled, runs managed setup directly
using Node and verifies the global version and configuration. No second installation or
setup command is required. Existing disabled choices, authentication and custom
project grants are preserved; the updater does not open apps or chats or kill
processes. A pending service migration is reported instead of interrupting work.

Setup registers the local bridges, adds native pipe forwarding, and bootstraps
the relay executor. It reuses an available Codex CLI or installs a pinned
official package under `~/.config/GptClaudeBridge/tools` (or
`XDG_CONFIG_HOME/GptClaudeBridge/tools`). No separate Codex CLI install command
is required. Run the install under the account that uses the apps, without `sudo`.
If setup or update exits nonzero, inspect the reported component and installed
version, correct the cause, and rerun the same updater command. A completed
package installation is preserved when managed setup fails.

The command also installs an independent per-user LaunchAgent for separate
Claude, Codex and Antigravity CLI workers and updates its managed settings on
each release. It registers worker communication and adds only Antigravity's four
relay tool grants, preserving existing denials, disabled choices and unrelated
settings. Install Claude Code and `agy` separately when those workers are needed;
CLI authentication is separate from Desktop sign-in.

With authenticated CLIs and an authorized project, `send_to_worker` supports
all six worker-to-worker directions independently of closed or frozen Desktop
apps. The operating system and user service must be running; network/provider
access, quota and tool permissions still apply. A frozen window cannot accept
new user input or show results until it responds. Use `worker-relay` in a terminal
or another responsive MCP client to submit authorized background work and read
receipts. These workers do not resume native chats or launch Desktop windows.

Use `worker-relay status` to inspect service and CLI readiness separately, and
`read_worker_delivery` for durable results. Authorize a selected project with
`bridge-projects allow-project <absolute-project-path>` before sending work if
it has no existing grant.

| Client | Entry | Route |
| --- | --- | --- |
| Claude Code | `codex-bridge` | Native Codex Desktop handoffs |
| Claude Desktop shared connectors | `codex-bridge-desktop` | Local Codex app-server sessions from ordinary chat |
| Codex | `claude-bridge` | Claude Code messages and replies |
| Codex | `codex-native-relay` | Native Desktop transport |
| Codex and Claude Code | `antigravity-bridge` | Antigravity App and bridge-owned CLI sessions |
| Antigravity | `agent-bridge` and `codex-bridge` sidecar | Outbound messaging and native App connectivity |
| Independent CLI workers | `worker-relay` | Authorized background jobs and all six worker-to-worker directions |

The shared `codex-bridge-desktop` connector cannot establish a native Code
sender identity. The native route uses the actual Code session and the same
saved local Codex project. Setup does not pair the hosted ChatGPT connector.

The native Codex relay needs the trusted app-bundled Node runtime selected by
setup; do not substitute an arbitrary Homebrew/nvm Node. Pipe forwarding saves
only the `CODEX_APP_TOOLS_PIPE_PATH` variable name, never its temporary value.

Managed MCP supervisors adopt compatible updates when idle. An old direct MCP
process remains stale until its host reconnects normally; setup does not open
or create chats, restart apps or interrupt active work to load a relay. When the
tools are available, check `codex_bridge_status` inside Claude Code,
`claude_bridge_status` and `native_relay_status` in Codex, and
`agent_bridge_status` in Antigravity. Follow
[installation verification](../README.md#verify-the-installation) for each
selected native or background route. Saved configuration is not a completed live
exchange or a claim of verification on another Mac.

## Checks, recovery, and manual alternatives

```bash
codex-bridge-setup --check
codex-bridge-setup --dry-run
codex-bridge-setup
```

These are optional configuration-only checks and repairs after installation.
`--check` inspects registrations; `--dry-run` previews components and paths
without downloads or writes; the plain command applies setup again. Add
`--json` for structured output or `--no-download` to require an existing Codex
CLI. `codex-mcp-bridge setup` runs the same setup. An incomplete result identifies
the component to correct before rerunning. Explicit setup and `--check` return
a nonzero exit status while configuration is incomplete.

Local `npm install` and `npm ci` do not change app settings. For a deliberate
package-only installation, a direct global npm install can use
`CODEX_BRIDGE_SKIP_SETUP=1` or `--ignore-scripts`; the complete updater runs
managed setup directly after package installation. For Homebrew, run
`codex-bridge-setup` after installing the formula. A pinned source checkout can
use `node scripts/setup.mjs`.

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
