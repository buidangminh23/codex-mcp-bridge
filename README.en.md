# codex-mcp-bridge

*[Bản tiếng Việt](README.md)*

An MCP server that lets Claude Desktop **push a prompt straight into an existing Codex thread**, through a **shared Codex app-server**. Runs on **macOS, Windows and Linux**.

This is not `codex exec`, which starts a fresh session every time. The bridge speaks JSON-RPC to the real Codex app-server, so the thread keeps its history, its `cwd`, its model and its rollout file.

## Architecture

```
Claude Desktop ──stdio──> codex-mcp-bridge ──WebSocket──> codex app-server (ws://127.0.0.1:8791)
                                                                  │
Codex TUI  ──codex --remote ws://127.0.0.1:8791───────────────────┘   (same app-server, same live thread)
```

- The app-server is a **singleton per port**. The bridge probes `http://127.0.0.1:8791/readyz`; if nothing answers it spawns a detached `codex app-server --listen ws://127.0.0.1:8791`, which keeps running after the bridge exits.
- Every client pointed at the same URL shares **one app-server**, so `thread/resume` with a `threadId` rejoins the running thread instead of opening a new session.
- The bridge keeps exactly one WebSocket, calls `initialize` once, and routes notifications by `threadId`, so parallel threads never bleed into each other.

## Tools

| Tool | What it does |
|---|---|
| `send_to_codex_thread` | Sends a prompt as a user turn into `threadId`, waits for `turn/completed`, returns Codex's reply plus an activity trail (commands run, files changed). |
| `list_codex_threads` | Lists threads (id, title, cwd, last update, status) so you can pick the **exact** `threadId`. `loadedOnly: true` shows only threads live inside the app-server. On macOS each row carries a `codex://threads/<id>` deep link. |
| `start_codex_thread` | Opens a new Codex thread at a given `cwd` and returns its `threadId`. |
| `read_codex_thread` | Reads the recent conversation without sending anything. |
| `interrupt_codex_turn` | Stops a turn that is still running. |
| `open_codex_thread` | **macOS**: brings a thread to the front in the Codex desktop app via `codex://threads/<id>` so a human can watch it work. Pass `background: true` to open without stealing focus. |
| `codex_bridge_status` | Reports the environment: platform, resolved `codex` binary, whether the app-server endpoint is live, plus the macOS integrations (LaunchAgent, desktop app). Start here when something misbehaves. |

`send_to_codex_thread` also accepts `timeoutSec` (default 240), `cwd`, `model`, `effort`, and `openInApp` (macOS — surface the thread in the desktop app before sending). A timeout does **not** cancel the turn: the bridge returns what it collected plus the `turnId`; keep reading with `read_codex_thread` or stop it with `interrupt_codex_turn`.

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

## macOS

### Keep the app-server alive with launchd

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

- The Codex desktop app runs its own app-server over stdio and accepts no external endpoint. Threads opened there can still be driven through the bridge, but by resuming from the rollout `.jsonl` rather than attaching live. **Do not send into a thread that is mid-turn inside the desktop app** — two app-servers writing one rollout can corrupt the history. Check `status` with `list_codex_threads` first and only send when it is `idle` or `notLoaded`.
- A repo living on the NTFS partition of a dual-boot machine (`/Volumes/...`) is **read-only** under macOS. Keep a separate checkout on an APFS volume to run and edit it.
- `codex app-server daemon start` uses the `unix://` transport with a control socket at `~/.codex/app-server-control/app-server-control.sock`. The bridge does **not** use that path (different framing, no public API) — it always talks over `ws://`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_APP_SERVER_URL` | `ws://127.0.0.1:8791` | Shared app-server endpoint. |
| `CODEX_BIN` | auto-detected | Path to `codex` used for autostart. |
| `CODEX_BRIDGE_AUTOSTART` | `1` | `0` = never spawn an app-server; one must already be running. |
| `CODEX_BRIDGE_APPROVAL` | `approve` | How to answer approval requests from Codex. Set `deny` to refuse. |
| `CLAUDE_DESKTOP_CONFIG` | auto-detected | Override the config path used by `install-claude-desktop.mjs`. |
| `CODEX_EXE` | auto-detected | Override the `codex` path used by both install scripts. |

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

From inside Claude, call the `codex_bridge_status` tool to inspect the environment.

## License

MIT — see [LICENSE](LICENSE).
