# Changelog

Theo [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) và [SemVer](https://semver.org/lang/vi/).

## [1.2.0] - 2026-08-17

### Added

- `claude-bridge` — MCP server chạy trong Codex để nói chuyện với phiên Claude Code đang mở: `list_claude_sessions`, `send_to_claude_session`, `read_claude_inbox`, `read_claude_transcript`, `bind_codex_thread`, `claude_bridge_status`.
- `src/peer-protocol.mjs` — client cho peer protocol của Claude Code (NDJSON trên `/tmp/cc-socks/<pid>.sock`), tự đăng ký một peer session để Claude nhìn thấy và trả lời được.
- `scripts/install-codex-mcp.mjs` — đăng ký/gỡ bridge trong `~/.codex/config.toml` qua `codex mcp`.
- `scripts/check-claude-bridge.mjs` — kiểm tra chiều Codex → Claude, gửi thật và chờ trả lời.

### Fixed

- MCP server chết khi được spawn với PATH rỗng: gọi `/bin/ps` bằng đường dẫn tuyệt đối và không để lỗi đăng ký peer làm sập server (biểu hiện cũ: Codex treo 60s mỗi lần `thread/start`).
- Đọc transcript Claude bằng cách quét `~/.claude/projects/` thay vì tự dựng lại slug thư mục (`/Volumes/Win_Dev` → `-Volumes-Win-Dev`, không giữ `_`).

## [1.1.0] - 2026-08-17

### Added

- Hỗ trợ macOS và Linux: `src/platform.mjs` dò `codex` theo từng platform và dựng lại PATH cho tiến trình con.
- `scripts/install-launch-agent.mjs` — LaunchAgent giữ app-server sống trên macOS.
- Tool `open_codex_thread` và tham số `openInApp` — mở thread trong Codex desktop app qua `codex://threads/<id>`.
- Tool `codex_bridge_status` — báo cáo môi trường đã resolve.
- `README.en.md` và giấy phép MIT.

### Fixed

- `install-claude-desktop.mjs` chọn đúng đường dẫn config theo macOS/Windows/Linux và tạo file khi chưa có.
- Spawn app-server trên macOS/Linux không còn chết ở shebang `#!/usr/bin/env node` khi PATH bị cắt gọn.

## [1.0.0] - 2026-08-15

### Added

- MCP server gửi prompt vào thread Codex đang mở qua app-server dùng chung: `send_to_codex_thread`, `list_codex_threads`, `start_codex_thread`, `read_codex_thread`, `interrupt_codex_turn`.
- Tự spawn app-server khi chưa có, tự trả lời approval request theo `CODEX_BRIDGE_APPROVAL`.
- `scripts/install-claude-desktop.mjs`, `scripts/check.mjs`, `scripts/smoke.mjs`.
