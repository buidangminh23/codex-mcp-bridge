import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const DEFAULT_PAGE_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const responsePreferencesSchema = z.object({
  delivery: z.object({
    type: z.literal('cursorPagination'),
    options: z.object({
      maxBytes: z.number().int().min(8 * 1024).max(96 * 1024).optional(),
      cursor: z.string().min(1).max(512).optional(),
    }).strict().optional(),
  }).strict().optional(),
  filter: z.object({
    includeReasoning: z.boolean().optional(),
    includeToolPayloads: z.boolean().optional(),
  }).strict().optional(),
}).strict();

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
function parsePreferences(input) {
  const result = responsePreferencesSchema.safeParse(input);
  if (!result.success) throw failure('INVALID_RESPONSE_PREFERENCES', result.error.message);
  return result.data;
}
export function normalizeResponsePreferences(input) {
  if (input === undefined) return undefined;
  const value = parsePreferences(input);
  return {
    ...(value.delivery ? { delivery: { type: 'cursorPagination', options: { maxBytes: value.delivery.options?.maxBytes ?? DEFAULT_PAGE_BYTES } } } : {}),
    filter: { includeReasoning: value.filter?.includeReasoning ?? true, includeToolPayloads: value.filter?.includeToolPayloads ?? false },
  };
}
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value?.[key] !== undefined && scalar(value[key])).map(key => [key, value[key]]));
}
const IDENTITY = ['id', 'type', 'name', 'status', 'startedAt', 'completedAt', 'createdAt', 'updatedAt', 'timestamp', 'durationMs', 'exitCode'];
const TOOL_TYPES = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange', 'collabAgentToolCall', 'webSearch', 'imageView', 'imageGeneration', 'function_call', 'function_call_output', 'tool_call', 'tool_result', 'functionCall', 'functionCallOutput', 'subAgentActivity', 'contextCompaction', 'sleep']);
const MESSAGE_TYPES = new Set(['agentMessage', 'userMessage', 'assistantMessage', 'message', 'commentary']);

export function projectHistory(turns, filter = { includeReasoning: true, includeToolPayloads: false }) {
  const omissions = { reasoningRecords: 0, toolPayloadRecords: 0, unknownRecords: 0 };
  const headers = [], items = [];
  for (const turn of turns) {
    const turnId = typeof turn.id === 'string' ? turn.id : typeof turn.turnId === 'string' ? turn.turnId : null;
    headers.push({ ...pick(turn, ['id', 'turnId', 'status', 'startedAt', 'completedAt', 'createdAt', 'updatedAt', 'timestamp']), turnId });
    const source = Array.isArray(turn.items) ? turn.items : [];
    for (let index = source.length - 1; index >= 0; index--) {
      const raw = source[index];
      if (!raw || typeof raw !== 'object') { omissions.unknownRecords++; continue; }
      let item;
      if (raw.type === 'reasoning') {
        if (!filter.includeReasoning) { omissions.reasoningRecords++; continue; }
        item = raw;
      } else if (MESSAGE_TYPES.has(raw.type)) item = raw;
      else if (TOOL_TYPES.has(raw.type)) {
        if (filter.includeToolPayloads) item = raw;
        else {
          omissions.toolPayloadRecords++;
          item = pick(raw, [...IDENTITY, 'tool', 'server', 'callId', 'processId', 'cwd', 'path', 'kind', 'agentId', 'agentThreadId', 'agentPath', 'namespace', 'receiverThreadId', 'senderThreadId']);
          if (Array.isArray(raw.changes)) item.changes = raw.changes.map(change => ({
            ...pick(change, ['path', 'kind']),
            ...(change?.kind && typeof change.kind === 'object' ? { kind: pick(change.kind, ['type', 'movePath']) } : {}),
          }));
        }
      } else { omissions.unknownRecords++; item = pick(raw, IDENTITY); }
      items.push({ turnId, itemId: typeof raw.id === 'string' ? raw.id : `${turnId}:${index}`, sourceIndex: index, item });
    }
  }
  return { turns: headers, items, omissions };
}
export function projectReply(assistantItems, turnId) {
  return assistantItems.map((item, sourceIndex) => ({ turnId, itemId: item.id ?? `${turnId}:${sourceIndex}`, sourceIndex, item: { type: 'agentMessage', text: item.text } }));
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
const encode = value => JSON.stringify(stable(value));
export function responseResult(envelope) {
  return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, ...(['unavailable', 'failed', 'systemError'].includes(envelope.status) ? { isError: true } : {}) };
}
const size = value => Buffer.byteLength(JSON.stringify(value));
function oversize(bytes, limit) {
  return failure('RESPONSE_TOO_LARGE', `Response requires ${bytes} bytes; limit is ${limit}`, { boundary: 'mcp_tool_result', bytes, limit });
}
export function assertResponseResultSize(result) {
  const bytes = size(result);
  if (bytes > MAX_RESPONSE_BYTES) throw oversize(bytes, MAX_RESPONSE_BYTES);
  return result;
}

