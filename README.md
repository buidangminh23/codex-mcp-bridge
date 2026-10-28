<p align="center">
  <img src="assets/agent-pets.svg" width="240" height="220" alt="Claude, Codex, and Antigravity connected by curved two-way arrows" />
</p>

<h1 align="center">codex-mcp-bridge</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@minhspark/codex-mcp-bridge"><img src="https://img.shields.io/npm/v/@minhspark/codex-mcp-bridge?logo=npm&amp;color=CB3837" height="20" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@minhspark/codex-mcp-bridge"><img src="https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/stats-npm-downloads.svg" height="20" alt="npm downloads" /></a>
  <a href="https://www.npmcharts.com/compare/%40minhspark%2Fcodex-mcp-bridge?minimal=true"><img src="https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/stats-npm-downloads-month.svg" height="20" alt="npm downloads / month" /></a>
  <br />
  <a href="https://github.com/buidangminh23/codex-mcp-bridge/network/dependents"><img src="https://img.shields.io/librariesio/dependent-repos/npm/@minhspark/codex-mcp-bridge?label=Used%20by&amp;logo=github&amp;color=0969da" height="20" alt="Used by repositories (Libraries.io)" /></a>
  <a href="https://skills.sh/buidangminh23/codex-mcp-bridge/codex-bridge"><img src="https://skills.sh/b/buidangminh23/codex-mcp-bridge?label=skills.sh" height="20" alt="skills.sh installs" /></a>
  <a href="https://buidangminh23.github.io/codex-mcp-bridge/"><img src="https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/stats-github-views.svg" height="20" alt="GitHub views / source window" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@minhspark/codex-mcp-bridge" height="20" alt="license" /></a>
</p>

Connect **Claude, Codex, and Antigravity** through MCP, keeping work in each agent's own app and preserving native identity and permission checks. Supports Windows, macOS, and Linux; native Desktop integration supports Windows and macOS.

