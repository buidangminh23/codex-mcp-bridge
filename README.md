# codex-mcp-bridge

[![npm](https://img.shields.io/npm/v/@minhspark/codex-mcp-bridge?logo=npm&color=CB3837)](https://www.npmjs.com/package/@minhspark/codex-mcp-bridge)
[![CI](https://github.com/buidangminh23/codex-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/buidangminh23/codex-mcp-bridge/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@minhspark/codex-mcp-bridge)](LICENSE)

Send prompts and replies between **Claude and Codex**, keeping each conversation in its own app. Supports Windows, macOS, and Linux; native Desktop integration supports Windows and macOS.

![Claude and Codex exchanging messages](https://github.com/buidangminh23/codex-mcp-bridge/releases/download/v1.16.0/desktop-demo.gif)

## Project statistics

**[Open live dashboard — refreshes every 30 seconds](https://buidangminh23.github.io/codex-mcp-bridge/)**

[![Repository usage dashboard](https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/dashboard.svg)](https://github.com/buidangminh23/codex-mcp-bridge/tree/analytics)

[Full statistics and daily history](https://github.com/buidangminh23/codex-mcp-bridge/tree/analytics) · [Public aggregate JSON](https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/data.json) · [How these metrics work](#repository-analytics)

## Installation

[Windows](#windows-powershell) · [macOS](#macos-terminal) · [Linux / WSL](#linux--wsl-bash) · [Claude Code registration](#register-claude-code) · [Verify](#verify-the-installation) · [Troubleshooting](#troubleshooting)

Choose the mode for the conversations you want to connect:

| Platform | Mode | Required clients |
|---|---|---|
| Windows / macOS | Native Desktop tasks | Signed-in Codex Desktop and a Claude **Code** session in Claude Desktop |
| Linux / WSL | CLI / app-server | Signed-in Codex CLI and a running Claude Code CLI session |

The bridge requires **Node.js 22+**; Node 24 LTS is a suitable starting point. If Node is already managed by a version manager, use that installation. Install the bridge under the same OS user as the clients. A global npm install does not require cloning this repository.

For Desktop mode, install [Codex Desktop](https://developers.openai.com/codex/app) and [Claude Desktop](https://claude.com/download), sign in, and save the intended local project in Codex Desktop. Open that same directory in Claude Desktop's Code tab. A normal Claude chat is not a Code session.

### Windows (PowerShell)

Install Node and a native Codex executable with WinGet:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id OpenAI.Codex --exact
```

Open a **new PowerShell window** so it receives the updated PATH, then run:

```powershell
node --version
npm.cmd --version
codex.exe --version
codex.exe login
npm.cmd install -g @minhspark/codex-mcp-bridge@latest
$env:CODEX_EXE = (Get-Command codex.exe).Source
codex-native-relay-install.cmd --desktop-tasks
codex-mcp-bridge-install.cmd --desktop-tasks
$env:CODEX_BRIDGE_DESKTOP_TASKS = "1"
claude-mcp-bridge-install.cmd
```

The `.cmd` suffix selects npm's Windows launchers without changing PowerShell's execution policy. `CODEX_EXE` must point to the real `codex.exe`, not an npm `.ps1` shim. If WinGet is unavailable, install [App Installer](https://learn.microsoft.com/en-us/windows/package-manager/winget/) or use the vendors' installers.

Continue with [Claude Code registration](#register-claude-code), then [verification](#verify-the-installation).

### macOS (Terminal)

With [Homebrew](https://brew.sh/) installed:

```bash
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
npm --version
npm install -g @openai/codex@latest @minhspark/codex-mcp-bridge@latest
codex --version
codex login
codex-native-relay-install --desktop-tasks
codex-mcp-bridge-install --desktop-tasks
CODEX_BRIDGE_DESKTOP_TASKS=1 claude-mcp-bridge-install
```

Add the same Node PATH line to `~/.zshrc` if this is your Node installation; use `~/.bashrc` for Bash. If Homebrew is not installed, the [Node.js installer](https://nodejs.org/en/download) is another option; skip the two Homebrew lines after installing it.

Keep the bootstrap enabled on a first relay install: it creates the executor required by native delivery. `--no-bootstrap` is for an already configured executor. On macOS, the relay installer selects the runtime bundled with Codex Desktop for native app authentication.

Continue with [Claude Code registration](#register-claude-code), then [verification](#verify-the-installation).

### Linux / WSL (Bash)

Use a Linux terminal with `curl`, `unzip`, and Bash available. This example uses [fnm](https://github.com/Schniz/fnm#installation) to install Node without system-wide npm permissions:

```bash
curl -fsSL https://fnm.vercel.app/install | bash
```

Open a new Bash terminal so fnm's shell setup loads, then run:

```bash
eval "$(fnm env --use-on-cd --shell bash)"
fnm install 24
fnm default 24
fnm use 24
node --version
npm --version
npm install -g @openai/codex@latest @minhspark/codex-mcp-bridge@latest
codex login
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
claude --version
CODEX_BRIDGE_DESKTOP_TASKS=0 claude-mcp-bridge-install
```

Start `claude` once and complete sign-in, then exit back to the shell. Register the forward bridge below, then reopen Claude or reconnect its MCP server:

```bash
bridge_root="$(npm root -g)/@minhspark/codex-mcp-bridge"
claude mcp add --scope user codex-bridge \
  -e CODEX_BIN="$(command -v codex)" \
  -e CODEX_BRIDGE_DESKTOP_TASKS=0 \
  -e CODEX_BRIDGE_AUTOSTART=1 \
  -e CODEX_BRIDGE_THREAD_POLICY=roots \
  -e CODEX_BRIDGE_ALLOWED_ROOTS="$HOME" \
  -- "$(command -v node)" "$bridge_root/src/mcp-supervisor.mjs" index.mjs
```

Use an existing writable project under your home directory, or replace `$HOME` in the allowed roots with the intended project directories. Keep both CLI clients running under the same Linux user. The bridge starts its local app-server on demand; no native relay installer is needed. This mode does not provide native Desktop project assignment. WSL and Windows have separate paths and client registrations; use the Windows instructions to connect Windows Desktop tasks.

### Register Claude Code

**Claude Desktop configuration and Claude Code's MCP registry are separate.** If the sending Code session does not have `codex-bridge`, register it below. These are first-registration commands; if `claude mcp get codex-bridge` already returns an entry, preserve its custom environment and access settings when updating it.

Install the Claude Code CLI if `claude --version` is unavailable. The [official setup guide](https://code.claude.com/docs/en/setup) provides these native installers:

**Windows PowerShell:**

```powershell
irm https://claude.ai/install.ps1 | iex
```

**macOS / Linux:**

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Open a new terminal after installation. Linux users who completed the preceding section are already registered. For **Windows Desktop mode**:

```powershell
$bridgeRoot = Join-Path ((npm.cmd root -g).Trim()) '@minhspark/codex-mcp-bridge'
$nodeBin = (Get-Command node.exe).Source
$codexBin = (Get-Command codex.exe).Source
claude mcp add --scope user codex-bridge `
  -e "CODEX_BIN=$codexBin" `
  -e CODEX_BRIDGE_DESKTOP_TASKS=1 `
  -e CODEX_BRIDGE_AUTOSTART=0 `
  -e CODEX_BRIDGE_THREAD_POLICY=roots `
  -e "CODEX_BRIDGE_ALLOWED_ROOTS=$env:USERPROFILE" `
  -- $nodeBin (Join-Path $bridgeRoot 'src/mcp-supervisor.mjs') index.mjs
```

For **macOS Desktop mode**:

```bash
bridge_root="$(npm root -g)/@minhspark/codex-mcp-bridge"
claude mcp add --scope user codex-bridge \
  -e CODEX_BIN="$(command -v codex)" \
  -e CODEX_BRIDGE_DESKTOP_TASKS=1 \
  -e CODEX_BRIDGE_AUTOSTART=0 \
  -e CODEX_BRIDGE_THREAD_POLICY=roots \
  -e CODEX_BRIDGE_ALLOWED_ROOTS="$HOME" \
  -- "$(command -v node)" "$bridge_root/src/mcp-supervisor.mjs" index.mjs
```

These examples allow projects under the current user's home. For projects elsewhere, supply their actual absolute directories, separated by `;` on Windows or `:` on macOS/Linux. `--scope user` makes the registration available across projects; it does not override the allowed roots.

### Verify the installation

Check registration from a terminal; on Windows use `codex.exe` if `codex` resolves to a blocked PowerShell shim:

```bash
node --version
codex --version
claude --version
claude mcp get codex-bridge
codex mcp get claude-bridge
```

For Windows/macOS Desktop mode, also run `codex mcp get codex-native-relay`. Reconnect the affected MCP servers in the **existing** client tasks; Claude Code exposes them through `/mcp`. If a client has no reconnect control, restart that client after its active work finishes.

Ask the active tasks to run these **MCP tools**, not shell commands:

| Where | Tool | Expected result |
|---|---|---|
| Claude Code | `codex_bridge_status` | Current runtime; native relay and saved projects available in Desktop mode, or a working app-server in CLI mode |
| Codex | `claude_bridge_status` | Current runtime and the intended Claude session policy |
| Codex Desktop only | `native_relay_status` | Account relay listening and native tools available |

The registered supervisor should report auto-reload enabled. Next, list the intended destination with `list_codex_threads` or `list_claude_sessions`, then send a short message and verify its reply. A package version or a running process alone does not establish successful delivery.

## Use

| Direction | Tools |
|---|---|
| Claude → Codex | `list_codex_threads`, then `send_to_codex_thread` |
| Codex → Claude | `list_claude_sessions`, then `send_to_claude_session` |
| Create a Codex task | `delegate_to_codex` with `cwd` and `prompt` |

Example requests:

- **In Claude:** “Send this review request to my existing Codex task in this project and wait for its reply.”
- **In Codex:** “Send this result to my Claude Desktop Code session in this project and confirm its reply.”

Use the exact project directory and destination task. If several Claude sessions match, specify the task ID. A `reply_received` receipt confirms a reply; a timeout does not mean the task stopped, so inspect it before retrying.

## Important behavior

- Desktop mode uses the native relay and the apps' permissions; it does not fall back to an external app-server.
- Account switches are checked before delivery. Missing identity or incompatible permissions block sending.
- Access settings are preserved on reinstall. Review allowed workspaces before enabling the bridge.
- CLI/app-server setup, all tools, and advanced settings are in the [reference](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md).

## Update

```bash
npm install -g @minhspark/codex-mcp-bridge@latest
```

Supervisor-based installs reload compatible updates when idle. Older installs or changed MCP settings need a one-time reconnect; see [upgrade instructions](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md#upgrading-an-install-you-already-have).

On Windows, use `npm.cmd` if PowerShell blocks `npm.ps1`. Upgrade the Codex CLI with the same manager used to install it: `winget upgrade --id OpenAI.Codex --exact` for the Windows path above, or `npm install -g @openai/codex@latest` for the macOS/Linux path. Updating the bridge does not update the clients.

If Node moved or a registration still points at an old installation, rerun the corresponding platform registration steps and reconnect its MCP server. Preserve existing access settings. Use `--no-bootstrap` only when refreshing a relay that already has an executor.

## Troubleshooting

### Download or installation failed

| Error / symptom | What to check and how to fix it |
|---|---|
| `node`, `npm`, or a bridge command is not found | Open a new terminal. Check `node --version` and `npm --version`. On Windows run `Get-Command node.exe` and `npm.cmd prefix -g`; the global prefix must be on PATH. On macOS/Linux run `command -v node` and `npm prefix -g`; its `bin` directory must be on PATH. Reload your Node version manager's shell setup if used. |
| `EBADENGINE`, missing `WebSocket`, or Node older than 22 | Switch to Node 24 with the installer/version manager above, reinstall the bridge under that Node, then refresh MCP registrations that reference an old executable. |
| PowerShell says `npm.ps1` or an installer script cannot be loaded | Use `npm.cmd` and the bridge installer's `.cmd` command shown above. For Codex use `codex.exe`; keep machine execution policies unchanged. |
| `EACCES` on macOS/Linux | Use a user-owned Node version manager, then reinstall globally under that Node. See npm's [permission error guide](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/). |
| `EPERM`, `EBUSY`, or a file is in use on Windows | Let active work finish, close the process named in the error if it owns the package files, and retry the same npm command. Check the reported path's permissions or security-software event if it persists. |
| `E404` for the bridge | Check the exact package name `@minhspark/codex-mcp-bridge`. Run the registry checks below; a private mirror may not contain the package. |
| `ETIMEDOUT`, `ECONNRESET`, DNS, proxy, or certificate errors | Run the registry checks below. Correct the configured proxy or use the CA certificate supplied by the network administrator. Keep TLS verification enabled. |
| Claude installer returns HTML, `403`, or a curl error | Use the alternatives and error-specific fixes in [Claude Code installation troubleshooting](https://code.claude.com/docs/en/troubleshooting). |

Run these registry and cache diagnostics; in PowerShell replace `npm` with `npm.cmd`:

```bash
npm config get registry
npm ping
npm view @minhspark/codex-mcp-bridge version
npm view @minhspark/codex-mcp-bridge version --registry=https://registry.npmjs.org/
npm cache verify
```

If the public registry works but a configured mirror does not, update the mirror configuration or, where permitted, install once from the public registry:

```bash
npm install -g @minhspark/codex-mcp-bridge@latest --registry=https://registry.npmjs.org/
```

### Installed, but the bridge does not connect

Start with `codex doctor` for Codex installation problems and `claude doctor` for Claude Code. Then inspect the MCP registrations and the status tools in [verification](#verify-the-installation).

| Error / symptom | Fix |
|---|---|
| `codex binary not found`, `ENOENT`, or Windows `EINVAL` during registration | Locate the actual executable. Set `CODEX_EXE` before rerunning the installer: PowerShell `$env:CODEX_EXE = (Get-Command codex.exe).Source`; macOS/Linux `export CODEX_EXE="$(command -v codex)"`. On Windows, do not point it at `codex.ps1` or `codex.cmd`. |
| Tools appear in Claude Desktop but not in its Code task | Complete the separate [Claude Code registration](#register-claude-code), then reconnect `/mcp` in that Code session. |
| Installer refuses an entry with custom access/timeout settings | Keep those settings. Update only the existing entry's `command` and `args` to the values printed by the installer, then reconnect. |
| Desktop task still reports `app-server` | Rerun `codex-mcp-bridge-install --desktop-tasks`; set `CODEX_BRIDGE_DESKTOP_TASKS=1` in the separate Claude Code registration too. Refresh the reverse registration with the same setting and reconnect the actual sending task. |
| Relay is installed but unavailable | Open Codex Desktop and reconnect `codex-native-relay`. Check `codex mcp get codex-native-relay` and the in-task `native_relay_status`; a registered entry alone is insufficient. |
| `RELAY_THREAD_UNCONFIGURED` | Rerun `codex-native-relay-install --desktop-tasks` without `--no-bootstrap` to create the missing executor. |
| macOS `untrusted-code-signing-identity` or `NATIVE_DELIVERY_UNCONFIRMED` | Inspect the client logs and the installer's `relay runtime:` line. Rerun the relay installer with Codex Desktop installed; if runtime detection fails, set `CODEX_NATIVE_RELAY_NODE` to the actual app-bundled runtime. Relaunch the companion after active work finishes. Inspect any original delivery before retrying. |
| Linux says native relay unavailable | Use the Linux CLI setup with `CODEX_BRIDGE_DESKTOP_TASKS=0` on both registrations. Native Desktop relay support is Windows/macOS only. |
| No Claude sessions or no matching saved project | Keep the intended Code session open under the same OS user. In Desktop mode, use a Claude Desktop Code session and an existing saved Codex project with the exact local path. Check both clients are signed in. |
| `NOT AUTHORIZED` / workspace refused | Inspect `CODEX_BRIDGE_ALLOWED_ROOTS` and `CODEX_BRIDGE_THREAD_POLICY`. Add the intended writable project path to the relevant registration and reconnect; retain unrelated restrictions. |
| Account identity unavailable / changed | Complete sign-in in the intended clients and recheck their status. Desktop routing requires supported local account identity; API-key or unsupported credential storage is not a substitute. See [account requirements](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md#switching-desktop-accounts). |
| Runtime is stale or update pending | Check the configured installation path and `autoReload` status. Active calls and unresolved deliveries defer a reload. Let them finish; reconnect once for legacy registrations or changed environment variables. |
| Task is “open in another application” | For Desktop tasks, use the native mode above. For CLI/app-server tasks, let the owning turn finish and release its subscription before opening elsewhere. |
| CLI mode cannot connect after reboot | Check `codex_bridge_status`, the configured endpoint, and whether autostart is enabled. The CLI setup uses `ws://127.0.0.1:8791`. If manually starting `codex app-server --listen ws://127.0.0.1:8791`, first confirm no server already owns that endpoint. |
| CLI server says the model needs a newer Codex | Update Codex, then restart the specific old app-server after its active work finishes. Updating files does not replace an already running process. |
| Send timed out / reply unconfirmed | Read the original task or delivery receipt before retrying. A timeout does not cancel the task, and retrying can send it twice. |

For unresolved failures, [open an issue](https://github.com/buidangminh23/codex-mcp-bridge/issues) with the OS, Node/bridge/client versions, the failing command, and the relevant redacted status/error. Leave out tokens, credentials, and private conversations. More detail is in the [technical reference](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md#troubleshooting).

## Repository analytics

The live dashboard polls the aggregate API every 30 seconds. Installation counts reflect reports received by the server; this is not a count of currently online processes. Public GitHub/npm sources are refreshed with a short cache, but their own statistics may be delayed. Private GitHub traffic is archived hourly when the owner's scheduled collector is available. The README image is a snapshot and may be cached by GitHub; open the live dashboard for automatic updates. Source timestamps show freshness; missing data is unavailable, not zero. Only aggregate figures are published. Installation IDs stay in the private database.

Repository owners can view [GitHub traffic](https://github.com/buidangminh23/codex-mcp-bridge/graphs/traffic) for recent views and clones. Downloads and clones include updates, reinstalls, and automation; they do not measure active users. GitHub traffic only covers the recent 14-day window, so collect it regularly to keep a longer history.

From a source checkout with Node 22+ and GitHub CLI authenticated as an account with repository traffic access:

```bash
gh auth status
npm run analytics
```

The collector saves `history.json` and a self-contained `index.html` dashboard privately:

| Platform | Default directory |
|---|---|
| Windows | `%LOCALAPPDATA%\codex-mcp-bridge\analytics` |
| macOS | `~/Library/Application Support/codex-mcp-bridge/analytics` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/codex-mcp-bridge/analytics` |

Open `index.html` in a browser. Back up `history.json` to preserve the archive. Use `npm run analytics -- --output <directory>` to choose another private directory. Each run refreshes overlapping dates without double-counting, records per-source collection times, and preserves earlier successful data if a source fails. Daily unique visitors/cloners cannot be summed to estimate unique people across days. Release asset download counters are also retained in the JSON archive.

Run this command daily through a local scheduler or Codex automation while the machine is available. Scheduling is not installed by the package. A missed interval longer than GitHub's retention window cannot be recovered. For collection errors, check `gh auth status`, repository permissions, network connectivity, and API limits; rerun after correcting the cause. Never commit the private output directory.

To refresh the public dashboard, run `npm run analytics:publish`. It publishes an allowlisted aggregate snapshot to the separate `analytics` data branch and leaves application source unchanged. To include installation metrics, run `scripts/usage-summary.sql` through the owner's Supabase SQL editor or connector, save the returned `summary` object privately as `usage-summary.json`, and pass `--usage <path-to-usage-summary.json>` to the publisher. The summary query returns counts only. Do not supply raw installation rows or service credentials.

### Optional active-install statistics

Usage reporting is **off by default**. Each end user must explicitly enable it:

```bash
codex-mcp-bridge telemetry enable
codex-mcp-bridge telemetry status
codex-mcp-bridge telemetry disable
```

The equivalent `claude-mcp-bridge telemetry ...` commands share the same local consent. When enabled, the bridge checks at startup and hourly while running, sending at most one successful report per UTC day to the project's Supabase endpoint: a random installation ID, UTC day, bridge version, and operating system. No chat content, paths, account identity, or credentials are included. Network infrastructure may process normal request metadata; the application's statistics table does not store IP addresses. Reporting failures do not interrupt bridge operation. `DO_NOT_TRACK=1` or `CODEX_BRIDGE_TELEMETRY=0` overrides local consent and suppresses reporting.

These counts represent voluntarily reporting installations, not unique people or all users. Disabling stops future reports and removes the local installation ID. Previously submitted records older than 90 days are removed during subsequent ingestion. Source checkouts containing this feature support these commands; older published package versions do not.

The owner can query `public.bridge_usage_daily` in the Supabase SQL editor. Public and authenticated client roles cannot read the table or call its ingestion function. The endpoint validates the project's public publishable key, so counts are approximate and can include fabricated IDs; its 10,000-record daily storage cap does not prevent request spam. Apply the migration under `supabase/migrations` before deploying `bridge-usage` with the supplied function configuration (custom publishable-key validation; legacy JWT verification disabled). The client contains only a public publishable key; service credentials stay in the Edge Function environment.

```sql
SELECT day, count(*) AS reporting_installations
FROM public.bridge_usage_daily
GROUP BY day ORDER BY day DESC;

SELECT count(DISTINCT install_id) AS reporting_installations_last_30_days
FROM public.bridge_usage_daily
WHERE day >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 29;
```

## Development

```bash
npm ci
npm test
```

On Windows, use `node --test --test-concurrency=2` (also avoids npm versions that reject forwarded flags). CI tests Node 22 and 24 on Linux, macOS, and Windows. Tests use isolated fixtures and do not spend model quota. For the optional telemetry endpoint, also run `deno test --allow-env supabase/functions/bridge-usage/contract-check.ts`.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
