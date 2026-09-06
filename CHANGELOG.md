# Changelog

Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [SemVer](https://semver.org/).

## [Unreleased]

## [1.13.8] - 2026-09-07

### Fixed

- Reject contradictory message IDs, non-peer origins, duplicate matching roots, and reply branches that cross another queued command. Preserve both measured Desktop transcript formats while preventing another command's answer from completing the wrong pending request.
- Ignore malformed transcript records and text blocks without crashing the reply watcher. Empty or malformed user input no longer counts as a tool-result continuation.

### Changed

- Document that an absorbed message is identified by `source_uuid` on Claude Code 2.1.260 and later and by `origin.msg_id` on earlier builds, which 1.13.7 already matches.

## [1.13.7] - 2026-09-07

### Fixed

- Correlate a Desktop reply to a message that arrived while the recipient was mid-turn. Claude Code absorbs such a message into the running turn and records it as a `queued_command` attachment whose `source_uuid` is the message id, under a fresh uuid; only the idle shape (a user entry whose uuid is the message id) was recognised, so the reply appeared in the app while the bridge reported `reply_timeout` and kept the message pending. Both shapes now resolve to the turn's closing text. A reply taken from an absorbed turn is marked `replyAbsorbed: true` in receipts, the tool result says so, and the text forwarded to Codex carries the same note, because that closing text may not address the message.
- Detect a Claude Desktop task record rewritten during inspection by comparing its bytes, not only its stat fields. A same-size rewrite inside one filesystem timestamp tick (about 16 ms on Windows) left size, times and inode unchanged, so the replace-detection test failed intermittently on Windows CI and the guard could miss such a replacement.

### Added

- Read the recipient session's effective `crossSessionInbound` (managed, user, project, and local settings with Claude's tightening precedence) and refuse a send at preflight with `CLAUDE_RECIPIENT_INBOUND_POLICY` when it is `refuse` or `hold`; an explicit `accept` sends without a class check. Otherwise read the recipient task's permission mode from Claude Desktop metadata, report it with its Claude parity class in `list_claude_sessions`, and refuse with `CLAUDE_RECIPIENT_CLASS_MISMATCH` when that class differs from the verified sender class, naming both classes and the user-only remedies on either side, since Claude Desktop cannot show the approval dialog such a hold would need. Both checks repeat before writing; an unknown mode leaves the decision to Claude. Only a plain alphabetic mode value is exposed. Receipts carry `senderApprovalPolicy`, `recipientPermissionMode`, `recipientPermissionClass`, and `recipientInboundPolicy`, and a held receipt names both classes.

### Changed

- Document Claude's symmetric inbound parity: a prompting-class Desktop recipient holds a `bypass` sender just as a bypassing recipient holds a `prompting` one, so a `held` receipt means the two tasks run in different permission classes and only the user can align them, by running the recipient in the matching class or setting `crossSessionInbound` to `accept` there. The bridge never adjusts the attested class. Describe `node_repl_auto_review_required` as the per-model catalog attribute observed live alongside a user reviewer, note that `auto_review_enabled: true` with a user reviewer is unobserved, and pin the held-receipt wording in the tool contract test.

### Upgrade notes

- Reconnect the MCP connections in both Desktop clients after upgrading; a bridge process started before this version reports stale source and refuses new sends once the files change.

## [1.13.6] - 2026-09-06

### Fixed

- Classify a Desktop sender by its human approval policy alone. `node_repl_auto_review_required` is a Codex model-catalog requirement (`gpt-6-astra` cannot run without auto review) and `auto_review_enabled` names an automated Guardian reviewer; neither adds a human prompt, so a verified full-access `approval_policy: never` sender is `bypass` whichever review flags the host sets. Since 1.13.5 such senders were downgraded to `prompting`, and a bypassing Claude Desktop recipient held every message behind a `peer_inbound_approval` dialog that Claude Desktop does not declare it can render, so nothing sent from that model could ever be delivered. Review flags remain required booleans and are still reported in status and receipts.
- Report the verified sender's approval policy in `claude_bridge_status`, and state in held receipts that Claude Desktop exposes no peer approval dialog.

### Upgrade notes

- Reconnect the `claude-bridge` MCP in the Codex Desktop task after upgrading. A bridge process started before this version keeps the old classification until it is restarted; its status reports stale source and refuses new sends once the files change.

## [1.13.5] - 2026-09-06

### Fixed

- Verify each Desktop sender from Codex-provided MCP task/turn identity and its active rollout permission settings, instead of relying on a shared environment declaration. Explicitly enabled host review uses the prompting sender class; missing, invalid, stale, or unsupported contexts stop before message bytes are sent. Diagnostic sandbox labels never grant permissions, and review never grants bypass permissions.
- Match Claude sessions to exact native Desktop task IDs and titles, require the intended task ID and cwd, and revalidate process and task identity at dispatch. Discovery can filter by exact project and never falls back to a different project.
- Preserve the original sender task and permission class per request, including concurrent and early replies. Revalidate sender evidence after connecting and before writing. Held receipts explicitly leave the approval UI unverified instead of implying a button exists.
- Queue burst replies instead of dropping them under the forwarding rate limit. Preserve the original destination and expose forwarding outcomes, uncertainty, and session-limit blocks through receipts and inbox reads without automatic retries or fallback routing.
- Keep unread inbox pages and require the exact correlated Desktop transcript reply before completing a request. Unrelated socket notifications no longer cancel the original response watcher.
- Expose each host review flag and preserve its value in delivery receipts. Already accepted replies can finish after a source update while the configured delivery route remains unchanged.

