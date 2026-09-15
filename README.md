# codex-mcp-bridge

[![npm](https://img.shields.io/npm/v/@minhspark/codex-mcp-bridge?logo=npm&color=CB3837)](https://www.npmjs.com/package/@minhspark/codex-mcp-bridge)
[![CI](https://github.com/buidangminh23/codex-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/buidangminh23/codex-mcp-bridge/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@minhspark/codex-mcp-bridge)](LICENSE)

Send prompts and replies between **Claude and Codex**, keeping each conversation in its own app. Supports Windows, macOS, and Linux; native Desktop integration supports Windows and macOS.

[![Claude and Codex exchanging messages](https://github.com/buidangminh23/codex-mcp-bridge/releases/download/v1.16.0/desktop-demo.gif)](https://github.com/buidangminh23/codex-mcp-bridge/releases/download/v1.16.0/desktop-demo.mp4)

## Quick start

Requires **Node.js 22+**, the Codex CLI, and signed-in Claude and Codex Desktop apps. Open a Claude **Code** session and save the same project folder in Codex Desktop.

```bash
npm install -g @minhspark/codex-mcp-bridge
codex-native-relay-install --desktop-tasks
codex-mcp-bridge-install --desktop-tasks
claude-mcp-bridge-install
```

Reconnect the MCP servers in both apps. In the active tasks, check `codex_bridge_status` and `claude_bridge_status`: the native relay should be available and the runtime current. Claude Code has a separate MCP registration; see the [setup reference](https://github.com/buidangminh23/codex-mcp-bridge/blob/main/REFERENCE.md#3-claude--codex-into-claude-code-cli).

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

## Development

```bash
npm ci
npm test
```

On Windows, use `npm test -- --test-concurrency=2`. CI tests Node 22 and 24 on Linux, macOS, and Windows. Tests use isolated fixtures and do not spend model quota.

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)