The optional **Antigravity bridge** sends work both ways between existing Desktop conversations in the same project. Codex and Claude can also start and continue bridge-owned Antigravity CLI streaming sessions. Antigravity App replies remain in the App; outbound calls from Antigravity CLI are not supported. [Setup and current limits](#antigravity-app-and-cli).

https://github.com/user-attachments/assets/98b23989-826f-4d7d-9dcb-ad7dd2739095

## Installation

```bash
npm install -g @minhspark/codex-mcp-bridge@latest
```

Requires **Node.js 22.13+**. In Windows PowerShell, use `npm.cmd` instead of `npm`. Run the same command to update; reconnect MCP servers if their settings or installation paths changed.

On macOS or Linux you can install with [Homebrew](https://github.com/buidangminh23/homebrew-tap) instead, which brings its own Node.js:

```bash
brew install buidangminh23/tap/codex-mcp-bridge
```

Update with `brew upgrade codex-mcp-bridge`. The installers record Homebrew's stable `opt` paths, so registrations keep working after an upgrade and running bridges reload the new version. Keep one install channel: whichever of npm or Homebrew comes first on `PATH` provides the commands.

[Windows](#windows-powershell) · [macOS](#macos-terminal) · [Linux / WSL](#linux--wsl-bash) · [ChatGPT plugin](#chatgpt-plugin)

### Antigravity App and CLI

Install and sign in to the Antigravity App and/or `agy` CLI, then run:

```bash
antigravity-mcp-bridge-install --all
```

Use `.cmd` on Windows. Select `--codex`, `--claude`, or `--desktop` to install individual components; `--dry-run` previews changes. The installer preserves unrelated configuration and native permissions. Reload Codex/Claude to load the new MCP server. Antigravity launches its own sidecar from `~/.gemini/config/sidecars/codex-bridge/sidecar.json`; do not run that sidecar manually or copy authentication environment variables between processes.

| Tool | Behavior |
| --- | --- |
| `antigravity_bridge_status` | Reports native sidecar connectivity and CLI capabilities. |
| `list_antigravity_conversations` | Lists the selected surface in the verified sender's exact project directory. |
| `send_to_antigravity_conversation` | Sends to an exact existing App conversation or a CLI session owned by this bridge. |
| `start_antigravity_cli_session` | Starts an explicitly authorized CLI streaming session with its initial prompt. |
| `read_antigravity_delivery` | Reads the original receipt without resending. |
| `close_antigravity_cli_session` | Closes an idle CLI session owned by the sender. |

Generate a new `requestId` UUID for each intentional delivery and reuse it only when inspecting or retrying that same delivery. A pending or unknown receipt must be inspected before further action. Receipts survive process restarts; live CLI processes do not. A CLI timeout retains its conversation identity for inspection. No mode or permission-bypass flag is added; headless tool requests requiring interaction may be denied by Antigravity.

The App adapter uses the official [sidecar `agentapi`](https://antigravity.google/docs/sidecars), verifies native workspace metadata, and refuses busy or ambiguous destinations. An App `accepted` receipt confirms native acceptance, not a completed agent reply. Open the exact App conversation to read its response. The CLI adapter uses the official [streaming JSON interface](https://antigravity.google/docs/cli/headless) and returns the agent's final result. It creates bridge-owned headless sessions; it does not attach to an already running interactive terminal. The two surfaces never substitute for one another.

The installer also registers **agent-bridge inside Antigravity Desktop** in `~/.gemini/config/mcp_config.json`. Reload the App after installation to discover it. From an Antigravity conversation, ask the agent to check `agent_bridge_status`, call `list_agent_tasks` for `codex` or `claude`, then use `send_to_agent_task` with the exact destination ID, project directory, prompt, and a fresh request UUID. Claude destinations also require their native `taskId`. Read `read_agent_delivery` without resending; `read_agent_task` reads the selected Codex task's response or Claude's native task metadata.

Outbound calls verify Antigravity's per-call MCP metadata, Desktop process ancestry, native workspace/project, and effective permission settings. The sender is attributed as Antigravity. Codex keeps its native task settings; Claude's inbound policy and permission-class checks remain in effect. A socket write to Claude is `sent_unconfirmed`, not acceptance or completion. After MCP restart, a saved receipt remains available but live Claude reply tracking may be unavailable; inspect the exact native task before further action.

Outbound support targets existing local Codex tasks and live Claude Desktop Code sessions in the same project. Nested Antigravity callers, outbound CLI callers, App conversation creation, and automatic App reply forwarding are not implemented. Windows Desktop is the live verification platform; macOS ancestry has unit coverage and Linux outbound host verification fails closed. The existing Codex↔Claude bridge remains separate. Use `antigravity-mcp-bridge-install --all --remove` to remove only these registrations; delivery receipts are retained.

### Windows (PowerShell)

Install and sign in to [Codex Desktop](https://developers.openai.com/codex/app) and [Claude Desktop](https://claude.com/download). Save the project in Codex Desktop and open the same directory in Claude Desktop's **Code tab**. Have the Codex and Claude Code CLIs available.

If the Codex CLI is missing, run `winget install --id OpenAI.Codex --exact`, open a new terminal, then run `codex.exe login`.

```powershell
$env:CODEX_EXE = (Get-Command codex.exe).Source
codex-native-relay-install.cmd --desktop-tasks
codex-mcp-bridge-install.cmd --desktop-tasks
$env:CODEX_BRIDGE_DESKTOP_TASKS = "1"
claude-mcp-bridge-install.cmd
```

Next: [register Claude Code](#register-claude-code), add [relay pipe forwarding](#native-relay-pipe-forwarding), then [verify](#verify-the-installation).

### macOS (Terminal)

Install and sign in to Codex Desktop and Claude Desktop. Save the project in Codex Desktop and open the same directory in Claude Desktop's **Code tab**.

```bash
npm install -g @openai/codex@latest
codex login
codex-native-relay-install --desktop-tasks
codex-mcp-bridge-install --desktop-tasks
CODEX_BRIDGE_DESKTOP_TASKS=1 claude-mcp-bridge-install
```

Keep bootstrap enabled on the first relay install. Next: [register Claude Code](#register-claude-code), add [relay pipe forwarding](#native-relay-pipe-forwarding), then [verify](#verify-the-installation).

### Register Claude Code

Claude Desktop and Claude Code have separate MCP registrations. If `claude --version` is unavailable, [install Claude Code](https://code.claude.com/docs/en/setup) first. For a new registration, replace the example project path below with the actual directory. Preserve custom settings if `codex-bridge` is already registered.

<details>
<summary>Windows PowerShell</summary>

```powershell
$bridgeRoot = Join-Path ((npm.cmd root -g).Trim()) '@minhspark/codex-mcp-bridge'
claude mcp add --scope user codex-bridge `
  -e "CODEX_BIN=$((Get-Command codex.exe).Source)" `
  -e CODEX_BRIDGE_DESKTOP_TASKS=1 `
  -e CODEX_BRIDGE_AUTOSTART=0 `
  -e CODEX_BRIDGE_THREAD_POLICY=roots `
  -e "CODEX_BRIDGE_ALLOWED_ROOTS=C:\Projects\YourProject" `
  -- (Get-Command node.exe).Source (Join-Path $bridgeRoot 'src/mcp-supervisor.mjs') index.mjs
```

</details>

<details>
<summary>macOS Terminal</summary>

```bash
bridge_root="$(npm root -g)/@minhspark/codex-mcp-bridge"
claude mcp add --scope user codex-bridge \
  -e CODEX_BIN="$(command -v codex)" \
  -e CODEX_BRIDGE_DESKTOP_TASKS=1 \
  -e CODEX_BRIDGE_AUTOSTART=0 \
  -e CODEX_BRIDGE_THREAD_POLICY=roots \
  -e CODEX_BRIDGE_ALLOWED_ROOTS="$HOME/YourProject" \
  -- "$(command -v node)" "$bridge_root/src/mcp-supervisor.mjs" index.mjs
```

For a Homebrew install, use the stable paths instead of `npm root -g` and `command -v node`:

```bash
bridge_root="$(brew --prefix)/opt/codex-mcp-bridge/libexec/lib/node_modules/@minhspark/codex-mcp-bridge"
node_bin="$(brew --prefix)/opt/node/bin/node"
```

and end the command with `-- "$node_bin" "$bridge_root/src/mcp-supervisor.mjs" index.mjs`.

</details>

Separate multiple allowed directories with `;` on Windows or `:` on macOS/Linux.

### Native relay pipe forwarding

On Windows and macOS, `codex-native-relay-install` adds this to the relay's entry in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) and keeps its other settings:

```toml
[mcp_servers.codex-native-relay]
env_vars = ["CODEX_APP_TOOLS_PIPE_PATH"]
```

If you register the relay by hand, add the same line and append the variable name if `env_vars` already exists. Only the name is saved, never the temporary pipe path. Restart Codex Desktop after active work finishes so it relaunches the relay.

### Linux / WSL (Bash)

Use Node.js 22+ and signed-in Codex and Claude Code CLIs under the same Linux user. This mode uses a local app-server; native Desktop integration requires Windows or macOS.

<details>
<summary>CLI registration commands</summary>

```bash
npm install -g @openai/codex@latest
codex login
CODEX_BRIDGE_DESKTOP_TASKS=0 claude-mcp-bridge-install
bridge_root="$(npm root -g)/@minhspark/codex-mcp-bridge"
claude mcp add --scope user codex-bridge \
  -e CODEX_BIN="$(command -v codex)" \
  -e CODEX_BRIDGE_DESKTOP_TASKS=0 \
  -e CODEX_BRIDGE_AUTOSTART=1 \
  -e CODEX_BRIDGE_THREAD_POLICY=roots \
  -e CODEX_BRIDGE_ALLOWED_ROOTS="$HOME/YourProject" \
  -- "$(command -v node)" "$bridge_root/src/mcp-supervisor.mjs" index.mjs
```

Replace `$HOME/YourProject` with the actual project directory. WSL and Windows use separate paths and registrations.

</details>

### Verify the installation

Reconnect the affected MCP servers in the actual client tasks; Claude Code provides `/mcp`. Run these **MCP tools** inside the apps:

| Client | Tool |
|---|---|
| Claude Code | `codex_bridge_status` |
| Codex | `claude_bridge_status` |
| Codex Desktop | `native_relay_status` |

Send a short message and confirm its reply **in both directions**. Registration alone does not prove delivery.

## Use

- **Claude → Codex:** “Send this review to my Codex task in this project and wait for its reply.”
- **Codex → Claude:** “Send this result to my Claude Desktop Code session in this project.”
- **Codex → Codex on another computer:** configure an SSH project mapping, then use `remote_codex` to list, read or message an existing Desktop task. Different Codex accounts on the two computers are supported. See [remote Codex setup](REFERENCE.md#codex-to-codex-over-ssh).
- **New work:** “Create a new Codex conversation for this feature and send the brief there.”

Continue unfinished work with its original `threadId`. For an authorized new Desktop task, use `delegate_to_codex` or `start_codex_thread` with a fresh UUID `requestId`; retain that ID on retries. If a send times out, use `wait_codex_reply` with the original `deliveryId` before retrying the message.

[Daily handoffs](docs/daily-handoffs.md) · [Project permissions](docs/project-onboarding.md) · [All tools and settings](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md)

## ChatGPT plugin

[Open Codex Bridge](https://codex-mcp-bridge.buidangminh23.chatgpt.site) to connect ChatGPT to a selected project on a Windows or macOS computer. After installing the package and native relay above, pair the connector:

```bash
codex-sites-connector --pair --site https://codex-mcp-bridge.buidangminh23.chatgpt.site --roots "/absolute/project/path"
```

In PowerShell use `codex-sites-connector.cmd` and a Windows path such as `C:\Projects\YourProject`. Open the printed pairing URL, sign in, and select **Connect this computer**. Keep Codex Desktop and the connector running; use `codex-sites-connector` to reconnect later.

The MCP endpoint is `https://codex-mcp-bridge.buidangminh23.chatgpt.site/mcp`. Plugin availability follows [OpenAI's Sites access rules](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites); a public directory listing is not claimed.

<details>
<summary>Hosted data and privacy</summary>

The service is operated by Bui Dang Minh on OpenAI Sites. It stores a Site-scoped account ID, connector ID and token hash, timestamps, tool arguments (including prompts), and returned Desktop results. The operator can access these records. Local credentials and receipts stay in `~/.codex/sites-bridge`.

Dispatch expires after two minutes; operation history remains stored. Disconnecting revokes the connector and cancels queued work, but does not erase history or stop dispatched tasks. For deletion requests, contact the operator through the repository's support link without posting private content publicly. The hosted Worker implements no advertising or analytics collection.

</details>

## Troubleshooting

- **Command missing:** open a new terminal and check Node.js 22+ and the global npm directory (or Homebrew's `bin`) on PATH.
- **PowerShell blocks scripts:** use `npm.cmd`, installer `.cmd` launchers, and `codex.exe`.
- **No sessions or wrong project:** open the intended Claude **Code** session and use the exact project directory saved in Codex Desktop.
- **Relay unavailable:** Codex Desktop runs the relay only while a task has its MCP servers loaded. On macOS the bridge opens the destination task (or your project's latest Codex task) in the background to start it; otherwise open a regular project task and send it a turn. If it still fails, check [pipe forwarding](#native-relay-pipe-forwarding) and run `native_relay_status` in that task.
- **Timeout or unconfirmed send:** inspect the original task or receipt before sending again.

[More fixes](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md#troubleshooting) · [Report an issue](https://github.com/buidangminh23/codex-mcp-bridge/issues)

## Optional active-install statistics

Usage reporting is **off by default**. Manage it with `codex-mcp-bridge telemetry enable`, `telemetry status`, or `telemetry disable`. Reports contain a random installation ID, UTC day, version, and OS; no chat content, paths, account identity, or credentials. `DO_NOT_TRACK=1` or `CODEX_BRIDGE_TELEMETRY=0` disables reporting. Disabling removes the local ID; submitted records expire after 90 days during ingestion.

[Analytics dashboard](https://buidangminh23.github.io/codex-mcp-bridge/) · [Release notes](https://github.com/buidangminh23/codex-mcp-bridge/releases) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
