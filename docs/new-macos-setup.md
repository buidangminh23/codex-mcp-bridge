# New macOS setup

Connect Claude Desktop's **Code tab** and Codex Desktop through local MCP
processes and sockets. Both apps still authenticate with their providers and
use hosted models; local bridge transport does not mean offline inference.

## Local installation: required steps

The [ChatGPT plugin setup](../README.md#chatgpt-plugin) uses a hosted Sites
connector. For a local Desktop installation, use the following path instead:

1. Install and sign in to Codex Desktop and Claude Desktop under the same macOS
   user. Have Node.js 22+, npm, the Codex CLI, and the Claude Code CLI available.
   Save the intended local project in Codex Desktop and open it in Claude's
   Code tab.
2. Follow [macOS installation](../README.md#macos-terminal) to install the bridge
   and register the native relay and reverse bridge. Keep bootstrap enabled on
   the first relay install. Do not use the ChatGPT plugin pairing instructions,
   run `codex-sites-connector`, or configure a hosted endpoint.
3. Follow [Claude Code registration](../README.md#register-claude-code) for the
   forward bridge. Use the intended project directories for
   `CODEX_BRIDGE_ALLOWED_ROOTS`, rather than the example's entire home directory;
   macOS separates multiple roots with `:`. Preserve an existing entry's
   custom settings.
4. Add [native relay pipe forwarding](../README.md#native-relay-pipe-forwarding)
   to the existing relay entry. Forward `CODEX_APP_TOOLS_PIPE_PATH` by name,
   not its temporary value. The relay needs the trusted app-bundled Node runtime
   selected by the installer; do not substitute an arbitrary Homebrew/nvm Node.
5. Reconnect the affected MCP servers in the actual Desktop Code conversations,
   or restart the affected app after active work finishes. Complete
   [installation verification](../README.md#verify-the-installation), including
   a message and reply in each direction.

There are three registrations: `codex-bridge` in Claude Code, and
`claude-bridge` plus `codex-native-relay` in Codex Desktop. The relay is transport
plumbing, not a third agent. Ordinary Claude chat has a separate MCP registry;
adding a server there does not register it in the Code tab.

## Restricted local configuration

Local transport does not require Full Access. Keep the intended sandbox,
approval reviewer, and project restrictions. Before running installers, check
for `$CODEX_HOME/bridge-full-access.enabled` (normally
`~/.codex/bridge-full-access.enabled`): a saved opt-in makes them enable Full
Access even without `--full-access`. Resolve that existing opt-in deliberately
before installing; `CODEX_BRIDGE_ENFORCE_FULL_ACCESS=0` does not disable it.

For a restricted Codex setup, these are top-level configuration settings,
before any `[table]`:

```toml
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
```

Verify the active Desktop task uses the intended restrictions; defaults alone
are not evidence of its effective permissions. To suppress optional reporting,
set `CODEX_BRIDGE_TELEMETRY=0` in all three MCP registrations' environments;
see [telemetry controls](../README.md#optional-active-install-statistics).

For workspace trust, shared project grants, and optional messaging automation,
use [project onboarding](project-onboarding.md). For target selection,
permission mismatches, and uncertain deliveries, use
[daily Desktop handoffs](daily-handoffs.md) and the
[technical reference](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md). Tool discovery or a connected socket
alone does not establish a completed exchange.
