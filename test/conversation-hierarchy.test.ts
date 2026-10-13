import { describe, expect, it, vi } from 'vitest';
import { BaseLlm } from '@google/adk';
import type { Context, BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import type { GoogleGenAI } from '@google/genai';
import { LocalConversationEnricher, validateAnnotations } from '../src/knowledge/conversation.js';
import { GeminiConversationEnricher } from '../src/adk/enrichment.js';
import { MemlayerAdapter, runAdkAnswer } from '../src/adk/adapter.js';
import { testAuthorization } from './authorization-helper.js';
import type { Exchange } from '../src/types.js';
import { testMemory } from './helpers.js';

const input = { userId: 'a', sessionId: 'session', requestId: 'r1', question: 'We chose PostgreSQL.', answer: 'Noted.' };
const exchange: Exchange = { ...input, id: 'ex_test', tenantId: 'one', topic: null, entities: [], createdAt: 100 };
const annotations = { topics: [{ key: 'database', label: 'Database decisions', role: 'user' as const, quote: 'PostgreSQL' }], entities: [{ label: 'PostgreSQL', role: 'user' as const, quote: 'PostgreSQL' }] };

class HierarchyModel extends BaseLlm {
  constructor() { super({ model: 'offline-test' }); }
  async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    const responses = request.contents.flatMap(content => content.parts ?? []).flatMap(part => part.functionResponse ? [part.functionResponse] : []);
    const leaf = responses.find(response => response.name === 'read_exchange');
    const tree = responses.find(response => response.name === 'browse_memory');
    if (leaf) {
      if (!JSON.stringify(leaf).includes('We chose PostgreSQL.')) throw new Error('Missing exact raw evidence');
      yield { content: { role: 'model', parts: [{ text: 'PostgreSQL' }] }, turnComplete: true };
    } else if (tree) {
      const id = JSON.stringify(tree).match(/ex_[a-f0-9-]+/)?.[0];
      if (!id) throw new Error('Missing hierarchy leaf');
      yield { content: { role: 'model', parts: [{ functionCall: { id: 'read-1', name: 'read_exchange', args: { exchangeId: id } } }] } };
    } else yield { content: { role: 'model', parts: [{ functionCall: { id: 'browse-1', name: 'browse_memory', args: {} } }] } };
  }
  async connect(): Promise<BaseLlmConnection> { throw new Error('Unused'); }
}

