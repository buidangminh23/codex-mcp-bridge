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

The standard `scripts/check.mjs` health check also passed with the existing Desktop-only configuration and external app-server autostart disabled. The full Windows rerun (`node --test --test-concurrency=2`) reported 768 passed, 6 failed, and 9 skipped. Three Windows pipe tests were blocked by PowerShell script policy, one installer migration case timed out, and the `mcp-supervisor` and `tool-contract` test processes exited unsuccessfully. No execution policy was changed. Passing live checks do not imply a green full suite.

Raw transcripts, account identifiers, task IDs, and machine-specific paths remain outside the published repository.
