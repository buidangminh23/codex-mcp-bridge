import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerDesktopReadTools } from '../src/desktop-read-tools.mjs';
import { DesktopTaskDelivery } from '../src/thread-delivery.mjs';
import { DesktopReplyReceipts } from '../src/desktop-reply-receipts.mjs';
import { captureProjectScope } from '../src/project-scope.mjs';

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) });
const failure = error => ({ ...textResult(error.message, true), structuredContent: { error: { code: error.code ?? 'AUTHORIZATION_FAILED' } } });
const pagePrefs = { delivery: { type: 'cursorPagination', options: { maxBytes: 8192 } } };
const cursorPrefs = cursor => ({ delivery: { type: 'cursorPagination', options: { cursor } } });

async function fixture(t, { desktop = true, realObservation = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'response-tools-'));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const context = { caller: { sessionId: 'caller', taskId: 'calling-task', cwd }, accounts: { claude: 'claude', codex: 'codex' }, deadline: Date.now() + 40000 };
  const originalAccounts = { ...context.accounts };
  const receipts = new DesktopReplyReceipts({ directory: path.join(root, 'receipts') });
  const delivered = { threadId: 'thread', cwd, previousTurnId: 'old', deliveryStatus: 'accepted', responseObservation: {
    threadId: 'thread', expectedCwd: cwd, previousTurnId: 'old', accountContext: context.accounts, prompt: 'private original prompt',
  } };
  const deliveryId = receipts.create(delivered, context);
  const state = { allowed: true, calls: [], turnId: 'current', afterInspect: null,
    turns: [{ id: 'current', status: 'inProgress', items: [
      { id: 'tool', type: 'commandExecution', command: 'hidden-command', output: 'hidden-output', status: 'completed' },
      { id: 'reason', type: 'reasoning', text: 'working now' },
      { id: 'answer', type: 'agentMessage', text: 'visible answer '.repeat(1800) },
    ] }],
    reply: { threadId: 'thread', turnId: 'current', status: 'completed', responseStatus: 'completed',
      text: 'authoritative '.repeat(1600), assistantItems: [{ id: 'final', text: 'authoritative '.repeat(1600) }], replySha256: 'original-reply-hash' },
  };
  const security = { assertCwd() { if (!state.allowed) throw new Error('scope revoked'); } };
  const desktopTasks = {
    now: Date.now,
    threadOperations: new Map(),
    async inspect(threadId, expectedCwd, { deadline } = {}) {
      state.calls.push('inspect'); security.assertCwd(cwd);
      if (realObservation && Date.now() >= deadline) throw new Error('Overall authorization deadline elapsed');
      assert.equal(threadId, 'thread');
      if (expectedCwd) assert.equal(expectedCwd, cwd);
      const result = { thread: { id: threadId, cwd, hostId: 'local' }, latestTurnId: state.turnId, projectScope: captureProjectScope(context.caller.cwd, cwd) };
      state.afterInspect?.(); return result;
    },
    async request(operation, args) {
      state.calls.push(operation);
      state.lastReadArguments = args;
      if (realObservation && operation === 'wait_threads') return { polls: [{ thread: { id: 'thread', hostId: 'local', status: { type: 'idle' } }, latestTurn: { id: 'current', status: 'completed' } }] };
      assert.equal(operation, 'read_thread');
      return { thread: { id: 'thread', cwd }, turns: state.turns, page: { hasMore: true, nextCursor: "native-history-cursor" } };
    },
    async observeNativeResponse() { return state.reply; },
    async inspectNativeTurn() { state.calls.push('inspectNativeTurn'); return state.reply; },
    async wait(threadId, options) {
      state.calls.push('wait');
      return realObservation ? DesktopTaskDelivery.prototype.wait.call(this, threadId, options) : state.reply;
    },
    async resolveCreation() { state.calls.push('resolveCreation'); throw new Error('must not resolve'); },
    async withThread(id, fn, options) {
      return realObservation ? DesktopTaskDelivery.prototype.withThread.call(this, id, fn, options) : fn();
    },
  };
  const server = new McpServer({ name: 'actual-read-tool-handlers', version: '1' });
  registerDesktopReadTools((name, definition, handler) => server.registerTool(name, definition, handler), {
    desktopTasksEnabled: desktop, desktopTasks, replyReceipts: receipts, security,
    context: () => context,
    async assertOperation(_context, options) {
      state.onAssertOperation?.(options);
      if (!state.allowed) throw new Error('scope revoked');
      assert.deepEqual(context.accounts, originalAccounts, 'account switched');
    },
    client: { async call() { state.calls.push('legacy-read'); return { thread: { id: 'thread', name: 'Legacy', cwd, turns: [{ items: [{ type: 'agentMessage', text: 'old answer' }] }] } }; } },
    assertThreadAccess: async () => {}, normalizeThreadCwd: value => value, textResult, failure,
    replyResult: (delivery, id, result) => ({ ...textResult('existing legacy reply'), structuredContent: { ...result, deliveryId: id, threadId: delivery.threadId } }),
  });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { state, context, cwd, root, deliveryId, receipts, client, call: (name, args) => client.callTool({ name, arguments: args }) };
}

