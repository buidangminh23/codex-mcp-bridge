# codex-mcp-bridge

[![M8ven Verified](https://m8ven.ai/badge/mcp/buidangminh23-codex-mcp-bridge-1ke8t1?variant=verified)](https://m8ven.ai/mcp/buidangminh23-codex-mcp-bridge-1ke8t1)

A **two-way** bridge between Claude and Codex: Claude pushes prompts into a **live Codex thread**, and Codex messages back into a **running Claude Code session**. Each side sees the other's sessions and follows the conversation inside its own app. Runs on **macOS, Windows and Linux** (the Codex → Claude direction needs unix sockets, so macOS/Linux only).

This is not `codex exec`, which starts a fresh session every time. The bridge speaks JSON-RPC to the real Codex app-server, so the thread keeps its history, its `cwd`, its model and its rollout file — and a human can watch it run in the Codex desktop app instead of reading the transcript afterwards.

## Architecture

Two MCP servers, one living inside each agent:

```
                     ┌──────────────── codex-mcp-bridge (runs inside Claude) ──────────────┐
Claude Desktop ──────┤ stdio                                    WebSocket                  ├──> codex app-server ──> thread shows in Codex Desktop
                     └────────────────────────────────────────────────────────────────────┘

                     ┌──────────────── claude-bridge (runs inside Codex) ──────────────────┐
Codex ───────────────┤ stdio                       unix socket /tmp/cc-socks/<pid>.sock    ├──> Claude Code session ──> message shows in Claude Desktop
                     └────────────────────────────────────────────────────────────────────┘

Codex TUI  ──codex --remote ws://127.0.0.1:8791──> same app-server, same live thread
```

- The app-server is a **singleton per port**. The bridge probes `http://127.0.0.1:8791/readyz`; if nothing answers it spawns a detached `codex app-server --listen ws://127.0.0.1:8791`, which keeps running after the bridge exits.
- Every client pointed at the same URL shares **one app-server**, so `thread/resume` with a `threadId` rejoins the running thread instead of opening a new session.
- The bridge keeps exactly one WebSocket, calls `initialize` once, and routes notifications by `threadId`, so parallel threads never bleed into each other.

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

### 1. Get the code

```bash
git clone https://github.com/buidangminh23/codex-mcp-bridge.git
cd codex-mcp-bridge
npm install
```

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

This runs `codex mcp add claude-bridge -- <node> src/claude-bridge.mjs`, writing to `~/.codex/config.toml`. The equivalent by hand:

```bash
codex mcp add claude-bridge --env CLAUDE_BRIDGE_PEER_NAME=codex-desktop -- "$(command -v node)" "$PWD/src/claude-bridge.mjs"
```

Verify and remove:

```bash
codex mcp list
codex mcp get claude-bridge
node scripts/install-codex-mcp.mjs --remove
```

Restart the Codex app (or open a new Codex session) to load it. If a shared app-server is already running under launchd, reload its config with:

```bash
launchctl kickstart -k gui/$UID/com.codex-mcp-bridge.app-server
```

`CLAUDE_BRIDGE_PEER_NAME` sets the name Claude shows for this bridge in its agent list.

### 5. macOS only: keep the app-server alive with launchd

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

### 6. Verify the install

```bash
npm run check          # boots the bridge, autostarts an app-server, lists threads
npm run check:claude   # lists the live Claude Code sessions Codex can reach
```

From inside Claude, call the `codex_bridge_status` tool; from inside Codex, call `claude_bridge_status`. Both print the resolved binary, the endpoint and whether anything is listening.

### 7. Uninstall everything

```bash
claude mcp remove codex-bridge --scope user
node scripts/install-codex-mcp.mjs --remove
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
| `send_to_codex_thread` | Sends a prompt as a user turn into `threadId`, waits for `turn/completed`, returns Codex's reply plus an activity trail (commands run, files changed). | destructive |
| `list_codex_threads` | Lists threads (id, title, cwd, last update, status) so you can pick the **exact** `threadId`. `loadedOnly: true` shows only threads live inside the app-server. On macOS each row carries a `codex://threads/<id>` deep link. | read-only |
| `start_codex_thread` | Opens a new Codex thread at a permitted `cwd` and returns its `threadId`; the bridge applies its configured safe sandbox and approval policy. | writes |
| `read_codex_thread` | Reads the recent conversation without sending anything. | read-only |
| `interrupt_codex_turn` | Stops a turn that is still running. | destructive |
| `open_codex_thread` | **macOS**: brings a thread to the front in the Codex desktop app via `codex://threads/<id>` so a human can watch it work. Pass `background: true` to open without stealing focus. | writes |
| `stop_codex_app_server` | Stops the shared app-server once a hand-off is done, so it stops competing with Codex Desktop for the `~/.codex` state. The bridge starts a new one when it next needs it. | destructive |
| `codex_bridge_status` | Reports the environment: platform, resolved `codex` binary, whether the app-server endpoint is live, plus the macOS integrations (LaunchAgent, desktop app), and **warns when two app-servers are running**. Start here when something misbehaves. | read-only |

`send_to_codex_thread` also accepts `timeoutSec` (default 240), `cwd`, `model`, `effort`, and `openInApp` (macOS — surface the thread in the desktop app before sending). A timeout does **not** cancel the turn: the bridge returns what it collected plus the `turnId`; keep reading with `read_codex_thread` or stop it with `interrupt_codex_turn`.

Thread operations are deny-by-default. Set `CODEX_BRIDGE_ALLOWED_THREADS` to a comma-separated list of exact thread IDs you want this MCP server to access; threads created by `start_codex_thread` are authorized for the lifetime of this bridge process. Set `CODEX_BRIDGE_ALLOWED_ROOTS` to the absolute project directories the bridge may use. The installer defaults that root to this repository, so change it when delegating into another project.

## Tools — `claude-bridge` (runs inside Codex)

| Tool | What it does | Hints |
|---|---|---|
| `list_claude_sessions` | Lists Claude Code sessions running on this machine (name, pid, sessionId, cwd, entrypoint). | read-only |
| `send_to_claude_session` | Delivers a message into a Claude session — it lands **in that session's chat**, exactly like a teammate's message — and waits for the reply. `waitSec: 0` fires and forgets. `target` takes a name, pid or sessionId; **Claude session names drift over time**, so target by `sessionId` when it matters. | destructive |
| `read_claude_inbox` | Reads **and clears** messages Claude pushed over on its own, including replies that arrived late. | destructive |
| `read_claude_transcript` | Reads a Claude session's recent conversation without sending anything. | read-only |
| `bind_codex_thread` | Binds a Codex thread so every message from Claude is relayed into it, **visible in the Codex desktop app**. Pass an empty string to stop. | writes |
| `claude_bridge_status` | Reports the peer endpoint, how many Claude sessions are live, the relay thread and the inbox depth. | writes |

Every tool declares MCP annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), because a client decides whether a call needs a human in the loop from those hints and a missing one reads as "unknown". Two are worth naming: `read_claude_inbox` empties the inbox as it reads it, so it is **not** read-only despite the name, and `claude_bridge_status` registers the peer endpoint on first call, so it writes too.

### How each side sees the other

- **Claude sees Codex:** `claude-bridge` registers itself as a *peer session* under `~/.claude/sessions/`. Claude lists it with `ListAgents` and messages it with `SendMessage` — not hidden, not an invisible background process. The default name is `codex-<pid>`; after `bind_codex_thread` it renames itself to `codex-<first 8 chars of threadId>`, which is what makes several bridges distinguishable (Codex starts **one bridge per session**, so a few peers usually advertise at once).
- **Codex sees Claude:** `list_claude_sessions` reads that same registry, and `read_claude_transcript` shows what a Claude session is working on.
- **Visible in chat:** a message from Codex appears in the Claude Desktop chat of the target session; a message from Claude is relayed into the bound Codex thread, so it appears in the Codex desktop app.

### Protocol (measured, not documented)

Every Claude Code session writes `~/.claude/sessions/<pid>.json` and listens on `/tmp/cc-socks/<pid>.sock`. Frames are **NDJSON**, one message per line:

```json
{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user",
 "content":"<cross-session-message from=\"uds:/tmp/cc-socks/<pid>.sock\" from-mode=\"bypass\">\n...\n</cross-session-message>"},
 "priority":"next","from":"uds:/tmp/cc-socks/<pid>.sock"}
```

There is no token in the frame — **the socket is mode `0600`, so owning the user account is the entire security boundary**. To receive replies you must register a peer session of your own (registry entry + socket), because Claude answers to the address in `from`.

> ⚠️ This is a **Claude Code internal with no public documentation** (measured on 2.1.229). If the format changes, the Codex → Claude direction breaks; fix it in `src/peer-protocol.mjs`. The Claude → Codex direction goes through the official app-server and is unaffected.

### Ping-pong guard

The relay has two hard limits in `src/claude-bridge.mjs`: at most **one message every 5s** and **50 per bridge run**. Two agents left talking to each other unattended still come to a stop.

## macOS notes

### Watch a thread in the Codex desktop app

The Codex desktop app on macOS is `/Applications/ChatGPT.app` and registers the `codex://` URL scheme. The bridge uses `codex://threads/<threadId>` to open the exact thread:

```
open_codex_thread { threadId: "01a0…", background: true }
send_to_codex_thread { threadId: "01a0…", prompt: "…", openInApp: true }
```

This is how a human watches Codex work in real time instead of reading the rollout at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` after the fact.

### Caveats

- The Codex desktop app runs its own app-server over stdio (`ChatGPT.app/Contents/Resources/codex … app-server`, **no** `--listen`), so nothing external can attach to it. `~/.codex/ipc/ipc.sock` is the Electron app's internal IPC, not an app-server. Threads opened there can still be driven through the bridge, but by resuming from the rollout `.jsonl` rather than attaching live.
- **A thread currently open in the desktop app cannot be written to** — Codex holds a per-thread writer lock (`~/.codex/thread-writer-locks/`) and returns `thread <id> already has an active writer`. That error is the guard working, not data loss. Check `status` with `list_codex_threads` first and only send when it is `idle` or `notLoaded` and not open in the app.
- **Threads created by the bridge do not show a title in the app.** The app lists from `~/.codex/session_index.jsonl`, and entries land there only once a thread has been named — naming is done by the app, not the app-server. The thread still exists in `~/.codex/state_5.sqlite` and opens via the `codex://threads/<id>` deep link.
- A repo living on the NTFS partition of a dual-boot machine (`/Volumes/<label>/...`) is **read-only** under macOS. Keep a separate checkout on an APFS volume to run and edit it.
- `codex app-server daemon start` uses the `unix://` transport with a control socket at `~/.codex/app-server-control/app-server-control.sock`. The bridge does **not** use that path (different framing, no public API) — it always talks over `ws://`.

## Troubleshooting

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

**The Codex app says a thread is "open in another application".** That is the per-thread writer lock, and the other application is usually this bridge: the shared app-server takes the lock when it loads a thread and keeps it until it exits, so the desktop app cannot write to the same thread. `open_codex_thread` and `openInApp` now say so at the moment they open a thread the bridge is holding, instead of leaving the app's message to be decoded. Release it with `stop_codex_app_server` once the hand-off is done — the bridge starts a new app-server the next time it needs one. A thread held by a *different* Codex window is the app's own lock; close it there.

**A thread opens against the wrong directory.** The same project sits at a different absolute path on each machine: on the shared drive's letter under Windows, under its mount point when that drive is visible from macOS (**read-only** there), and in a native checkout otherwise. Since 1.4.0 the bridge picks the candidate that both **exists and is writable** on the current machine and prints a `note: cwd remapped …` line whenever it rewrites one. If nothing usable exists it fails immediately instead of opening a thread somewhere wrong. Handing Codex a read-only cwd is a reliable way to hit the freeze above: it runs a few reads, then asks for write permission and stalls.

**The path as given always goes first.** If this machine can already write there, nothing is rewritten — guessing over an explicit instruction would be the bug. Rewriting only happens for a path this machine cannot use, which is exactly the case it exists for: macOS mounts NTFS read-only, so the drive a Windows brief quotes is visible and useless at the same time.

A path counts as coming from elsewhere when it names a drive letter (`D:\project`) or an attached volume (`/Volumes/<label>/project`, `/mnt/<label>/project`, `/media/<user>/<label>/project`). No particular letter or label is blessed, so any dual-boot or external-disk layout works without configuration. The bridge then looks for that project name under `$HOME`, then under **its own parent directory** — a bridge checked out at `~/code/codex-mcp-bridge` makes `~/code` the obvious place to find a sibling project, which is measured rather than configured. Override the list with `CODEX_BRIDGE_WORKSPACE_ROOTS`, or set `CODEX_BRIDGE_REMAP=0` to switch the rewriting off entirely.

Note: Codex Desktop does **not** group threads by directory — the sidebar has `Pinned` and everything else, and the protocol exposes no API to file a thread under a section (`thread/start` takes no `sectionId`; `thread/metadata/update` only patches gitInfo). What ties a thread to a project is its `cwd`.

**Connection errors or a silent stall on the first call after rebooting.** The app-server does not survive a restart, so the first call after boot has to bring it back. Since 1.5.0 `connect()` retries once for boot-time transients, `onclose` only tears down its own socket (a late close from the previous one used to wipe the freshly established connection), and **a turn interrupted by a dropped connection ends immediately with status `disconnected`** instead of waiting out `timeoutSec` (240s by default). Verify with `npm test`. No LaunchAgent is needed for this — the bridge spawns an app-server on demand, and running a LaunchAgent alongside Codex Desktop only contends for the `~/.codex` state.

**Codex hangs when opening a new thread after adding an MCP server.** An MCP client waits on the `initialize` handshake, so a server that dies before answering looks like a *hang*, not an error. Paid for in practice here: `claude-bridge` called `execFileSync("ps", …)` while Codex spawns MCP servers with an **empty PATH** → `ENOENT` → death before the handshake → every `thread/start` timed out after 60s. Fix: call `/bin/ps` by absolute path inside a try/catch (`src/peer-protocol.mjs`). General lesson: **an MCP server must not depend on its parent's PATH** — test with `env -i PATH="" node <server>` before shipping.

## Environment variables

The bridge reads these from the environment its MCP client hands it — there is no `.env` file and no configuration to commit.

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_APP_SERVER_URL` | `ws://127.0.0.1:8791` | Shared **loopback-only** app-server endpoint. Non-loopback endpoints are rejected because this bridge does not implement remote WebSocket authentication. |
| `CODEX_BIN` | auto-detected | Path to `codex` used for autostart. |
| `CODEX_BRIDGE_AUTOSTART` | `1` | `0` = never spawn an app-server; one must already be running. |
| `CODEX_BRIDGE_ALLOWED_THREADS` | empty | Exact comma-separated thread IDs permitted for read/send/interrupt/open/list. Empty means no pre-existing thread access. |
| `CODEX_BRIDGE_ALLOWED_ROOTS` | empty (installer sets its repo root) | Absolute project directories permitted for `cwd`, separated by `:` (`;` on Windows). |
| `CODEX_BRIDGE_APPROVAL` | `deny` | How to answer approval requests from Codex. `approve` is ignored unless `CODEX_BRIDGE_AUTO_APPROVE_ACK=1` is also set. |
| `CODEX_BRIDGE_AUTO_APPROVE_ACK` | empty | Explicit acknowledgement required to enable automatic command/file approval; set to `1` only after reviewing the risk. |
| `CODEX_BRIDGE_APPROVAL_POLICY` | `on-request` | Policy applied to threads created by the bridge. It is no longer caller-controlled. |
| `CODEX_BRIDGE_SANDBOX` | `workspace-write` | Sandbox applied to threads created by the bridge: `read-only` or `workspace-write`; unrestricted `danger-full-access` is rejected. |
| `CODEX_BRIDGE_REMAP` | `1` | `0` disables cwd remapping between a shared drive and a local checkout. |
| `CODEX_BRIDGE_WORKSPACE_ROOTS` | `$HOME` and the bridge's parent directory | Where to look for a project by name, most preferred first, separated by `:` (`;` on Windows). Setting it replaces the derived roots rather than adding to them. |
| `CODEX_BRIDGE_MODEL` | from `~/.codex/config.toml` | Default model for threads and turns the bridge creates, e.g. `gpt-5.6-luna`. |
| `CODEX_BRIDGE_EFFORT` | from `~/.codex/config.toml` | Default reasoning effort: `minimal` · `low` · `medium` · `high` · `xhigh` · `ultra`. |
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
| `test/tool-contract.test.mjs` | both servers boot over stdio and every tool declares a title, a description, per-parameter descriptions and complete annotation hints |
| `test/server-requests.test.mjs` | all 10 app-server requests get a reply in the shape their schema declares — the regression test for "the turn pauses itself" |
| `test/reconnect.test.mjs` | reconnect after a dropped socket, no leaked pending requests or listeners, an interrupted turn ending promptly, a refused first handshake being retried |
| `test/turn.test.mjs` | the turn state machine: buffered notifications, terminal statuses, timeout, disconnect, retryable vs fatal errors, and that a failed `turn/start` cannot kill the process |
| `test/peer-protocol.test.mjs` | frame round-trips, the session registry, transcript scanning, and a live peer endpoint over a real unix socket |
| `test/platform.test.mjs` | binary resolution, the PATH handed to child processes, per-OS config paths and cwd remapping |
| `test/repo-hygiene.test.mjs` | no environment file or build output is ever tracked, versions do not drift, documentation stays in English |

GitHub Actions runs the same command on every push and pull request, across Node 22 and 24 on Linux and macOS (`.github/workflows/ci.yml`). Windows is supported by the bridge but not covered by CI: the Codex → Claude direction needs unix sockets, so those tests skip there anyway.

Two checks need a real Codex and are not part of `npm test`:

```bash
npm run check    # boots the bridge against a real app-server and lists threads
npm run smoke    # creates a thread, sends two turns, asserts Codex still remembers a codeword from the first
```

`npm run smoke` spends quota — run it when a change touches turn handling, not on every commit.

The Codex → Claude direction has its own live check:

```bash
npm run check:claude                                    # list the Claude sessions Codex can see
CLAUDE_TARGET=<sessionId> CLAUDE_WAIT=150 npm run check:claude   # deliver a message and wait for the answer
```

A reply coming back proves both directions work.

## Contributing

Conventions, the test gate and the tool-annotation contract are in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
