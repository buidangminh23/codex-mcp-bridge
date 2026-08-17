# codex-mcp-bridge

*[English version](README.en.md)*

Cầu **hai chiều** giữa Claude và Codex: Claude gửi prompt vào **thread Codex đang mở**, Codex nhắn ngược vào **phiên Claude Code đang chạy**. Mỗi bên đều thấy phiên của bên kia và nhìn được hội thoại ngay trong app của mình. Chạy trên **macOS, Windows và Linux** (chiều Codex → Claude cần unix socket nên chỉ macOS/Linux).

Không phải `codex exec` (tạo phiên mới mỗi lần). Bridge nói JSON-RPC với app-server thật của Codex, nên thread giữ nguyên lịch sử, `cwd`, model và rollout file.

## Kiến trúc

Hai MCP server, mỗi cái sống trong một agent:

```
                     ┌──────────────── codex-mcp-bridge (chạy trong Claude) ────────────────┐
Claude Desktop ──────┤ stdio                                    WebSocket                   ├──> codex app-server ──> thread hiện trong Codex Desktop
                     └─────────────────────────────────────────────────────────────────────┘

                     ┌──────────────── claude-bridge (chạy trong Codex) ───────────────────┐
Codex ───────────────┤ stdio                       unix socket /tmp/cc-socks/<pid>.sock    ├──> phiên Claude Code ──> tin nhắn hiện trong Claude Desktop
                     └─────────────────────────────────────────────────────────────────────┘

Codex TUI  ──codex --remote ws://127.0.0.1:8791──> cùng app-server, cùng thread live
```

- App-server là **singleton theo port**. Bridge probe `http://127.0.0.1:8791/readyz`; nếu chưa sống thì tự spawn detached (`codex app-server --listen ws://127.0.0.1:8791`) và app-server đó tiếp tục chạy độc lập sau khi bridge thoát.
- Mọi client trỏ cùng URL đều dùng **chung một app-server** → `thread/resume` bằng `threadId` sẽ rejoin đúng thread đang chạy thay vì mở phiên mới.
- Bridge giữ đúng một WebSocket, `initialize` một lần, và route notification theo `threadId` nên nhiều thread chạy song song không lẫn nhau.

## Tools — `codex-mcp-bridge` (cài vào Claude)

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

## Tools — `claude-bridge` (cài vào Codex)

| Tool | Việc |
|---|---|
| `list_claude_sessions` | Liệt kê phiên Claude Code đang chạy trên máy (tên, pid, sessionId, cwd, khởi động từ đâu). |
| `send_to_claude_session` | Gửi tin nhắn vào phiên Claude — **hiện thẳng trong khung chat** của phiên đó y như tin từ đồng đội — rồi chờ Claude trả lời. `waitSec: 0` để gửi xong đi luôn. `target` nhận tên, pid hoặc sessionId; **tên phiên Claude tự đổi theo thời gian** nên nhắm bằng `sessionId` mới chắc. |
| `read_claude_inbox` | Đọc (và xoá) những tin Claude chủ động đẩy sang, kể cả trả lời tới muộn. |
| `read_claude_transcript` | Đọc hội thoại gần đây của một phiên Claude mà không gửi gì. |
| `bind_codex_thread` | Gắn một thread Codex để mọi tin từ Claude được relay vào thread đó → **hiện trong Codex Desktop**. Truyền chuỗi rỗng để tắt. |
| `claude_bridge_status` | Báo cáo peer endpoint, số phiên Claude đang sống, thread đang relay, số tin trong inbox. |

### Hai bên nhìn thấy nhau thế nào

- **Claude thấy Codex:** `claude-bridge` tự đăng ký thành một *peer session* trong `~/.claude/sessions/`. Claude liệt kê nó bằng `ListAgents` và nhắn sang bằng `SendMessage` — không ẩn, không phải phiên nền vô hình. Tên mặc định là `codex-<pid>`; sau `bind_codex_thread` nó tự đổi thành `codex-<8 ký tự đầu threadId>` để phân biệt được từng thread (Codex spawn **một bridge cho mỗi phiên**, nên thường có vài peer cùng lúc).
- **Codex thấy Claude:** `list_claude_sessions` đọc đúng registry đó, kèm `read_claude_transcript` để xem phiên Claude đang làm gì.
- **Hiện trong chat:** tin Codex gửi vào phiên Claude xuất hiện trong khung chat Claude Desktop; tin Claude gửi về được relay vào thread Codex (sau `bind_codex_thread`) nên hiện trong Codex Desktop.

### Protocol (đo thực tế, không có tài liệu chính thức)

Mỗi phiên Claude Code ghi `~/.claude/sessions/<pid>.json` và nghe trên `/tmp/cc-socks/<pid>.sock`. Khung là **NDJSON**, một dòng một tin:

