# Work Desktop bridge validation

Validated on Windows on 2026-09-28 with Node.js 24.13.0 and a fixed local project directory. Both participants were native Desktop conversations. The Codex sender used `codex_work_desktop` with a managed, network-restricted workspace and prompting approvals.

## Completed live checks

| Direction / scenario | Evidence | Result |
| --- | --- | --- |
| Codex sends a short task to Claude | One dispatch returned Claude's exact four-line final answer, including sum 89 and product 21199, with `reply_received`. | Passed |
| Claude sends a short task to idle Codex | One `send_to_codex_thread` call returned a new completed turn and the exact four-line final answer, including 3973, in about six seconds. The original tool result included the assistant item ID and reply SHA-256. | Passed |
| Independent final-answer verification | An exact-turn inspection after automatic delivery matched the original returned text and SHA-256. This inspection verified an already-returned answer; it did not supply a missing answer. | Passed |
| XML-escaped dispatch | The reverse prompt included `<tag> & literal &lt;tag&gt;` and an `<integer>` placeholder. The automatically returned reply remained correlated to that exact prompt and new turn. | Passed |
| Accepted send while the target was already active | The receiving Codex conversation observed the unique message before the later test report. When response waiting expired, Claude received confirmed acceptance with an unavailable final response instead of a misleading unknown-delivery error. | Passed |

No uncertain message was resent. A failed earlier reverse test was recovered separately by exact turn ID and was not counted as automatic completion. A fresh dispatch after the fix established the successful reverse result.

## Setup and scope

Claude used a project-local MCP registration with a distinct name. The original shared Desktop registration did not have the Code session ancestry required to authorize a Claude sender; the caller-identity check correctly rejected it. The dedicated registration retained the same bridge implementation and access settings, and its process ancestry was verified under the intended Code session.

The live checks cover the observed account, client setup, fixed-directory tasks, and short final replies. They do not validate migrated historical conversations, every Desktop version, or long tasks beyond the response budget. The unchanged-workspace check remains in force. No sender or recipient permission checks were disabled for acceptance.

## Reproducible regression checks

```sh
node --test test/codex-native-response.test.mjs test/codex-sender-context.test.mjs test/desktop-task-delivery.test.mjs
```

Result on the reviewed changes: 90 passed, 1 platform skip, 0 failed. These tests cover exact Desktop origins, invalid caller evidence, dispatch correlation and XML escaping, final-response integrity, confirmed versus unconfirmed deadlines, and operation-lock retention.

The standard `scripts/check.mjs` health check also passed with the existing Desktop-only configuration and external app-server autostart disabled. The initial full Windows rerun (`node --test --test-concurrency=2`) reported 768 passed, 6 failed, and 9 skipped. Three Windows pipe tests were blocked by PowerShell script policy, one installer migration case timed out, and the `mcp-supervisor` and `tool-contract` test processes exited unsuccessfully. The follow-up below records their diagnosis and final full-suite result.

Raw transcripts, account identifiers, task IDs, and machine-specific paths remain outside the published repository.

## Windows full-suite follow-up

The two abrupt test-process exits were reproduced with a minimal directory
copy: Node 24.13.0 copied an ASCII path successfully but exited with
`3221226505` (`0xC0000409`) for a Unicode path. The same Unicode copy succeeded
with Node 24.19.0 and with the asynchronous copy API in Node 24.13.0. Supervisor
and tool-contract fixtures now await asynchronous directory copies before
starting their workers. No assertions, integrity checks, or delivery code were
removed or relaxed. Node also tracks a similar Windows Unicode-copy crash in
[nodejs/node#59636](https://github.com/nodejs/node/issues/59636).

With this change and the original Node 24.13.0, a full rerun reached all 820
tests: 808 passed, 3 failed because Windows PowerShell blocked the local ACL
script, and 9 were platform skips. The previously crashing test files completed
and the installer migration test passed without changing its timeout. Its
earlier timeout was not reproduced; its original cause remains undetermined.

The operator then authorized `RemoteSigned` only for the acceptance process,
without changing machine or account policy. The three real Windows pipe tests
passed under that process policy, including rejection of a wrong server PID,
exact current-user permissions, and anonymous read/duplex denial. This is a
test-environment prerequisite, not an automatic policy override in the bridge.
The nine skipped tests are Windows-inapplicable checks for linked rollouts,
POSIX profiles/sockets/home remapping, and Linux XDG configuration. Separately,
Bash and Zsh footer suites are unavailable on this test host.

The final full Windows run on Node 24.13.0 with that approved process-only
policy completed in about 286 seconds: **811 passed, 0 failed, 9 skipped**
(820 tests, 65 suites). It used `node --test --test-concurrency=2`, without
filtering or disabling tests. The higher test count reflects tests that could
now finish after the two native process crashes were eliminated. The standard
Desktop-only health check also passed again. Machine/account execution policy
and the installed Node version were unchanged. Cross-platform GitHub CI still
requires maintainer approval for the external contributor's workflow.
