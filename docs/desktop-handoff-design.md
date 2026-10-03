# Desktop handoff recovery and project onboarding

This follow-up is based on upstream `00730b6` (1.19.6). PR #84 is already
merged and is not being resubmitted. Its historical validation record remains
dated; the maintainer's managed-permission implementation takes precedence.

## Problems addressed

| Trigger | Result before this change | Recovery/behavior in this branch |
| --- | --- | --- |
| A long Desktop conversation exceeds a whole-file read limit or rotates into continuation files | Sender verification or final-response collection becomes unavailable | Bounded per-record streaming, exact-ID segment discovery and active-turn/native identity checks |
| A native Desktop send is accepted but its first wait expires | The caller cannot continue the same reply observation after reconnecting | An owner/account-bound `deliveryId` and `wait_codex_reply`; no second send |
| A confirmed creation uses up the first-call budget, or a follow-up acknowledgement arrives late | The reply exists but no continuation ID reaches Claude | Preserve the original creation or pre-send binding, distinguish unconfirmed delivery, and continue observing without another send |
| Claude finishes a background command after an interim answer | The interim answer may be mistaken for the final report | Correlate the originating tool, background task and native completion notification |
| A new conversation command interrupts the reply chain | An old pending observation blocks later handoffs indefinitely | Return `interrupted`, `pending=false`, with task outcome explicitly unknown; inspect existing work before a follow-up |
| Read(image) adds a native `turnCompanion` record | A user-role image-size annotation breaks reply ancestry even though Claude already replied | Follow only companions with matching session, prompt and Read/image-result ancestry; preserve real user boundaries |
| Native `create_thread` creates a dedicated dispatcher | `agent_created_thread` is rejected as though it were a transient subagent | Require independent, account-bound Desktop ownership and exact active-turn proof, then re-read that task's own permissions |
| New projects need multiple copied connection settings | Generic Desktop processes cannot attest their actual Code caller, and grants drift between entries | Explicit user-level Code registration, a shared live project policy and diagnostic onboarding tools |

## Integration with current upstream

The existing upstream permission classifier, managed-policy diagnostics and
opt-in Full access repair implementation are retained. This contribution does
not enable Full access repair or change a user's installed permission mode.

Two modules serve different purposes:

- Upstream `project-scope.mjs` is unchanged: it binds the verified Claude sender
  and Codex destination to the same canonical directory or registered Git
  repository, and detects replacement before a native mutation.
- New `project-policy.mjs` stores explicit project/parent grants and denials.
  It is optional; when configured, both that policy and the upstream binding
  must pass. A grant for two unrelated repositories does not permit a
  cross-project Claude-to-Codex handoff.

The authorization module was renamed during integration because both branches
had independently introduced `project-scope.mjs`. Both sets of tests are kept.
Native creation, sends and renames retain the upstream before-write project
checks and additionally recheck a captured live policy grant. Diagnostic
readiness also reports a sender/destination mismatch even when both paths are
authorized. MCP tool approval is still evaluated separately by the host.

## Deliberate boundaries

Identity comes from host metadata, local records and native account-bound
inspection, not from claims in a message. `agent_created_thread` support is
limited to the measured Desktop origin; unknown sources and transient
subagents remain unsupported. The permission class is always the sending
task's current class, never a parent's class.

An interrupted wait is not a cancellation or a successful task result. Timeout,
unreadable records and unknown transcript formats do not silently discard
pending ownership. Image companions are recognized through bounded ancestry,
not by matching an image-size sentence. Forged companions, unrelated tools,
different sessions/prompts, failed image results and real human interruptions
have negative regression cases.

Project setup is explicit and backed up. The messaging-automation installer is
preview-only unless the user opts in, permits only the exact send/wait tools,
and refuses conflicting ask/deny rules. The optional card-settings adapter
does not require the card extension for communication or merge card and
communication permissions. The separate card extension binary is not shipped
by this PR.

## Validation and limits

Run the full isolated regression suite with:

```sh
node --test --test-concurrency=2
```