it('advertises strict preferences and preserves the absent-preference desktop response', async t => {
  const f = await fixture(t);
  const tools = await f.client.listTools();
  for (const tool of tools.tools) {
    assert.equal(tool.inputSchema.properties.responsePreferences.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.responsePreferences.properties.filter.additionalProperties, false);
  }
  const legacy = await f.call('read_codex_thread', { threadId: 'thread' });
  assert.equal(f.state.lastReadArguments.includeOutputs, false);
  assert.equal(f.state.lastReadArguments.maxOutputCharsPerItem, 2000);
  assert.equal(legacy.structuredContent, undefined);
  assert.match(legacy.content[0].text, /hidden-command/);
  const preferred = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: {} });
  assert.equal(f.state.lastReadArguments.includeOutputs, false);
  assert.equal(f.state.lastReadArguments.maxOutputCharsPerItem, 16000);
  assert.equal(preferred.structuredContent.responseVersion, 1);
  assert.doesNotMatch(preferred.content[0].text, /hidden-command|hidden-output/);
  assert.match(preferred.content[0].text, /working now/);
  assert.equal(preferred.structuredContent.sourceHasMore, true);
  assert.deepEqual(JSON.parse(preferred.content[0].text), preferred.structuredContent);
  const withTools = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: { filter: { includeToolPayloads: true } } });
  assert.equal(f.state.lastReadArguments.includeOutputs, true);
  assert.match(withTools.content[0].text, /hidden-output/);
});

it('rejects escape-expanded legacy history before it can poison the supervisor connection', async t => {
  const f = await fixture(t);
  f.state.turns = [{ id: 'current', status: 'inProgress', items: Array.from({ length: 1000 }, (_, index) => ({
    id: `item-${index}`, type: 'commandExecution', status: 'completed', output: '"'.repeat(4154),
  })) }];
  const native = { thread: { id: 'thread', cwd: f.cwd }, turns: f.state.turns, page: { hasMore: true, nextCursor: 'native-history-cursor' } };
  assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, result: native })) < 8 * 1024 * 1024);
  const unbounded = textResult(JSON.stringify(native, null, 2));
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: unbounded })) > 16 * 1024 * 1024);
  const rejected = await f.call('read_codex_thread', { threadId: 'thread' });
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.code, 'RESPONSE_TOO_LARGE');
  assert.ok(Buffer.byteLength(JSON.stringify(rejected)) < 8192);
  f.state.turns = [{ id: 'current', status: 'inProgress', items: [] }];
  const next = await f.call('read_codex_thread', { threadId: 'thread' });
  assert.equal(next.isError, undefined);
  assert.match(next.content[0].text, /current/);
});

it('returns stable replayable bounded pages while a new turn advances, and rejects selector changes', async t => {
  const f = await fixture(t);
  const first = await f.call('read_codex_thread', { threadId: 'thread', limit: 1, responsePreferences: pagePrefs });
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 8192);
  const cursor = first.structuredContent.page.nextCursor; assert.ok(cursor);
  f.state.turnId = 'new-turn'; f.state.turns = [{ id: 'new-turn', status: 'inProgress', items: [{ id: 'new', type: 'reasoning', text: 'fresh activity' }] }];
  const args = { threadId: 'thread', responsePreferences: cursorPrefs(cursor) };
  const next = await f.call('read_codex_thread', args);
  assert.equal(next.structuredContent.turnId, 'current');
  assert.deepEqual(await f.call('read_codex_thread', args), next);
  assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 8192);
  const conflict = await f.call('read_codex_thread', { ...args, limit: 2 });
  assert.equal(conflict.structuredContent.error.code, 'INVALID_CURSOR');
  const fresh = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: {} });
  assert.equal(fresh.structuredContent.turnId, 'new-turn');
  assert.match(fresh.content[0].text, /fresh activity/);
  assert.ok(f.state.calls.every(call => ['inspect', 'read_thread'].includes(call)));
});

