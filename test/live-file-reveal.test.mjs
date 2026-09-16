import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createReveal, eligible } = createRequire(import.meta.url)('../extensions/live-file-reveal/reveal.cjs');

test('source selection excludes dependencies, credentials, and generated output', () => {
  for (const name of ['src/app.ts', 'apply.html', 'styles.css', 'docs/guide.md']) assert.equal(eligible(name), true);
  for (const name of ['node_modules/pkg/index.js', '.git/config', '.env', '.env.local', 'credentials.json', 'package-lock.json', 'dist/app.js', 'image.png', '../other.js']) assert.equal(eligible(name), false, name);
});

function fixture({ dirty = false, enabled = true } = {}) {
  const uri = { fsPath: '/workspace/app.html', toString: () => 'file:///workspace/app.html' };
  const folder = { uri: { fsPath: '/workspace' } };
  const document = { uri, isDirty: dirty };
  const calls = [];
  const api = {
    FileType: { File: 1 }, ViewColumn: { Beside: -2 },
    workspace: {
      getConfiguration: () => ({ get: () => enabled }),
      getWorkspaceFolder: () => folder,
      textDocuments: [document],
      fs: { stat: async () => ({ type: 1, size: 100 }) },
      openTextDocument: async () => document
    },
    window: { visibleTextEditors: [], showTextDocument: async (doc, options) => calls.push({ doc, options }) }
  };
  const controller = createReveal(api, { info() {}, warn() {} }, 5);
  return { uri, calls, controller };
}

test('external writes open a pinned editor beside chat without taking focus', async () => {
  const { uri, calls, controller } = fixture();
  controller.changed(uri);
  controller.changed(uri);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, { viewColumn: -2, preserveFocus: true, preview: false });
  controller.dispose();
});

test('dirty buffers, disabled reveal, and user saves are not revealed', async () => {
  for (const options of [{ dirty: true }, { enabled: false }, { saved: true }]) {
    const { uri, calls, controller } = fixture(options);
    if (options.saved) controller.saved(uri);
    controller.changed(uri);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.length, 0);
    controller.dispose();
  }
});
