# Changelog

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/).

## [1.6.0] - 2026-08-19

### Fixed

- **A failed `turn/start` killed the whole MCP server.** `runTurn` rejected its internal completion promise from the catch block, but on that path nothing is awaiting it — `await done` sits after the `turn/start` call that just threw. Node treats an unhandled rejection as fatal by default, so the process exited while the tool handler was still formatting a tidy error message for a client that no longer had a server to talk to. Sending into a thread the Codex desktop app holds open (`thread <id> already has an active writer`) is the everyday way to trigger it. The promise is now resolve-only. **Measured: the same failure used to exit the process with code 1; it now returns an error and the server stays up.**
- `start_codex_thread` declared `approvalPolicy` and `sandbox` with no descriptions, leaving a caller to guess that anything other than `approvalPolicy: "never"` stalls an unattended turn on the first approval prompt.

### Added

- **Annotation hints on all 14 tools** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Clients decide whether a call needs a human in the loop from these, and a tool without them reads as an unknown quantity — the wrong default for tools that reach another agent with shell access. Two are worth naming: `read_claude_inbox` empties the inbox as it reads it, so it is not read-only despite the name, and `claude_bridge_status` registers the peer endpoint on first call, so it writes too.
- **A real test suite: `npm test`, 95 tests across 7 files, no Codex install or quota needed.** Connection behaviour runs against the fake app-server; anything touching `~/.claude` or `~/.codex` runs against a throwaway `HOME`. Covers the tool contract, all 10 server requests, connection recovery, the turn state machine, the peer protocol over a real unix socket, platform resolution, and repository hygiene.
- GitHub Actions runs `npm test` on every push and pull request, across Node 22 and 24 on Linux and macOS.
- `test/repo-hygiene.test.mjs` fails the build if an environment file or build output is ever committed, if the version in `src/index.mjs` drifts from `package.json`, or if documentation stops being English.

### Changed

- The repository is English-only. `README.en.md` merged back into `README.md`; the changelog translated.
- `README.md` documents every install path end to end, including Claude Code (`claude mcp add`), which was previously undocumented, plus prerequisites, verification and uninstall commands for each platform.
- `scripts/check-approvals.mjs` and `scripts/check-reconnect.mjs` became `test/server-requests.test.mjs` and `test/reconnect.test.mjs`; `scripts/fake-app-server.mjs` moved to `test/helpers/`. The fake app-server now binds an ephemeral port, so test files running in parallel cannot collide.

## [1.5.0] - 2026-08-18

### Fixed

- **A turn that lost its connection sat idle until its timeout expired — four minutes by default.** `runTurn` waits for a `turn/completed` notification, which can only arrive over a live socket; a dead socket wakes nobody. This is the everyday case after a machine wakes up: the old app-server died with the previous login session while the bridge kept waiting. The client now signals the break through `subscribeDisconnect()` and the turn ends immediately with status `disconnected` plus a hint to re-read the thread. **Measured: 20,004 ms → 302 ms.**
- **The old socket's `onclose` wiped the new one.** The handler set `this.ws = null` unconditionally, so a late `close` event from the previous socket destroyed the healthy connection a reconnect had just established and rejected all of its pending requests. It now only cleans up when `this.ws === ws`.
- **No retry at boot.** A freshly started machine produces transient failures: the app-server is still opening its sqlite state, or an old one is shutting down but still answering `/readyz`. `connect()` now retries once (750 ms apart) instead of failing the tool call and making the user repeat it. A handshake that breaks mid-way counts as an error rather than hanging for the full 15s timeout.

### Added

- `npm run check:reconnect` — 9 assertions against a fake app-server: reconnecting after a drop, no leaked pending requests or listeners, an interrupted turn exiting promptly, and a refused first handshake being retried. Run against 1.4.0 the first two fail.
- `scripts/fake-app-server.mjs` — a shared fake app-server for the connection tests (hand-rolled WebSocket, no extra dependency).

## [1.4.0] - 2026-08-18

### Fixed

- **A turn stopped mid-run as if Codex had paused itself.** The app-server waits for the client's reply to each server request before continuing, so an unanswered method does **not** surface as an error — the turn simply stops. `#handleServerRequest` now answers all **10** `ServerRequest` methods (taken from `codex app-server generate-json-schema`, identical in codex-cli 0.147 and 0.148). Three used to fall through to `default:` and get `-32601`:
  - `item/permissions/requestApproval` — Codex asking to widen permissions (writes outside the workspace, network). By far the most common.
  - `mcpServer/elicitation/request` — an MCP server asking for input.
  - `item/tool/call` — a dynamic tool call back to the client.

  Each method needs the response shape its own schema declares; they are **not** interchangeable: `commandExecution`/`fileChange` need `{decision}`, `permissions` needs `{permissions, scope}`, `elicitation` needs `{action}`, `tool/call` needs `{success, contentItems}`. `attestation/generate` and `account/chatgptAuthTokens/refresh` are refused deliberately — the bridge cannot mint real tokens and does not touch auth.
