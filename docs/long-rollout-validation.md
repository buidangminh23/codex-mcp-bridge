# Long and continued Desktop conversations

## Failure and fix

The bridge previously read an entire sender rollout under a 64 MiB file cap
and an entire native reply rollout under a 16 MiB cap. Established conversations
could therefore stop communicating without any permission change. Discovery
also matched only the initial `-<thread-id>.jsonl` filename, overlooking Desktop
continuations named `-<thread-id>_<segment-id>.jsonl`.

The readers now stream complete JSONL histories in 256 KiB chunks. The limits
apply to individual records, and native response observation also bounds the
aggregate records retained for the selected turn. Histories are not truncated,
edited, uploaded, or added to outgoing prompts. Empty files, oversized records,
incomplete writes, duplicate identities, and changed files remain distinct
failures. Transient concurrent writes receive at most two fresh retries.

Discovery considers at most 64 exact-ID segments inside the bounded sessions
directory scan. Sender selection uses the host-supplied active turn ID, never
modification time. The complete segment set and file versions are checked again
after scanning. Duplicate matching turns are rejected.

A Desktop task can retain its original CLI `session_meta` after being resumed
in the app. The observed `codex-tui` / `cli` shape now requires an additional
account-bound native `read_thread` check: exact task ID, local Codex host, current
workspace, and, for a sender, the exact active turn. The rollout is read again
after the native check. A manual binding, global permission setting, unknown
origin, or completed historical turn cannot substitute for this evidence.
Approval classification still comes from the verified active turn. Managed
workspaces are never promoted to bypass mode.

Desktop workspace migration uses the exact current turn's canonical cwd rather
than requiring the historical creation directory to remain present. VS Code's
same-project restriction remains unchanged. Reply observation still checks the
workspace against independently inspected native task metadata.

Pre-send watermarks cover every existing segment's identity, byte count, and
SHA-256 prefix. A reply in a newly created continuation must match the exact new
turn, executor, prompt, lifecycle, and final answer. All pre-send segments must
remain intact. Copies of a turn or a single turn split across multiple segments
are deliberately reported as unavailable rather than combined by guessed order.

Reading remains linear in total history size. Memory is bounded independently
of total file size, but very long histories can add noticeable local I/O time.

The first live send exposed a second interaction: the two-second connection
timer remained armed during post-connect sender verification. A successful
connection could therefore be reported as failed before any message was written.
Connection and write phases now each retain their two-second timeout, while
post-connect verification has its own 30-second bound. Verification still runs
immediately before writing; if it fails or expires, a late result cannot write
and the connected attempt is not retried automatically.

## Reproducible checks

```sh
node --test test/rollout-reader.test.mjs test/rollout-segments.test.mjs test/codex-sender-context.test.mjs test/codex-native-response.test.mjs test/desktop-task-delivery.test.mjs test/peer-protocol.test.mjs
node --test --test-concurrency=2
```

Regression coverage includes histories exceeding the old limits; UTF-8 across
chunk boundaries; file replacement, growth, and truncation; continued-file
selection independent of mtime; missing, mismatched, or stale native ownership;
permission changes during native inspection; post-dispatch rotation; prefix
tampering; duplicate/split turns; and proof that outgoing dispatch arguments do
not contain a sentinel placed only in historical conversation content. Peer
tests also cover verification taking longer than the connection deadline and
zero writes after the separate verification deadline expires.

## Local validation (2026-09-29)

On Windows with Node 24.13.0, the affected historical Desktop task had six
segments totaling about 847 MiB. All six parsed successfully. The account-bound
native relay confirmed the task and its current workspace, and watermark
capture selected its latest continuation in about 2.1 seconds. A separate
approximately 5 GiB rollout streamed successfully in about 18 seconds; peak RSS
was approximately 392 MiB. These are local observations, not performance guarantees.

The currently calling migrated Desktop task also returned verified sender
status with the patched runtime. After explicit authorization, the affected
historical task called the bridge itself in a fresh turn and confirmed verified,
prompting sender status in its current workspace. Its initial test message
failed before writing because of the connection/verification timeout interaction
above. The subsequent live check uses a distinct test marker, confirms the old
receipt is definitely unsent before proceeding, and does not resend production
work. Successful sender validation alone is not counted as end-to-end delivery.

The second live check passed from that same affected task. The old receipt was
`send_failed` with `pending=false`; the original Claude task, session, and cwd
were confirmed unchanged. Exactly one new test message returned `reply_received`
with its complete expected single-line marker in the sending call, in about
42 seconds. The automatic return also appeared in the original Codex task.
No manual reply retrieval was used to repair the result. Project files,
permissions, and production work remained untouched.

Final Windows regression result on Node 24.13.0: **832 passed, 0 failed,
9 platform skips** (841 tests, 65 suites), approximately 321 seconds, using
`node --test --test-concurrency=2`. The operator authorized `RemoteSigned` only
in the acceptance process environment so the existing Windows pipe ACL checks
could execute. Machine and account execution policy were not changed, and no
ACL assertions were skipped. The standard health check also passed using the
existing native Desktop relay with external app-server autostart disabled.

Raw histories, task IDs, account fingerprints, and machine-specific paths are
kept outside tracked documentation.
