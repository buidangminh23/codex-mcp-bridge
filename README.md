# codex-mcp-bridge

MCP server cho Claude Desktop để **gửi prompt thẳng vào một thread Codex đang có**, qua **một Codex app-server dùng chung**.

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
| `list_codex_threads` | Liệt kê thread (id, title, cwd, thời điểm cập nhật, status) — dùng để lấy **đúng** `threadId`. `loadedOnly: true` chỉ hiện thread đang live trong app-server. |
| `start_codex_thread` | Mở thread Codex mới tại một `cwd`, trả `threadId`. |
| `read_codex_thread` | Đọc hội thoại gần đây của thread, không gửi gì. |
| `interrupt_codex_turn` | Dừng một turn đang chạy. |

`send_to_codex_thread` nhận thêm `timeoutSec` (mặc định 240), `cwd`, `model`, `effort`. Hết thời gian chờ **không** hủy turn — bridge trả về những gì đã thu được kèm `turnId`; đọc tiếp bằng `read_codex_thread` hoặc dừng bằng `interrupt_codex_turn`.

## Cài vào Claude Desktop

```bash
node scripts/install-claude-desktop.mjs
```

Script merge vào `%APPDATA%\Claude\claude_desktop_config.json` (tự backup `*.bak-<ngày>-codexbridge`), giữ nguyên mọi key sẵn có:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["L:\\codex-mcp-bridge\\src\\index.mjs"],
      "env": {
        "CODEX_BIN": "C:\\Users\\<user>\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
        "CODEX_APP_SERVER_URL": "ws://127.0.0.1:8791"
      }
    }
  }
}
```

Restart Claude Desktop sau khi cài.

Claude Desktop khởi chạy MCP server với PATH bị cắt gọn, nên bridge tự dò `codex.exe` theo thứ tự: `CODEX_BIN` → `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` → `%APPDATA%\npm\codex.cmd` → `codex` trên PATH.

## Env

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `CODEX_APP_SERVER_URL` | `ws://127.0.0.1:8791` | Endpoint app-server dùng chung. |
| `CODEX_BIN` | tự dò | Đường dẫn `codex` để autostart. |
| `CODEX_BRIDGE_AUTOSTART` | `1` | `0` = không tự spawn app-server, bắt buộc phải có sẵn. |
| `CODEX_BRIDGE_APPROVAL` | `approve` | Cách trả lời approval request từ Codex. Đặt `deny` để từ chối. |

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

**Giới hạn đã biết:** Codex desktop app (bản MSIX trong `WindowsApps`) tự chạy app-server riêng qua stdio và không nhận endpoint ngoài. Thread mở trong app đó vẫn gửi được qua bridge, nhưng theo cơ chế resume từ rollout `.jsonl` chứ không phải attach live. **Không gửi vào thread đang chạy turn trong desktop app** — hai app-server cùng ghi một rollout có thể làm hỏng lịch sử. Kiểm tra `status` bằng `list_codex_threads` trước, chỉ gửi khi `idle`/`notLoaded`.

`codex app-server daemon start` / `proxy --sock` chỉ chạy trên Unix; trên Windows dùng transport WebSocket như trên.

## Test

```bash
node scripts/smoke.mjs
```

Smoke test tạo thread mới, gửi 2 turn liên tiếp và kiểm tra Codex nhớ được codeword từ turn trước — tức thread thật sự liên tục chứ không phải phiên mới mỗi lần.

```bash
node scripts/check.mjs
```

Kiểm tra nhanh: bridge khởi động, autostart app-server nếu cần, liệt kê thread.