## [1.13.4] - 2026-09-06

### Fixed

- Latch queued Desktop delivery deadlines when they expire, so a timed-out prompt cannot dispatch later or release the lock owned by an active send.
- Require and revalidate the exact intended workspace for Claude Desktop sends, expose pending recipient receipts through `read_claude_delivery`, and block no-wait retries of held or uncertain messages. Preserve pending ownership after an uncertain socket write.
- Detect source and Desktop-policy changes in loaded bridge processes and refuse new sends until reconnect. Diagnostics identify their separate MCP process instead of implying the Desktop connection was refreshed.
- Preserve the Codex MCP registration environment on upgrade, pin Desktop routing explicitly, disable its external autostart, and refuse to reset custom access or transport settings. Prefer existing Desktop tasks in MCP instructions.
- Enforce Desktop task mode for Claude destinations as well as Codex delivery. Exclude non-Desktop sessions from discovery, refuse CLI or unknown entrypoints before connecting, and require a unique exact target. Status reports eligible and excluded sessions; receipts identify the actual entrypoint, workspace, and session. Legacy CLI mode remains available when Desktop task mode is disabled.
- Register the native relay companion under a runtime Codex Desktop trusts instead of whichever Node happens to run the installer. The app authenticates the code-signing identity of any process connecting to its native tools pipe and closes the connection before reading a byte when that identity is not its own, so a companion started by a user-installed Node still created its socket and still reported itself installed while every delivery failed as `NATIVE_DELIVERY_UNCONFIRMED` — the refusal is only visible in the app's own log as `dynamic_app_tools_peer_rejected`. On macOS the installer now resolves the runtime the app ships, honours the variables the app declares for its own bundled plugin, and prints the runtime and its source; `CODEX_NATIVE_RELAY_NODE` overrides it. Windows and Linux keep the runtime running the installer, since neither was measured to enforce the check.

### Upgrade notes

- Reconnect the MCP connections in both Desktop clients after upgrading. Reinstall an existing native relay companion with the updated installer to apply runtime selection. Updating package files alone does not replace running processes or add the stale-runtime guard to an older process.
- In Desktop task mode, provide the independently verified absolute `expectedCwd` when sending to Claude. A held receipt still requires the recipient's approval; inspect its `msgId` with `read_claude_delivery` instead of resending. Receipt history is in memory and is not restored after a bridge restart.

## [1.13.3] - 2026-09-05

### Fixed

- Verify the current saved project's identity, canonical directory, and task membership before reusing a Desktop creation receipt. Project drift is rejected; omitted recent/pinned metadata reports unverified assignment while preserving the task ID without resending or creating a duplicate.
- Support `--version` and `-v` on every packaged command without starting servers, opening sockets, or mutating client configuration.
- Preserve PowerShell's `$?` and conditional `&&`/`||` behavior as well as `$LASTEXITCODE` by invoking its footer through a script alias.

### Added

- Opt-in Bash, Zsh, and PowerShell installation footers for `npm install -g @minhspark/codex-mcp-bridge@latest`: first installation, changed version, unchanged version, failure, dry run, and unverifiable metadata are distinguished after npm's final output while preserving its exit code.
- `codex-npm-footer-install` backs up and updates shell profiles idempotently, refuses unmanaged npm wrappers, supports removal, and explains how to reload an already-open terminal. Package installation does not change profiles automatically.

### Verification

- Regression coverage includes same-workspace project moves, deleted/repointed/replaced projects, incomplete Desktop snapshots, deadlines and authorization, shell argument boundaries, dry-run configuration, failure exit codes, metadata validation, and profile preservation.

## [1.13.2] - 2026-09-05

### Fixed

- Prevent duplicate Desktop tasks across concurrent MCP processes and restarts with durable creation receipts. The same workspace and explicit title reuse the verified existing task even after completion or an edited brief; continuations remain explicit sends to its ID.
- Bound the entire Desktop tool call to 40 seconds, including creation, opening, observation, and queued sends. Expired queued prompts are never sent later, and an accepted task keeps running with its ID available to the caller.
- Preserve confirmed task IDs when the first turn fails or needs attention; block uncertain creation retries without automatically expiring receipts or abandoned locks. Reusing a receipt cannot expand thread authorization.
- Keep project selection restricted to exact existing local projects. Explain that Desktop's recent-task snapshot can omit visible agent-created tasks, so absence is not evidence that a retry should create another one.

### Verification

- Windows suite: 322 passed, 0 failed, 8 platform-specific skips. Includes real concurrent MCP processes, restart reuse, lost acknowledgements, persisted receipt validation, strict owned-policy checks, and call deadlines.
- Archived two completed duplicate tasks and retained the latest task in its existing project. A direct native read verified its exact workspace before recording the existing creation receipt.

## [1.13.1] - 2026-09-05

### Fixed

- Make Desktop task mode independent of the external app-server for status, thread discovery, diagnostics, and fallback delivery. A missing native relay reports an actionable failure without starting another process or taking a task's writer lock.
- Verify native connectivity through Desktop projects and list its authorized local recent/pinned Codex tasks. Explain the snapshot coverage and reject unsupported `loadedOnly` queries instead of returning external-server state.
- Persist external autostart off when installing Claude Desktop in Desktop task mode, while preserving explicit legacy mode and existing permission settings. Reconnect the native companion after upgrading to enable the new allowlisted thread-list operation.

### Verification

