# Security Policy

## Reporting a Vulnerability

Report suspected vulnerabilities privately through [GitHub's Report a vulnerability form](https://github.com/buidangminh23/codex-mcp-bridge/security/advisories/new). The repository maintainer is Bui Dang Minh (`buidangminh23`).

Include the affected version or commit, operating system, component, required access, reproduction steps, expected security boundary, and observed impact. Use synthetic accounts, projects, and credentials. Redact tokens, private conversations, account identifiers, and local machine details. Coordinate disclosure through the private report before publishing exploit details. Public issues are suitable for ordinary bugs with no sensitive security information.

## Supported Versions

Use the latest stable release of `@minhspark/codex-mcp-bridge`. Security fixes are delivered in current releases; older versions should be upgraded. Reports against `main` and the hosted connector service are also welcome. This project does not promise security backports to every historical release.

## System and Scope

This policy covers the MCP bridge, native Desktop relay, installers and supervisors in `src/` and `scripts/`, the hosted Worker and database schema in `sites/codex-bridge/`, telemetry endpoints in `supabase/functions/`, dependencies, and GitHub Actions workflows.

The local bridge operates with the OS user's privileges and routes operations into Claude Code or Codex Desktop. The Sites connector uses outbound HTTPS to pair a computer with an authenticated account. The hosted Worker stores queued operations, returned results, connector token hashes, and account bindings. Prompts and operation results may contain private data.

## Threat Model and Trust Boundaries

Treat incoming MCP arguments, HTTP requests, pairing material, operation results, repository files, path aliases, and conversation metadata as potentially untrusted. A caller's claimed identity, workspace, permissions, or delivery status is not sufficient evidence of authority.

Important boundaries include authenticated account to paired connector; sender to recipient permission class; authorized project to canonical filesystem path; OS user to local IPC client; and queued request to Desktop execution and correlated receipt. The service operator and configured local account have administrative access to their own infrastructure. That access does not authorize one service account to read or dispatch another account's work.

## Security Invariants

- Authenticate protected service operations and enforce account and connector ownership before reading, claiming, mutating, or completing work.
- Enforce project roots on canonical paths, including symlinks and junctions. Missing or contradictory authorization evidence must not broaden access.
- Preserve sender and recipient permission checks. Bridge delivery must not bypass Desktop approval requirements.
- Reject expired, revoked, mismatched, or replayed authorization where the operation contract requires fresh authority. Uncertain delivery must not be represented as confirmed execution or silently retried as a new operation.
- Protect connector credentials, token hashes, private prompts, results, and receipts from unauthorized access or disclosure. Public telemetry must remain aggregate and exclude private records.
- Keep SQL data parameterized and escape SQL identifiers. Validate inputs before crossing filesystem, subprocess, IPC, network, or database boundaries.
- Keep release and CI credentials out of source, logs, generated packages, and untrusted pull-request execution.

## Assessment and Limitations

Report concrete authentication or authorization bypasses, cross-account data access, unauthorized Desktop dispatch, path-policy escapes, injection, credential exposure, and security-relevant resource exhaustion. Explain reachability, attacker prerequisites, affected configuration, and impact; scanner severity alone does not establish exploitability.

Development dependencies and alternate supported configurations remain in scope. A dependency advisory without a reachable application path still warrants dependency maintenance. Fixtures and tests may be used as evidence but do not prove a production control works.

OpenAI and Anthropic clients, authentication services, and hosting infrastructure have their own security policies. Report bridge integration failures here and issues wholly within another product to its maintainer. Automated scans do not prove that deployed services or local Desktop sessions are safe. This policy establishes no blanket finding exclusions or accepted vulnerability exceptions, and does not authorize testing against other users' data or machines.