it('does not substitute an older answer when the selected current turn filters to empty', async t => {
  const f = await fixture(t);
  f.state.turns = [{ id: 'current', status: 'inProgress', items: [{ id: 'r', type: 'reasoning', text: 'new' }] }];
  const result = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: { filter: { includeReasoning: false } } });
  assert.deepEqual(result.structuredContent.items, []);
  assert.equal(result.structuredContent.turnId, 'current');
  assert.equal(result.structuredContent.turnStatus, 'inProgress');
});

it('wait continuations page verified replies without waiting or resolving again and keep full hash', async t => {
  const f = await fixture(t);
  const first = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, responsePreferences: pagePrefs });
  assert.equal(first.structuredContent.replySha256, 'original-reply-hash');
  assert.equal(first.structuredContent.nextAction, 'wait_codex_reply');
  const cursor = first.structuredContent.page.nextCursor; assert.ok(cursor);
  f.state.calls.length = 0; f.state.turnId = 'next-turn';
  const next = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, responsePreferences: cursorPrefs(cursor) });
  assert.equal(next.structuredContent.replySha256, 'original-reply-hash');
  assert.ok(f.state.calls.every(call => call === 'inspect'));
  const rejected = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, timeoutSec: 1, responsePreferences: cursorPrefs(cursor) });
  assert.equal(rejected.structuredContent.error.code, 'INVALID_RESPONSE_PREFERENCES');
  f.state.reply = { status: 'timeout', responseStatus: 'unavailable', text: '' };
  const timeout = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, responsePreferences: pagePrefs });
  assert.equal(timeout.structuredContent.nextAction, 'wait_codex_reply');
  assert.equal(timeout.structuredContent.page.nextCursor, null);
  assert.equal(timeout.structuredContent.turnStatus, null);
});

it('wait continuations keep unavailable observation distinct from failure and discourage resends', async t => {
  const f = await fixture(t);
  f.state.reply = { threadId: 'thread', turnId: 'current', status: 'observation_unavailable', responseStatus: 'unavailable',
    observationStatus: 'unavailable', observationReason: 'Unrecognized native response record', text: '' };
  const result = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, responsePreferences: pagePrefs });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.status, 'observation_unavailable');
  assert.equal(result.structuredContent.deliveryStatus, 'accepted');
  assert.equal(result.structuredContent.deliveryId, f.deliveryId);
  assert.equal(result.structuredContent.nextAction, 'inspect_existing_task');
  assert.match(result.structuredContent.guidance, /do not resend the prompt/i);
  assert.equal(result.structuredContent.page.nextCursor, null);
  assert.deepEqual(result.structuredContent.items, []);
});

it('cached pages block account switches, revoked scope, replaced roots and receipt tampering', async t => {
  const f = await fixture(t);
  const first = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, responsePreferences: pagePrefs });
  const args = { deliveryId: f.deliveryId, responsePreferences: cursorPrefs(first.structuredContent.page.nextCursor) };
  f.context.accounts.codex = 'other';
  assert.equal((await f.call('wait_codex_reply', args)).isError, true);
  f.context.accounts.codex = 'codex'; f.state.allowed = false;
  assert.equal((await f.call('wait_codex_reply', args)).isError, true);
  f.state.allowed = true;
  fs.renameSync(f.cwd, `${f.cwd}-original`); fs.mkdirSync(f.cwd);
  const replaced = await f.call('wait_codex_reply', args); assert.equal(replaced.isError, true); assert.doesNotMatch(replaced.content[0].text, /authoritative/);
  fs.rmdirSync(f.cwd); fs.renameSync(`${f.cwd}-original`, f.cwd);
  const file = f.receipts.file(f.deliveryId); const receipt = JSON.parse(fs.readFileSync(file)); receipt.delivered.responseObservation.prompt = 'changed'; fs.writeFileSync(file, JSON.stringify(receipt));
  assert.equal((await f.call('wait_codex_reply', args)).isError, true);
});

it('withholds a page when scope changes during post-render reauthorization', async t => {
  const f = await fixture(t);
  const first = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: pagePrefs });
  let calls = 0;
  f.state.afterInspect = () => { if (++calls === 2) f.state.allowed = false; };
  const result = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: cursorPrefs(first.structuredContent.page.nextCursor) });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /visible answer/);
});

it('legacy backend rejects opt-in before touching backend and preserves old reads', async t => {
  const f = await fixture(t, { desktop: false });
  for (const [name, args] of [['read_codex_thread', { threadId: 'thread' }], ['wait_codex_reply', { deliveryId: f.deliveryId }]]) {
    const result = await f.call(name, { ...args, responsePreferences: {} });
    assert.equal(result.structuredContent.error.code, 'INVALID_RESPONSE_PREFERENCES');
  }
  assert.deepEqual(f.state.calls, []);
  const legacy = await f.call('read_codex_thread', { threadId: 'thread' });
  assert.equal(legacy.structuredContent, undefined); assert.match(legacy.content[0].text, /old answer/);
});

