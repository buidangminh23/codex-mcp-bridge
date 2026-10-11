# Bounded Desktop reads and response preferences

Status: implementation design, to accompany the code changes in the pull request.

## Use case and evidence

A client needs to check a long-running Codex task, read its answer, or inspect
tool activity without losing access as the conversation grows. Today a valid
Desktop response over 128 KiB fails with `Invalid Codex Desktop native frame
length`. This can also block sender verification and receipt checks. Reconnecting
does not shrink the response. See [issue #123](https://github.com/buidangminh23/codex-mcp-bridge/issues/123).

Read-only sampling on October 11, 2026 found:

- Three affected threads exceeded 128 KiB even with one turn, outputs excluded,
  and `maxOutputCharsPerItem: 1`. Commands, arguments, and many small records remained.
- Six latest-turn reads were about 15–700 KB before filtering. Simulated tool
  payload exclusion, **retaining reasoning**, produced 9–124 KB including the tool envelope.
- Longer history reads reached 3,840,620 bytes including the tool envelope; one
  turn alone was 1,468,303 bytes. These reads already capped individual outputs
  at 16,000 characters, so they are samples, not worst-case bounds.

Use larger bounded internal responses, optional filtering, and opt-in cursor
delivery. Keep reasoning by default because it may contain the latest visible
progress during a lengthy turn. Filtering must never substitute an older answer
for a current turn with no remaining visible items.

## Request contract

Add optional `responsePreferences` to the Desktop paths of `read_codex_thread`
and `wait_codex_reply`. Existing selectors remain: `threadId`, optional `turnId`
and `limit` for reads; `deliveryId` and optional `timeoutSec` for waits.

```json
{
  "threadId": "...",
  "responsePreferences": {
    "delivery": {
      "type": "cursorPagination",
      "options": { "maxBytes": 65536 }
    },
    "filter": {
      "includeReasoning": true,
      "includeToolPayloads": false
    }
  }
}
```

| Input | Behavior |
| --- | --- |
| Preferences absent | Existing selection and response format; no automatic filtering or paging. Transport fixes still apply. |
| Preferences present, filter fields omitted | `includeReasoning: true`, `includeToolPayloads: false`. Thus `{}` selects lighter output. |
| Delivery omitted | Return the complete filtered selection or an explicit oversize error. |
| `delivery.type: "cursorPagination"` | Return a bounded first page immediately; no failed first read is required. |
| `delivery.options` omitted | Default page budget of 64 KiB. |
| Unknown mode, field, wrong type, or unsupported budget | Reject explicitly; do not ignore or negotiate. Reject `null` preferences. |

`includeReasoning: false` removes reasoning records. `includeToolPayloads: false`
removes command text, arguments, outputs, embedded results, delegated prompts,
and patch bodies. Retain execution names, IDs, status, timing, exit codes, and
file paths/change kinds. Preserve user messages and assistant commentary/answers.
Use explicit projections for known tool record types so newly added payload
fields do not leak through; an unknown type retains only recognized identity
and status fields and is identified as reduced in response metadata.

Filtering selects content; it is not a secrecy boundary. Retained messages or
reasoning may describe tool activity. Select turns before filtering and preserve
their identity, status, and source timestamps when available.

Continuation uses the same tool and original selector (`deliveryId` for waits):

```json
{
  "threadId": "...",
  "responsePreferences": {
    "delivery": {
      "type": "cursorPagination",
      "options": { "cursor": "opaque-token" }
    }
  }
}
```

The cursor retains selection, filter, and budget. Omitted values inherit these
before defaults are applied; repeated values must match. Reject conflicting
selectors/preferences and a wait `timeoutSec` on a continuation: it reads a
snapshot rather than waiting again.

## Response contract and freshness

Opted-in calls use a versioned envelope in MCP `structuredContent`, with the same
JSON in text content for clients that consume text. Count **both copies** when
enforcing the byte budget. A representative completed reply page is:

```json
{
  "responseVersion": 1,
  "threadId": "...",
  "turnId": "...",
  "turnStatus": "completed",
  "snapshotAt": "2026-10-11T20:00:00Z",
  "appliedResponsePreferences": {
    "delivery": {
      "type": "cursorPagination",
      "options": { "maxBytes": 65536 }
    },
    "filter": {
      "includeReasoning": true,
      "includeToolPayloads": false
    }
  },
  "items": [
    {
      "turnId": "...",
      "itemId": "...",
      "sourceIndex": 12,
      "item": { "type": "agentMessage", "text": "First part of the answer." }
    }
  ],
  "page": {
    "complete": false,
    "nextCursor": "opaque-token",
    "remainingItems": 2,
    "expiresAt": "2026-10-11T20:30:00Z"
  }
}
```

- History responses also include selected turn headers and `sourceHasMore` from
  the native read. Page completion means the **selected history window** is
  delivered, not the whole conversation. Keep the current turn-limit semantics.
- Recent history is newest turn first, then newest item first. Keep stable source
  indices to reconstruct original order; do not invent event timestamps. Exact
  completed replies retain their normal reading order. No fallback to older text
  when the selected turn has no visible reply.
- `page.complete` concerns content delivery, independently of `turnStatus`.
  On the last page, cursor/expiry are null and remaining items are zero. A
  non-paged opted-in result uses these same terminal page fields.
- For an oversized item, replace `item` with `fragment: { encoding: "json",
  offsetBytes, totalBytes, text }`. Fragments contain consecutive, code-point-safe
  chunks of the item's serialized JSON; assemble all chunks before parsing it.
  Keep the same item identity/source index. Count a partially delivered item once
  in `remainingItems`. Never silently cut a field or return malformed outer JSON.
- Return omission counts for excluded reasoning, stripped tool payloads, and
  reduced unknown types. Defer remaining-byte/page counts; their meaning depends
  on serialization and fragmentation.
- Waits retain `deliveryId`, delivery/observation status, and applicable errors.
  `nextAction` is `wait_codex_reply` for either a timeout or more pages, with
  cursor presence distinguishing them. A timeout has no content cursor. A final
  reply hash, when available, describes the complete original verified reply,
  never the current page. Keep receipt and turn lifecycle validation intact.
- Following a cursor continues a frozen snapshot. A fresh request without a
  cursor checks for new progress. Cached turn status is not a live status claim.

## Bounds, storage, and authorization

| Boundary | Proposed limit |
| --- | --- |
| Existing request frames | 128 KiB, unchanged |
| Native-pipe and companion-to-bridge response frames | 8 MiB each |
| Cursor page, complete serialized MCP tool result | 64 KiB default; requestable from 8–96 KiB |
| Non-paged opted-in result | 8 MiB including the serialized MCP tool result |
| Snapshot cache | 32 MiB accounted serialized content/index bytes per bridge worker |
| Snapshot lifetime | 30 minutes from creation, not extended by reads |

Reject out-of-range budgets. If required metadata alone cannot fit, return a
small oversize error. Preserve the supervisor's existing 16 MiB bound and
account for outer JSON-RPC framing. The 8 MiB receive allowance is about twice
the largest observed envelope; expiry/cache values are operational starting points.

Keep filtered snapshots in memory, with least-recently-used eviction. Retain only
serialized content and the index needed for paging, not duplicate parsed trees.
The cache budget is not a process-RSS guarantee. Validate before caching; do not
retain omitted payloads. Restart, hot reload, expiry, or eviction invalidates
cursors with `CURSOR_EXPIRED`. Do not persist snapshots or delay reloads for them.

Use unguessable cursor tokens bound to the original caller/account, operation,
thread/turn selection, workspace binding, preferences, and receipt where present.
Recheck live authorization and receipt ownership before and after each page read;
a cursor is not authorization. Allow the live turn to advance while reading an
authorized older snapshot. Replaying a valid cursor returns the identical page.
Wrong-owner or mismatched cursors fail without disclosing cached content.

Preserve structured error causes across wrappers: `RESPONSE_TOO_LARGE` includes
the failing boundary, byte count when known, and limit; malformed frames remain
distinct. Use `INVALID_RESPONSE_PREFERENCES`, `INVALID_CURSOR`, and
`CURSOR_EXPIRED` for the new contract. Oversize errors must not prescribe a relay
restart or cause an automatic send retry.

## Compatibility and implementation sequence

Current v1.21.5 tool schemas advertise `additionalProperties: false`, but the
installed SDK strips unknown fields when calls reach the server. An in-memory
check confirmed that `responsePreferences` disappears before the old read handler.
Some clients instead reject it locally. New clients must inspect `tools/list`
for the field and validate the returned envelope; sending it is not proof it was
honored. No client-version allowlist is needed. Advertise the new nested schemas
with strict validation and document the envelope and cursor continuation in tool
descriptions. Legacy app-server mode rejects preferences explicitly in this first
release; absent preferences remain supported there.

1. **Fix transport boundaries.** In `src/native-relay.mjs`, separate request and
   response limits at both response readers. Update companion request-limit
   imports and add a bounded response-size check before its socket write in
   `src/native-relay-companion.mjs`. Preserve framing, account checks, and pending
   request cleanup. Carry oversize details through `src/thread-delivery.mjs`.
2. **Reduce internal reads.** Use the existing `includeOutputs: false` /
   `maxOutputCharsPerItem: 1` shape for metadata reads in `thread-delivery.mjs`
   and companion authorization. Retain the matching sender inspection in
   `claude-bridge.mjs`. These trims help but do not guarantee a bounded response.
3. **Add one response module.** A proposed `src/response-preferences.mjs` owns
   strict schemas, record projection, byte-budgeted serialization, snapshots,
   and cursors. Native Desktop arguments remain unchanged; never forward our
   preferences to the native API. Inject authorization checks from existing
   delivery/receipt code rather than creating another permission system.
4. **Wire read-only tools.** Extend only `read_codex_thread` and
   `wait_codex_reply` in `src/index.mjs`. Keep the absent-preferences branches
   and shared send/create `replyResult` behavior unchanged. Cursor reads do not
   call `wait`, send, or create. Reuse `codex-native-response.mjs` verification
   before projecting authoritative reply items. Publish schemas/descriptions
   and examples in `REFERENCE.md`; new modules need no dependency or config flag.
5. **Validate and stage installation.** Complete focused tests, then the full
   isolated suite. Separately validate read-only behavior against the affected
   Desktop sessions. Installing into live bridge/companion processes and
   reconnecting clients is a later, explicit rollout step.

## Tests and acceptance

- **Transport:** extend `native-relay.test.mjs` and
  `native-relay-companion.test.mjs`. Accept valid responses above 128 KiB through
  both hops, including fragmented UTF-8; reject above 8 MiB with precise errors.
  Keep oversized requests, zero/malformed frames, and pending cleanup protected.
- **Contract:** add `response-preferences.test.mjs`. Cover absent/empty/partial
  preferences, defaults, strict unknown-field rejection, budget bounds, filtering
  across known and unknown records, actual envelope byte counts, and oversized
  item reconstruction with quotes, escapes, and multibyte text.
- **Paging:** verify newest-first active history, forward final replies, stable
  snapshots as turns advance, exact replay, no gaps/duplicates, remaining-item
  counts, expiry/eviction/reload, and conflicting selectors/preferences. Test
  an empty filtered current turn without substituting the previous reply.
- **Integration:** extend `desktop-task-delivery.test.mjs` and receipt tests;
  add in-memory MCP calls exercising the actual tool handlers. Verify schema
  discovery, unchanged legacy response shapes, wait timeout versus page
  continuation, unchanged authoritative hashes, and zero mutation dispatches.
  Account switches, revoked scope, replaced roots, and another caller's receipt
  must block cached pages as they block fresh reads. Confirm reload invalidation
  in `mcp-supervisor.test.mjs` without retaining snapshots across workers.
- **Live acceptance:** repeat one-turn and longer reads for the previously
  affected chats, measure every returned page, and reconstruct the selected
  filtered data. While a task advances, confirm an old cursor stays stable and
  a fresh read shows newer activity. Use synthetic fixtures shaped like the
  measured records in the repository; do not commit private session transcripts.

## Risks and limits

Filtering and paging run **after** receiving Desktop's native response. A native
response above 8 MiB still fails explicitly; this proposal does not add an
upstream metadata-only API or native item pagination. Native history summaries
may already omit/truncate content, and existing rollout/reply validation and size
limits remain. `page.complete` cannot promise recovery of such missing content.

Larger internal responses increase transient memory and parsing work. Cache
eviction/reload can force clients to restart a read; authorization checks can
still fail even when content is cached. Reasoning retention improves visibility
but does not guarantee that an active task has emitted recent progress.

Streaming, subscriptions, send/create preferences, hosted Sites contract changes,
and cross-restart cursor persistence are out of scope. Shared transport fixes
must preserve existing Sites and non-opted-in callers. Do not relax ownership,
workspace, account, or authoritative-reply checks to make paging succeed.
