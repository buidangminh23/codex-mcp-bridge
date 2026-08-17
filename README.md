# codex-mcp-bridge

MCP server cho Claude Desktop để **gửi prompt thẳng vào một thread Codex đang có**, qua **một Codex app-server dùng chung**. Chạy trên **macOS, Windows và Linux**.

Không phải `codex exec` (tạo phiên mới mỗi lần). Bridge nói JSON-RPC với app-server thật của Codex, nên thread giữ nguyên lịch sử, `cwd`, model và rollout file.

## Kiến trúc

```
Claude Desktop ──stdio──> codex-mcp-bridge ──WebSocket──> codex app-server (ws://127.0.0.1:8791)
                                                                  │
Codex TUI  ──codex --remote ws://127.0.0.1:8791───────────────────┘   (cùng app-server, cùng thread live)
```

- App-server là **singleton theo port**. Bridge probe `http://127.0.0.1:8791/readyz`; nếu chưa sống thì tự spawn detached (`codex app-server --listen ws://127.0.0.1:8791`) và app-server đó tiếp tục chạy độc lập sau khi bridge thoát.
- Mọi client trỏ cùng URL đều dùng **chung một app-server** → `thread/resume` bằng `threadId` sẽ rejoin đúng thread đang chạy thay vì mở phiên mới.
- Bridge giữ đúng một WebSocket, `initialize` một lần, và route notification theo `threadId` nên nhiều thread chạy song song không lẫn nhau.

## Tools

| Tool | Việc |
|---|---|
| `send_to_codex_thread` | Gửi prompt như một user turn vào `threadId`, chờ `turn/completed`, trả lời của Codex + trail hoạt động (lệnh đã chạy, file đã sửa). |
| `list_codex_threads` | Liệt kê thread (id, title, cwd, thời điểm cập nhật, status) — dùng để lấy **đúng** `threadId`. `loadedOnly: true` chỉ hiện thread đang live trong app-server. Trên macOS mỗi dòng kèm luôn deep link `codex://threads/<id>`. |
| `start_codex_thread` | Mở thread Codex mới tại một `cwd`, trả `threadId`. |
| `read_codex_thread` | Đọc hội thoại gần đây của thread, không gửi gì. |
| `interrupt_codex_turn` | Dừng một turn đang chạy. |
| `open_codex_thread` | **macOS**: bật thread lên trong Codex desktop app qua `codex://threads/<id>` để người dùng xem trực tiếp. `background: true` để mở mà không cướp focus. |
| `codex_bridge_status` | Báo cáo môi trường: platform, `codex` binary đã resolve, endpoint app-server còn sống không, LaunchAgent + desktop app trên macOS. Dùng đầu tiên khi bridge có vấn đề. |

`send_to_codex_thread` nhận thêm `timeoutSec` (mặc định 240), `cwd`, `model`, `effort`, và `openInApp` (macOS — mở thread trong app trước khi gửi để xem live). Hết thời gian chờ **không** hủy turn — bridge trả về những gì đã thu được kèm `turnId`; đọc tiếp bằng `read_codex_thread` hoặc dừng bằng `interrupt_codex_turn`.

## Cài vào Claude Desktop

```bash
npm install
node scripts/install-claude-desktop.mjs
```

Script tự nhận platform, tạo file config nếu chưa có, backup bản cũ (`*.bak-<ngày>-codexbridge`) và giữ nguyên mọi key sẵn có:

| OS | Config path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Claude/claude_desktop_config.json` |

Kết quả trên macOS:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "/Users/<user>/.local/node/v24.18.0/bin/node",
      "args": ["/Users/<user>/minhspark/codex-mcp-bridge/src/index.mjs"],
      "env": {
        "CODEX_BIN": "/Users/<user>/.local/bin/codex",
        "CODEX_APP_SERVER_URL": "ws://127.0.0.1:8791"
      }
    }
  }
}
```

Restart Claude Desktop sau khi cài.

**Resolve `codex` binary:** Claude Desktop (và launchd) khởi chạy MCP server với PATH bị cắt gọn nên `codex` thường không có trên PATH. Bridge dò theo thứ tự — `CODEX_BIN` → các vị trí cài quen thuộc của platform → PATH:

| OS | Thứ tự dò |
|---|---|
| macOS / Linux | `~/.local/bin/codex` → `~/.npm-global/bin/codex` → `/opt/homebrew/bin/codex` → `/usr/local/bin/codex` → `~/.volta/bin` → `~/.bun/bin` → `~/.cargo/bin` → `~/.codex/packages/standalone/current/codex` → `/Applications/ChatGPT.app/Contents/Resources/codex` (chỉ macOS) |
| Windows | `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` → `%APPDATA%\npm\codex.cmd` → `%ProgramFiles%\nodejs\codex.cmd` |

