# Contributing

## Check which copy you are in

The same tree is often reachable at more than one path. A project on a drive
shared between a dual-boot Windows install and macOS appears under its drive
letter on one side and under a mount point on the other, and **macOS mounts
NTFS read-only**: writes fail there, so edits are lost and that checkout
silently drifts behind `origin`.

Confirm before editing:

```bash
git rev-parse --show-toplevel
test -w . && echo "writable" || echo "READ-ONLY - you are in the wrong copy"
```

Work in a checkout on a writable local disk and let the other machine pull.

`resolveWorkspacePath()` in `src/platform.mjs` exists for the same reason: a
brief written on one machine quotes whichever path that machine uses, and the
other machine cannot always use it.

## Before pushing

```bash
npm test          # the whole suite: no Codex install, no login, no quota
npm run check     # boots the bridge against a real app-server and lists threads
```

`npm test` is the gate, and CI runs the same command on Node 22 and 24 across
Linux and macOS. It works against a fake app-server and a throwaway `HOME`, so
it is the one to run on every commit.

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

## Nothing here may depend on one person's setup

Nothing tracked here may name a real home directory, volume or checkout. Use
placeholders (`/Users/<user>`, `/Volumes/<label>`, `~/code/<project>`) so the
repository reads the same for everyone who clones it.

Nor may it carry instructions from somewhere the reader cannot open — a private
repository, or a personal rule, memory or skills file kept outside this
project. Whatever a contributor has to obey belongs in this repo, in English.

`test/repo-hygiene.test.mjs` enforces both, alongside the English-only rule.

## Protocol questions

Do not guess method names or payload shapes. The app-server ships its own
schema:

```bash
codex app-server generate-json-schema --out /tmp/codex-schema
```

`ServerRequest.json` lists every request the server sends to a client; each one
needs a reply, and an unanswered method stalls the turn instead of raising an
error.
