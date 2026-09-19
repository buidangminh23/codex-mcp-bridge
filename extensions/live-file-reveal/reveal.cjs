const path = require('node:path');

const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.vue', '.svelte', '.astro', '.py', '.pyi', '.rs', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cs', '.fs', '.php', '.rb', '.swift', '.sql', '.graphql', '.gql', '.prisma', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml', '.md', '.mdx', '.txt', '.ps1', '.sh', '.bat', '.cmd', '.r', '.dart', '.ex', '.exs', '.erl', '.lua', '.ipynb']);
const excluded = /(^|\/)(\.git|\.hg|\.svn|node_modules|vendor|dist|build|out|coverage|\.next|\.nuxt|\.venv|venv|__pycache__|\.cache|\.claude|\.codex|\.playwright-mcp)(\/|$)/i;

function eligible(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1);
  if (!name || normalized.startsWith('../') || excluded.test(normalized)) return false;
  if (/(^\.env($|\.)|secret|credential|token|^id_rsa|^id_ed25519|\.lock$|lock\.json$|lock\.yaml$|\.min\.|\.generated\.)/i.test(name)) return false;
  return sourceExtensions.has(path.extname(name).toLowerCase()) || /^(Dockerfile|Makefile|CMakeLists\.txt)$/i.test(name);
}

function createReveal(api, output, delay = 500) {
  const pending = new Map();
  const saves = new Map();
  let timer;
  let running = false;
  let disposed = false;
  async function flush() {
    if (running || disposed) return;
    running = true;
    try {
      for (const [key, uri] of pending) {
        pending.delete(key);
        if (disposed || !api.workspace.getConfiguration('liveFileReveal', uri).get('enabled', true)) continue;
        if (Date.now() - (saves.get(key) || 0) < 1500) continue;
        const folder = api.workspace.getWorkspaceFolder(uri);
        if (!folder || !eligible(path.relative(folder.uri.fsPath, uri.fsPath))) continue;
        if (api.workspace.textDocuments.some(doc => doc.uri.toString() === key && doc.isDirty)) continue;
        try {
          const stat = await api.workspace.fs.stat(uri);
          if (stat.type !== api.FileType.File || stat.size > 1024 * 1024) continue;
          const document = await api.workspace.openTextDocument(uri);
          if (document.isDirty || disposed) continue;
          const visible = api.window.visibleTextEditors.find(editor => editor.document.uri.toString() === key);
          const textGroup = api.window.visibleTextEditors.find(editor => api.workspace.getWorkspaceFolder(editor.document.uri));
          await api.window.showTextDocument(document, {
            viewColumn: visible?.viewColumn ?? textGroup?.viewColumn ?? api.ViewColumn.Beside,
            preserveFocus: true,
            preview: false
          });
          output.info(`Revealed ${uri.fsPath}`);
        } catch (error) { output.warn(`Could not reveal ${uri.fsPath}: ${error.message}`); }
      }
    } finally { running = false; }
  }
  return {
    changed(uri) {
      const folder = api.workspace.getWorkspaceFolder(uri);
      if (disposed || !folder || !eligible(path.relative(folder.uri.fsPath, uri.fsPath))) return;
      pending.set(uri.toString(), uri);
      clearTimeout(timer);
      timer = setTimeout(flush, delay);
    },
    saved(uri) {
      const now = Date.now();
      saves.set(uri.toString(), now);
      for (const [key, time] of saves) if (now - time > 2000) saves.delete(key);
    },
    dispose() { disposed = true; clearTimeout(timer); pending.clear(); saves.clear(); }
  };
}

module.exports = { createReveal, eligible };
