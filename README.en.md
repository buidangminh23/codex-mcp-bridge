# codex-mcp-bridge

*[Bản tiếng Việt](README.md)*

A **two-way** bridge between Claude and Codex: Claude pushes prompts into a **live Codex thread**, and Codex messages back into a **running Claude Code session**. Each side can see the other's sessions and follow the conversation inside its own app. Runs on **macOS, Windows and Linux** (the Codex → Claude direction needs unix sockets, so macOS/Linux only).

This is not `codex exec`, which starts a fresh session every time. The bridge speaks JSON-RPC to the real Codex app-server, so the thread keeps its history, its `cwd`, its model and its rollout file.

## Architecture

Two MCP servers, one living inside each agent:

```
                     ┌──────────────── codex-mcp-bridge (runs inside Claude) ──────────────┐
Claude Desktop ──────┤ stdio                                    WebSocket                   ├──> codex app-server ──> thread shows in Codex Desktop
                     └─────────────────────────────────────────────────────────────────────┘

                     ┌──────────────── claude-bridge (runs inside Codex) ──────────────────┐
Codex ───────────────┤ stdio                       unix socket /tmp/cc-socks/<pid>.sock    ├──> Claude Code session ──> message shows in Claude Desktop
                     └─────────────────────────────────────────────────────────────────────┘

Codex TUI  ──codex --remote ws://127.0.0.1:8791──> same app-server, same live thread
```

- The app-server is a **singleton per port**. The bridge probes `http://127.0.0.1:8791/readyz`; if nothing answers it spawns a detached `codex app-server --listen ws://127.0.0.1:8791`, which keeps running after the bridge exits.
- Every client pointed at the same URL shares **one app-server**, so `thread/resume` with a `threadId` rejoins the running thread instead of opening a new session.
- The bridge keeps exactly one WebSocket, calls `initialize` once, and routes notifications by `threadId`, so parallel threads never bleed into each other.

## Tools — `codex-mcp-bridge` (install into Claude)

| Tool | What it does |
|---|---|
| `send_to_codex_thread` | Sends a prompt as a user turn into `threadId`, waits for `turn/completed`, returns Codex's reply plus an activity trail (commands run, files changed). |
| `list_codex_threads` | Lists threads (id, title, cwd, last update, status) so you can pick the **exact** `threadId`. `loadedOnly: true` shows only threads live inside the app-server. On macOS each row carries a `codex://threads/<id>` deep link. |
| `start_codex_thread` | Opens a new Codex thread at a given `cwd` and returns its `threadId`. |
| `read_codex_thread` | Reads the recent conversation without sending anything. |
| `interrupt_codex_turn` | Stops a turn that is still running. |
| `open_codex_thread` | **macOS**: brings a thread to the front in the Codex desktop app via `codex://threads/<id>` so a human can watch it work. Pass `background: true` to open without stealing focus. |
| `stop_codex_app_server` | Stops the shared app-server once a hand-off is done, so it stops competing with Codex Desktop for the `~/.codex` state. The bridge starts a new one when it next needs it. |
| `codex_bridge_status` | Reports the environment: platform, resolved `codex` binary, whether the app-server endpoint is live, plus the macOS integrations (LaunchAgent, desktop app), and **warns when two app-servers are running**. Start here when something misbehaves. |

`send_to_codex_thread` also accepts `timeoutSec` (default 240), `cwd`, `model`, `effort`, and `openInApp` (macOS — surface the thread in the desktop app before sending). A timeout does **not** cancel the turn: the bridge returns what it collected plus the `turnId`; keep reading with `read_codex_thread` or stop it with `interrupt_codex_turn`.

## Tools — `claude-bridge` (install into Codex)

| Tool | What it does |
|---|---|
| `list_claude_sessions` | Lists Claude Code sessions running on this machine (name, pid, sessionId, cwd, entrypoint). |
| `send_to_claude_session` | Delivers a message into a Claude session — it lands **in that session's chat**, exactly like a teammate's message — and waits for the reply. `waitSec: 0` fires and forgets. `target` takes a name, pid or sessionId; **Claude session names drift over time**, so target by `sessionId` when it matters. |
| `read_claude_inbox` | Reads (and clears) messages Claude pushed over on its own, including replies that arrived late. |
| `read_claude_transcript` | Reads a Claude session's recent conversation without sending anything. |
| `bind_codex_thread` | Binds a Codex thread so every message from Claude is relayed into it, **visible in the Codex desktop app**. Pass an empty string to stop. |
| `claude_bridge_status` | Reports the peer endpoint, how many Claude sessions are live, the relay thread and the inbox depth. |

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

## Requirements