The merge retains upstream mismatch, moved-target, replaced-directory and
managed-policy negative tests. Additional integration cases combine live
revocation with same-project enforcement and confirm that authorized unrelated
repositories fail readiness while registered worktrees pass.

Earlier installed Windows builds completed two-way Desktop handoffs and
accepted-timeout continuation without a resend. The latest image-companion fix
passed 62 peer tests and recovered the exact historical reply in an offline
replay of the affected transcript, including pending-release and reload checks.
Raw transcripts, identifiers, hashes and machine paths are not published.

That offline replay is not a claim that the old live worker recovered. A worker
already stuck on an unrecognized pending record can defer hot reload until it
is reconnected. Preserve the original receipt and inspect the existing task
first; an unknown ID after reconnecting never proves non-delivery. The merged
1.19.6 branch has not yet replaced the installed runtime or completed a new
live Desktop round trip. No second-machine or cross-platform live acceptance
is claimed; upstream CI should validate the supported platforms.

### Merged-branch Windows check (2026-10-02)

Node 24.13.0, `node --test --test-concurrency=2`: **1,000 tests,
986 passed, 2 failed, 12 skipped**, approximately 903 seconds. The Windows
pipe ACL checks ran successfully with `RemoteSigned` scoped only to the test
process; machine/account policy and assertions were unchanged. All messaging,
sender, project-binding and revocation checks passed.

Both failures were existing installer cases reaching their unchanged 60-second
deadline: explicit Full access setup and cross-machine defaults. A focused
repeat of the installer, messaging-automation and repository-hygiene suites
gave **28 passed, the same 2 timeouts**, after the final documentation/package
and language-guidance edits. This is not a clean full-suite pass.

A control run on untouched upstream `00730b6`, with freshly installed locked
dependencies and only those two test names selected, reproduced **both**
60-second timeouts (~125 seconds total). Thus the failures reproduce without
this contribution on this machine; their underlying cause remains undiagnosed.
No test deadline was increased and no failing case was skipped.

`npm pack --dry-run --json --ignore-scripts` includes the English guides and
excludes local acceptance artifacts. `git diff --check` passes. The standalone
Desktop health check discovers tools and the existing native relay, then
returns `SENDER_UNVERIFIED` as expected for a terminal process with no Claude
Code ancestry. It does not substitute a sender or start an external app-server.

### Path-alias CI fixes (2026-10-03)

The first CI run exposed path aliases on macOS (`/var` versus `/private/var`)
and Windows (short versus long temporary-directory names). The card-settings
adapter compared page paths literally against canonical policy paths, so
removing a displayed project or parent could leave its grant in place. It now
canonicalizes page paths, including missing projects via their nearest existing
ancestor, before reconciliation. Exclusions and concurrent-change checks remain
in force. Onboarding also canonicalizes the configured home before rejecting
whole-home trust requests.

Continuation/sender tests now expect the canonical paths returned by rollout
discovery. They still check exact file and turn identity; no production sender
check was relaxed. New directory-alias regressions exercise project revocation,
parent removal, deleted-project exclusions and home-root rejection on Windows
junctions and POSIX symlinks. The focused Windows run passed 102 checks with one
existing platform skip. Fresh installation and bidirectional live acceptance
remain separate from these isolated tests.

The full Windows run at `989ed6c` completed with **989 passed, 2 failed and
12 skipped** (1,003 tests). Both failures remain the same installer cases
reaching the unchanged 60-second deadline described above. The standalone
health check listed tools but could not reach the default native relay and
reported an unverified sender from the terminal; it did not send a message,
change permissions or launch an external app-server.

Upstream subsequently advanced to `e0f40b5` (1.20.1), making the PR conflicted
and preventing a fresh pull-request CI run. The merge preserves upstream's
composer submission, dormant-task recovery, Sites connector and dependency
updates. Creation and recovery callbacks still await this branch's asynchronous
sender verification before any UI action. A regression checks rejection both
before opening and between opening and automatic trust/submission. No installed
runtime or client configuration was replaced for this merge.