describe('grounded conversation hierarchy', () => {
  it('runs browse-to-leaf retrieval through the real ADK tool runner', async () => {
    const memory = await testMemory();
    try {
      await memory.commitExchange('one', input);
      await memory.drainIndexing();
      const adapter = new MemlayerAdapter(memory, { tenantId: 'one', userId: 'a' }, 'bm25', testAuthorization());
      expect(await runAdkAnswer({ question: 'Which database did we choose?', adapter, model: new HierarchyModel() })).toBe('PostgreSQL');
      expect(await memory.listEpisodes('one', { userId: 'a' })).toHaveLength(1);
    } finally { await memory.close(); }
  });
  it('routes a topic query to exact raw leaves and keeps user/tenant boundaries', async () => {
    const memory = await testMemory();
    try {
      const e = await memory.commitExchange('one', input);
      expect(await memory.searchExchanges('one', { userId: 'a', query: 'database' })).toEqual([]);
      await memory.drainIndexing();
      expect((await memory.searchExchanges('one', { userId: 'a', query: 'database', topic: 'database', entity: 'PostgreSQL' }))[0]?.id).toBe(e.id);
      const tree = await memory.conversationHierarchy('one', 'a');
      expect(tree.sessions[0]?.topics[0]?.key).toBe('database');
      expect(tree.sessions[0]?.topics[0]?.leaves[0]?.support).toEqual([{ role: 'user', quote: 'PostgreSQL' }]);
      expect((await memory.readExchange('one', 'a', e.id))?.question).toBe(input.question);
      expect(await memory.readExchange('one', 'b', e.id)).toBeNull();
      expect(await memory.readExchange('two', 'a', e.id)).toBeNull();
      expect((await memory.conversationHierarchy('one', 'b')).sessions).toEqual([]);
      expect(await memory.searchExchanges('one', { userId: 'b', query: 'database' })).toEqual([]);
      await memory.commitExchange('one', { ...input, requestId: 'unicode', question: 'আমার নাম অমিতাভ' });
      await memory.drainIndexing();
      expect((await memory.searchExchanges('one', { userId: 'a', entity: 'অমিতাভ' }))[0]?.requestId).toBe('unicode');
      await memory.commitExchange('one', { ...input, requestId: 'r2' });
      expect((await memory.conversationHierarchy('one', 'a', { limit: 1 })).truncated).toBe(true);
    } finally { await memory.close(); }
  });

  it('rejects invented quotes, role laundering and unsupported entity labels', () => {
    expect(validateAnnotations(exchange, annotations)).toEqual(annotations);
    expect(() => validateAnnotations(exchange, { ...annotations, topics: [{ ...annotations.topics[0], role: 'assistant' }] })).toThrow('grounded');
    expect(() => validateAnnotations(exchange, { topics: [], entities: [{ label: 'MySQL', role: 'user', quote: 'PostgreSQL' }] })).toThrow('Entity label');
    expect(() => validateAnnotations(exchange, { ...annotations, entitlements: { canWrite: true } })).toThrow();
    const unicode = new LocalConversationEnricher().extract({ ...exchange, question: 'আমার নাম অমিতাভ' });
    expect(unicode.entities.some(e => e.label === 'অমিতাভ')).toBe(true);
  });

  it('falls back safely on poisoned extraction and backfills without re-embedding', async () => {
    const memory = await testMemory({ conversationEnricher: { id: 'poisoned', extract: () => ({ ...annotations,
      topics: [{ ...annotations.topics[0]!, quote: 'invented secret' }] }) } });
    try {
      await memory.commitExchange('one', input);
      expect(await memory.annotateConversationHistory('one', 'a')).toBe(1);
      expect(await memory.annotateConversationHistory('one', 'a')).toBe(0);
      const tree = await memory.conversationHierarchy('one', 'a');
      expect(tree.sessions[0]?.topics[0]?.leaves[0]?.extractorId).toContain(':fallback');
      expect(memory.indexingStatus()).toEqual({ pending: 1 });
      expect((await memory.searchExchanges('one', { userId: 'a', query: 'database' }))[0]?.question).toBe(input.question);
    } finally { await memory.close(); }
  });

  it('checks Gemini entitlement before calls and after responses, with grounded schema validation', async () => {
    let policy = await testAuthorization()();
    const generate = vi.fn(async () => ({ text: JSON.stringify(annotations) }));
    const client = { models: { generateContent: generate } } as unknown as GoogleGenAI;
    const enricher = new GeminiConversationEnricher('gemini-2.5-flash', async () => policy, client);
    expect(await enricher.extract(exchange)).toEqual(annotations);
    policy = { ...policy, entitlements: { ...policy.entitlements, allowedModels: ['offline-test'] } };
    await expect(enricher.extract(exchange)).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(1);
    policy = await testAuthorization()();
    generate.mockImplementation(async () => {
      policy = { ...policy, entitlements: { ...policy.entitlements, capabilities: [], canWrite: false } };
      return { text: JSON.stringify(annotations) };
    });
    await expect(enricher.extract(exchange)).rejects.toThrow('Permission denied');
  });

  it('exposes read-only tools with runtime revocation and bounded historical responses', async () => {
    const memory = await testMemory();
    let policy = await testAuthorization()();
    policy = { ...policy, entitlements: { ...policy.entitlements, maxContextChars: 1000 } };
    const adapter = new MemlayerAdapter(memory, { tenantId: 'one', userId: 'a' }, 'bm25', async () => policy);
    try {
      const e = await memory.commitExchange('one', { ...input, question: 'PostgreSQL '.repeat(1000) });
      const tools = await adapter.tools(true);
      const read = tools.find(t => t.name === 'read_exchange')!;
      const value = await read.runAsync({ args: { exchangeId: e.id }, toolContext: {} as Context });
      expect(JSON.stringify(value).length).toBeLessThanOrEqual(1000);
      expect(JSON.stringify(value)).toContain('truncated');
      policy = { ...policy, entitlements: { ...policy.entitlements, capabilities: ['get_profile'], canWrite: false } };
      expect((await adapter.tools(true)).map(t => t.name)).toEqual(['get_profile']);
      await expect(read.runAsync({ args: { exchangeId: e.id }, toolContext: {} as Context })).rejects.toThrow('Permission denied');
    } finally { await memory.close(); }
  });
});