it('rejects null and unknown nested preferences through actual MCP schema validation', async t => {
  const f = await fixture(t);
  for (const responsePreferences of [null, { extra: true }, { delivery: { type: 'streaming' } }, { filter: { invented: false } }]) {
    const result = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(f.state.calls, []);
});

it('retains authoritative read status and failure signaling without claiming unavailable is a turn state', async t => {
  const f = await fixture(t);
  const exact = await f.call('read_codex_thread', { threadId: 'thread', turnId: 'current', responsePreferences: {} });
  assert.equal(exact.structuredContent.replySha256, 'original-reply-hash');
  assert.equal(exact.structuredContent.turnStatus, 'completed');
  f.state.reply = { status: 'unavailable', reason: 'lifecycle not verified', assistantItems: [], text: '', replySha256: null };
  const unavailable = await f.call('read_codex_thread', { threadId: 'thread', turnId: 'current', responsePreferences: pagePrefs });
  assert.equal(unavailable.isError, true);
  assert.equal(unavailable.structuredContent.turnStatus, null);
  assert.deepEqual(unavailable.structuredContent.items, []);
  assert.deepEqual(JSON.parse(unavailable.content[0].text), unavailable.structuredContent);
  for (const status of ['failed', 'systemError']) {
    f.state.reply = { status, text: '', assistantItems: [], errors: [{ message: 'failure' }] };
    const failed = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, responsePreferences: pagePrefs });
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.status, status);
    assert.ok(Buffer.byteLength(JSON.stringify(failed)) <= 8192);
  }
});

it('observes an already-completed reply at the minimum one-second timeout', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const f = await fixture(t, { realObservation: true });
  f.context.deadline = Date.now() + 1000;
  const result = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, timeoutSec: 1, responsePreferences: {} });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent.status, 'completed');
  assert.equal(result.structuredContent.replySha256, 'original-reply-hash');
  assert.equal(f.state.calls.filter(call => call === 'wait_threads').length, 1);
  assert.ok(f.state.calls.every(call => ['inspect', 'wait', 'wait_threads'].includes(call)));
});

for (const setupDelay of [800, 1100]) it(`preserves live authorization after setup consumes ${setupDelay}ms of a one-second wait`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const f = await fixture(t, { realObservation: true });
  f.context.deadline = Date.now() + 1000;
  f.state.afterInspect = () => { f.state.afterInspect = null; t.mock.timers.tick(setupDelay); };
  const result = await f.call('wait_codex_reply', { deliveryId: f.deliveryId, timeoutSec: 1, responsePreferences: {} });
  if (setupDelay < 1000) {
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, 'timeout');
    assert.equal(result.structuredContent.nextAction, 'wait_codex_reply');
    assert.equal(result.structuredContent.page.nextCursor, null);
    assert.equal(f.state.calls.length, 3, 'initial inspection and both live authorization checks still run');
  } else {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /authorization deadline elapsed/);
  }
  assert.ok(f.state.calls.every(call => call === 'inspect'), 'exhausted observation budget does not poll or mutate');
});

it('reuses entry process ancestry while rechecking live authorization on fresh and cached reads', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const f = await fixture(t, { realObservation: true });
  let authorizationChecks = 0;
  let processRefreshes = 0;
  f.state.onAssertOperation = options => {
    authorizationChecks++;
    if (options?.verifyProcess) {
      processRefreshes++;
      // Model a cold Windows process lookup; repeated scans exhaust the call budget.
      t.mock.timers.tick(15000);
    }
  };
  const first = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: pagePrefs });
  assert.equal(first.isError, undefined, JSON.stringify(first));
  const cursor = first.structuredContent.page.nextCursor;
  assert.ok(cursor);
  const continuation = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: cursorPrefs(cursor) });
  assert.equal(continuation.isError, undefined, JSON.stringify(continuation));
  assert.equal(processRefreshes, 0);
  assert.equal(authorizationChecks, 8, 'both sides of each read retain both live operation checks');
  f.state.allowed = false;
  const revoked = await f.call('read_codex_thread', { threadId: 'thread', responsePreferences: cursorPrefs(cursor) });
  assert.equal(revoked.isError, true);
  assert.equal(authorizationChecks, 9);
  assert.equal(processRefreshes, 0);
});