- Windows suite: 300 passed, 0 failed, 8 platform-specific skips. Added absent-relay, zero-external-connection, native-list authorization, and overlapping-send regressions.
- Live Windows checks returned bridge 1.13.1, eight native local projects, recent Desktop tasks, and an existing task's history while port 8791 remained stopped.

## [1.13.0] - 2026-09-05

### Added

- Opt-in Desktop task delivery: `delegate_to_codex` creates a task in the exact saved local project and opens it while running. `send_to_codex_thread` continues through Desktop without a second writer. `start_codex_thread` accepts an initial prompt and requires it in Desktop mode.
- Enable with `codex-native-relay-install --desktop-tasks` or `CODEX_BRIDGE_DESKTOP_TASKS=1`. Desktop mode uses Desktop permissions and preserves bridge workspace/thread authorization. Missing, ambiguous, remote, or parent-only project matches fail before creation; the requested checkout is preserved.
- Strictly allowlisted native operations and a separate Desktop task socket allow upgrades alongside an older legacy relay owner. Read/open operations use Desktop too; timed-out native tasks point to Desktop's Stop control.

### Fixed

- Distinguish task acceptance, model failure, attention requests, and observation timeout. Follow-up polling ignores the previous completed turn; unconfirmed creation or sending is never automatically retried through another backend.
- Mark prompt-bearing task creation as potentially destructive in MCP annotations, and preserve the shared Desktop opt-in when bootstrapping a relay executor.

### Verification

- Added project matching, authorization, protocol validation, socket transport, uncertain acknowledgement, attention, timeout, and full MCP creation/opening tests.
- A real Windows Desktop task appeared under PCC4SH and completed with `cwd=C:\PCC4SH`, `HEAD=74ed553`. A subsequent native message reached that same task and reported an account usage-limit failure; a second successful model response was not claimed.

## [1.12.5] - 2026-09-05

### Fixed

- Preserve the configured environment when the Claude diagnostic starts its MCP child, including sender permission mode and native-relay settings. The MCP SDK's default environment whitelist otherwise drops these settings and can make the diagnostic exercise a different receiver policy than the installed bridge.

### Verification

- The live Codex MCP bridge returned a real Claude Desktop answer through the UUID-correlated transcript path with the expected workspace. The native Codex relay also delivered its marker into the existing Desktop task. No receiver permission settings or Desktop tool restrictions were changed.
- The live `check:claude` command reported bridge 1.12.5, received the correlated Desktop response, and exited with code 0.

## [1.12.4] - 2026-09-05

### Fixed

- Authenticate Windows peer connections with the destination peer key, publish keys under the canonical socket hash, use Claude-compatible reply pipe names, and encode reply addresses. Incoming unauthenticated Windows frames are refused.
- Keep receiver policy receipts separate from replies and correlate them to the original message and destination. Socket writes no longer report confirmed delivery; timeout and held/refused outcomes fail the roundtrip diagnostic without automatic retries.
- Read ordinary Claude Desktop responses from the local transcript using the injected UUID and assistant ancestry, preserving Desktop's disabled native reply tool. Late correlated responses remain available while the bridge runs.
- Declare sender permission mode only when explicitly configured, and preserve receiver approval decisions. Status reports unknown sender mode instead of inventing one.

### Tests

- Added authenticated transport, missing/bad auth, canonical key and address, receiver status, MCP outcome, and transcript-correlation regressions. Live Windows testing confirmed authentication and returned an actual `held` receipt; the Desktop assistant roundtrip remains subject to recipient approval.

## [1.12.3] - 2026-09-05

### Fixed

- Discover the native tools pipe from the launching Desktop app-server's `mcp_servers.codex_app.env` override when Desktop does not pass it to custom MCP servers. Explicit pipe settings keep precedence; discovery rejects unrelated processes, ambiguous settings, and remote Windows pipes without scanning other sessions or persisting a restart-specific address.
- Cancel pending pipe discovery when the client closes, and share discovery between concurrent connection requests so a closed client cannot send a delayed message.
- Report a reachable shared companion in native relay status when another MCP instance owns the listening endpoint.

### Tests

- Added Windows/POSIX command-line parsing, parent discovery, environment precedence, real mock-pipe delivery, cancellation, concurrent connection, and shared-companion regressions.

## [1.12.2] - 2026-09-05

### Fixed