- **Threads opened against the wrong directory.** The same project sits at `L:\X` on Windows, `/Volumes/Win_Dev/X` when that drive is mounted on macOS (read-only), and a separate checkout under `$HOME` on macOS. `resolveWorkspacePath()` picks the candidate that both exists and is writable on the current machine. If nothing usable exists it fails immediately instead of opening a thread somewhere wrong; if the only match is read-only it says so. Disable with `CODEX_BRIDGE_REMAP=0`.
- **The wrong codex build spawned the app-server.** On macOS the bridge probed `~/.local/bin/codex` first and started a 0.147 app-server while Codex Desktop ran 0.148 — two builds writing the same `~/.codex/state_5.sqlite`. When the desktop app is installed, its own binary now wins.

### Added

- `npm run check:approvals` — stands up a fake app-server (hand-rolled WebSocket, no extra dependency), fires all 10 server requests and asserts each reply matches its schema. Run against the unpatched code, exactly the three methods above fail.

## [1.3.0] - 2026-08-17

### Added

- `CODEX_BRIDGE_MODEL` and `CODEX_BRIDGE_EFFORT` — default model and effort for threads and turns the bridge creates, because Codex Desktop ignores `model`/`model_reasoning_effort` in `~/.codex/config.toml` and runs its own configuration.
- `effort` accepts `ultra` (verified: `state_5.sqlite` and the rollout both record `ultra` rather than silently dropping it).
- `codex_bridge_status` prints the default model and effort in effect.
- `install-claude-desktop.mjs` writes both variables into the MCP server's `env` when they are passed.

## [1.2.1] - 2026-08-17

### Added

- `stop_codex_app_server` — stop the shared app-server after a hand-off so Codex Desktop owns `~/.codex` alone; the bridge starts a new one when it next needs it.

### Fixed

- `codex_bridge_status` detects the desktop app's own app-server and warns when a LaunchAgent runs alongside it — two app-servers sharing the `~/.codex` sqlite state make the Codex app UI stutter (measured at ~11% CPU while idle).
- `isDesktopAppServerRunning()` was missing its `execFileSync` import and silently always returned `false`.

### Documentation

- Spelled out: do not enable the LaunchAgent while using Codex Desktop; a thread open in the app holds a writer lock; threads created by the bridge have no entry in `session_index.jsonl`, so the app shows no title for them.

## [1.2.0] - 2026-08-17

### Added

- `claude-bridge` — an MCP server that runs inside Codex and talks to a live Claude Code session: `list_claude_sessions`, `send_to_claude_session`, `read_claude_inbox`, `read_claude_transcript`, `bind_codex_thread`, `claude_bridge_status`.
- `src/peer-protocol.mjs` — a client for the Claude Code peer protocol (NDJSON over `/tmp/cc-socks/<pid>.sock`) that registers a peer session so Claude can see it and reply to it.
- `scripts/install-codex-mcp.mjs` — register and remove the bridge in `~/.codex/config.toml` through `codex mcp`.
- `scripts/check-claude-bridge.mjs` — exercise the Codex → Claude direction, sending for real and waiting for the answer.

### Fixed

- The MCP server died when spawned with an empty PATH: `/bin/ps` is now called by absolute path and a failed peer registration no longer takes the server down (the old symptom was Codex hanging for 60s on every `thread/start`).
- Claude transcripts are found by scanning `~/.claude/projects/` instead of rebuilding the directory slug (`/Volumes/Win_Dev` becomes `-Volumes-Win-Dev`, which does not preserve `_`).

## [1.1.0] - 2026-08-17

### Added

- macOS and Linux support: `src/platform.mjs` resolves `codex` per platform and rebuilds PATH for child processes.
- `scripts/install-launch-agent.mjs` — a LaunchAgent that keeps the app-server alive on macOS.
- `open_codex_thread` and the `openInApp` parameter — open a thread in the Codex desktop app through `codex://threads/<id>`.
- `codex_bridge_status` — report the resolved environment.
- `README.en.md` and the MIT license.

### Fixed

- `install-claude-desktop.mjs` picks the right config path for macOS/Windows/Linux and creates the file when it is missing.
- Spawning the app-server on macOS/Linux no longer dies at the `#!/usr/bin/env node` shebang when PATH is trimmed.

## [1.0.0] - 2026-08-15

### Added

- An MCP server that sends prompts into a live Codex thread through a shared app-server: `send_to_codex_thread`, `list_codex_threads`, `start_codex_thread`, `read_codex_thread`, `interrupt_codex_turn`.
- Autostart of the app-server when none is running, and automatic answers to approval requests according to `CODEX_BRIDGE_APPROVAL`.
- `scripts/install-claude-desktop.mjs`, `scripts/check.mjs`, `scripts/smoke.mjs`.
