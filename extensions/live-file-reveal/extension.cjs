const vscode = require('vscode');
const { createReveal } = require('./reveal.cjs');

function activate(context) {
  const output = vscode.window.createOutputChannel('Live File Reveal', { log: true });
  const controller = createReveal(vscode, output);
  const watchers = new Map();
  function refresh() {
    const folders = vscode.workspace.workspaceFolders || [];
    const active = new Set(folders.map(folder => folder.uri.toString()));
    for (const [key, watcher] of watchers) {
      if (!active.has(key)) { watcher.dispose(); watchers.delete(key); }
    }
    for (const folder of folders) {
      const key = folder.uri.toString();
      if (watchers.has(key)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
      watcher.onDidChange(uri => controller.changed(uri));
      watcher.onDidCreate(uri => controller.changed(uri));
      watchers.set(key, watcher);
      output.info(`Watching ${folder.uri.fsPath}`);
    }
  }
  refresh();
  context.subscriptions.push(output, controller,
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onWillSaveTextDocument(event => controller.saved(event.document.uri)),
    vscode.commands.registerCommand('liveFileReveal.toggle', async () => {
      const config = vscode.workspace.getConfiguration('liveFileReveal');
      await config.update('enabled', !config.get('enabled', true), vscode.ConfigurationTarget.Global);
    }),
    { dispose() { for (const watcher of watchers.values()) watcher.dispose(); } }
  );
}

module.exports = { activate };