- Node.js 22 or newer
- The [Codex CLI](https://developers.openai.com/codex) (`codex`) installed and logged in
- Claude Desktop (or any MCP client that can launch a stdio server)

## Install into Claude Desktop

```bash
npm install
node scripts/install-claude-desktop.mjs
```

The script detects the platform, creates the config file if it does not exist, backs up the previous one (`*.bak-<date>-codexbridge`) and preserves every other key:

| OS | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Claude/claude_desktop_config.json` |

Result on macOS:

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

Restart Claude Desktop afterwards.

**Resolving the `codex` binary:** Claude Desktop (and launchd) start MCP servers with a trimmed PATH, so `codex` is usually not on it. The bridge probes `CODEX_BIN` first, then the usual install locations for the platform, then PATH:

| OS | Probe order |
|---|---|
| macOS / Linux | `~/.local/bin/codex` → `~/.npm-global/bin/codex` → `/opt/homebrew/bin/codex` → `/usr/local/bin/codex` → `~/.volta/bin` → `~/.bun/bin` → `~/.cargo/bin` → `~/.codex/packages/standalone/current/codex` → `/Applications/ChatGPT.app/Contents/Resources/codex` (macOS only) |
| Windows | `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` → `%APPDATA%\npm\codex.cmd` → `%ProgramFiles%\nodejs\codex.cmd` |

On macOS and Linux the `codex` launcher is a Node script with a `#!/usr/bin/env node` shebang, so the bridge also rebuilds `PATH` for the child process (current node directory + `/opt/homebrew/bin` + `/usr/local/bin` + system dirs). Without that step, spawning the app-server dies at the shebang.

## Install into Codex (the reverse direction)

```bash
node scripts/install-codex-mcp.mjs
```

Runs `codex mcp add claude-bridge -- <node> src/claude-bridge.mjs`, writing to `~/.codex/config.toml`. Verify with `codex mcp list`; remove with `node scripts/install-codex-mcp.mjs --remove`.

Restart the Codex app (or open a new Codex session) to load it. If a shared app-server is already running under launchd, reload its config with:

```bash
launchctl kickstart -k gui/$UID/com.codex-mcp-bridge.app-server
```

Set `CLAUDE_BRIDGE_PEER_NAME` to advertise a name other than `codex` — that is the name Claude sees in its agent list.

## macOS

### Keep the app-server alive with launchd

> ⚠️ **Do not enable the LaunchAgent while using the Codex desktop app.** The app runs its **own** stdio app-server against the **same** `~/.codex` sqlite state. Two app-servers contend even while idle — measured here: the launchd one burned ~11% CPU doing nothing and **the Codex app UI stuttered**. Keep exactly one alive; `codex_bridge_status` detects and warns about this.
>
> The LaunchAgent makes sense on a machine **without** the desktop app (headless box, CLI/TUI only). With the app running, drop it and let the bridge spawn an app-server on demand — contention then lasts only while you are actually delegating work, not 24/7.

```bash
node scripts/install-launch-agent.mjs
```

Writes `~/Library/LaunchAgents/com.codex-mcp-bridge.app-server.plist` (`RunAtLoad` plus `KeepAlive` on crash, 10s `ThrottleInterval`) and bootstraps it into `gui/$UID`. The app-server is then up from login, so the bridge never has to spawn one and threads stay live.

```bash
launchctl print gui/$UID/com.codex-mcp-bridge.app-server | head -20   # status
node scripts/install-launch-agent.mjs --uninstall                     # remove
```

Logs: `~/Library/Logs/codex-mcp-bridge/app-server.{out,err}.log`.

### Watch a thread in the Codex desktop app

The Codex desktop app on macOS is `/Applications/ChatGPT.app` and registers the `codex://` URL scheme. The bridge uses `codex://threads/<threadId>` to open the exact thread:

```
open_codex_thread { threadId: "01a0…", background: true }
send_to_codex_thread { threadId: "01a0…", prompt: "…", openInApp: true }
```

This is how a human watches Codex work in real time instead of reading the rollout at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` after the fact.

### macOS caveats

- The Codex desktop app runs its own app-server over stdio (`ChatGPT.app/Contents/Resources/codex … app-server`, **no** `--listen`), so nothing external can attach to it. `~/.codex/ipc/ipc.sock` is the Electron app's internal IPC, not an app-server. Threads opened there can still be driven through the bridge, but by resuming from the rollout `.jsonl` rather than attaching live.
- **A thread currently open in the desktop app cannot be written to** — Codex holds a per-thread writer lock (`~/.codex/thread-writer-locks/`) and returns `thread <id> already has an active writer`. That error is the guard working, not data loss. Check `status` with `list_codex_threads` first and only send when it is `idle` or `notLoaded` and not open in the app.
- **Threads created by the bridge do not show a title in the app.** The app lists from `~/.codex/session_index.jsonl`, and entries land there only once a thread has been named — naming is done by the app, not the app-server. The thread still exists in `~/.codex/state_5.sqlite` and opens via the `codex://threads/<id>` deep link.
- A repo living on the NTFS partition of a dual-boot machine (`/Volumes/...`) is **read-only** under macOS. Keep a separate checkout on an APFS volume to run and edit it.
- `codex app-server daemon start` uses the `unix://` transport with a control socket at `~/.codex/app-server-control/app-server-control.sock`. The bridge does **not** use that path (different framing, no public API) — it always talks over `ws://`.

## Troubleshooting

**`readyz` never returns 200 after restarting the app-server.** The log says `failed to initialize sqlite state runtime under ~/.codex`. Cause: an older app-server is still alive and holding the sqlite state of `~/.codex` — only **one** process may hold it. Hard kills (`pkill -9`) or repeated `launchctl kickstart -k` leave zombies that `pkill -f "app-server --listen ws://…"` misses, because the process name is the vendored binary path.

```bash
ps aux | grep "[a]pp-server --listen"
pkill -9 -f "codex-darwin-arm64/vendor.*app-server"
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.codex-mcp-bridge.app-server.plist
```

**Codex hangs when opening a new thread after adding an MCP server.** An MCP client waits on the `initialize` handshake, so a server that dies before answering looks like a *hang*, not an error. Paid for in practice here: `claude-bridge` called `execFileSync("ps", …)` while Codex spawns MCP servers with an **empty PATH** → `ENOENT` → death before the handshake → every `thread/start` timed out after 60s. Fix: call `/bin/ps` by absolute path inside a try/catch (`src/peer-protocol.mjs`). General lesson: **an MCP server must not depend on its parent's PATH** — test with `env -i PATH="" node <server>` before shipping.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_APP_SERVER_URL` | `ws://127.0.0.1:8791` | Shared app-server endpoint. |
| `CODEX_BIN` | auto-detected | Path to `codex` used for autostart. |
| `CODEX_BRIDGE_AUTOSTART` | `1` | `0` = never spawn an app-server; one must already be running. |
| `CODEX_BRIDGE_APPROVAL` | `approve` | How to answer approval requests from Codex. Set `deny` to refuse. |
| `CODEX_BRIDGE_MODEL` | from `~/.codex/config.toml` | Default model for threads and turns the bridge creates, e.g. `gpt-5.6-luna`. |
| `CODEX_BRIDGE_EFFORT` | from `~/.codex/config.toml` | Default reasoning effort: `minimal` · `low` · `medium` · `high` · `xhigh` · `ultra`. |
| `CLAUDE_DESKTOP_CONFIG` | auto-detected | Override the config path used by `install-claude-desktop.mjs`. |
| `CODEX_EXE` | auto-detected | Override the `codex` path used by both install scripts. |

**About model and effort:** the Codex desktop app **does not read** `model`/`model_reasoning_effort` from `~/.codex/config.toml` — it runs its own. A thread opened through the bridge can therefore be quietly weaker than the same work done in the app. Set `CODEX_BRIDGE_MODEL` and `CODEX_BRIDGE_EFFORT` in the MCP server's `env` so both paths match; `codex_bridge_status` prints what is in effect. Verify by reading Codex's own state rather than trusting that the override applied:

```bash
sqlite3 ~/.codex/state_5.sqlite "select model, reasoning_effort from threads order by updated_at desc limit 3;"
```

**About approvals:** Codex asks for command and patch approval unless `approval_policy` is `never`. Nobody is sitting in front of Claude Desktop to click, so the bridge answers according to `CODEX_BRIDGE_APPROVAL` and logs each decision to stderr. The `approve` default matches an `approval_policy = "never"` + `sandbox_mode = "danger-full-access"` setup in `~/.codex/config.toml`; with a tighter sandbox, consider `deny`.

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
npm run check
```

Quick check: the bridge boots, autostarts an app-server if needed, lists threads.

```bash
npm run smoke
```

The smoke test creates a thread, sends two turns and verifies Codex still remembers a codeword from the first one — proof the thread is continuous rather than a fresh session each time.

```bash
npm run check:claude
```

Checks the Codex → Claude direction by listing live Claude sessions. To send for real:

```bash
CLAUDE_TARGET=<sessionId> CLAUDE_WAIT=150 npm run check:claude
```

That delivers a message into the session and **waits for Claude's answer** — a reply coming back proves both directions work.

From inside Claude, call `codex_bridge_status`; from inside Codex, call `claude_bridge_status`.

## License

MIT — see [LICENSE](LICENSE).
