<p align="center">
  <img src="assets/agent-pets.svg" width="240" height="220" alt="Claude, Codex, and Antigravity connected by curved two-way arrows" />
</p>

<h1 align="center">codex-mcp-bridge</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@minhspark/codex-mcp-bridge"><img src="https://img.shields.io/npm/v/@minhspark/codex-mcp-bridge?logo=npm&amp;color=CB3837" height="20" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@minhspark/codex-mcp-bridge"><img src="https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/stats-npm-downloads.svg" height="20" alt="npm downloads" /></a>
  <a href="https://www.npmcharts.com/compare/%40minhspark%2Fcodex-mcp-bridge?minimal=true"><img src="https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/stats-npm-downloads-month.svg" height="20" alt="npm downloads / month" /></a>
  <br />
  <a href="https://github.com/buidangminh23/codex-mcp-bridge/network/dependents"><img src="https://img.shields.io/librariesio/dependent-repos/npm/@minhspark/codex-mcp-bridge?label=Used%20by&amp;logo=github&amp;color=0969da" height="20" alt="Used by repositories (Libraries.io)" /></a>
  <a href="https://skills.sh/buidangminh23/codex-mcp-bridge/codex-bridge"><img src="https://skills.sh/b/buidangminh23/codex-mcp-bridge?label=skills.sh" height="20" alt="skills.sh installs" /></a>
  <a href="https://buidangminh23.github.io/codex-mcp-bridge/"><img src="https://raw.githubusercontent.com/buidangminh23/codex-mcp-bridge/analytics/stats-github-views.svg" height="20" alt="GitHub views / source window" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@minhspark/codex-mcp-bridge" height="20" alt="license" /></a>
</p>

Connect **Claude, Codex, and Antigravity** through MCP. Send work between native Desktop conversations or use independent CLI background workers.

Supports Windows, macOS, and Linux. Native Desktop integration supports Windows and macOS.

https://github.com/user-attachments/assets/98b23989-826f-4d7d-9dcb-ad7dd2739095

## Installation

### Package — npm

Requires **Node.js 22.13+**. Use the same command for a fresh install or an update.

**Windows PowerShell**

```powershell
npx.cmd --yes --ignore-scripts --package=@minhspark/codex-mcp-bridge@latest -- codex-bridge-update --user
```

**macOS / Linux / WSL**

```bash
npm exec --yes --ignore-scripts --package=@minhspark/codex-mcp-bridge@latest -- codex-bridge-update
```

The updater installs the package, applies Claude/Codex/Antigravity settings, and verifies the background relay. Windows installs into `%APPDATA%\npm` without administrator rights. Existing permissions, project grants, custom settings, and disabled services are preserved.

For native handoffs, sign in to the Desktop apps and open the same saved project in Codex Desktop and Claude Desktop's **Code tab**. The shared Claude chat connector is a separate local app-server route.

Setup supplies a missing Codex CLI. Install and authenticate Claude Code and `agy` separately for their workers; CLI authentication is separate from Desktop sign-in.

[Windows setup](docs/new-windows-setup.md) · [macOS setup](docs/new-macos-setup.md) · [Project permissions](docs/project-onboarding.md)

### Independent background workers

Codex ↔ Claude, Codex ↔ Antigravity, and Claude ↔ Antigravity workers communicate through a per-user service, even while Desktop apps are closed or unresponsive. Workers use separate CLI sessions and require an authenticated provider, a running service, and an authorized project.

- MCP tools: `worker_status`, `list_workers`, `send_to_worker`, `read_worker_delivery`.
- Terminal: `worker-relay status`, `worker-relay list`, `worker-relay send`, `worker-relay read`.
- Authorize a selected project with `bridge-projects allow-project <absolute-project-path>`.

On Windows, add `.cmd` to terminal commands. Provider quotas and tool permissions still apply. [Worker setup and authorization](docs/project-onboarding.md)

### Verify the installation

