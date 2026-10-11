import assert from 'node:assert/strict';
import { test } from 'node:test';
import { responsePreferencesSchema, normalizeResponsePreferences, projectHistory, projectReply, ResponseSnapshots, MAX_RESPONSE_BYTES, assertResponseResultSize } from '../src/response-preferences.mjs';

const owner = { caller: 'caller', account: 'account', operation: 'read' };
const selection = { threadId: 'thread', limit: 1 };
const preferences = { delivery: { type: 'cursorPagination', options: { maxBytes: 8192 } } };
const follow = cursor => ({ delivery: { type: 'cursorPagination', options: { cursor } } });
const item = text => ({ turnId: 'turn', itemId: 'answer', sourceIndex: 0, item: { type: 'agentMessage', text } });
function first(store, items, options = {}) {
  return store.respond({ preferences, binding: owner, selection, metadata: { threadId: 'thread', turnId: 'turn', turnStatus: 'inProgress' }, items, ...options });
}
function next(store, cursor, options = {}) {
  return store.continue({ preferences: follow(cursor), binding: owner, selection: { threadId: 'thread' }, ...options });
}
const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('strict optional preferences preserve absence and normalize only opted-in calls', () => {
  assert.equal(normalizeResponsePreferences(undefined), undefined);
  assert.deepEqual(normalizeResponsePreferences({}), { filter: { includeReasoning: true, includeToolPayloads: false } });
  assert.equal(normalizeResponsePreferences({ delivery: { type: 'cursorPagination' } }).delivery.options.maxBytes, 65536);
  for (const value of [null, { extra: true }, { filter: { includeReasoning: 'false' } }, { filter: { extra: true } }, { delivery: { type: 'streaming' } }, { delivery: { type: 'cursorPagination', options: { maxBytes: 8191 } } }, { delivery: { type: 'cursorPagination', options: { maxBytes: 98305 } } }, { delivery: { type: 'cursorPagination', options: { unknown: true } } }]) {
    assert.equal(responsePreferencesSchema.safeParse(value).success, false);
    assert.throws(() => normalizeResponsePreferences(value), { code: 'INVALID_RESPONSE_PREFERENCES' });
  }
});

