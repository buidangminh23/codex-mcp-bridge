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

One global npm command installs the package and configures the local Claude, Codex, and Antigravity bridges. Install and sign in to the apps you intend to use first. Setup preserves existing project restrictions and custom settings; it does not sign in, grant workspace trust, change permission modes, or restart running apps.

### Package — npm

**macOS / Linux / WSL**

```bash
npm install -g @minhspark/codex-mcp-bridge@latest --allow-scripts=@minhspark/codex-mcp-bridge
```

**Windows PowerShell**

```powershell
npm.cmd install -g @minhspark/codex-mcp-bridge@latest --allow-scripts=@minhspark/codex-mcp-bridge
```

Requires **Node.js 22.13+**. Use `.cmd` for this package's commands in Windows PowerShell. Run the same command to update. The global install runs setup automatically and verifies the saved registrations. If a native Codex CLI is missing, setup installs a pinned official `@openai/codex` package in the current user's `~/.config/GptClaudeBridge/tools` (or the corresponding `XDG_CONFIG_HOME` path); no separate CLI install command is needed.

`--allow-scripts=@minhspark/codex-mcp-bridge` authorizes only this package's setup hook. npm versions that block install scripts by default need this flag; a plain install works only when the hook is allowed. Add `--foreground-scripts` to the command to see setup progress because npm may hide lifecycle output. If npm prints `1 package had install scripts blocked`, rerun the recommended command or run `codex-bridge-setup` explicitly.

| Client | Installed entry | Purpose |
| --- | --- | --- |
| Claude Code | `codex-bridge` | Native Codex Desktop handoffs on Windows/macOS; local app-server mode on Linux |
| Claude Desktop shared connectors | `codex-bridge-desktop` | Local Codex app-server sessions from ordinary chat |
| Codex | `claude-bridge` | Send to Claude and observe replies |
| Codex Desktop, Windows/macOS | `codex-native-relay` | Native delivery, pipe forwarding, and relay executor bootstrap |
| Codex and Claude Code | `antigravity-bridge` | Send to Antigravity App or bridge-owned CLI sessions |
| Antigravity | `agent-bridge` and `codex-bridge` sidecar | Outbound agent messages and native App connectivity |

After setup, open or reconnect the affected apps after active work finishes. For native Claude-to-Codex handoffs, use Claude Desktop's **Code tab** and the same local project saved in Codex Desktop. The shared `codex-bridge-desktop` connector has its own legacy route; it does not establish a native Code sender identity. Saved configuration is not proof of a live connection. Complete [verification](#verify-the-installation) in the actual clients.

