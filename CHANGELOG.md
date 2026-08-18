# Changelog

Theo [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) và [SemVer](https://semver.org/lang/vi/).

## [1.4.0] - 2026-08-18

### Fixed

- **Turn dừng giữa chừng như thể Codex tự pause.** App-server chờ client trả lời từng server request rồi mới chạy tiếp, nên một method không được trả lời **không** nổi thành lỗi — turn chỉ đứng im. `#handleServerRequest` mới trả lời đủ **10 method** của `ServerRequest` (lấy từ `codex app-server generate-json-schema`, giống nhau ở codex-cli 0.147 và 0.148). Ba method trước đây rơi vào `default:` và bị trả `-32601`:
  - `item/permissions/requestApproval` — Codex xin nâng quyền (ghi ngoài workspace, network). Đây là cái hay gặp nhất.
  - `mcpServer/elicitation/request` — MCP server hỏi input.
  - `item/tool/call` — dynamic tool call gọi về client.
  Mỗi method trả đúng shape schema của nó, **không dùng chung được**: `commandExecution`/`fileChange` cần `{decision}`, `permissions` cần `{permissions, scope}`, `elicitation` cần `{action}`, `tool/call` cần `{success, contentItems}`. `attestation/generate` và `account/chatgptAuthTokens/refresh` bị từ chối có chủ đích — bridge không tạo được token thật và không đụng vào auth.
- **Thread mở sai thư mục.** Cùng một dự án nằm ở `L:\X` trên Windows, `/Volumes/Win_Dev/X` khi mount ổ đó trên macOS (read-only), và một checkout riêng dưới `$HOME` trên macOS. `resolveWorkspacePath()` chọn ứng viên **tồn tại và ghi được** cho máy đang chạy, ưu tiên `$HOME/X` rồi `$HOME/minhspark/X`. Không tìm được thư mục dùng được thì báo lỗi ngay thay vì mở thread ở chỗ sai; tìm được nhưng read-only thì cảnh báo rõ. Tắt bằng `CODEX_BRIDGE_REMAP=0`.
- **Sai bản codex khi spawn app-server.** Trên macOS bridge dò `~/.local/bin/codex` trước, nên spawn app-server bản 0.147 trong khi Codex Desktop chạy 0.148 — hai bản cùng ghi `~/.codex/state_5.sqlite`. Khi có Codex Desktop thì ưu tiên binary của chính app.

### Added

- `npm run check:approvals` — dựng app-server giả (WebSocket tự implement, không thêm dependency), bắn đủ 10 server request và assert từng response đúng shape schema. Chạy trên code trước bản vá thì đỏ đúng 3 method trên.

## [1.3.0] - 2026-08-17

### Added

- `CODEX_BRIDGE_MODEL` và `CODEX_BRIDGE_EFFORT` — model/effort mặc định cho thread và turn do bridge tạo, vì Codex Desktop không đọc `model`/`model_reasoning_effort` trong `~/.codex/config.toml` mà chạy cấu hình riêng.
- `effort` nhận thêm mức `ultra` (đã kiểm chứng: `state_5.sqlite` và rollout đều ghi `ultra`, không bị nuốt im lặng).
- `codex_bridge_status` in ra model/effort mặc định đang áp dụng.
- `install-claude-desktop.mjs` ghi hai biến trên vào `env` của MCP server khi được truyền.

## [1.2.1] - 2026-08-17

### Added

- Tool `stop_codex_app_server` — dừng app-server dùng chung sau khi giao việc xong để Codex Desktop giữ `~/.codex` một mình; bridge tự bật lại khi cần.

### Fixed

- `codex_bridge_status` phát hiện app-server của Codex desktop và cảnh báo khi LaunchAgent chạy song song — hai app-server dùng chung state sqlite `~/.codex` làm giao diện Codex app giật (đo được ~11% CPU lúc rảnh).
- `isDesktopAppServerRunning()` thiếu import `execFileSync` nên luôn trả `false` trong im lặng.

### Documentation

- Ghi rõ: không bật LaunchAgent khi dùng Codex Desktop; thread đang mở trong app bị khoá writer; thread do bridge tạo không có tên trong `session_index.jsonl` nên app không hiện tiêu đề.

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