- **Use the native protocol measured by Seb in [#23](https://github.com/buidangminh23/codex-mcp-bridge/issues/23#issuecomment-5547163688).** The companion uses the native pipe inherited from Codex Desktop, separately from MCP stdio. Dispatch is `tools/call` with distinct executor and destination thread IDs, fresh call/turn IDs, and a UInt32LE length prefix. A response must explicitly report `success: true`. The companion recovers when a configured native pipe appears after startup.
- **Do not kill other delegations when one finishes.** Automatic handoff unsubscribes only the completed thread. It confirms unload before opening Desktop, reports pending idle unload honestly, and fails safely on servers without `thread/unsubscribe`. Explicit shared-server shutdown remains a separate destructive tool.
- **Keep RPC and turn state consistent across failures.** Failed sends settle their pending promise, concurrent calls wait for initialization, and disconnects clean up listeners and requests. Same-thread transactions are serialized while other threads remain independent; timed-out or disconnected turns require state reconciliation before another turn starts.
- **Prevent duplicate or misattributed messages.** A native request with an unconfirmed outcome is never retried through another backend, and invalid messages cannot bypass validation through fallback. Claude requests are queued per destination; unresolved earlier replies block new waited sends instead of assigning a late reply to the wrong request. Fire-and-forget and late responses remain accessible through the inbox.
- **Preserve Unicode across fragmented pipe traffic.** Both relay protocols and Claude peer messages retain complete UTF-8 characters when stream chunks split a character.
- **Validate the workspace actually used.** Relative input becomes absolute, regular files are refused as directories, and a created thread must report the requested workspace within allowed roots. A path map cannot disguise an unexpected server-created cwd.
- **List loaded threads correctly.** The bridge reads the IDs returned by `thread/loaded/list`, applies workspace/title filters, and follows pagination to find matching threads.
- **Keep diagnostics and installer settings truthful.** The Desktop installer honors both enabling and revoking `CODEX_BRIDGE_AUTO_APPROVE_ACK`. Check commands fail on MCP tool errors, and the live continuity smoke test requires two completed turns to preserve a unique codeword.

### Tests

- Added regressions for connection and turn lifecycle, authorization, concurrent handoffs, late replies, fragmented/malformed native frames, missing/late native pipes, fallback boundaries, configuration preservation, and diagnostic exit status. Native wire tests run a real MCP child against isolated mock pipes without sending messages to user sessions.

## [1.12.1] - 2026-09-05

### Fixed

- **Windows no longer loses the Codex Desktop native relay to a Unix-only transport.** The Claude peer endpoint
  and the Codex Desktop companion now use local named pipes on Windows, while macOS and Linux keep their Unix
  sockets. The same platform-aware endpoint detection is used by status checks and cleanup, so a live Windows
  companion is not mistaken for a missing session or deleted as a stale file.
- **Live Claude sessions no longer disappear intermittently while their registry file is being rewritten.** Session
  metadata is read twice and retried until stable, and peer delivery retries the short startup window before the
  named pipe is listening. A session that is alive but still bringing up its Windows pipe remains visible and
  deliverable.
- **A disconnected hand-off now releases the bridge app-server when release-after-turn is enabled.** This prevents
  a dropped turn from leaving a writer lock behind and blocking Codex Desktop on the next open.
- **Windows resolves the versioned Codex Desktop binary before older install locations.** The bridge and installers
  therefore use the current desktop executable instead of silently attaching to an obsolete copy.

## [1.12.0] - 2026-09-04

### Added

- **A thread open in Codex Desktop can now receive Claude's messages without being taken away from the app.**
  Binding a thread with `bind_codex_thread` and then watching it in Codex Desktop was the workflow the relay
  was built for, and it was the one case that could not work: Codex takes a per-thread writer lock when the
  app loads a thread and holds it while the thread is open, so the relay's `thread/resume` was refused with
  `thread <id> already has an active writer`. The only way through was to close the thread before every
  message - which gives up the reason the thread was bound in the first place.

  The fix is to stop bringing a second writer. `codex-native-relay` is a companion MCP process that Codex
  Desktop launches itself, so it already sits inside the app's context and can ask the app's own app-server
  to deliver the message. Nothing attaches, nothing resumes, no second app-server starts, and the desktop app
  stays the single writer of the thread throughout. `claude-bridge` reaches it over a private mode-`0600`
  unix socket at `~/.codex/native-relay.sock` and sends exactly `{ targetThreadId, message }`.

  `codex_app.send_message_to_thread` runs against an *executor* thread, distinct from the destination and
  validated by Codex - a synthetic UUID is rejected. A dedicated relay thread carries that role so the watched
  thread never has to: `scripts/install-native-relay.mjs` creates it once, records it in
  `~/.codex/native-relay.json`, and stops the app-server it borrowed so no lock is left held. Resolution is
  `CODEX_RELAY_ID`, then that file, then an explicit error naming both - never an invented id, which Codex
  would reject with a message that says nothing about the missing configuration behind it.

- Delivery is now a **backend choice** rather than a call, in `src/thread-delivery.mjs`. Nothing else moves:
  the Claude peer protocol, `list_claude_sessions`, `send_to_claude_session`, `bind_codex_thread`, the routing,
  the ping-pong limits, `codex-mcp-bridge`, `CodexAppServerClient` and the thread authorization policies are
  unchanged, and the app-server path stays the default for every thread Codex Desktop does not own. The native
  path is macOS-only, feature-detected on the companion socket, and switched off entirely with
  `CODEX_BRIDGE_NATIVE_RELAY=0`.

  An unreachable companion falls back to the app-server path, because an absent relay says nothing about the
  target thread. A companion that answered with a *refusal* does not: Codex has already been asked, and a
  second app-server would only contend for the `~/.codex` state before failing on the very writer lock the
  native path exists to avoid.

- `claude_bridge_status` and `bind_codex_thread` report the backend in force, and carry the reason when it is
  not the native one - a missing companion socket, an explicit `0`, and an unsupported platform are three
  different problems that otherwise look identical from the outside.

- `native_relay_status` on the companion reports its socket, its executor thread and the dispatch method.
  `npm run install:relay` / `npm run uninstall:relay` register and remove it.

### Security

- The relay socket is created mode `0600` inside the Codex home and swept on exit; that file mode is the whole
  boundary, exactly as it already is for the Claude peer protocol. The companion accepts one payload shape,
  caps a frame at 128 KiB on both halves, and refuses a destination that is its own executor thread - otherwise
  a mistaken bind would deliver into the invisible relay thread and report success. A socket already held by a
  live companion is never stolen: an in-use path is probed before any leftover from a killed process is swept.

### Notes

- `codex_app.send_message_to_thread` and the Codex Desktop native tools pipe are **internals with no public
  documentation**, on the same footing as the Claude peer protocol in `src/peer-protocol.mjs`. That is why this
  path is optional, feature-detected and fallback-safe rather than the default. If Codex changes it, the two
  places to fix are `NATIVE_DISPATCH_METHOD` and `nativeDispatchParams()` in `src/native-relay.mjs`, and
  `CODEX_NATIVE_RELAY_METHOD` overrides the method name without a release.

## [1.11.3] - 2026-09-03

### Fixed

- **The peer endpoint never started on Windows, so the bridge was one-way there.** `/tmp/cc-socks` has no
  Windows equivalent, and `path.join` rewrote it to `\tmp\cc-socks` on the system drive, where `listen()`
  fails with `EACCES`. Codex could push a message into a live Claude session, but Claude had no address to
  answer on - and the only sign was one line on stderr saying replies could not be received, which nothing
  surfaces once the server is running under an MCP client. The peer now listens on a named pipe on Windows,
  the same transport Claude Code itself advertises in `~/.claude/sessions/<pid>.json`, and skips the
  directory, mode and unlink steps that a pipe does not have.

- `fast-uri` is bumped to 3.1.7 and `qs` to 6.16.0. `fast-uri` 3.0.0-3.1.5 is vulnerable to host confusion
  and server-side request forgery through repeated hostname percent-decoding (CVE-2026-75899, high); it
  reaches the tree transitively through `@modelcontextprotocol/sdk` -> `ajv`.

- **A tag is not a release, and nothing was creating the release.** Pushing `v1.10.1`, `v1.11.0` and
  `v1.11.1` published all three to npm, while the Releases page still showed `v1.10.0` as *Latest* -
  the one release that had been created by hand. Anyone reading the repository saw a project that had
  not shipped in days, and the three versions people were actually installing had no notes anywhere
  except this file.

  The publish workflow now creates the release from the changelog entry, in a separate job that is the
  only one granted `contents: write` - the job that talks to npm keeps the read-only default. Generated
  commit lists say what changed; the entry says why it mattered, so the entry is what ships. Re-running
  a tag is safe: an existing release is left alone.

- `scripts/release-notes.mjs` prints one version's changelog section, and a test asserts the version in
  `package.json` has an entry substantial enough to be a release note - so forgetting to write it fails
  before the tag is pushed rather than at the end of a release.

### Added

- `delegate_to_codex` now gives Claude a single contract for handing work to Codex: it creates the thread
  at the requested project directory, names it through `thread/name/set`, returns the exact `threadId` and
  `cwd`, releases the bridge writer lock after a terminal turn, and opens the Windows or macOS `codex://`
  deep link when configured. Windows app-server shutdown uses `netstat` and `taskkill` instead of the Unix-only
  `lsof` path, which removes the lock that previously left Codex Desktop showing "open in another app".

## [1.11.2] - 2026-08-28

### Fixed

- Thread workspaces are normalized through the cross-machine path resolver before authorization, attaching,
  reading, interrupting, or opening. A stale drive letter, mount point, or UNC path can therefore be mapped to
  the writable checkout on the current machine instead of sending Codex into the wrong directory.
- `CODEX_BRIDGE_ALLOWED_ROOTS=*` now explicitly means every usable workspace, and the installer uses that
  cross-machine default together with `CODEX_BRIDGE_THREAD_POLICY=roots`, so a thread opened by a human is not
  rejected because its id or the install directory belongs to another machine. A workspace still has to resolve
  to an existing writable directory before a turn acts on it.
- `scripts/check.mjs` now forwards `CODEX_BRIDGE_THREAD_POLICY`, so validation checks the same authorization mode
  as the MCP server.

## [1.11.1] - 2026-08-23

### Fixed

- **Re-running `codex-mcp-bridge-install` deleted settings it does not write.** It assigned a whole new
  entry over the old one, so `CODEX_BRIDGE_ALLOWED_THREADS`, a hand-added `CODEX_BRIDGE_THREAD_POLICY`
  and any key from a later version were dropped, and `CODEX_BRIDGE_ALLOWED_ROOTS` was reset to the
  install directory. Upgrading is exactly when people re-run it, so the command you reach for to keep
  the bridge current was the command that silently broke it. Measured on a config carrying four custom
  values: all four gone, roots narrowed from two projects to the install directory, other MCP servers
  untouched.

  Existing values are now the fallback rather than the casualty. Precedence, highest first: a variable
  passed to this run, what the config already says, then the default. `command`, `args` and `CODEX_BIN`
  are still resolved fresh — pointing the entry at the code installed now is the reason to re-run at
  all. `--reset` discards inherited values for the rare case of wanting the defaults back.

### Added

- The installer now writes `CODEX_BRIDGE_THREAD_POLICY` explicitly, and when it is left at `owned` it
  says what that means: a thread opened in the Codex app or the VS Code extension will answer
  `NOT AUTHORIZED`, because its id is assigned as it opens and cannot be allowlisted in advance. Shipping
  1.11.0 without this left the fix reachable only by reading the environment table — and the symptom
  points nowhere near the setting responsible.

## [1.11.0] - 2026-08-23

### Added

- `CODEX_BRIDGE_THREAD_POLICY` selects what authorizes a thread: `owned` (unchanged default) or `roots`.

  Under the only behaviour that existed before, a thread opened in the Codex app or the VS Code extension
  was not merely restricted - it was unreachable. Codex assigns the thread ID at the moment it opens, so
  the ID cannot have been listed in `CODEX_BRIDGE_ALLOWED_THREADS` beforehand, and the bridge-owned set
  lives in memory and empties on every MCP server restart. The listing showed those threads, because
  listing is gated on the workspace, and then every send into one answered `not authorized`. On a machine
  with ten live threads, nine of them were unreachable and the tenth only because the bridge had just
  created it.

  `roots` grants on the workspace instead of the ID: a thread already working inside a directory named in
  `CODEX_BRIDGE_ALLOWED_ROOTS` is reachable. That is the same containment every tool already enforces on
  the `cwd` it is handed, applied to the `cwd` the thread reports. It is opt-in so an existing install
  cannot widen silently on upgrade, and an unknown workspace fails closed exactly like one outside the
  roots.

### Fixed

- Authorization now happens **before** `thread/resume`. Attaching takes the per-thread writer lock away
  from whoever else has the thread open, so deciding afterwards would have locked a thread on its way to
  being refused.
- `openInApp` no longer raises a thread on screen before that thread is known to be in scope - a refusal
  that leaked which threads exist.
- `codex_bridge_status` printed the approval policy under a `thread policy` label. Two different settings:
  one was misreported, the other invisible. It now names both.
- The `NOT AUTHORIZED` line in `list_codex_threads` pointed only at `CODEX_BRIDGE_ALLOWED_THREADS`, which
  is the option that cannot work for a thread a human just opened. It now names the policy as well.

## [1.10.1] - 2026-08-20

### Fixed

- **`claude_bridge_status` advertised `claude-bridge 1.3.0` inside a 1.10.0 package.** Seven releases of drift, and the only thing it could tell a bug reporter was a wrong answer about which build was running. The stale constant was the symptom: `scripts/sync-version.mjs` named `src/index.mjs` and the repo-hygiene test checked that same single file, so nothing in the release path ever looked at the second entry point. The sync script now walks both, the `version` lifecycle stages both, and the test **discovers** every `src/*.mjs` declaring `const VERSION` rather than naming one - a third bridge added later is covered without editing any of this again. Confirmed red on the previous tree: `src/claude-bridge.mjs declares 1.3.0, package.json says 1.10.0`.
- README said Windows was supported but not covered by CI, while `windows-latest` has been in the matrix since 1.10.0. A README that undersells its own coverage reads as a warning, and it is the first thing anyone evaluating the bridge sees. What stays true is narrower and is now what it says: the Codex to Claude tests skip on Windows because they need unix sockets, and the rest of the suite runs there.

## [1.10.0] - 2026-08-20

### Added

- The package can be installed instead of cloned: `npm install -g @minhspark/codex-mcp-bridge`, or straight from the repository with `npm install -g git+https://github.com/buidangminh23/codex-mcp-bridge.git` for anyone who would rather not involve a registry. Measured end to end on a clean directory before this was documented: 94 packages, both server bins resolve, and the server prints its ready line.
- Two installer bins, `codex-mcp-bridge-install` and `claude-mcp-bridge-install`, so a copy installed as a package can do the wiring without `node scripts/...` paths into `node_modules`. Both installer scripts gained the shebang this requires.
- `publish` workflow, tag-triggered, with provenance and a guard that fails when the tag and `package.json` version disagree.
- `.gitattributes` pinning `eol=lf`, so a Windows clone and a macOS clone stop producing different bytes for the same file.
- `windows-latest` in the CI matrix.
- The publish workflow authenticates with npm through OIDC trusted publishing, so the repository stores no access token at all. npm attaches provenance automatically in that mode, so the `provenance` flag came back out of `publishConfig` - it would also have broken the one publish that cannot use OIDC, which is the first one. Note the version pin: trusted publishing needs npm 11.5.1 or newer and Node 22 still bundles npm 10.9.x, so the publish job runs Node 24 and fails early with a clear message if npm is older.
- `npm version` now rewrites the `VERSION` constant in `src/index.mjs` and stages it, via a `version` lifecycle script. The repo-hygiene test has always required the two to match; keeping them in step by hand was an avoidable way to fail a release.
- Workflows pin `actions/checkout@v7` and `actions/setup-node@v7`. The v4 pair targets Node.js 20, which GitHub deprecated and now force-runs on Node 24 with a warning on every job. The platform layer has Windows-specific branches and this is where the bridge is most used, so leaving it untested was the wrong gap to carry.

### Changed

- **Package renamed to `@minhspark/codex-mcp-bridge`.** The unscoped name on npm belongs to an unrelated project by another author, so a scoped name is the only one this package can honestly publish under. The scope is `@minhspark` because npm only accepts a scope matching the publishing account or an organisation it belongs to, and the account here is `minhspark` - the GitHub handle and the npm handle are not the same.
- `CODEX_BRIDGE_ALLOWED_ROOTS` no longer defaults to the install directory when the package is installed as a dependency — it defaults to the directory the installer was run from, and the installer warns when the roots it wrote point inside `node_modules`. The old default produced an entry that started fine and then refused every thread.

### Fixed

- **The peer bridge ignored `HOME` on Windows.** `src/peer-protocol.mjs` resolved `~/.claude` through `os.homedir()`, which reads `HOME` on macOS and Linux but `USERPROFILE` on Windows. A Windows user whose `HOME` points somewhere else - the default for Git Bash and MSYS shells - had the bridge look for Claude Code sessions and transcripts in a directory that holds neither, and get an empty list with no error. It now resolves the home directory through the same `homeDir()` helper as the rest of the code, so all three platforms agree.
- `files` now limits the tarball to what a consumer runs. Before this, `npm pack` shipped 37 files including `.github/`, the whole test suite, and a stray tooling directory carrying a second, older copy of the source. It now ships 17 files, 45.6 kB packed.
- Two tests could never pass on Windows and had gone unnoticed because CI never ran there: the Claude Desktop config assertion assumed the path follows `HOME` when Windows correctly follows `APPDATA`, and the symlink containment test needs a privilege Windows withholds from an unelevated process. The first now points `APPDATA` into its sandbox; the second skips with a stated reason instead of reporting a containment failure that never happened.

## [1.9.6] - 2026-08-19

### Changed

- The M8ven badge now requests `?variant=verified`, which their listing page documents as the way to show the verified mark without the letter grade. **It has no effect today**: with cache-busting query strings, `?variant=verified`, `?variant=nonsense` and no variant at all return byte-identical 1017-byte SVGs still reading `C · Emerging`, and the edge cache advertises `netlify-vary: query=__nextDataReq|_rsc`, so the parameter never reaches the application. The URL is written the documented way regardless, so it starts behaving correctly the moment they fix it rather than needing another commit here. The listing itself is claimed and verified, which the badge does show.

## [1.9.5] - 2026-08-19

### Added

- M8ven Trust Index badge in the README, linking to the third-party audit of this server. Two of that audit's findings were real and are fixed in 1.6.0 (missing annotation hints, no test suite); a third - "11 of 14 tool handlers declare input schemas" - is a scanner artefact: all 14 declare `inputSchema`, and the three counted as missing are empty because those tools take no parameters. The publisher has been told.

## [1.9.4] - 2026-08-19

### Changed

- **`CLAUDE.md` removed; its contributor guidance now lives in `CONTRIBUTING.md`.** A file named for one vendor's agent reads as part of one person's toolchain rather than as this project's conventions, which is the wrong shape for a public repository. Nothing was dropped: how to tell which checkout you are in, the `npm test` gate, the annotation contract every tool must satisfy, the rule that nothing here may depend on one person's setup, and how to get the app-server schema instead of guessing at it - all of it moved, under the name a contributor already knows to look for.

## [1.9.3] - 2026-08-19

### Added

- `test/repo-hygiene.test.mjs` fails the build on an instruction that only works inside one person's setup: a link to a private repository, or a reference to a personal rule, memory or skills file kept outside this project. A public repository cannot lean on a private one - an instruction pointing somewhere the reader cannot open is a dead end wearing the clothes of a rule. Verified by adding such a reference and watching the suite go red at that line.

## [1.9.2] - 2026-08-19

### Added

- **`open_codex_thread` and `openInApp` warn when the bridge is still holding the thread's writer lock.** The app-server takes that lock when it loads a thread and keeps it until it exits, so opening the same thread in the Codex app produces a message with no cause attached to it - the app only says the thread is open somewhere else, and the bridge is the somewhere else. The warning names the thread and the way out (`stop_codex_app_server`) at the moment of opening, which is the moment the reader can still act on it.
- `stop_codex_app_server` now says it released the writer locks too, not only the `~/.codex` state.
- `CodexAppServerClient.holdsThread()` and coverage for it: attaching takes the claim, creating a thread takes it too, and a dropped connection drops it - because the lock died with the app-server and continuing to claim it would be a lie.

## [1.9.1] - 2026-08-19

### Changed

- **Nothing tracked here names a real home directory, volume or checkout any more.** `CLAUDE.md` documented one contributor's machines by absolute path and the changelog quoted the same drive letter and mount point. To anyone else cloning the repository that reads as an instruction rather than as one person's setup. The same guidance is now stated as the situation it actually is - a tree reachable at more than one path, read-only on the macOS side of a shared NTFS drive - together with the two commands that tell you which copy you are in.

### Added

- `test/repo-hygiene.test.mjs` fails the build on a path naming a real home directory, and on a real volume name in prose. Fixtures may still use invented volume labels, because a test has to hand the code under test a concrete string. Verified by injecting a real path and watching the suite go red.

## [1.9.0] - 2026-08-19

### Security

- **Thread operations are deny-by-default.** Existing threads require an exact ID in `CODEX_BRIDGE_ALLOWED_THREADS`; newly created threads are authorized only for the lifetime of that bridge process. Reading, sending, interrupting and opening all enforce that capability check.
- **Listing is gated on the workspace root instead**, because gating it on the same allowlist left no path to a thread id at all: an id cannot be allowlisted before it is known, and the bridge is the only thing that can report it, so the only usable thread was one the bridge had created itself. Naming a root in `CODEX_BRIDGE_ALLOWED_ROOTS` is the operator declaring that project in scope, which is what makes the id safe to disclose - acting on it still needs the allowlist, and every listed row says so when it is missing. A cwd this machine cannot resolve stays out of the listing: containment is decided on the real path, and a directory that is not there cannot be shown to be inside the root.
- **Working directories are confined.** `CODEX_BRIDGE_ALLOWED_ROOTS` is required for thread creation and every authorized thread's cwd is checked against it, including symlink canonicalization and traversal attempts. Callers can no longer supply arbitrary approval or sandbox settings; new threads use the bridge's safe policy (`on-request` plus `workspace-write` by default).
- **Automatic approval is disabled by default.** `CODEX_BRIDGE_APPROVAL=approve` now requires the explicit `CODEX_BRIDGE_AUTO_APPROVE_ACK=1` acknowledgement.
- **App-server endpoints are loopback-only.** The bridge rejects non-loopback `CODEX_APP_SERVER_URL` values because its WebSocket transport does not implement remote authentication.

### Added

- Security-policy regression coverage for thread capabilities, workspace containment, endpoint validation, approval defaults, and the split between listing a thread and acting on one.

## [1.8.0] - 2026-08-19

### Changed

- **No drive letter or volume label is blessed any more.** 1.7.0 still shipped one machine's mount point and drive letter as defaults, which is a storage layout wearing a configuration hat. A path now counts as coming from another machine by its *shape* — a drive letter (`D:\project`) or an attached volume (`/Volumes/<label>/`, `/mnt/<label>/`, `/media/<user>/<label>/`) — so every dual-boot and external-disk setup is handled without configuring anything.
- **The path as given is tried first.** Rewriting a directory this machine can already write to would be guessing over an explicit instruction. Rewriting now only happens for a path this machine cannot use, which is exactly the case it exists for: macOS mounts NTFS read-only (measured: `EROFS` on the mount this was built for), so the drive a Windows brief quotes is visible and useless at the same time. This is what makes recognising every volume safe rather than reckless.

### Removed

- `CODEX_BRIDGE_SHARE_MOUNT` and `CODEX_BRIDGE_SHARE_DRIVE`, added in 1.7.0 earlier the same day. Generic detection makes them dead knobs, and a dead knob in the documentation costs more than it saves. `CODEX_BRIDGE_WORKSPACE_ROOTS` and `CODEX_BRIDGE_REMAP` still cover overriding and opting out.

### Verified

- Every path that resolved under the hardcoded version resolves to the same directory: the mounted-drive and drive-letter forms of a repo both reach the checkout beside the bridge, another project reaches its `$HOME`-level checkout, and a nonexistent project still fails with the list of what was tried.

## [1.7.0] - 2026-08-19

### Changed

- **The cwd remapping no longer hardcodes one developer's directory layout.** `remapCandidates()` used to probe a literal `$HOME/<a developer's own folder>/<project>`, which is a fact about one machine sitting in the source of a public repository. The second candidate is now derived from where the bridge itself is checked out: a bridge at `~/code/codex-mcp-bridge` makes `~/code` the place to look for a sibling project. That is a measurement rather than a guess, and it needs no configuration to be right. Verified unchanged on the machine the hardcoded value came from — every path that resolved before resolves to the same directory now.

### Added

- `CODEX_BRIDGE_SHARE_MOUNT` and `CODEX_BRIDGE_SHARE_DRIVE` — the two halves of the dual-boot pair the remapping bridges, previously fixed at one machine's mount point and drive letter. Those remain the defaults; a drive letter is normalised, so `d`, `D` and `D:` all mean the same thing.
- `CODEX_BRIDGE_WORKSPACE_ROOTS` — take over the search entirely with an explicit, ordered, `path.delimiter`-separated list. It replaces the derived roots rather than adding to them, so the order is exactly what was written.
- Candidate lists are deduplicated, so a bridge checked out directly in `$HOME` no longer probes the same directory twice.
- `CODEX_BRIDGE_REMAP`, `CODEX_BRIDGE_SHARE_MOUNT` and `CODEX_BRIDGE_SHARE_DRIVE` are read per call instead of at import, so a client that changes the environment does not have to restart the bridge to be believed — and so the behaviour is testable in-process.
- Five tests covering the derived root, the explicit override and its ordering, a reconfigured mount and drive letter, and the `CODEX_BRIDGE_REMAP=0` opt-out.

## [1.6.0] - 2026-08-19

### Fixed

- **A failed `turn/start` killed the whole MCP server.** `runTurn` rejected its internal completion promise from the catch block, but on that path nothing is awaiting it — `await done` sits after the `turn/start` call that just threw. Node treats an unhandled rejection as fatal by default, so the process exited while the tool handler was still formatting a tidy error message for a client that no longer had a server to talk to. Sending into a thread the Codex desktop app holds open (`thread <id> already has an active writer`) is the everyday way to trigger it. The promise is now resolve-only. **Measured: the same failure used to exit the process with code 1; it now returns an error and the server stays up.**
- `start_codex_thread` declared `approvalPolicy` and `sandbox` with no descriptions, leaving a caller to guess that anything other than `approvalPolicy: "never"` stalls an unattended turn on the first approval prompt.

### Added

- **Annotation hints on all 14 tools** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). Clients decide whether a call needs a human in the loop from these, and a tool without them reads as an unknown quantity — the wrong default for tools that reach another agent with shell access. Two are worth naming: `read_claude_inbox` empties the inbox as it reads it, so it is not read-only despite the name, and `claude_bridge_status` registers the peer endpoint on first call, so it writes too.
- **A real test suite: `npm test`, 96 tests across 7 files, no Codex install or quota needed.** Connection behaviour runs against the fake app-server; anything touching `~/.claude` or `~/.codex` runs against a throwaway `HOME`. Covers the tool contract, all 10 server requests, connection recovery, the turn state machine, the peer protocol over a real unix socket, platform resolution, and repository hygiene.
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
- **Threads opened against the wrong directory.** The same project sits at `D:\X` on Windows, `/Volumes/<label>/X` when that drive is mounted on macOS (read-only), and a separate checkout under `$HOME` on macOS. `resolveWorkspacePath()` picks the candidate that both exists and is writable on the current machine. If nothing usable exists it fails immediately instead of opening a thread somewhere wrong; if the only match is read-only it says so. Disable with `CODEX_BRIDGE_REMAP=0`.
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
- Claude transcripts are found by scanning `~/.claude/projects/` instead of rebuilding the directory slug (`/mnt/dev_disk` becomes `-mnt-dev-disk`, which does not preserve `_`).

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