Trên macOS/Linux, `codex` là script Node có shebang `#!/usr/bin/env node`, nên bridge còn bơm lại `PATH` (thư mục node hiện tại + `/opt/homebrew/bin` + `/usr/local/bin` + system dirs) cho tiến trình con — thiếu bước này thì spawn app-server chết ngay từ shebang.

## macOS

### App-server chạy nền bằng launchd

```bash
node scripts/install-launch-agent.mjs
```

Tạo `~/Library/LaunchAgents/com.codex-mcp-bridge.app-server.plist` (`RunAtLoad` + `KeepAlive` khi crash, `ThrottleInterval` 10s) rồi `launchctl bootstrap gui/$UID`. App-server sống sẵn từ lúc đăng nhập nên bridge không phải tự spawn, và thread luôn ở trạng thái live.

```bash
launchctl print gui/$UID/com.codex-mcp-bridge.app-server | head -20   # trạng thái
node scripts/install-launch-agent.mjs --uninstall                     # gỡ
```

Log: `~/Library/Logs/codex-mcp-bridge/app-server.{out,err}.log`.

### Xem thread trực tiếp trong Codex desktop app

Codex desktop app trên macOS là `/Applications/ChatGPT.app` và đăng ký scheme `codex://`. Bridge dùng `codex://threads/<threadId>` để mở đúng thread:

```
open_codex_thread { threadId: "01a0…", background: true }
send_to_codex_thread { threadId: "01a0…", prompt: "…", openInApp: true }
```

Đây là cách để người giao việc **nhìn thấy Codex đang làm** thay vì phải đọc lại rollout `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` sau khi xong.

### Giới hạn trên macOS

- Codex desktop app tự chạy app-server riêng qua stdio (`ChatGPT.app/Contents/Resources/codex … app-server`) và không nhận endpoint ngoài. Thread mở trong app vẫn gửi được qua bridge, nhưng theo cơ chế resume từ rollout `.jsonl` chứ không phải attach live. **Không gửi vào thread đang chạy turn trong desktop app** — hai app-server cùng ghi một rollout có thể làm hỏng lịch sử. Kiểm tra `status` bằng `list_codex_threads` trước, chỉ gửi khi `idle`/`notLoaded`.
- Repo đặt trên phân vùng NTFS của máy dual-boot (`/Volumes/...`) chỉ **đọc được** trên macOS — Finder/macOS mount NTFS read-only. Giữ một checkout riêng trên ổ APFS (vd `~/minhspark/codex-mcp-bridge`) để chạy và sửa.
- `codex app-server daemon start` dùng transport `unix://` với control socket `~/.codex/app-server-control/app-server-control.sock`. Bridge **không** dùng đường này (giao thức khung khác WebSocket, chưa có API công khai) — luôn nói chuyện qua `ws://`.

## Env

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CODEX_APP_SERVER_URL` | `ws://127.0.0.1:8791` | Endpoint app-server dùng chung. |
| `CODEX_BIN` | tự dò | Đường dẫn `codex` để autostart. |
| `CODEX_BRIDGE_AUTOSTART` | `1` | `0` = không tự spawn app-server, bắt buộc phải có sẵn. |
| `CODEX_BRIDGE_APPROVAL` | `approve` | Cách trả lời approval request từ Codex. Đặt `deny` để từ chối. |
| `CLAUDE_DESKTOP_CONFIG` | tự dò theo OS | Ép đường dẫn config khi chạy `install-claude-desktop.mjs`. |
| `CODEX_EXE` | tự dò | Ép đường dẫn `codex` cho hai script cài đặt. |

**Về approval:** Codex sẽ hỏi duyệt lệnh/patch nếu `approval_policy` không phải `never`. Không ai ngồi trước Claude Desktop để bấm, nên bridge tự trả lời theo `CODEX_BRIDGE_APPROVAL` và log ra stderr. Mặc định `approve` khớp với cấu hình `approval_policy = "never"` + `sandbox_mode = "danger-full-access"` trong `~/.codex/config.toml`; nếu siết sandbox lại thì cân nhắc đổi sang `deny`.

## Dùng chung app-server với phiên Codex tương tác

Mở TUI trỏ vào cùng endpoint để thread trong TUI và thread bridge nhìn thấy là **một**:

```bash
codex --remote ws://127.0.0.1:8791
```

Chạy app-server thủ công (không phụ thuộc bridge autostart):

```bash
codex app-server --listen ws://127.0.0.1:8791
```

## Test

```bash
npm run check
```

Kiểm tra nhanh: bridge khởi động, autostart app-server nếu cần, liệt kê thread.

```bash
npm run smoke
```

Smoke test tạo thread mới, gửi 2 turn liên tiếp và kiểm tra Codex nhớ được codeword từ turn trước — tức thread thật sự liên tục chứ không phải phiên mới mỗi lần.

Kiểm tra môi trường từ trong Claude: gọi tool `codex_bridge_status`.