Automatic setup runs only for a **global npm install**. Local `npm install` and `npm ci` do not change app settings. Set `CODEX_BRIDGE_SKIP_SETUP=1`, or pass `--ignore-scripts`, to install the package without configuring apps. The optional [workflow skill](#workflow-skill--npx-skills), VS Code preview, and hosted ChatGPT pairing retain their separate setup steps.

### Setup recovery and checks

If an app configuration step fails, the npm install retains the package and its commands so setup can be repaired. A successful npm exit alone does not mean all registrations are configured. If setup reports an incomplete component, correct its reported issue and rerun:

```bash
codex-bridge-setup
```

On Windows use `codex-bridge-setup.cmd`. `codex-mcp-bridge setup` is an equivalent entry point. Repeated setup keeps existing settings and reports conflicts rather than overwriting unrelated registrations.

```bash
codex-bridge-setup --check
codex-bridge-setup --dry-run
```

`--check` inspects saved registrations without sending work. Explicit setup and `--check` exit with a nonzero status when configuration is incomplete. `--dry-run` lists planned components and configuration paths without downloads or writes. Add `--json` for structured output, or `--no-download` to require an already available Codex CLI. Setup never labels a saved registration as a verified live exchange.

### Package — Homebrew

On macOS or Linux you can install with [Homebrew](https://github.com/buidangminh23/homebrew-tap) instead, which brings its own Node.js:

```bash
brew install buidangminh23/tap/codex-mcp-bridge
```

**Homebrew — update**

```bash
brew upgrade codex-mcp-bridge
```

Run `codex-bridge-setup` after installing through Homebrew. The installers record Homebrew's stable `opt` paths, so registrations keep working after an upgrade and running bridges reload compatible code changes. Keep one install channel: whichever of npm or Homebrew comes first on `PATH` provides the commands.

[Windows](#windows-powershell) · [macOS](#macos-terminal) · [Claude Code](#register-claude-code) · [Antigravity](#antigravity-app-and-cli) · [VS Code](#vs-code-extensions--windows-preview) · [Linux / WSL](#linux--wsl-bash) · [NPX Skills](#workflow-skill--npx-skills) · [ChatGPT plugin](#chatgpt-plugin)

| Integration | Setup |
| --- | --- |
| Claude Desktop Code → Codex Desktop | Automatic native setup on Windows/macOS |
| Claude Code CLI → local Codex app-server | Automatic on Linux; optional manual CLI mode on Windows/macOS |
| Claude Desktop shared MCP → local Codex app-server | Automatic `codex-bridge-desktop` registration |
| Codex → Claude Desktop Code | Automatic `claude-bridge` registration |
| Codex / Claude Desktop Code → Antigravity App or CLI | Automatic Antigravity registrations |
| Antigravity App → Codex / Claude Desktop Code | Automatic outbound registration and sidecar |
| Claude Code ↔ Codex inside VS Code | Separate Windows preview registrations below |
| ChatGPT → paired Codex Desktop | Hosted plugin plus `codex-sites-connector --pair` |

### Antigravity App and CLI

The global npm setup registers all Antigravity components. Install and sign in to the Antigravity App and/or `agy` CLI to use them. The following commands are optional for selective manual setup or repair:

```bash
antigravity-mcp-bridge-install --all
```

**Windows PowerShell — all components**

```powershell
antigravity-mcp-bridge-install.cmd --all
```

**Codex → Antigravity App / CLI**

```bash
antigravity-mcp-bridge-install --codex
```

**Claude Desktop Code → Antigravity App / CLI**

```bash
antigravity-mcp-bridge-install --claude
```

**Antigravity App sidecar and outbound bridge**

```bash
antigravity-mcp-bridge-install --desktop
```

**Preview the installation without changing configuration**

```bash
antigravity-mcp-bridge-install --all --dry-run
```

Use `.cmd` for each command on Windows. `--all` includes all three components; the individual commands are alternatives when only some clients are needed. The installer preserves unrelated configuration and native permissions. Reload Codex/Claude to load the new MCP server. Antigravity launches its own sidecar from `~/.gemini/config/sidecars/codex-bridge/sidecar.json`; do not run that sidecar manually or copy authentication environment variables between processes.

The `agy` CLI must be installed and signed in separately. CLI sessions are started through the `start_antigravity_cli_session` MCP tool; there is no separate `--cli` installer flag. Set `ANTIGRAVITY_CLI_BIN` to the absolute `agy` executable path in the MCP server environment if automatic discovery cannot find it.

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

Install and sign in to [Codex Desktop](https://developers.openai.com/codex/app) and [Claude Desktop](https://claude.com/download). Save the project in Codex Desktop and open the same directory in Claude Desktop's **Code tab**. The [global npm command](#package--npm) configures both apps, the shared `codex-bridge-desktop` connector, and Antigravity. Then [verify](#verify-the-installation).

<details>
<summary>Optional manual native setup</summary>

These advanced commands require an existing Codex CLI on PATH. If it is missing, use `codex-bridge-setup.cmd` to resolve or install it automatically. A separately managed CLI can instead be installed with `winget install --id OpenAI.Codex --exact` and signed in with `codex.exe login`.

```powershell
$env:CODEX_EXE = (Get-Command codex.exe).Source
codex-native-relay-install.cmd --desktop-tasks
$env:CODEX_BRIDGE_DESKTOP_TASKS = "1"
claude-mcp-bridge-install.cmd
```

For manual setup, also [register Claude Code](#register-claude-code) and check [relay pipe forwarding](#native-relay-pipe-forwarding).

</details>

### macOS (Terminal)

Install and sign in to Codex Desktop and Claude Desktop. Save the project in Codex Desktop and open the same directory in Claude Desktop's **Code tab**. Run the [global npm command](#package--npm), then [verify](#verify-the-installation). Setup selects the trusted app-bundled relay runtime when available and initializes the relay executor.

<details>
<summary>Optional manual native setup</summary>

```bash
npm install -g @openai/codex@latest
codex login
codex-native-relay-install --desktop-tasks
CODEX_BRIDGE_DESKTOP_TASKS=1 claude-mcp-bridge-install
```

Keep bootstrap enabled on the first manual relay install. Also [register Claude Code](#register-claude-code) and check [relay pipe forwarding](#native-relay-pipe-forwarding).

</details>

### Register Claude Code

Global npm setup creates the user-level Code registration automatically. Claude Desktop and Claude Code have separate MCP registrations. The commands below are optional manual alternatives; they require the [Claude Code CLI](https://code.claude.com/docs/en/setup). Replace the example project path with the actual directory and preserve custom settings if `codex-bridge` is already registered.

Native Desktop handoffs require a verified Claude Desktop **Code** session. A shared Desktop chat MCP registration cannot establish that sender identity. Automatic setup safely renames a recognized shared `codex-bridge` entry to `codex-bridge-desktop`, retaining its contents, so it cannot shadow the Code registration. A conflicting target or unknown entry is reported for review. For manual edits, close Claude first and keep the two entry names distinct.

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

For a Homebrew install, use this complete command with stable `opt` paths instead:

```bash
bridge_root="$(brew --prefix)/opt/codex-mcp-bridge/libexec/lib/node_modules/@minhspark/codex-mcp-bridge"
node_bin="$(brew --prefix)/opt/node/bin/node"
claude mcp add --scope user codex-bridge \
  -e CODEX_BIN="$(command -v codex)" \
  -e CODEX_BRIDGE_DESKTOP_TASKS=1 \
  -e CODEX_BRIDGE_AUTOSTART=0 \
  -e CODEX_BRIDGE_THREAD_POLICY=roots \
  -e CODEX_BRIDGE_ALLOWED_ROOTS="$HOME/YourProject" \
  -- "$node_bin" "$bridge_root/src/mcp-supervisor.mjs" index.mjs
```

</details>

Separate multiple allowed directories with `;` on Windows or `:` on macOS/Linux.

`codex-bridge-code-install --install` now creates or updates the supervised Code entry; `--install --dry-run` previews it. The complete `codex-bridge-setup` command also supplies the other registrations and prerequisites. The helper's existing `--check` and policy migration modes remain available; see [project onboarding](docs/project-onboarding.md).

### Claude Desktop shared MCP — legacy option

Global setup includes this connector as **`codex-bridge-desktop`** in Claude Desktop's shared MCP configuration. It connects ordinary chat to local Codex app-server sessions. For verified handoffs into Codex Desktop conversations, use the Code-tab route above. The following commands are optional manual alternatives and require an available, signed-in Codex CLI.

**Windows PowerShell**

```powershell
$env:CODEX_EXE = (Get-Command codex.exe).Source
$env:CODEX_BRIDGE_DESKTOP_TASKS = "0"
$env:CODEX_BRIDGE_AUTOSTART = "1"
codex-mcp-bridge-install.cmd --entry-name codex-bridge-desktop
```

**macOS Terminal**

```bash
CODEX_BRIDGE_DESKTOP_TASKS=0 CODEX_BRIDGE_AUTOSTART=1 codex-mcp-bridge-install --entry-name codex-bridge-desktop
```

Close and reopen Claude after active work finishes to load changed shared configuration. A fresh `--entry-name codex-bridge-desktop` registration defaults to legacy mode even when the native relay is configured. Existing custom modes are preserved. `--desktop-tasks` does not make a shared Desktop chat server a verified Code sender.

### VS Code extensions — Windows preview

For existing Claude Code and Codex extension conversations inside the same VS Code project, register the separate preview bridge in both clients. Install the npm package first and replace the example root with the real project directory. These registrations preserve extension sender checks and do not provide Desktop access.

```powershell
$bridgeRoot = Join-Path ((npm.cmd root -g).Trim()) '@minhspark/codex-mcp-bridge'
$nodeBin = (Get-Command node.exe).Source
$projectRoot = 'C:\Projects\YourProject'
claude mcp add --scope user codex-vscode-bridge `
  -e "VSCODE_BRIDGE_ALLOWED_ROOTS=$projectRoot" `
  -- $nodeBin (Join-Path $bridgeRoot 'src/vscode-bridge.mjs') claude
codex.exe mcp add claude-vscode-bridge `
  --env "VSCODE_BRIDGE_ALLOWED_ROOTS=$projectRoot" `
  -- $nodeBin (Join-Path $bridgeRoot 'src/vscode-bridge.mjs') codex
```

Reload the VS Code window after registration. Separate multiple explicit project roots with `;`; drive roots are not accepted. See [preview behavior and limits](REFERENCE.md#vs-code-extension-bridge-windows-preview).

### Native relay pipe forwarding

On Windows and macOS, `codex-native-relay-install` adds this to the relay's entry in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) and keeps its other settings:

```toml
[mcp_servers.codex-native-relay]
env_vars = ["CODEX_APP_TOOLS_PIPE_PATH"]
```

If you register the relay by hand, add the same line and append the variable name if `env_vars` already exists. Only the name is saved, never the temporary pipe path. Restart Codex Desktop after active work finishes so it relaunches the relay.

### Linux / WSL (Bash)

The global npm command configures local app-server mode on Linux/WSL and resolves the Codex CLI automatically. Use Node.js 22.13+ and signed-in Codex and Claude Code under the same Linux user. Native Desktop integration requires Windows or macOS. WSL and Windows have separate paths and registrations. The following commands are optional manual alternatives.

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

<details>
<summary>Linux Homebrew registration commands</summary>

```bash
npm install -g @openai/codex@latest
codex login
CODEX_BRIDGE_DESKTOP_TASKS=0 claude-mcp-bridge-install
bridge_root="$(brew --prefix)/opt/codex-mcp-bridge/libexec/lib/node_modules/@minhspark/codex-mcp-bridge"
node_bin="$(brew --prefix)/opt/node/bin/node"
claude mcp add --scope user codex-bridge \
  -e CODEX_BIN="$(command -v codex)" \
  -e CODEX_BRIDGE_DESKTOP_TASKS=0 \
  -e CODEX_BRIDGE_AUTOSTART=1 \
  -e CODEX_BRIDGE_THREAD_POLICY=roots \
  -e CODEX_BRIDGE_ALLOWED_ROOTS="$HOME/YourProject" \
  -- "$node_bin" "$bridge_root/src/mcp-supervisor.mjs" index.mjs
```

Replace `$HOME/YourProject` with the actual project directory. The bridge and Node paths remain stable across Homebrew upgrades.

</details>

### Workflow skill — NPX Skills

The repository includes one portable skill, `codex-bridge`, for the [hosted Codex Bridge workflow](#chatgpt-plugin). These commands install its Markdown instructions only. Using the workflow requires a client with the hosted plugin's MCP tools and a paired connector; copying the skill does not install the local bridges, configure authentication, or make a client a supported native sender.

Use a Node.js version supported by the current [Skills CLI](https://github.com/vercel-labs/skills). The examples target the current project; add `-g` for a user-wide install. In Windows PowerShell use `npx.cmd` instead of `npx`.

**NPX Skills — select the workflow skill**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge
```

**List available skills without installing**

```bash
npx skills add buidangminh23/codex-mcp-bridge --list
```

**Claude Code**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a claude-code
```

**Codex**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a codex
```

**Cursor**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a cursor
```

**Gemini CLI**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a gemini-cli
```

**Antigravity**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a antigravity
```

**Antigravity CLI**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a antigravity-cli
```

**Cline**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a cline
```

**OpenCode**

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge -a opencode
```

**All Skills CLI agents — user-wide, without prompts**

```bash
npx skills add buidangminh23/codex-mcp-bridge --all -g
```

`--all` installs every skill in the repository for every supported Skills CLI agent, not just detected apps. Choose an individual `-a` command above for a narrower install. Agent names and scope flags follow the [Skills CLI reference](https://github.com/vercel-labs/skills/blob/main/docs/commands.md).

**Legacy `add-skill` command**

```bash
npx add-skill buidangminh23/codex-mcp-bridge
```

`add-skill` is deprecated and forwards to `npx skills add`; use the current command above, especially on Windows where the legacy wrapper may fail to find `npx`.

**Marketplace and Gemini extension installs**

This repository ships a hosted ChatGPT plugin and the skill above. It does not currently publish a Claude/Codex marketplace catalog or a `gemini-extension.json` package. Consequently, `/plugin marketplace add`, `codex plugin marketplace add`, and `gemini extensions install` are not installation routes for this repository. Use the native bridge setup, NPX skill commands, or [hosted plugin setup](#chatgpt-plugin) as appropriate.

### Verify the installation

Run `codex-bridge-setup --check` (`codex-bridge-setup.cmd --check` on Windows) to inspect saved registrations. An incomplete result names the component requiring attention; rerun setup after correcting it.

Reconnect the affected MCP servers in the actual client tasks; Claude Code provides `/mcp`. If the app has not loaded the new registrations, close and reopen it after active work finishes. Setup does not kill or restart apps. Run these **MCP tools** inside the apps:

| Client | Tool |
|---|---|
| Claude Code | `codex_bridge_status` |
| Codex | `claude_bridge_status` |
| Codex Desktop | `native_relay_status` |
| Codex / Claude Desktop Code with Antigravity installed | `antigravity_bridge_status` |
| Antigravity App | `agent_bridge_status` |

To check CLI registrations without sending work:

```bash
codex mcp list
claude mcp list
```

These optional CLI checks require the respective CLI on PATH; the complete setup check can also use its managed Codex CLI. On Windows use `codex.exe mcp list`. An installed skill is listed separately with `npx skills list` (add `-g` for user-wide skills); it is not an MCP registration.

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
- **Installed package but no entries:** run `codex-bridge-setup.cmd --check` on Windows, or `codex-bridge-setup --check` elsewhere. A local install, `--ignore-scripts`, or `CODEX_BRIDGE_SKIP_SETUP=1` skips automatic configuration; run setup explicitly when wanted.
- **npm says install scripts were blocked:** rerun the recommended install with `--allow-scripts=@minhspark/codex-mcp-bridge`, or run `codex-bridge-setup` explicitly. The flag allows this package's hook without changing the global script security setting. Add `--foreground-scripts` when installation progress is needed.
- **Claude connector failed or tools missing:** inspect `codex-bridge` in `/mcp` inside the actual Code session and reconnect it. A standalone process answering `initialize` does not prove the app loaded that server. For ordinary Claude chat, check the separate `codex-bridge-desktop` connector.
- **A new package still runs an older bridge:** compare the version reported by `codex_bridge_status` in the actual client with the installed package, and inspect that client's MCP command and script path. An old source checkout can remain active beside a newer global package. Rerun setup and reconnect the affected client so it loads the intended installation.
- **Startup reaches a connection timeout:** setup prepares runtime snapshots in advance, but this does not guarantee a particular machine's startup time. A `prepared ... (reused)` line means the runtime directory was reused; its integrity metadata may still need to be rebuilt. After correcting the installation path and reloading, collect the runtime version, startup log, and exact timeout to distinguish a cache miss from another startup failure. A reported 30-second timeout is not established as fixed by configuration changes alone.
- **Claude labels startup diagnostics as `Server stderr`:** ordinary `preparing`, `prepared`, and `ready` lines are diagnostics, not evidence of failure by themselves. Inspect the actual connection status and error. MCP reserves stdout for protocol messages; redirecting diagnostics there can break the connection.
- **No sessions or wrong project:** open the intended Claude **Code** session and use the exact project directory saved in Codex Desktop.
- **Relay unavailable:** Codex Desktop runs the relay only while a task has its MCP servers loaded. On macOS the bridge opens the destination task (or your project's latest Codex task) in the background to start it; otherwise open a regular project task and send it a turn. If it still fails, check [pipe forwarding](#native-relay-pipe-forwarding) and run `native_relay_status` in that task.
- **Timeout or unconfirmed send:** inspect the original task or receipt before sending again.

[More fixes](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md#troubleshooting) · [Report an issue](https://github.com/buidangminh23/codex-mcp-bridge/issues)

## Optional active-install statistics

Usage reporting is **off by default**. Manage it with `codex-mcp-bridge telemetry enable`, `telemetry status`, or `telemetry disable`. Reports contain a random installation ID, UTC day, version, and OS; no chat content, paths, account identity, or credentials. `DO_NOT_TRACK=1` or `CODEX_BRIDGE_TELEMETRY=0` disables reporting. Disabling removes the local ID; submitted records expire after 90 days during ingestion.

[Analytics dashboard](https://buidangminh23.github.io/codex-mcp-bridge/) · [Release notes](https://github.com/buidangminh23/codex-mcp-bridge/releases) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