test('projection strips tool payloads and unknown fields while retaining reasoning and active identity', () => {
  const turns = [{ id: 'active', status: 'inProgress', preview: 'omit', items: [
    { id: 'a', type: 'userMessage', content: [{ text: 'question' }] },
    { id: 'b', type: 'commandExecution', command: 'secret', output: 'secret', futurePayload: 'secret', exitCode: 0, status: 'completed' },
    { id: 'c', type: 'fileChange', changes: [{ path: 'a.txt', kind: { type: 'update', movePath: 'b.txt', payload: 'secret' }, diff: 'secret' }] },
    { id: 'd', type: 'reasoning', text: 'latest progress' },
    { id: 'e', type: 'newTool', name: 'future', payload: 'secret', arguments: 'secret' },
  ] }, { id: 'older', status: 'completed', items: [{ type: 'agentMessage', text: 'previous answer' }] }];
  const result = projectHistory(turns);
  assert.deepEqual(result.items.slice(0, 5).map(x => x.sourceIndex), [4, 3, 2, 1, 0]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(result.turns[0].turnId, 'active');
  assert.equal(Object.hasOwn(result.turns[0], 'preview'), false);
  assert.deepEqual(result.omissions, { reasoningRecords: 0, toolPayloadRecords: 2, unknownRecords: 1 });
  const empty = projectHistory([{ id: 'active', status: 'inProgress', items: [{ type: 'reasoning', text: 'progress' }] }], { includeReasoning: false, includeToolPayloads: false });
  assert.equal(empty.items.length, 0);
  assert.equal(empty.turns[0].status, 'inProgress');
  assert.equal(empty.omissions.reasoningRecords, 1);
  assert.equal(projectHistory(turns, { includeReasoning: true, includeToolPayloads: true }).items.find(x => x.itemId === 'b').item.command, 'secret');
});

test('reply projection preserves reading order', () => {
  assert.deepEqual(projectReply([{ id: 'a', text: 'first' }, { id: 'b', text: 'second' }], 'turn').map(x => x.item.text), ['first', 'second']);
});

test('full duplicated MCP envelope stays bounded and UTF-8 fragments reconstruct without gaps', () => {
  const store = new ResponseSnapshots();
  const records = [item('quotes " slash \\ newline\n emoji 🧑🏽‍💻 界 '.repeat(1200)), { ...item('last'), itemId: 'second', sourceIndex: 1 }];
  let result = first(store, records), offset = 0, chunks = [], pages = 0;
  while (true) {
    pages++;
    assert.ok(bytes(result) <= 8192, bytes(result));
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    for (const record of result.structuredContent.items) {
      if (record.fragment) {
        assert.equal(record.fragment.offsetBytes, offset);
        assert.equal(record.fragment.text.includes('\ufffd'), false);
        offset += Buffer.byteLength(record.fragment.text);
        chunks.push(record.fragment.text);
      } else assert.equal(record.itemId, 'second');
    }
    const page = result.structuredContent.page;
    if (page.complete) { assert.equal(page.expiresAt, null); assert.equal(page.remainingItems, 0); break; }
    assert.equal(page.remainingItems, 2);
    const a = next(store, page.nextCursor), b = next(store, page.nextCursor);
    assert.deepEqual(a, b);
    result = a;
  }
  assert.ok(pages > 2);
  assert.deepEqual(JSON.parse(chunks.join('')), records[0].item);
});

test('snapshot is frozen, caches no omitted payloads, and selectors/filter/budget cannot change', () => {
  const store = new ResponseSnapshots();
  const projected = projectHistory([{ id: 'turn', items: [{ type: 'commandExecution', command: 'omitted-secret' }, { type: 'agentMessage', text: 'a'.repeat(12000) }] }]);
  const original = first(store, projected.items);
  const cursor = original.structuredContent.page.nextCursor;
  const baseline = next(store, cursor);
  projected.items[0].item.text = 'changed';
  assert.deepEqual(next(store, cursor), baseline);
  assert.equal([...store.snapshots.values()].some(entry => entry.records.some(record => record.body.includes('omitted-secret'))), false);
  for (const override of [
    { binding: { ...owner, account: 'other' } },
    { selection: { threadId: 'other' } },
    { selection: { threadId: 'thread', limit: 2 } },
    { preferences: { ...follow(cursor), filter: { includeToolPayloads: true } } },
    { preferences: { delivery: { type: 'cursorPagination', options: { cursor, maxBytes: 16384 } } } },
  ]) assert.throws(() => next(store, cursor, override), { code: 'INVALID_CURSOR' });
  assert.deepEqual(store.inspect(follow(cursor), owner, { threadId: 'thread' }).selection, selection);
  assert.throws(() => next(store, cursor.slice(0, -1) + (cursor.endsWith('a') ? 'b' : 'a')), { code: 'INVALID_CURSOR' });
});

test('expiry is absolute; LRU eviction and worker reset invalidate cursors', () => {
  let now = 1000;
  const store = new ResponseSnapshots({ now: () => now, ttlMs: 100 });
  const cursor = first(store, [item('x'.repeat(10000))]).structuredContent.page.nextCursor;
  now += 80;
  next(store, cursor);
  now += 21;
  assert.throws(() => next(store, cursor), { code: 'CURSOR_EXPIRED' });
  assert.equal(store.cacheBytes, 0);
  const a = first(store, [item('a'.repeat(10000))]).structuredContent.page.nextCursor;
  store.maxCacheBytes = store.cacheBytes * 2 + 10;
  const b = first(store, [item('b'.repeat(10000))]).structuredContent.page.nextCursor;
  next(store, a);
  first(store, [item('c'.repeat(10000))]);
  assert.throws(() => next(store, b), { code: 'CURSOR_EXPIRED' });
  next(store, a);
  store.clear();
  assert.throws(() => next(store, a), { code: 'CURSOR_EXPIRED' });
  assert.throws(() => next(new ResponseSnapshots(), a), { code: 'CURSOR_EXPIRED' });
});

test('metadata and non-paged results obey complete envelope bounds', () => {
  const store = new ResponseSnapshots();
  assert.throws(() => first(store, [], { metadata: { huge: 'x'.repeat(8192) } }), { code: 'RESPONSE_TOO_LARGE', limit: 8192 });
  const small = first(store, [item('okay')], { preferences: {} });
  assert.equal(small.structuredContent.page.complete, true);
  assert.equal(store.cacheBytes, 0);
  assert.throws(() => first(store, [item('x'.repeat(MAX_RESPONSE_BYTES / 2))], { preferences: {} }), { code: 'RESPONSE_TOO_LARGE', limit: MAX_RESPONSE_BYTES });
});

test('wait continuation points to read-only wait and preserves original hash/status', () => {
  const store = new ResponseSnapshots();
  const result = first(store, [item('a'.repeat(20000))], { metadata: { deliveryId: 'receipt', turnStatus: 'completed', replySha256: 'original', nextAction: null } });
  assert.equal(result.structuredContent.nextAction, 'wait_codex_reply');
  const last = next(store, result.structuredContent.page.nextCursor);
  assert.equal(last.structuredContent.replySha256, 'original');
  assert.equal(last.structuredContent.turnStatus, 'completed');
});

test('observed native tool records are opt-in and newly added payload fields remain excluded', () => {
  const types = ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration', 'functionCall', 'functionCallOutput', 'subAgentActivity', 'contextCompaction', 'sleep'];
  const turns = [{ id: 'turn', items: types.map(type => ({ type, id: type, name: 'operation', namespace: 'tools', kind: 'spawn', agentThreadId: 'child', agentPath: '/root/child', command: 'private', arguments: 'private', output: 'private', prompt: 'private', futurePayload: 'private' })) }];
  const excluded = projectHistory(turns);
  assert.equal(JSON.stringify(excluded).includes('private'), false);
  assert.equal(excluded.omissions.toolPayloadRecords, types.length);
  assert.equal(excluded.omissions.unknownRecords, 0);
  const included = projectHistory(turns, { includeReasoning: true, includeToolPayloads: true });
  assert.ok(included.items.every(record => record.item.output === 'private'));
  assert.equal(excluded.items.find(record => record.item.type === 'subAgentActivity').item.agentThreadId, 'child');
  const unknown = projectHistory([{ id: 'turn', items: [{ type: 'future', id: { payload: 'private' }, status: 'running', payload: 'private' }] }]);
  assert.equal(JSON.stringify(unknown).includes('private'), false);
});

test('a final page can finish one fragment then deliver another complete item exactly once', () => {
  const store = new ResponseSnapshots();
  let result = first(store, [item('a'.repeat(10000)), { ...item('tail'), itemId: 'tail' }]);
  const delivered = [];
  while (true) {
    delivered.push(...result.structuredContent.items);
    if (result.structuredContent.page.complete) break;
    result = next(store, result.structuredContent.page.nextCursor);
  }
  assert.equal(delivered.filter(record => record.itemId === 'tail').length, 1);
  assert.equal(JSON.parse(delivered.filter(record => record.fragment).map(record => record.fragment.text).join('')).text, 'a'.repeat(10000));
});

test('failed reads retain MCP error status within the page budget', () => {
  for (const status of ['unavailable', 'failed', 'systemError']) {
    const result = first(new ResponseSnapshots(), [item('a'.repeat(10000))], { metadata: { status, error: 'observation unavailable' } });
    assert.equal(result.isError, true);
    assert.ok(bytes(result) <= 8192);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
});

test('terminal content may fit even when an unnecessary continuation envelope would not', () => {
  const store = new ResponseSnapshots();
  const record = item('tiny');
  const baseline = first(store, [record], { metadata: { padding: '' } });
  const padding = 'x'.repeat(Math.floor((8192 - bytes(baseline)) / 2) - 2);
  const result = first(store, [record], { metadata: { padding } });
  assert.ok(bytes(result) <= 8192);
  assert.equal(result.structuredContent.page.complete, true);
});

test('pagination reserves growing cursor offsets before promising continuation', () => {
  const store = new ResponseSnapshots({ now: () => 0 });
  const args = { preferences, binding: {}, selection: {}, metadata: { padding: 'x'.repeat(3528) }, items: [{ item: { text: 'x'.repeat(10000) } }] };
  assert.throws(() => store.respond(args), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(store.cacheBytes, 0);
  let result = store.respond({ ...args, metadata: { padding: 'x'.repeat(3450) } });
  let text = '', largestOffset = 0;
  for (let count = 0; ; count++) {
    assert.ok(count < 1000, 'pagination must make progress');
    assert.ok(bytes(result) <= 8192);
    for (const { fragment } of result.structuredContent.items) {
      assert.equal(fragment.offsetBytes, Buffer.byteLength(text));
      text += fragment.text;
      largestOffset = Math.max(largestOffset, fragment.offsetBytes);
    }
    if (result.structuredContent.page.complete) break;
    result = store.continue({ preferences: follow(result.structuredContent.page.nextCursor), binding: {}, selection: {} });
  }
  assert.ok(largestOffset > 1000);
  assert.deepEqual(JSON.parse(text), args.items[0].item);
});


test('legacy text-result guard measures escaped MCP serialization rather than native input size', () => {
  const legacyResult = response => ({ content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] });
  const small = legacyResult({ turns: [{ items: [{ text: '\\"'.repeat(100) }] }] });
  assert.equal(assertResponseResultSize(small), small);
  const native = { turns: [{ items: [{ text: '\\"'.repeat(1500000) }] }] };
  assert.ok(bytes(native) < MAX_RESPONSE_BYTES, 'upstream response fits its native bound');
  const result = legacyResult(native);
  assert.ok(bytes(result) > MAX_RESPONSE_BYTES, 'MCP text encoding expands escape-dense input');
  assert.throws(() => assertResponseResultSize(result), {
    code: 'RESPONSE_TOO_LARGE', boundary: 'mcp_tool_result', bytes: bytes(result), limit: MAX_RESPONSE_BYTES,
  });
});
