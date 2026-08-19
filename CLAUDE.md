# Working on this repo

## Pick the right checkout first

This project is developed from two machines and the same tree is reachable at
more than one path, so the first thing to check is **which copy you are in**.

| Machine | Use this checkout | Notes |
|---|---|---|
| Windows | `L:\codex-mcp-bridge` | the working copy |
| macOS | `~/minhspark/codex-mcp-bridge` | internal SSD, the working copy |
| macOS | `/Volumes/Win_Dev/codex-mcp-bridge` | **do not use** — this is the Windows copy seen through an NTFS mount |

`/Volumes/Win_Dev` is an external drive mounted **read-only** on macOS: writes
fail, so edits made there are lost and the checkout drifts behind `origin`.
On macOS, work in `~/minhspark/codex-mcp-bridge` and let the other machine pull.

Confirm before editing:

```bash
git rev-parse --show-toplevel && df -h . | tail -1
```

`/dev/disk3s5` (or any `/System/Volumes/Data` row) is the internal disk and is
fine. A `/Volumes/Win_Dev` row means you are in the read-only Windows copy.

The same split applies to any project shared this way — `resolveWorkspacePath()`
in `src/platform.mjs` exists precisely because Codex threads kept being opened
against whichever path the brief happened to quote.

## Before pushing

```bash
npm test          # the whole suite: no Codex install, no login, no quota
npm run check     # boots the bridge against a real app-server and lists threads
```

`npm test` is the gate. It runs against a fake app-server and a throwaway
`HOME`, so it is the one to run on every commit.

`npm run smoke` sends real turns to Codex and spends quota — run it when the
change touches turn handling, not on every commit.

## Adding a tool

Every tool declares `annotations` with all four hints (`readOnlyHint`,
`destructiveHint`, `idempotentHint`, `openWorldHint`), a description, and a
description on every parameter. `test/tool-contract.test.mjs` enforces it and
also pins which tools are read-only and which are destructive, so a tool that
changes character has to say so in the test too.

Be literal about `readOnlyHint`: `read_claude_inbox` drains the inbox as it
reads, and `claude_bridge_status` registers the peer endpoint on its first
call. Neither is read-only, whatever its name suggests.

## Documentation language

The repository is English-only, enforced by `test/repo-hygiene.test.mjs`.

## Protocol questions

Do not guess method names or payload shapes. The app-server ships its own
schema:

```bash
codex app-server generate-json-schema --out /tmp/codex-schema
```

`ServerRequest.json` lists every request the server sends to a client; each one
needs a reply, and an unanswered method stalls the turn instead of raising an
error.
