# codex-mcp-bridge

[![npm](https://img.shields.io/npm/v/@minhspark/codex-mcp-bridge?logo=npm&color=CB3837)](https://www.npmjs.com/package/@minhspark/codex-mcp-bridge)
[![CI](https://github.com/buidangminh23/codex-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/buidangminh23/codex-mcp-bridge/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@minhspark/codex-mcp-bridge?logo=node.js&color=5FA04E)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@minhspark/codex-mcp-bridge)](LICENSE)
[![M8ven Verified](https://m8ven.ai/badge/mcp/buidangminh23-codex-mcp-bridge-1ke8t1?variant=verified)](https://m8ven.ai/mcp/buidangminh23-codex-mcp-bridge-1ke8t1)

A **two-way** bridge between Claude and Codex: Claude pushes prompts into a **live Codex thread**, and Codex messages back into a **running Claude Code session**. Each side sees the other's sessions and follows the conversation inside its own app. Runs on **macOS, Windows and Linux** (the Codex → Claude direction uses unix sockets on macOS/Linux and named pipes on Windows).

The bridge preserves task history and working directories across messages. Enable **Desktop tasks** to create, assign, and watch work directly in Codex Desktop. The separate app-server backend remains available for CLI use; it cannot provide live Desktop viewing while it owns the task's writer lock.

### Visible tasks in the correct Desktop project

Install the native companion, choose an existing local project in Codex Desktop, and enable Desktop task delivery:

```bash
codex-native-relay-install --desktop-tasks
```

Reload the native companion and the Claude MCP client after upgrading. The installer stores the opt-in in the existing `~/.codex/native-relay.json`; `CODEX_BRIDGE_DESKTOP_TASKS=1` also enables it, and an explicit `0` overrides the shared setting. Desktop mode uses **Codex Desktop permissions**, while the bridge's workspace and thread authorization checks still apply. Existing installations keep their app-server permission settings unless they opt in.

Call `delegate_to_codex` with `cwd`, `prompt`, and optionally `name`. The bridge resolves the real directory, selects the saved local project with that exact path, starts in its existing checkout, and opens the task immediately while it runs. `openInApp: false` suppresses page navigation; project assignment still happens. It never creates projects or selects a parent directory, remote namesake, or a new worktree. Missing or ambiguous project matches return an error before creation; choose an existing project's directory or continue a task already in the requested workspace.

`start_codex_thread` requires `prompt` in Desktop mode and returns after acceptance. Use `delegate_to_codex` to also wait for the reply. `send_to_codex_thread` continues the existing Desktop task without attaching another writer; its cwd cannot be changed. On timeout, the task continues. Inspect it in Desktop and use its Stop button to interrupt it. Quota failures and approval/input requests remain visible; delivery does not bypass them. An uncertain creation or send is never automatically repeated through another backend.

Desktop calls share a maximum 40-second budget across creation, opening, queueing, and observation, so a slow task returns its confirmed ID before the caller's usual 60-second timeout. The task keeps running in Desktop. If creation itself cannot be confirmed, the bridge reports uncertainty and blocks another creation instead of inventing an ID.

Creation receipts persist in `$CODEX_HOME/bridge-task-receipts` (default `~/.codex/bridge-task-receipts`). The same canonical workspace and explicit title reuse the existing task, including after completion or a bridge restart; an edited brief is not resent. Use `send_to_codex_thread` to continue it, or a distinct title for separate work. Without an explicit title, the key uses the exact prompt hash. Receipts store hashes rather than prompt text and never grant thread permissions: `owned` policy still requires authorization after restart. Pending or uncertain receipts and abandoned creation locks fail closed without automatic expiry; inspect the actual task before repairing them.

Reusing a receipt also verifies that the saved project still has the same identity and exact directory, then checks the task's current project membership in Desktop's recent/pinned listing. A moved task or deleted/repointed project is rejected before sending or creating anything. A task omitted from that listing keeps its known ID and reports `project assignment: unverified`; stored receipt metadata is not presented as current membership. If a checkout has moved, edit the existing project's folder in Desktop, then inspect the existing task's workspace. Do not add another project or append the obsolete directory merely to satisfy a match.

The updated companion exposes a separate `-desktop-tasks` endpoint so a previous companion holding the legacy reply socket need not be killed during an upgrade. `codex_bridge_status` verifies the native connection through Desktop's local project list; `native_relay_status` reports both endpoints. Reconnect the companion after upgrading so it accepts the current native operations.

Desktop mode never contacts, starts, or falls back to an external app-server, including during status checks and thread discovery. The Claude Desktop installer records `CODEX_BRIDGE_AUTOSTART=0` in this mode. If Desktop or its companion is unavailable, the bridge reports the failure and leaves existing tasks in Desktop. `stop_codex_app_server` is a no-op in Desktop mode; stop an obsolete external service through its own launcher after confirming it has no active work.

`list_codex_threads` filters Desktop's recent/pinned task snapshot by authorization, workspace/title, and result limit. The snapshot can omit agent-created tasks visible in the sidebar and does not cover the complete archive. Absence from this list does not mean creation failed: read the returned task ID directly. Desktop does not expose the external server's `loadedOnly` state; requesting it returns an explanation without contacting that server.

## Architecture

Two MCP servers, one living inside each agent:

```
                     ┌──────────────── codex-mcp-bridge (runs inside Claude) ──────────────┐
Claude Desktop ──────┤ stdio                                    WebSocket                  ├──> separate codex app-server
                     └────────────────────────────────────────────────────────────────────┘

                     ┌──────────────── claude-bridge (runs inside Codex) ──────────────────┐
Codex ───────────────┤ stdio             unix socket / named pipe for the Claude session       ├──> Claude Code session ──> message shows in Claude Desktop
                     └────────────────────────────────────────────────────────────────────┘

Codex TUI  ──codex --remote ws://127.0.0.1:8791──> same app-server, same live thread

                     ┌── codex-native-relay (launched by Codex Desktop, Windows/macOS) ────┐
both bridges ───────┤ named pipe / unix socket                         native tools       ├──> visible project tasks in Codex Desktop
                     └────────────────────────────────────────────────────────────────────┘
```

- In app-server mode, the app-server is a **singleton per port**. The bridge probes `http://127.0.0.1:8791/readyz`; with autostart enabled, if nothing answers it spawns a detached `codex app-server --listen ws://127.0.0.1:8791`, which keeps running after the bridge exits. Desktop mode does not use this path.
- Every client pointed at the same URL shares **one app-server**, so `thread/resume` with a `threadId` rejoins the running thread instead of opening a new session.
- The bridge keeps exactly one WebSocket, calls `initialize` once, and routes notifications by `threadId`, so parallel threads never bleed into each other.
- In app-server mode, `delegate_to_codex` starts the thread at the supplied `cwd`, names it, sends the prompt, and unsubscribes that thread after a terminal turn. It opens `codex://threads/<id>` only after unload is confirmed; other threads on the shared app-server keep running. Desktop mode instead creates and assigns the task through the app immediately.
- The **native relay** (Windows/macOS, optional) is the third line: a thread the human is watching in Codex Desktop belongs to the app, and a second app-server cannot write to it. Instead of taking the thread away, `claude-bridge` hands the message to a companion the app itself launched, and the app delivers it. See [Codex Desktop native relay](#codex-desktop-native-relay).

## Requirements

| Requirement | Why |
|---|---|
| Node.js 22 or newer | the bridge uses the built-in `WebSocket` and `node --test` |
| [Codex CLI](https://developers.openai.com/codex) (`codex`), logged in | the bridge drives its app-server |
| An MCP client that launches stdio servers | Claude Desktop, Claude Code, or Codex itself |

Install the prerequisites:

```bash
# macOS
brew install node
npm install -g @openai/codex
codex login
```

```powershell
# Windows (PowerShell 7+)
winget install OpenJS.NodeJS.LTS
npm install -g @openai/codex
codex login
```

```bash
# Linux
curl -fsSL https://fnm.vercel.app/install | bash && exec $SHELL
fnm install 22 && fnm use 22
npm install -g @openai/codex
codex login
```

Verify before going further — both commands must print a version:

```bash
node --version && codex --version
```

## Install

### 1. Get the bridge

Two ways in. Pick by what you intend to do with it.

**Install it — no clone, no checkout to keep in sync.** Right for a machine that only has to run the bridge:

```bash
npm install -g @minhspark/codex-mcp-bridge
```

Already installed? The same command with `@latest` upgrades it in place — then restart the client. Details in [Upgrading an install you already have](#upgrading-an-install-you-already-have):

```bash
npm install -g @minhspark/codex-mcp-bridge@latest
```

Installing straight from the repository works the same way and needs no registry account:

```bash
npm install -g git+https://github.com/buidangminh23/codex-mcp-bridge.git
```

Either route puts the bridge servers, configuration installers, native relay, and `codex-npm-footer-install` on your PATH. Wherever this README runs `node scripts/install-claude-desktop.mjs`, an installed copy runs `codex-mcp-bridge-install` instead. Every packaged command supports `--version` and `-v` without starting a server or changing configuration.

#### Upgrading an install you already have

`npm install -g @minhspark/codex-mcp-bridge@latest`, then restart Claude Desktop or Claude Code — an MCP server only loads its code when the client spawns it. Check `codex_bridge_status` reports the version you expect. The global install path carries no version number, so the entry keeps pointing at the right file. If the existing entry still has `CODEX_BRIDGE_THREAD_POLICY=owned`, pass `CODEX_BRIDGE_THREAD_POLICY=roots` once when re-running the installer to enable human-opened threads.

Re-running `codex-mcp-bridge-install` is **not** required to upgrade, and before 1.11.1 it actively hurt: it replaced the whole entry, discarding `CODEX_BRIDGE_ALLOWED_THREADS`, any hand-added `CODEX_BRIDGE_THREAD_POLICY`, and resetting `CODEX_BRIDGE_ALLOWED_ROOTS` to the install directory. From 1.11.1 it keeps what is already there — an environment variable you pass wins, the existing value is the fallback, and `--reset` gives you the defaults back.

#### Show the final npm installation result

Enable the optional shell integration once after installing the package:

```sh
codex-npm-footer-install --shell zsh
```

Use `--shell bash` on Bash or `--shell powershell` in PowerShell 7. A source checkout can run `npm run install:footer -- --shell zsh`. The installer backs up existing profiles, preserves unrelated content, and prints a command to load the integration into the current terminal. New login and interactive Bash/Zsh shells load it automatically; PowerShell uses its current-user all-hosts profile. A terminal started before setup must run the printed reload command or open a new shell. Existing unmanaged `npm` functions are refused for review rather than overwritten. Use `--profile /absolute/path` to select a custom profile or `--remove` to remove the managed loader.

The integration leaves the command unchanged:

```sh
npm install -g @minhspark/codex-mcp-bridge@latest
```

| Measured result | Final line |
| --- | --- |
| No previous installation | `Successfully installed: @minhspark/codex-mcp-bridge v<version>` |
| Version changed | `Successfully updated: @minhspark/codex-mcp-bridge v<before> -> v<after>` |
| Same version after reinstalling | `Already up to date: @minhspark/codex-mcp-bridge v<version>` |
| npm failed | `Failed to install: ... (exit code <code>). See npm error above.` |
| Dry run | `Dry run completed: ... (no changes applied).` |
| Mode or installed metadata cannot be verified | A warning instead of a success claim |

The footer runs after npm finishes and keeps npm's output and exit code. It supports `install`/`i`, explicit global installation, one bridge package, dry-run flags, common install booleans, and a single `--prefix`. Other commands, multiple packages, unknown options, and machine-readable or silent output modes pass through without a footer. Installing the package itself does not alter shell profiles. A successful install confirms files on disk; restart the MCP client separately to load the new bridge code.

**Clone it** — right if you intend to read, test or change the code:

```bash
git clone https://github.com/buidangminh23/codex-mcp-bridge.git
cd codex-mcp-bridge
npm install
```

A clone upgrades with `git pull && npm ci`, then the same restart.

Confirm the tree is healthy before wiring it into anything:

```bash
npm test
```

### 2. Claude → Codex, into Claude Desktop

```bash
node scripts/install-claude-desktop.mjs
```

The script detects the platform, creates the config file if it does not exist, backs up the previous one (`*.bak-<date>-codexbridge`) and preserves every other key:

| OS | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Claude/claude_desktop_config.json` |

The v1.11.2 installer accepts threads from every usable workspace by default, so it does not bake one machine's clone path into the config. Narrow the scope to named projects when you want that:

```bash
# macOS and Linux separate entries with ":", Windows with ";"
CODEX_BRIDGE_ALLOWED_ROOTS="/path/to/project-a:/path/to/project-b" codex-mcp-bridge-install
```

On an older config, existing values are preserved. To migrate that entry to the cross-machine behaviour explicitly, run:

```bash
CODEX_BRIDGE_ALLOWED_ROOTS="*" CODEX_BRIDGE_THREAD_POLICY=roots codex-mcp-bridge-install
```

The wildcard means every usable workspace; the bridge still resolves the thread's reported `cwd` and refuses a path that does not exist or cannot be written.

Pass defaults through the environment if you want them written into the entry:

```bash
CODEX_BRIDGE_MODEL=gpt-5.6-luna CODEX_BRIDGE_EFFORT=xhigh node scripts/install-claude-desktop.mjs
```

The result on macOS:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "/Users/<user>/.local/node/v24.18.0/bin/node",
      "args": ["/Users/<user>/code/codex-mcp-bridge/src/index.mjs"],
      "env": {
        "CODEX_BIN": "/Users/<user>/.local/bin/codex",
        "CODEX_APP_SERVER_URL": "ws://127.0.0.1:8791"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. To write the same entry by hand, use absolute paths for both `command` and `args` — Claude Desktop does not resolve either from PATH.

### 3. Claude → Codex, into Claude Code (CLI)

Claude Code keeps its own MCP registry, so it needs its own registration. Run this from the repo root:

```bash
claude mcp add codex-bridge --scope user -e CODEX_BIN="$(command -v codex)" -- "$(command -v node)" "$PWD/src/index.mjs"
```

```powershell
# Windows (PowerShell 7+)
claude mcp add codex-bridge --scope user -e CODEX_BIN="$((Get-Command codex).Source)" -- "$((Get-Command node).Source)" "$PWD\src\index.mjs"
```

Check and remove it with:

```bash
claude mcp list
claude mcp get codex-bridge
claude mcp remove codex-bridge --scope user
```

`--scope user` makes the bridge available in every project. Use `--scope project` instead to commit the entry into a repo's `.mcp.json` and share it with the team.

### 4. Codex → Claude, into Codex

```bash
node scripts/install-codex-mcp.mjs
```

The installer updates the named entry through `codex mcp add`, preserves existing environment settings, pins the configured Desktop policy, and disables external autostart in Desktop mode. It refuses to reset custom access, timeout, or transport settings. It never infers the sender permission class from the recipient. The basic registration by hand is:

```bash
codex mcp add claude-bridge --env CLAUDE_BRIDGE_PEER_NAME=codex-desktop -- "$(command -v node)" "$PWD/src/claude-bridge.mjs"
```

Verify and remove:

```bash
codex mcp list
codex mcp get claude-bridge
node scripts/install-codex-mcp.mjs --remove
```

Reconnect the MCP server in the existing Codex Desktop task, or restart the app and reopen that same task. Verify `claude_bridge_status` **from that task**: `runtime state` must be `current` and `session policy` must match the intended mode. Do not create a replacement task. `npm run check:claude` starts a separate diagnostic process and cannot prove that the app's existing MCP connection reloaded.

`CLAUDE_BRIDGE_PEER_NAME` sets the name Claude shows for this bridge in its agent list.

### 5. Windows/macOS: the Codex Desktop native relay

Optional, and only worth installing if you keep the bound thread **open in Codex Desktop** while Claude messages back. See [Codex Desktop native relay](#codex-desktop-native-relay) for what it does and why.

```bash
node scripts/install-native-relay.mjs
```

This registers the companion with Codex (`codex mcp add codex-native-relay -- <node> src/native-relay-companion.mjs`) and bootstraps the executor thread the native dispatch needs, writing its id to `~/.codex/native-relay.json`. The `<node>` is resolved rather than inherited: Codex Desktop authenticates the code-signing identity of any process that connects to its native tools pipe, so on macOS the installer registers the runtime the app ships and prints the `relay runtime:` line naming it and where it came from. `CODEX_NATIVE_RELAY_NODE` overrides that on any platform; Windows and Linux keep the Node running the installer, as before. The bootstrap creates one thread, unsubscribes it, and closes its connection. It leaves other clients and threads running; an idle server may retain the executor until its configured unload delay expires.

```bash
codex mcp get codex-native-relay
node scripts/install-native-relay.mjs --no-bootstrap   # register only; supply CODEX_RELAY_ID yourself
node scripts/install-native-relay.mjs --remove         # unregister, and remove the relay config and thread id
```

Restart Codex Desktop so it launches the companion, then call its `native_relay_status` tool — or `claude_bridge_status`, whose `delivery:` line names the backend in force. Until both the companion and the executor thread are in place, `claude-bridge` keeps using the app-server path exactly as before.

### 6. macOS only: keep the app-server alive with launchd

> ⚠️ **Do not enable the LaunchAgent while using the Codex desktop app.** The app runs its **own** stdio app-server against the **same** `~/.codex` sqlite state. Two app-servers contend even while idle — measured here: the launchd one burned ~11% CPU doing nothing and **the Codex app UI stuttered**. Keep exactly one alive; `codex_bridge_status` detects and warns about this.
>
> The LaunchAgent makes sense on a machine **without** the desktop app (headless box, CLI/TUI only). With the app running, drop it and let the bridge spawn an app-server on demand — contention then lasts only while you are actually delegating work, not 24/7.

```bash
node scripts/install-launch-agent.mjs
```

Writes `~/Library/LaunchAgents/com.codex-mcp-bridge.app-server.plist` (`RunAtLoad` plus `KeepAlive` on crash, 10s `ThrottleInterval`) and bootstraps it into `gui/$UID`.

```bash
launchctl print gui/$UID/com.codex-mcp-bridge.app-server | head -20   # status
tail -f ~/Library/Logs/codex-mcp-bridge/app-server.err.log            # logs
node scripts/install-launch-agent.mjs --uninstall                     # remove
```

### 7. Verify the install

```bash
npm run check          # boots the bridge, autostarts an app-server, lists threads
npm run check:claude   # lists the live Claude Code sessions Codex can reach
```

From inside Claude, call the `codex_bridge_status` tool; from inside Codex, call `claude_bridge_status`. Both print the resolved binary, the endpoint and whether anything is listening. `claude_bridge_status` also prints a `delivery:` line naming the backend that would carry a relayed message, and the reason when it is not the native one.

### 8. Uninstall everything

```bash
claude mcp remove codex-bridge --scope user
node scripts/install-codex-mcp.mjs --remove
node scripts/install-native-relay.mjs --remove
node scripts/install-launch-agent.mjs --uninstall
```

Then delete the `codex-bridge` entry from `claude_desktop_config.json` (a dated `.bak-*` copy from before the install sits next to it) and remove the clone.

**Resolving the `codex` binary:** Claude Desktop (and launchd) start MCP servers with a trimmed PATH, so `codex` is usually not on it. The bridge probes `CODEX_BIN` first, then the usual install locations for the platform, then PATH:

| OS | Probe order |
|---|---|
| macOS / Linux | `/Applications/ChatGPT.app/Contents/Resources/codex` (macOS, when the desktop app is installed) → `~/.local/bin/codex` → `~/.npm-global/bin/codex` → `/opt/homebrew/bin/codex` → `/usr/local/bin/codex` → `~/.volta/bin` → `~/.bun/bin` → `~/.cargo/bin` → `~/.codex/packages/standalone/current/codex` |
| Windows | `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` → `%APPDATA%\npm\codex.cmd` → `%ProgramFiles%\nodejs\codex.cmd` |

On macOS and Linux the `codex` launcher is a Node script with a `#!/usr/bin/env node` shebang, so the bridge also rebuilds `PATH` for the child process (current node directory + `/opt/homebrew/bin` + `/usr/local/bin` + system dirs). Without that step, spawning the app-server dies at the shebang.

## Tools — `codex-mcp-bridge` (runs inside Claude)

| Tool | What it does | Hints |
|---|---|---|
| `delegate_to_codex` | Creates a named Codex thread at the requested project `cwd`, sends Claude's prompt, returns the reply, releases the bridge writer lock, and opens the exact session in Codex Desktop when enabled. | destructive |
| `send_to_codex_thread` | Sends a prompt as a user turn into `threadId`, waits for `turn/completed`, returns Codex's reply plus an activity trail (commands run, files changed). | destructive |
| `list_codex_threads` | Lists threads (id, title, cwd, last update, status) so you can pick the **exact** `threadId`. Desktop mode uses recent/pinned authorized local tasks; app-server mode supports `loadedOnly: true`. Windows and macOS rows carry a `codex://threads/<id>` deep link. | read-only |
| `start_codex_thread` | Opens a new Codex thread at a permitted `cwd`, optionally names it, and returns its `threadId`; the bridge applies its configured safe sandbox and approval policy. | writes |
| `read_codex_thread` | Reads the recent conversation without sending anything. | read-only |
| `interrupt_codex_turn` | Stops a turn that is still running. | destructive |
| `open_codex_thread` | **Windows or macOS**: brings a thread to the front in the Codex desktop app via `codex://threads/<id>` so a human can watch it work. Pass `background: true` to open without stealing focus. | writes |
| `stop_codex_app_server` | Stops the shared app-server once a hand-off is done, so it stops competing with Codex Desktop for the `~/.codex` state. The bridge starts a new one when it next needs it. | destructive |
| `codex_bridge_status` | Reports the environment: platform, resolved `codex` binary, whether the app-server endpoint is live, plus the macOS integrations (LaunchAgent, desktop app), and **warns when two app-servers are running**. Start here when something misbehaves. | read-only |

`delegate_to_codex` accepts `cwd`, `prompt`, an optional `name`, `timeoutSec` (default 240), `model`, `effort`, `openInApp`, and `releaseAfterTurn`. `send_to_codex_thread` accepts the same hand-off controls plus an existing `threadId`. On Windows, the installer defaults `openInApp` and `releaseAfterTurn` to `1`; explicit tool arguments override them. A timeout does **not** cancel the turn: the bridge returns what it collected plus the `turnId`; keep reading with `read_codex_thread` or stop it with `interrupt_codex_turn`.

`releaseAfterTurn` uses `thread/unsubscribe`, never an automatic process stop. The server may keep a thread loaded during its idle grace period or while another client subscribes. The bridge reports that state and defers Desktop opening rather than claiming the writer lock is released. Older servers without `thread/unsubscribe` return an explicit release failure. `stop_codex_app_server` remains a separate, destructive operation that affects every client on that endpoint.

Concurrent sends to the same Codex thread are serialized; different threads can run in parallel. After a timeout or disconnect, the bridge checks unresolved turn state before allowing another turn. `loadedOnly` resolves the server's thread IDs and searches subsequent pages before applying workspace and title filters.

For the normal Claude → Codex workflow, Claude should call `delegate_to_codex` with the exact project directory in `cwd`. The response always includes the Codex `threadId`, visible session `name`, exact `cwd`, rollout path, and the desktop deep link or the reason it could not be opened. The bridge sets the protocol-supported `thread/name/set` before the first turn, so the session is not an unnamed entry in Recents.

Thread operations are checked before the bridge attaches, and `CODEX_BRIDGE_THREAD_POLICY` decides what counts as permission:

| Policy | A thread is reachable when | Use it when |
|---|---|---|
| `owned` *(runtime default)* | the bridge created it with `start_codex_thread`, or its exact ID is listed in `CODEX_BRIDGE_ALLOWED_THREADS` | the bridge drives only threads it opens itself |
| `roots` *(v1.11.2 installer default)* | it is working inside a directory allowed by `CODEX_BRIDGE_ALLOWED_ROOTS` | you open threads in the Codex app or VS Code and want Claude to talk to them |

Under `owned`, a thread a human opened is **unreachable rather than merely restricted**: Codex assigns its ID at the moment it opens, so the ID cannot have been allowlisted beforehand, and the bridge-owned set lives in memory and empties whenever the MCP server restarts. If every live thread answers `NOT AUTHORIZED`, that is the cause — switch to `roots`.

`roots` does not remove a gate; it moves it from the ID to the workspace, which is the containment every tool already applies to the `cwd` it is handed. The bridge resolves a thread's workspace with a read **before** attaching, so a thread outside every root is refused without ever taking its writer lock. `CODEX_BRIDGE_ALLOWED_ROOTS=*` means every usable workspace. Otherwise set it to absolute project directories, separated by `:` (`;` on Windows). A root as broad as `/` or `C:\` has the same all-directories meaning, but `*` is portable across operating systems and machines.

## Tools — `claude-bridge` (runs inside Codex)

| Tool | What it does | Hints |
|---|---|---|
| `list_claude_sessions` | Lists Claude Code sessions running on this machine (name, pid, sessionId, cwd, entrypoint). | read-only |
| `send_to_claude_session` | Sends to a Claude inbox and waits for a correlated reply. Receipt statuses distinguish `reply_received`, `sent_unconfirmed`, `reply_timeout`, and receiver policy outcomes such as `held` or `refused`. `waitSec: 0` sends without waiting for confirmation. Prefer an exact `sessionId` because session names can change. | destructive |
| `read_claude_delivery` | Inspects the latest recipient receipt or correlated reply by original message ID without resending or clearing the inbox. Receipts belong to this MCP process; an unknown ID after reconnect never proves non-delivery. | read-only |
| `read_claude_inbox` | Reads and consumes the oldest requested page of messages, including late replies, preserving unread messages. Includes reply forwarding status. | destructive |
| `read_claude_transcript` | Reads a Claude session's recent conversation without sending anything. | read-only |
| `bind_codex_thread` | Sets the peer label and legacy reply destination. Desktop replies always return to their verified original sending task; binding neither authorizes nor redirects them. An empty string disables legacy forwarding. | writes |
| `claude_bridge_status` | Reports the peer endpoint, how many Claude sessions are live, the relay thread and the inbox depth. | writes |

Every tool declares MCP annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), because a client decides whether a call needs a human in the loop from those hints and a missing one reads as "unknown". Two are worth naming: `read_claude_inbox` empties the inbox as it reads it, so it is **not** read-only despite the name, and `claude_bridge_status` registers the peer endpoint on first call, so it writes too.

Desktop task mode (`CODEX_BRIDGE_DESKTOP_TASKS=1` or the shared setting written by `codex-native-relay-install --desktop-tasks`) applies in both directions. `list_claude_sessions` only offers sessions advertised by Claude Desktop (`entrypoint: claude-desktop`), and sending refuses CLI or unknown entrypoints before connecting. Targets must match a unique exact session ID, PID, or name; partial names are not accepted. Open or reconnect an existing Code session in Claude Desktop at the intended project when none is available. Do not launch a replacement CLI session: CLI and Desktop have separate conversation histories. Legacy mode still supports CLI sessions.

`claude_bridge_status` reports the destination policy, eligible session count, and excluded non-Desktop count. Send receipts include the destination's `entrypoint`, `cwd`, and `sessionId`. A correlated reply confirms receipt in that session; it does not independently prove that its conversation is visible in the Desktop UI. Desktop sends require `expectedCwd`, an absolute independently verified project directory. The bridge resolves both paths and refuses a missing, nonexistent, parent, or different directory before sending; it rechecks the destination after queueing. Reconnect the bridge's MCP connection after upgrading to load the enforcement code.

Desktop session discovery includes the native task title and task ID, matched through Claude Desktop's local session metadata. Use `list_claude_sessions({expectedCwd})` for the intended project; an empty result is not permission to substitute a different project. Sending additionally requires `expectedTaskId` from the intended task, alongside `target` and `expectedCwd`. The bridge verifies the exact CLI session ID, unique native task ID, canonical cwd, archive state, optional bridge ID, and live process start identity. It repeats these checks at dispatch. Missing, stale, ambiguous, or unreadable metadata blocks the send rather than guessing from a generated name such as `pcc4sh-19`. Each matched Desktop row also reports the task's permission mode from that metadata and its Claude parity class (`bypass` for `bypassPermissions`; `prompting` for `default`, `acceptEdits`, `auto`, and `dontAsk`; no class for `plan` or an unknown value).

A `held` receipt confirms only that the recipient has withheld a message. It does not prove an approval button is available in Claude Desktop. Inspect that exact task before directing the user to approve; when the UI offers no approval route, preserve the receipt and report the boundary. A preflight failure is distinct: it returns `sent: false` and no message ID, so nothing was submitted to the recipient.

Sends to the same Claude session run in order. An outstanding message blocks all further sends to that session, including `waitSec: 0`; changing wait time must not bypass a held or uncertain delivery. Use `read_claude_delivery` with the original message ID to observe `held`, `expired`, `refused`, or a late reply. A transport error after writing began also retains pending ownership. Different destination sessions remain independent. A process restart loses in-memory receipts: retain the original ID and inspect the existing recipient conversation before any resend; never treat an unknown ID as permission to retry.

Both bridge status tools report the loaded source fingerprint and process identity. Source or Desktop-routing configuration changes make the running process stale and block new sends until reconnect, while Claude inbox/receipt reads remain available. This guard applies only after the version containing it has loaded; upgrading files cannot retrofit the guard into an older process already running.

Claude's [inbound permission controls](https://code.claude.com/docs/en/cross-session-messaging#control-inbound-messages) remain authoritative, and their default rule is symmetric: when no `crossSessionInbound` value applies, a message is delivered only when the sender's attested class matches the recipient's. A recipient that bypasses permission prompts holds every sender that does not attest `bypass`; a recipient that prompts (default, `acceptEdits`, `auto`, `dontAsk`) holds every sender that attests `bypass`. The bridge attests the sender's true class from the verified Codex turn and never adjusts it to suit a recipient. Claude Desktop does not declare the `peer_inbound_approval` dialog kind to Claude Code, so a message held by a Desktop-hosted session has no approval button there; Claude Code keeps it until `dialogExpiry` (five minutes by default) and then reports it as expired. A `held` receipt in Desktop mode therefore means the two tasks run in different permission classes, not that the sender was misread. Report that to the user: only they can run the recipient task in the matching class or set `crossSessionInbound` to `accept` in that session's own settings. Because that outcome is predictable, `send_to_claude_session` first reads the recipient session's effective `crossSessionInbound` from the same files Claude Desktop loads (managed settings, then the user's `~/.claude/settings.json`, with the recipient project's `.claude/settings.json` and `settings.local.json` able only to tighten it) and refuses at preflight with `CLAUDE_RECIPIENT_INBOUND_POLICY` when that value is `refuse` or `hold`, since nothing could reach Claude or be approved. An explicit `accept` sends without a class check, because Claude delivers regardless of class. Otherwise the parity default applies: the recipient task's permission mode from Claude Desktop metadata is compared with the verified sender class and a mismatch is refused with `CLAUDE_RECIPIENT_CLASS_MISMATCH`, naming both classes and the user-only remedies on either side; both checks repeat immediately before writing. A task whose mode is unknown is sent as before and Claude decides. Flags passed at launch such as `--settings` are invisible to the bridge, so put the value in a settings file. `list_claude_sessions` shows an explicit inbound value with its source, and receipts carry `senderApprovalPolicy`, `recipientPermissionMode`, `recipientPermissionClass`, and `recipientInboundPolicy`; a held receipt repeats both classes. Do not change `CLAUDE_BRIDGE_PERMISSION_MODE`, fabricate a sender class, or edit recipient settings on the user's behalf. Legacy CLI configuration must truthfully represent every session using that MCP entry; Desktop sends derive their class from the verified calling turn. If the Desktop UI does not expose the pending approval, keep the original receipt rather than creating a CLI session.

Claude Desktop disables the CLI-native `SendMessage` tool. For Desktop targets, the bridge requests an ordinary answer in the destination conversation and reads only a completed assistant turn descended from the transcript entry that records the injected message. Unrelated human prompts and sidechains are excluded. Late answers remain available through the inbox while the bridge process is running. This does not change Desktop tool permissions or the receiver's inbound policy. Claude Code records the injected message in one of two shapes: an idle recipient starts a new turn with a user entry whose uuid is the message id, while a busy recipient absorbs the message into its running turn as a `queued_command` attachment whose `source_uuid` is the message id, and that turn's closing text is the reply. Both shapes are recognised; before 1.13.7 only the idle one was, so a reply to an absorbed message was visible in the app yet reported as `reply_timeout` with the message still pending. A reply taken from an absorbed turn is that turn's closing text, which may not address the message, so the receipt marks it `replyAbsorbed: true`, the tool result says so, and the text forwarded to Codex carries the same note.

In Desktop-only mode, the sender is resolved separately for every MCP call. Codex supplies `x-codex-turn-metadata` with the calling task and turn IDs; the bridge matches them to one active, local Codex Desktop rollout and reads its effective permission profile and approval settings. The diagnostic `sandbox_mode` label is never used to authorize a send. Missing or invalid host review flags, a completed or superseded turn, or an unsupported permission profile blocks sending before any message bytes are written. Status distinguishes enabled, disabled, missing, and invalid review flags. Do not supply fabricated MCP metadata or use another process to make a blocked send succeed.

Only an explicitly disabled permission profile with a matching full-access sandbox and user approval reviewer is supported. With `approval_policy: never` it maps to `bypass`; with `on-request`, `on-failure`, or `untrusted` it maps to `prompting`. The class answers the question Claude's parity gate asks, whether a human still prompts the sender, so Codex's two host review flags never change it: `node_repl_auto_review_required` is a per-model catalog attribute that Codex Desktop derives from `autoReview.requiredOnModels`, describing automated review of Node REPL code, and `auto_review_enabled` names an automated Guardian reviewer; neither adds a human prompt. The live `gpt-6-astra` task carried `node_repl_auto_review_required: true` together with `approvals_reviewer: user` and `auto_review_enabled: false`, and its messages are delivered to a bypassing Claude Desktop task. `auto_review_enabled: true` alongside a user reviewer has not been observed; the class still follows `approval_policy` there. Both flags must still be present as booleans and are reported in status and preserved in receipts as evidence. Other profiles remain unsupported and fail closed. The receiver may still require approval for a prompting sender. The context, approval policy, and review flags are checked again before each connection attempt and immediately before writing, so queued messages cannot inherit another turn's permissions.

`CLAUDE_BRIDGE_PERMISSION_MODE` remains a legacy CLI setting and is ignored for Desktop sends. A manually bound relay task is not proof of the sender's identity. Correlated Desktop replies retain the original sending task ID even if the relay binding later changes.

`npm run check:claude` without `CLAUDE_TARGET` checks discovery only. A standalone diagnostic has no host-supplied calling-turn identity and therefore cannot send in Desktop-only mode. Run the MCP tools in the existing Codex Desktop task for a real Desktop test. In legacy mode, a diagnostic with a target requires `reply_received`; a socket write, a held message, or a timeout fails the roundtrip check.

### How each side sees the other

- **Claude sees Codex:** `claude-bridge` registers a peer under `~/.claude/sessions/`. CLI sessions can use their permitted peer messaging tools to reply; Desktop replies use the correlated transcript path described above. The default name is `codex-<pid>`; `bind_codex_thread` renames it to `codex-<first 8 chars of threadId>`.
- **Codex sees Claude:** `list_claude_sessions` reads that same registry, and `read_claude_transcript` shows what a Claude session is working on.
- **Visible in chat:** messages accepted by Claude appear in the target conversation. Correlated Desktop replies return to their verified sending task; legacy replies use the bound Codex task. A `held` receipt means the receiver has not released the message to Claude yet.

### Peer protocol

Claude Code advertises local inboxes in `~/.claude/sessions/<pid>.json`. The bridge uses a Unix socket on macOS/Linux and `\\.\pipe\LOCAL\cc-msg-<32 hex characters>` on Windows. Frames are **NDJSON**, one message per line. A Windows connection starts with an authentication line using the destination's peer key; it never uses the separate child-process token:

```json
{"type":"auth","token":"<destination peer token>"}
```

The message carries an explicit UUID for transcript correlation:

```json
{"msgV":1,"msg_id":"<uuid>","uuid":"<uuid>","type":"user","message":{"role":"user",
 "content":"<cross-session-message from=\"uds:/tmp/cc-socks/<pid>.sock\">\n...\n</cross-session-message>"},
 "priority":"next","from":"uds:/tmp/cc-socks/<pid>.sock"}
```

Peer key names are `<pid>.<sha256(canonical socket)>.key`. Windows pipe names are normalized for hashing, and reply addresses are percent-encoded on the wire. Authentication and control frames are not user replies. `peer_message_status` receipts are matched to the original message ID and destination. A successful socket write alone is not a delivery acknowledgement.

See [Claude Code cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) for authentication and inbound-policy behavior. Wire compatibility was checked against installed Claude Code 2.1.260; peer internals can change between releases.

### Ping-pong guard

The relay has two hard limits in `src/claude-bridge.mjs`: at most **one forwarding attempt every 5s** and **50 per bridge run**. Replies arriving together are queued in order rather than discarded. Rebinding cannot reset the limit. Every queued reply keeps its original destination task and an inspectable forwarding status: `queued`, `sending`, `forwarded`, `failed`, `unknown`, or `blocked`. Read `read_claude_delivery` for a specific request or `read_claude_inbox` for late replies; status includes queue totals. A confirmed relay acknowledgement marks `forwarded`, while visibility in the Desktop conversation requires a separate UI check.

Uncertain delivery is never retried automatically or routed through another backend. Replies blocked by the session limit remain readable with an explicit reason. Source updates block new prompts until reconnect but do not discard replies to already accepted prompts while their configured Desktop routing remains unchanged. The queue and receipts live in the current MCP process only: inspect pending messages before restarting; a new process does not prove that an old request failed. Two agents left talking to each other unattended still come to a stop.

## Tools — `codex-native-relay` (launched by Codex Desktop, macOS)

| Tool | What it does | Hints |
|---|---|---|
| `native_relay_status` | Reports the local socket the companion listens on, the executor thread it dispatches through, and the dispatch method in force. | read-only |

The companion carries no work of its own. Its job is the socket and the dispatch; everything a human asks for still goes through the two bridges above.

## macOS notes

### Watch a thread in the Codex desktop app

The Codex desktop app on macOS is `/Applications/ChatGPT.app` and registers the `codex://` URL scheme. The bridge uses `codex://threads/<threadId>` to open the exact thread:

```
open_codex_thread { threadId: "01a0…", background: true }
send_to_codex_thread { threadId: "01a0…", prompt: "…", openInApp: true }
```

This is how a human watches Codex work in real time instead of reading the rollout at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` after the fact.

### Codex Desktop native relay

Returning a Claude response requires delivery into a Codex task: the verified sender in Desktop-only mode, or the bound task in legacy mode. Codex takes a per-thread writer lock when the app loads a thread and holds it for as long as the thread is open, so the external app-server path, which has to `thread/resume` before it can send, is refused:

```
thread <id> already has an active writer
```

Closing the thread first is not a fix. It is the opposite of the point: Codex Desktop is meant to stay the permanent owner of the thread and the surface the human is looking at.

The native relay removes the second writer rather than fighting it. A companion MCP process, **launched by Codex Desktop's own app-server**, already sits inside the app's context, so it can ask that app-server to deliver the message. Nothing attaches, nothing resumes, no second app-server starts, and the lock never changes hands:

```
Claude
  → claude-bridge
  → Windows named pipe / macOS ~/.codex/native-relay.sock (unix socket, mode 0600)
  → codex-native-relay                  (launched by Codex Desktop's app-server)
  → codex_app.send_message_to_thread    (over that same connection)
  → the thread already open in Codex Desktop
```

**The executor thread.** `codex_app.send_message_to_thread` runs against an executor thread, and that thread is not the destination — it is validated, so a synthetic UUID is rejected with `NATIVE_DISPATCH_FAILED`. A dedicated relay thread keeps that requirement away from the thread you are watching. It is created once by `scripts/install-native-relay.mjs` and recorded in `~/.codex/native-relay.json`:

```json
{ "relayThreadId": "<uuid>" }
```

Resolution order is `CODEX_RELAY_ID` → that file → an error naming both. Never a guess: an invented executor fails inside Codex with a message that says nothing about the configuration that actually caused it. The recorded thread works as an executor even if it has never been opened in the app.

**It is a backend, not a replacement.** `claude-bridge` picks between two delivery backends and reports which one it used; the tools, the peer protocol, the routing, the rate limits and `CodexAppServerClient` are untouched. The native path is used only when all of these hold — otherwise the app-server path runs exactly as it did before:

| Condition | Otherwise |
|---|---|
| Windows or macOS, companion endpoint exists | the app-server path (`CODEX_BRIDGE_NATIVE_RELAY=1` forces the attempt anyway) |
| `CODEX_BRIDGE_NATIVE_RELAY` is not `0` | switched off by hand |
| the Windows named pipe or macOS unix socket exists | the companion is not installed, or Codex Desktop is not running |

A companion that cannot be reached before sending falls back to the app-server path. Once a request has been written, a refusal, timeout, or lost acknowledgement does not trigger another delivery: the first attempt may already have succeeded. Invalid or oversized messages are also refused rather than passed to another backend.

The companion uses `CODEX_APP_TOOLS_PIPE_PATH` when inherited. Desktop builds that supply it only to their bundled `codex_app` MCP are also supported: the companion reads the exact `mcp_servers.codex_app.env` override from its launching app-server. It never picks a pipe from another session or saves a restart-specific address. The native connection remains separate from MCP stdio. If neither source provides a valid pipe, the relay stays unavailable; if a configured pipe is late during startup, it retries in the background. When several MCP instances start, status identifies a reachable shared companion instead of reporting that the relay is down.

> ⚠️ `codex_app.send_message_to_thread` and the native tools pipe are **Codex Desktop internals with no public documentation**, on the same footing as the Claude peer protocol above. That is why the relay is Windows/macOS, feature-detected, optional and fallback-safe. If Codex changes it, the two places to fix are `NATIVE_DISPATCH_METHOD` and `nativeDispatchParams()` in `src/native-relay.mjs`; `CODEX_NATIVE_RELAY_METHOD` overrides the method name without a release. The request the companion sends is:
>
> ```json
> {"jsonrpc":"2.0","id":1,"method":"tools/call",
>  "params":{"arguments":{"threadId":"<destination>","prompt":"..."},
>    "callId":"<unique call id>","namespace":"codex_app","threadId":"<relay thread>",
>    "tool":"send_message_to_thread","turnId":"<unique turn id>"}}
> ```

The native pipe uses a 4-byte UInt32LE payload length followed by UTF-8 JSON-RPC, and delivery requires `response.result.success === true`. `callId` and `turnId` are fresh for each dispatch. The local bridge-to-companion protocol remains NDJSON. Both transports preserve Unicode across arbitrary stream chunk boundaries. This wire format follows [Seb's measured prototype in issue #23](https://github.com/buidangminh23/codex-mcp-bridge/issues/23#issuecomment-5547163688).

**Security.** On macOS/Linux the relay socket is mode `0600` inside `~/.codex`; Windows uses the Claude-compatible local named-pipe namespace. Anything able to open the relay can put text into a Codex thread, so the endpoint is feature-detected and the companion accepts exactly one shape, `{ targetThreadId, message }`, caps a frame at 128 KiB, and refuses a destination that is its own executor thread — otherwise a mistaken bind would deliver into the invisible relay thread and report success.

### Caveats

- The Codex desktop app runs its own app-server over stdio (`ChatGPT.app/Contents/Resources/codex … app-server`, **no** `--listen`), so nothing external can attach to it. `~/.codex/ipc/ipc.sock` is the Electron app's internal IPC, not an app-server. Threads opened there can still be driven through the bridge, but by resuming from the rollout `.jsonl` rather than attaching live. The [native relay](#codex-desktop-native-relay) is not an exception to this: the companion never attaches to that app-server, it is *launched by* it as one of the app's own MCP servers.
- **A thread currently open in the desktop app cannot be written to** through a second app-server — Codex holds a per-thread writer lock (`~/.codex/thread-writer-locks/`) and returns `thread <id> already has an active writer`. That error is the guard working, not data loss. Check `status` with `list_codex_threads` first and only send when it is `idle` or `notLoaded` and not open in the app. For the Claude → Codex relay specifically, the [native relay](#codex-desktop-native-relay) removes the second writer instead of waiting for the lock.
- **Bridge-created threads are named before they are opened.** The bridge calls the app-server's `thread/name/set` with the requested title, or derives `[project] first line of prompt`, then opens the exact `codex://threads/<id>` link. This gives Codex Desktop a visible session title and preserves the precise `cwd` in the thread metadata.
- A repo living on the NTFS partition of a dual-boot machine (`/Volumes/<label>/...`) is **read-only** under macOS. Keep a separate checkout on an APFS volume to run and edit it.
- `codex app-server daemon start` uses the `unix://` transport with a control socket at `~/.codex/app-server-control/app-server-control.sock`. The bridge does **not** use that path (different framing, no public API) — it always talks over `ws://`.

## Troubleshooting

**A turn fails with "model requires a newer version of Codex" after upgrading Desktop.** An app-server already listening at `CODEX_APP_SERVER_URL` keeps running its original executable. Resolving a newer `CODEX_EXE` does not replace that process. Check the listening process and its executable version, then restart that server with the current Codex binary when its active work has finished. An isolated server on another local port can verify the upgrade without interrupting shared work.

**`readyz` never returns 200 after restarting the app-server.** The log says `failed to initialize sqlite state runtime under ~/.codex`. Cause: an older app-server is still alive and holding the sqlite state of `~/.codex` — only **one** process may hold it. Hard kills (`pkill -9`) or repeated `launchctl kickstart -k` leave zombies that `pkill -f "app-server --listen ws://…"` misses, because the process name is the vendored binary path.

```bash
ps aux | grep "[a]pp-server --listen"
pkill -9 -f "codex-darwin-arm64/vendor.*app-server"
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.codex-mcp-bridge.app-server.plist
```

**A turn runs a few steps then freezes, as if Codex paused itself.** The app-server **blocks on the client's reply** to each server request before continuing, so an unanswered method never surfaces as an error — the turn simply stops. Before 1.4.0 the bridge answered only 7 of 10 methods; the three that fell through to `default:` and got `-32601` were `item/permissions/requestApproval` (Codex asking to widen permissions — by far the most common), `mcpServer/elicitation/request` and `item/tool/call`. Verify with `npm test`. Get the authoritative method list from Codex itself rather than guessing:

```bash
codex app-server generate-json-schema --out /tmp/codex-schema
python3 -c "import json;[print(v['properties']['method'].get('const') or v['properties']['method'].get('enum')) for v in json.load(open('/tmp/codex-schema/ServerRequest.json'))['oneOf']]"
```

**The bridge disappears from Claude after sending into a busy thread.** Fixed in 1.6.0. A rejected `turn/start` — which is exactly what a thread locked by the desktop app produces — also rejected an internal promise nothing was awaiting. Node treats that as an unhandled rejection and, by default, exits the process, so the MCP server died while the tool handler was still formatting a tidy error message for a client that no longer had a server. Pinned by a test that runs the failure in a real child process and asserts it exits 0.

**The Codex app says a thread is "open in another application".** The app-server holds a writer lock while the thread is loaded. With `releaseAfterTurn: true`, the bridge unsubscribes after completion; unload can still wait for the server's idle delay or another subscriber. Open the thread after it unloads. Use `stop_codex_app_server` only when all work on that shared server may be stopped. A thread held by a different Codex window must be released there. To keep a thread open in Codex Desktop while Claude messages into it, use the [native relay](#codex-desktop-native-relay), which never takes a second writer lock.

**Desktop delivery fails on macOS while the relay reports itself installed.** The companion still creates its socket and `native_relay_status` still reports the native pipe, because Codex Desktop accepts the connection and only then closes it: it authenticates the connecting process's code-signing identity first, and a companion running under a Node build signed by anyone other than the vendor is refused. Every send then fails hard as `NATIVE_DELIVERY_UNCONFIRMED` rather than falling back, since the companion was reached. The app records the refusal as `dynamic_app_tools_peer_rejected reason=untrusted-code-signing-identity` (`~/Library/Logs/com.openai.codex/<date>/`; a process the app did not spawn is logged as `missing-code-signing-identity` instead). Re-run `scripts/install-native-relay.mjs` and check its `relay runtime:` line — it must not say `process.execPath` when Codex Desktop is installed. Point `CODEX_NATIVE_RELAY_NODE` at the runtime inside the app bundle if discovery misses it, and restart Codex Desktop so it relaunches the companion.

**`claude_bridge_status` says the delivery backend is `app-server` on Windows or macOS with the relay installed.** The `delivery:` line carries the reason: *"no companion socket at …"* means Codex Desktop has not launched the companion, so restart the app after `install-native-relay.mjs` and check `codex mcp get codex-native-relay`; *"disabled by CODEX_BRIDGE_NATIVE_RELAY=0"* means it was switched off in the MCP server's `env`; *"unavailable on Linux"* means the native relay is not supported there. A relay that is reachable but has no executor thread fails at send time instead, with `RELAY_THREAD_UNCONFIGURED` naming both `CODEX_RELAY_ID` and the file to bootstrap.

**A thread opens against the wrong directory.** The same project sits at a different absolute path on each machine: on the shared drive's letter under Windows, under its mount point when that drive is visible from macOS (**read-only** there), and in a native checkout otherwise. Since 1.4.0 the bridge picks the candidate that both **exists and is writable** on the current machine and prints a `note: cwd remapped …` line whenever it rewrites one. If nothing usable exists it fails immediately instead of opening a thread somewhere wrong. Handing Codex a read-only cwd is a reliable way to hit the freeze above: it runs a few reads, then asks for write permission and stalls.

**A path from another machine is remapped before it can cause a wrong checkout.** An explicit `CODEX_BRIDGE_PATH_MAP` is checked first. Otherwise the bridge keeps a path that already exists and is writable, and only then tries portable candidates for foreign drive letters, mount points, or UNC shares. If nothing usable exists it fails with the paths it tried instead of opening Codex in a guessed directory.

A path counts as coming from elsewhere when it names a drive letter (`D:\project`), a UNC share (`\\server\share\project`), or an attached volume (`/Volumes/<label>/project`, `/mnt/<label>/project`, `/media/<user>/<label>/project`). No particular letter, share, or label is blessed, so any dual-boot or external-disk layout works without configuration. The bridge then looks for that project under `$HOME`, then under **its own parent directory** — a bridge checked out at `~/code/codex-mcp-bridge` makes `~/code` the obvious place to find a sibling project. Override the list with `CODEX_BRIDGE_WORKSPACE_ROOTS`, provide deterministic source/target pairs with `CODEX_BRIDGE_PATH_MAP='{"L:\\project":"C:\\project"}'`, or set `CODEX_BRIDGE_REMAP=0` to switch heuristic rewriting off entirely.

Desktop task mode assigns tasks to the existing saved project through Desktop's native API. The separate app-server protocol does not provide that project assignment; a thread's `cwd` alone is not evidence that it appears under the expected Desktop project.

**Connection errors or a silent stall on the first call after rebooting.** The app-server does not survive a restart, so the first call after boot has to bring it back. Since 1.5.0 `connect()` retries once for boot-time transients, `onclose` only tears down its own socket (a late close from the previous one used to wipe the freshly established connection), and **a turn interrupted by a dropped connection ends immediately with status `disconnected`** instead of waiting out `timeoutSec` (240s by default). Verify with `npm test`. No LaunchAgent is needed for this — the bridge spawns an app-server on demand, and running a LaunchAgent alongside Codex Desktop only contends for the `~/.codex` state.

**Codex hangs when opening a new thread after adding an MCP server.** An MCP client waits on the `initialize` handshake, so a server that dies before answering looks like a *hang*, not an error. Paid for in practice here: `claude-bridge` called `execFileSync("ps", …)` while Codex spawns MCP servers with an **empty PATH** → `ENOENT` → death before the handshake → every `thread/start` timed out after 60s. Fix: call `/bin/ps` by absolute path inside a try/catch (`src/peer-protocol.mjs`). General lesson: **an MCP server must not depend on its parent's PATH** — test with `env -i PATH="" node <server>` before shipping.

## Environment variables

The bridge reads these from the environment its MCP client hands it — there is no `.env` file and no configuration to commit.

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_APP_SERVER_URL` | `ws://127.0.0.1:8791` | Shared **loopback-only** app-server endpoint. Non-loopback endpoints are rejected because this bridge does not implement remote WebSocket authentication. |
| `CODEX_BIN` | auto-detected | Path to `codex` used for autostart. |
| `CODEX_BRIDGE_AUTOSTART` | `1` in app-server mode | `0` = never spawn an external app-server. Always off in Desktop mode, which does not need one. |
| `CODEX_BRIDGE_THREAD_POLICY` | `owned` in the direct server; installer writes `roots` for new v1.11.2 entries | What authorizes a thread: `owned` (created by this bridge, or listed in `CODEX_BRIDGE_ALLOWED_THREADS`) or `roots` (working inside `CODEX_BRIDGE_ALLOWED_ROOTS`). Existing config values are preserved on upgrade. |
| `CODEX_BRIDGE_ALLOWED_THREADS` | empty | Exact comma-separated thread IDs permitted for read/send/interrupt/open/list; `*` explicitly permits every thread ID. Under `roots`, the workspace check still runs. |
| `CODEX_BRIDGE_ALLOWED_ROOTS` | `*` in the v1.11.2 installer | Absolute project directories permitted for `cwd`, separated by `:` (`;` on Windows); `*` means every usable workspace. |
| `CODEX_BRIDGE_APPROVAL` | `deny` | How to answer approval requests from Codex. `approve` is ignored unless `CODEX_BRIDGE_AUTO_APPROVE_ACK=1` is also set. |
| `CODEX_BRIDGE_AUTO_APPROVE_ACK` | empty | Explicit acknowledgement required to enable automatic command/file approval; set to `1` only after reviewing the risk. |
| `CODEX_BRIDGE_APPROVAL_POLICY` | `on-request` | Policy applied to threads created by the bridge. It is no longer caller-controlled. |
| `CODEX_BRIDGE_SANDBOX` | `workspace-write` | Sandbox applied to threads created by the bridge: `read-only` or `workspace-write`; unrestricted `danger-full-access` is rejected. |
| `CODEX_BRIDGE_REMAP` | `1` | `0` disables cwd remapping between a shared drive and a local checkout. |
| `CODEX_BRIDGE_PATH_MAP` | empty | Optional JSON object mapping absolute source paths to absolute target paths; use it when the same project has a known different path on another machine. |
| `CODEX_BRIDGE_WORKSPACE_ROOTS` | `$HOME` and the bridge's parent directory | Where to look for a project by name, most preferred first, separated by `:` (`;` on Windows). Setting it replaces the derived roots rather than adding to them. |
| `CODEX_BRIDGE_MODEL` | from `~/.codex/config.toml` | Default model for threads and turns the bridge creates, e.g. `gpt-5.6-luna`. |
| `CODEX_BRIDGE_EFFORT` | from `~/.codex/config.toml` | Default reasoning effort: `minimal` · `low` · `medium` · `high` · `xhigh` · `ultra`. |
| `CODEX_BRIDGE_OPEN_IN_APP` | `1` on Windows, `0` elsewhere | Open delegated or sent threads through the `codex://threads/<id>` desktop link. |
| `CODEX_BRIDGE_RELEASE_AFTER_TURN` | `1` on Windows, `0` elsewhere | Unsubscribe the completed thread without stopping other work; defer Desktop opening until unload is confirmed. |
| `CODEX_BRIDGE_NATIVE_RELAY` | `auto` | Delivery backend for relayed Claude messages. `auto` uses the Codex Desktop native relay on Windows/macOS when its companion endpoint exists; `0` never does; `1` attempts it on any platform. |
| `CODEX_RELAY_ID` | from `~/.codex/native-relay.json` | Executor thread for `codex_app.send_message_to_thread`. Not the destination — see [Codex Desktop native relay](#codex-desktop-native-relay). |
| `CODEX_HOME` | `~/.codex` | Where `native-relay.json` lives; POSIX relay sockets also live here, while Windows uses a named pipe. |
| `CODEX_NATIVE_RELAY_SOCKET` | Windows named pipe or `$CODEX_HOME/native-relay.sock` on macOS | Override the companion endpoint on both halves of the relay. |
| `CODEX_NATIVE_RELAY_METHOD` | `tools/call` | The undocumented Codex Desktop JSON-RPC method the companion dispatches through; override only for a verified protocol change. |
| `CODEX_NATIVE_RELAY_NAME` | `codex-native-relay` | The MCP server name `scripts/install-native-relay.mjs` registers with Codex. |
| `CODEX_NATIVE_RELAY_NODE` | the runtime Codex Desktop ships on macOS, otherwise `process.execPath` | Node runtime `scripts/install-native-relay.mjs` registers the companion under. Codex Desktop rejects a peer whose code-signing identity is not its own, so the companion has to run under a runtime the app trusts. |
| `CLAUDE_BRIDGE_PEER_NAME` | `codex-<pid>` | The name Claude shows for this bridge in its agent list. |
| `CLAUDE_BRIDGE_CWD` | the process cwd | The working directory the peer advertises. |
| `CLAUDE_DESKTOP_CONFIG` | auto-detected | Override the config path used by `install-claude-desktop.mjs`. |
| `CODEX_EXE` | auto-detected | Override the `codex` path used by the install scripts. |

**About model and effort:** the Codex desktop app **does not read** `model`/`model_reasoning_effort` from `~/.codex/config.toml` — it runs its own. A thread opened through the bridge can therefore be quietly weaker than the same work done in the app. Set `CODEX_BRIDGE_MODEL` and `CODEX_BRIDGE_EFFORT` in the MCP server's `env` so both paths match; `codex_bridge_status` prints what is in effect. Verify by reading Codex's own state rather than trusting that the override applied:

```bash
sqlite3 ~/.codex/state_5.sqlite "select model, reasoning_effort from threads order by updated_at desc limit 3;"
```

**About approvals:** Codex asks for command and patch approval unless `approval_policy` is `never`. The bridge denies those requests by default and logs each decision to stderr. Automatic approval is an explicit opt-in requiring both `CODEX_BRIDGE_APPROVAL=approve` and `CODEX_BRIDGE_AUTO_APPROVE_ACK=1`; keep the sandbox at `workspace-write` or `read-only`.

## Sharing the app-server with an interactive Codex session

Point the TUI at the same endpoint so the TUI thread and the bridge thread are literally the same thread:

```bash
codex --remote ws://127.0.0.1:8791
```

Run the app-server manually (independent of bridge autostart):

```bash
codex app-server --listen ws://127.0.0.1:8791
```

## Tests

```bash
npm test
```

Runs the whole suite with `node --test`. It needs no Codex install, no login and no quota: connection behaviour is exercised against a fake app-server (`test/helpers/fake-app-server.mjs`, a hand-rolled WebSocket with no extra dependency), and everything touching `~/.claude` or `~/.codex` runs against a throwaway `HOME`.

| File | Covers |
|---|---|
| `test/tool-contract.test.mjs` | all three servers boot over stdio and every tool declares a title, a description, per-parameter descriptions and complete annotation hints |
| `test/server-requests.test.mjs` | all 10 app-server requests get a reply in the shape their schema declares — the regression test for "the turn pauses itself" |
| `test/reconnect.test.mjs` | reconnect after a dropped socket, no leaked pending requests or listeners, an interrupted turn ending promptly, a refused first handshake being retried |
| `test/app-server-lifecycle.test.mjs` | concurrent initialization, failed sends, per-thread serialization and unsubscribe, and reconciliation of turns after reconnect |
| `test/bridge-integration.test.mjs` | real MCP children against isolated app-servers: workspace authorization, loaded-thread pagination, diagnostic exit status, and concurrent handoffs |
| `test/turn.test.mjs` | the turn state machine: buffered notifications, terminal statuses, timeout, disconnect, retryable vs fatal errors, and that a failed `turn/start` cannot kill the process |
| `test/peer-protocol.test.mjs` | frame round-trips, the session registry, transcript scanning, and a live peer endpoint over a real unix socket |
| `test/platform.test.mjs` | binary resolution, the PATH handed to child processes, per-OS config paths and cwd remapping |
| `test/native-relay.test.mjs` | the Codex Desktop relay: executor thread resolution, feature detection, Windows named-pipe and POSIX socket round trips, backend selection and fallback, and the companion answering a real MCP client that plays Codex Desktop |
| `test/repo-hygiene.test.mjs` | no environment file or build output is ever tracked, versions do not drift, documentation stays in English |

GitHub Actions runs the same command on every push and pull request, across Node 22 and 24 on Linux, macOS and Windows (`.github/workflows/ci.yml`). The Codex → Claude direction uses unix sockets on macOS/Linux and named pipes on Windows; the native relay has matching platform-specific coverage.

Two checks need a real Codex and are not part of `npm test`:

```bash
npm run check    # boots the bridge against a real app-server and lists threads
npm run smoke    # creates a thread, sends two turns, asserts Codex still remembers a codeword from the first
```

`npm run smoke` spends quota — run it when a change touches turn handling, not on every commit.

The Codex → Claude direction has its own live check:

```bash
npm run check:claude                                    # list the Claude sessions Codex can see
CLAUDE_TARGET=<sessionId> CLAUDE_EXPECTED_CWD=/absolute/project CLAUDE_WAIT=150 npm run check:claude   # deliver a message and wait for the answer
```

A reply coming back proves both directions work.

## Contributing

Conventions, the test gate and the tool-annotation contract are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