```bash
codex-bridge-setup --check
worker-relay status
```

On Windows use `codex-bridge-setup.cmd --check` and `worker-relay.cmd status`. The first command checks saved settings; the second checks the independent service and CLI readiness.

Check native connections with the tools available inside each client:

| Client | Status tool |
| --- | --- |
| Claude Code | `codex_bridge_status` |
| Codex | `claude_bridge_status`, `native_relay_status` |
| Codex / Claude with Antigravity | `antigravity_bridge_status` |
| Antigravity | `agent_bridge_status` |

Confirm a reply on each route used. Saved configuration alone does not verify live delivery.

## Use

- **Claude → Codex:** “Send this review to my Codex task in this project and wait for its reply.”
- **Codex → Claude:** “Send this result to my Claude Desktop Code session in this project.”
- **Background work:** “Send this task to a Claude worker in this project.”
- **Another computer:** use [`remote_codex` over SSH](REFERENCE.md#codex-to-codex-over-ssh) with an existing Desktop task.

Native handoffs preserve the actual sender and destination permissions. Antigravity App replies stay in their App conversation; independent workers return separate delivery receipts.

Continue unfinished work in its original conversation. If delivery times out or is uncertain, inspect the original receipt before sending again. [Daily handoffs](docs/daily-handoffs.md)

## ChatGPT plugin

[Open Codex Bridge](https://codex-mcp-bridge.buidangminh23.chatgpt.site) to connect ChatGPT to a selected project on Windows or macOS. After installing the package, pair the connector:

```bash
codex-sites-connector --pair --site https://codex-mcp-bridge.buidangminh23.chatgpt.site --roots "/absolute/project/path"
```

On Windows use `codex-sites-connector.cmd` and a Windows project path. Open the printed pairing URL and select **Connect this computer**. Keep Codex Desktop and the connector running.

The hosted service stores account/connector identifiers, prompts, and returned results; its operator, Bui Dang Minh, can access these records. Disconnecting revokes access but does not erase history or stop dispatched tasks. Request deletion through [support](https://github.com/buidangminh23/codex-mcp-bridge/issues) without posting private content publicly. Availability follows [OpenAI's Sites access rules](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites).

### Optional workflow skill

Install the hosted workflow's Markdown instructions with:

```bash
npx skills add buidangminh23/codex-mcp-bridge --skill codex-bridge
```

Use `npx.cmd` on Windows. The skill requires the hosted plugin and a paired connector; it does not install the local bridges.

## Troubleshooting

Rerun the installation command to update, or `codex-bridge-setup` to repair settings. Use `--dry-run` to preview changes and `--check --json` to inspect configuration. Add `.cmd` on Windows.

Include the **Bridge diagnostic** block when [reporting an issue](https://github.com/buidangminh23/codex-mcp-bridge/issues). Retain the original request/delivery ID after a timeout and remove private data from surrounding logs.

## Documentation

- [Windows setup and recovery](docs/new-windows-setup.md)
- [macOS setup and recovery](docs/new-macos-setup.md)
- [Project authorization](docs/project-onboarding.md)
- [Daily Desktop handoffs](docs/daily-handoffs.md)
- [Tools, settings, SSH, and technical details](REFERENCE.md)
- [Homebrew installation](https://github.com/buidangminh23/homebrew-tap)
- [Changelog](CHANGELOG.md) · [Releases](https://github.com/buidangminh23/codex-mcp-bridge/releases)

## Optional active-install statistics

Usage reporting is **off by default**. Use `codex-mcp-bridge telemetry status` to inspect it, or `telemetry enable` / `telemetry disable` to change it. Reports include a random installation ID, UTC day, version, and OS; no chats, paths, accounts, or credentials. `DO_NOT_TRACK=1` or `CODEX_BRIDGE_TELEMETRY=0` disables reporting.

[Analytics](https://buidangminh23.github.io/codex-mcp-bridge/) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE)