// The caller checks live scope and receipt ownership before and after each store operation.
export class ResponseSnapshots {
  constructor({ now = Date.now, maxCacheBytes = 32 * 1024 * 1024, ttlMs = 30 * 60 * 1000 } = {}) {
    this.now = now;
    this.maxCacheBytes = maxCacheBytes;
    this.ttlMs = ttlMs;
    this.snapshots = new Map();
    this.cacheBytes = 0;
  }
  clear() { this.snapshots.clear(); this.cacheBytes = 0; }
  remove(id) {
    const entry = this.snapshots.get(id);
    if (entry) { this.cacheBytes -= entry.bytes; this.snapshots.delete(id); }
  }
  prune() {
    for (const [id, entry] of this.snapshots) if (entry.expires <= this.now()) this.remove(id);
  }
  token(entry, index, offset) {
    const value = `${entry.id}.${index}.${offset}`;
    return `${value}.${createHmac('sha256', entry.secret).update(value).digest('base64url')}`;
  }
  lookup(preferences, binding, selection) {
    const requested = parsePreferences(preferences);
    const cursor = requested.delivery?.options?.cursor;
    const match = typeof cursor === 'string' && /^([A-Za-z0-9_-]{32})\.(\d+)\.(\d+)\.([A-Za-z0-9_-]{43})$/.exec(cursor);
    if (!match) throw failure('INVALID_CURSOR', 'Invalid response cursor');
    this.prune();
    const entry = this.snapshots.get(match[1]);
    if (!entry) throw failure('CURSOR_EXPIRED', 'Response snapshot expired or is no longer available');
    if (entry.binding !== encode(binding)) throw failure('INVALID_CURSOR', 'Cursor does not belong to this caller');
    const index = Number(match[2]), offset = Number(match[3]);
    const expected = this.token(entry, index, offset);
    if (cursor.length !== expected.length || !timingSafeEqual(Buffer.from(cursor), Buffer.from(expected))) throw failure('INVALID_CURSOR', 'Invalid response cursor');
    const originalSelection = JSON.parse(entry.selection);
    for (const [key, value] of Object.entries(selection ?? {})) {
      if (value !== undefined && encode(value) !== encode(originalSelection[key])) throw failure('INVALID_CURSOR', `Cursor conflicts with selector ${key}`);
    }
    const original = JSON.parse(entry.preferences);
    if (requested.delivery.options?.maxBytes !== undefined && requested.delivery.options.maxBytes !== original.delivery.options.maxBytes) throw failure('INVALID_CURSOR', 'Cursor conflicts with page budget');
    for (const [key, value] of Object.entries(requested.filter ?? {})) {
      if (value !== original.filter[key]) throw failure('INVALID_CURSOR', `Cursor conflicts with filter ${key}`);
    }
    return { entry, index, offset };
  }
  inspect(preferences, binding, selection) {
    const { entry } = this.lookup(preferences, binding, selection);
    return { selection: JSON.parse(entry.selection), metadata: JSON.parse(entry.metadata), authorization: JSON.parse(entry.authorization) };
  }
  continue({ preferences, binding, selection }) {
    const { entry, index, offset } = this.lookup(preferences, binding, selection);
    const result = this.render(entry, index, offset);
    this.snapshots.delete(entry.id);
    this.snapshots.set(entry.id, entry);
    return result;
  }
  respond({ preferences, binding, selection, metadata = {}, items, authorization = null }) {
    const supplied = parsePreferences(preferences);
    if (supplied.delivery?.options?.cursor) throw failure('INVALID_CURSOR', 'Use continuation for a response cursor');
    const applied = normalizeResponsePreferences(supplied);
    const now = this.now();
    const entry = {
      id: randomBytes(24).toString('base64url'), secret: randomBytes(32),
      binding: encode(binding), selection: encode(selection ?? {}), authorization: encode(authorization),
      metadata: JSON.stringify({ ...metadata, responseVersion: 1, snapshotAt: new Date(now).toISOString(), appliedResponsePreferences: applied }),
      preferences: JSON.stringify(applied), expires: now + this.ttlMs,
      records: items.map(({ item, ...header }) => ({ header: JSON.stringify(header), body: Buffer.from(JSON.stringify(item), 'utf8') })),
    };
    entry.bytes = Buffer.byteLength(entry.binding + entry.selection + entry.authorization + entry.metadata + entry.preferences + entry.id) + entry.secret.length + entry.records.reduce((total, record) => total + Buffer.byteLength(record.header) + record.body.length + 32, 0);
    if (!applied.delivery) {
      const result = responseResult({ ...JSON.parse(entry.metadata), items: entry.records.map(record => ({ ...JSON.parse(record.header), item: JSON.parse(record.body.toString('utf8')) })), page: { complete: true, nextCursor: null, remainingItems: 0, expiresAt: null } });
      return assertResponseResultSize(result);
    }
    const result = this.render(entry, 0, 0);
    if (result.structuredContent.page.complete) return result;
    const limit = applied.delivery.options.maxBytes;
    const maximumOffset = entry.records.reduce((maximum, record) => Math.max(maximum, record.body.length), 0);
    const page = { ...result.structuredContent.page, nextCursor: this.token(entry, entry.records.length, maximumOffset), remainingItems: entry.records.length };
    for (const record of entry.records) {
      const header = JSON.parse(record.header);
      const measured = item => size(responseResult({ ...result.structuredContent, items: [item], page }));
      if (record.body.length * 2 <= limit && measured({ ...header, item: JSON.parse(record.body.toString('utf8')) }) <= limit) continue;
      // Reserve maximum offset/token widths and one four-byte code point before issuing any cursor.
      const required = measured({ ...header, fragment: { encoding: 'json', offsetBytes: record.body.length, totalBytes: record.body.length, text: '🧑' } });
      if (required > limit) throw oversize(required, limit);
    }
    if (entry.bytes > this.maxCacheBytes) throw oversize(entry.bytes, this.maxCacheBytes);
    this.prune();
    while (this.cacheBytes + entry.bytes > this.maxCacheBytes) this.remove(this.snapshots.keys().next().value);
    this.snapshots.set(entry.id, entry);
    this.cacheBytes += entry.bytes;
    return result;
  }
  render(entry, startIndex, startOffset) {
    const metadata = JSON.parse(entry.metadata);
    const limit = metadata.appliedResponsePreferences.delivery.options.maxBytes;
    const envelope = (items, index, offset) => {
      const complete = index === entry.records.length;
      return responseResult({ ...metadata, ...(metadata.deliveryId && !complete ? { nextAction: 'wait_codex_reply' } : {}), items, page: {
        complete, nextCursor: complete ? null : this.token(entry, index, offset), remainingItems: entry.records.length - index,
        expiresAt: complete ? null : new Date(entry.expires).toISOString(),
      } });
    };
    let index = startIndex, offset = startOffset;
    const items = [];
    let result = envelope(items, index, offset);
    if (index === entry.records.length && size(result) > limit) throw oversize(size(result), limit);
    while (index < entry.records.length) {
      const record = entry.records[index], header = JSON.parse(record.header);
      if (!offset) {
        const complete = { ...header, item: JSON.parse(record.body.toString('utf8')) };
        const candidate = envelope([...items, complete], index + 1, 0);
        if (size(candidate) <= limit) { items.push(complete); index++; result = candidate; continue; }
        if (items.length && size(envelope([complete], index + 1, 0)) <= limit) break;
      }
      const fragmentAt = end => ({ ...header, fragment: { encoding: 'json', offsetBytes: offset, totalBytes: record.body.length, text: record.body.subarray(offset, end).toString('utf8') } });
      const candidateAt = end => envelope([...items, fragmentAt(end)], end === record.body.length ? index + 1 : index, end === record.body.length ? 0 : end);
      let low = offset + 1, high = record.body.length, best = offset;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        let end = middle;
        while (end > offset && end < record.body.length && (record.body[end] & 0xc0) === 0x80) end--;
        if (end > offset && size(candidateAt(end)) <= limit) { best = Math.max(best, end); low = middle + 1; }
        else if (end === offset) low = middle + 1;
        else high = middle - 1;
      }
      if (best === offset) {
        if (!items.length) throw oversize(size(candidateAt(Math.min(record.body.length, offset + 4))), limit);
        break;
      }
      items.push(fragmentAt(best));
      if (best === record.body.length) { index++; offset = 0; } else offset = best;
      result = envelope(items, index, offset);
      if (offset) break;
    }
    return result;
  }
}