```json
{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user",
 "content":"<cross-session-message from=\"uds:/tmp/cc-socks/<pid>.sock\" from-mode=\"bypass\">\n...\n</cross-session-message>"},
 "priority":"next","from":"uds:/tmp/cc-socks/<pid>.sock"}
```

Không có token trong khung — **socket để mode `0600` nên chỉ user sở hữu mới gửi được**, đó là toàn bộ ranh giới bảo mật. Muốn nhận trả lời thì phải tự đăng ký một peer session (registry + socket), vì Claude trả lời về địa chỉ trong `from`.

> ⚠️ Đây là cơ chế **nội bộ của Claude Code, không có tài liệu công khai** (đo trên bản 2.1.229). Claude Code đổi format là chiều Codex → Claude gãy — sửa ở `src/peer-protocol.mjs`. Chiều Claude → Codex đi qua app-server chính thức nên không dính.

### Chống ping-pong vô hạn

Relay có hai chốt chặn cứng trong `src/claude-bridge.mjs`: tối đa **1 tin mỗi 5s** và **50 tin mỗi lần chạy bridge**. Hai agent tự nói chuyện với nhau mà không ai trông thì vẫn dừng lại được.

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
      "args": ["/Users/<user>/code/codex-mcp-bridge/src/index.mjs"],
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

## Cài vào Codex (chiều ngược)

```bash
node scripts/install-codex-mcp.mjs
```

Chạy `codex mcp add claude-bridge -- <node> src/claude-bridge.mjs`, ghi vào `~/.codex/config.toml`. Kiểm tra bằng `codex mcp list`, gỡ bằng `node scripts/install-codex-mcp.mjs --remove`.

Khởi động lại Codex app (hoặc mở phiên Codex mới) để nạp. Nếu app-server dùng chung đang chạy sẵn (LaunchAgent), nạp config mới bằng:

```bash
launchctl kickstart -k gui/$UID/com.codex-mcp-bridge.app-server
```

Đặt tên peer khác `codex` bằng `CLAUDE_BRIDGE_PEER_NAME` — đây là tên Claude nhìn thấy trong danh sách agent.

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
- Repo đặt trên phân vùng NTFS của máy dual-boot (`/Volumes/...`) chỉ **đọc được** trên macOS — macOS mount NTFS read-only. Giữ một checkout riêng trên ổ APFS (vd `~/code/codex-mcp-bridge`) để chạy và sửa.
- `codex app-server daemon start` dùng transport `unix://` với control socket `~/.codex/app-server-control/app-server-control.sock`. Bridge **không** dùng đường này (giao thức khung khác WebSocket, chưa có API công khai) — luôn nói chuyện qua `ws://`.

## Sự cố thường gặp

**`readyz` không bao giờ trả 200 sau khi restart app-server.** Log có `failed to initialize sqlite state runtime under ~/.codex`. Nguyên nhân: còn một app-server cũ chưa chết hẳn đang giữ state sqlite của `~/.codex` — chỉ **một** tiến trình được giữ nó. Kill cứng (`pkill -9`) hay `launchctl kickstart -k` liên tiếp dễ để lại zombie mà `pkill -f "app-server --listen ws://…"` không khớp vì tên tiến trình là đường dẫn binary vendor.

```bash
ps aux | grep "[a]pp-server --listen"
pkill -9 -f "codex-darwin-arm64/vendor.*app-server"
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.codex-mcp-bridge.app-server.plist
```

**Codex treo khi mở thread mới sau khi thêm MCP server.** Client MCP chờ handshake `initialize`; server chết trước đó thì biểu hiện là *treo*, không phải lỗi. Đã trả giá thật: `claude-bridge` gọi `execFileSync("ps", …)` mà Codex spawn MCP server với **PATH rỗng** → `ENOENT` → chết trước handshake → mọi `thread/start` timeout 60s. Fix: gọi `/bin/ps` bằng đường dẫn tuyệt đối và bọc try/catch (`src/peer-protocol.mjs`). Bài học chung: **MCP server không được phụ thuộc PATH của tiến trình cha** — luôn test bằng `env -i PATH="" node <server>` trước khi ship.

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

```bash
npm run check:claude
```

Kiểm tra chiều Codex → Claude: liệt kê phiên Claude đang sống. Muốn thử gửi thật thì đặt biến môi trường:

```bash
CLAUDE_TARGET=<sessionId> CLAUDE_WAIT=150 npm run check:claude
```

Script gửi một tin vào phiên đó rồi **chờ Claude trả lời** — trả lời về được nghĩa là cả hai chiều đều thông.

Kiểm tra môi trường từ trong Claude: gọi tool `codex_bridge_status`. Từ trong Codex: `claude_bridge_status`.
