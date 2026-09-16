# Live File Reveal

Opens source files changed on disk in the VS Code window that owns their workspace. This includes writes made by Claude, Codex, shell commands, and other external tools. It does not depend on agent instructions or MCP configuration.

The extension activates automatically in every workspace. It pins changed files in a text editor group without taking keyboard focus from chat. If only chat is visible, it opens a text editor beside it. Existing dirty buffers are left alone. Dependency folders, build outputs, common secret filenames, lockfiles, binary files, and files over 1 MiB are excluded. User saves are suppressed where VS Code reports them before the filesystem event.

Use **Live File Reveal: Toggle** or the `liveFileReveal.enabled` setting to pause it globally or per workspace. This watches disk changes, not individual keystrokes, and cannot identify which external program wrote a file. VS Code watcher exclusions still apply.

Package with `npx @vscode/vsce package --no-dependencies`, then install the resulting VSIX with `code --install-extension <absolute-path-to-vsix>`. An already running extension host may require a window reload before the first activation.
