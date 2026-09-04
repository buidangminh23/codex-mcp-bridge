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
Linux, macOS and Windows. It works against a fake app-server and a throwaway `HOME`, so
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

## Undocumented protocols

Two things this project talks to have no published schema: the Claude Code peer
protocol in `src/peer-protocol.mjs`, and the Codex Desktop native tools pipe in
`src/native-relay.mjs`. Both are measured, not documented, and both can change
without notice.

Anything resting on one of them must be optional, feature-detected, and safe
when it is absent - never the default path, and never a hard dependency of a
tool that would otherwise work. Keep the unverifiable shape in one named
function with one test pinning it, so a protocol change is a small edit in a
place someone can find rather than a hunt through a request body.

## Nothing here may depend on one person's setup

Nothing tracked here may name a real home directory, volume or checkout. Use
placeholders (`/Users/<user>`, `/Volumes/<label>`, `~/code/<project>`) so the
repository reads the same for everyone who clones it.

Nor may it carry instructions from somewhere the reader cannot open — a private
repository, or a personal rule, memory or skills file kept outside this
project. Whatever a contributor has to obey belongs in this repo, in English.

`test/repo-hygiene.test.mjs` enforces both, alongside the English-only rule.

## Releasing

`.github/workflows/publish.yml` publishes on a `v*` tag and authenticates with
npm through OIDC trusted publishing. **There is no access token in this
repository and none needs to be added.**

One gap belongs to npm rather than to this project: a trusted publisher can
only be configured on a package that already exists, so the first release of a
name cannot use OIDC. Publish that one by hand, once:

```bash
npm login
npm publish --access public
```

Then on npmjs.com open the package, go to Settings, and add a GitHub Actions
trusted publisher:

| Field | Value |
|---|---|
| Organization or user | the account that owns this repository |
| Repository | `codex-mcp-bridge` |
| Workflow filename | `publish.yml` |
| Environment | leave empty |

Every release after that is a tag:

```bash
npm version minor      # or patch / major
git push --follow-tags
```

`npm version` runs `scripts/sync-version.mjs`, which rewrites the `VERSION`
constant in `src/index.mjs` to match and stages it - `test/repo-hygiene.test.mjs`
fails the build if the two ever disagree, and `codex_bridge_status` reports that
constant to anyone filing a bug.

The workflow refuses to publish when the tag and `package.json` disagree, and
checks the npm CLI is at least 11.5.1 before trying: trusted publishing needs
it, and Node 22 still bundles npm 10.9.x, which is why the publish job pins
Node 24 while the test matrix covers both.

## Protocol questions

Do not guess method names or payload shapes. The app-server ships its own
schema:

```bash
codex app-server generate-json-schema --out /tmp/codex-schema
```

`ServerRequest.json` lists every request the server sends to a client; each one
needs a reply, and an unanswered method stalls the turn instead of raising an
error.
