import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryRedis } from '../src/redis/memory.js';
import { HashEmbeddingProvider } from '../src/embed/hash.js';
import { tokenize } from '../src/text.js';
import { testMemory } from './helpers.js';

describe('cross-instance consistency', () => {
  it('preserves concurrent working writes after both readers cached an empty session', async () => {
    const redis = new MemoryRedis();
    const services = await Promise.all(Array.from({ length: 3 }, () => testMemory({ redis })));
    try {
      await Promise.all(services.map(m => m.getWorkingMemory('acme', 'shared')));
      await Promise.all(Array.from({ length: 12 }, (_, i) =>
        services[i % 2]!.appendTurn('acme', 'shared', { role: 'user', content: `turn-${i}` })));
      const turns = (await services[2]!.getWorkingMemory('acme', 'shared')).turns;
      expect(turns).toHaveLength(12);
      expect(new Set(turns.map(t => t.content)).size).toBe(12);
      expect((await services[0]!.getWorkingMemory('acme', 'shared')).turns).toHaveLength(12);
    } finally { await Promise.all(services.map(m => m.close())); }
  });

  it('refreshes profile snapshots and knowledge indexes without restarting another instance', async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), 'memlayer-consistency-')), 'memory.sqlite');
    const redis = new MemoryRedis();
    const first = await testMemory({ databasePath, redis });
    const second = await testMemory({ databasePath, redis });
    try {
      await second.getProfile('acme', 'user');
      expect(await second.searchKnowledge('acme', { query: 'freshmarker', mode: 'bm25' })).toEqual([]);
      await Promise.all([
        first.setProfileFact('acme', 'user', { key: 'locale', type: 'string', value: 'bn' }),
        second.setProfileFact('acme', 'user', { key: 'style', type: 'string', value: 'concise' }),
      ]);
      expect((await first.getProfile('acme', 'user')).facts).toHaveLength(2);
      expect((await second.getProfile('acme', 'user')).facts).toHaveLength(2);
      await first.forgetFact('acme', 'user', 'style');
      expect((await second.getProfile('acme', 'user')).facts.map(f => f.key)).toEqual(['locale']);
      const doc = await first.ingestDocument('acme', { title: 'Fresh', text: 'freshmarker newly committed evidence' });
      expect((await second.searchKnowledge('acme', { query: 'freshmarker', mode: 'bm25' }))[0]?.documentId).toBe(doc.documentId);
      expect(await second.searchKnowledge('other', { query: 'freshmarker', mode: 'bm25' })).toEqual([]);
    } finally { await first.close(); await second.close(); }
  });

  it('preserves Indic letters and combining marks and retrieves Unicode evidence', async () => {
    expect(tokenize('আমার নাম অমিতাভ')).toEqual(['আমার', 'নাম', 'অমিতাভ']);
    expect(tokenize('मेरा नाम अमिताभ')).toEqual(['मेरा', 'नाम', 'अमिताभ']);
    expect(tokenize('ＣＡＦÉ')).toEqual(['café']);
    const memory = await testMemory();
    try {
      await memory.ingestDocument('acme', { title: 'নাম', text: 'আমার নাম অমিতাভ' });
      expect((await memory.searchKnowledge('acme', { query: 'অমিতাভ', mode: 'bm25' }))[0]?.text).toContain('অমিতাভ');
    } finally { await memory.close(); }
  });

  it('keeps legacy hash vectors compatible and versions Unicode features explicitly', () => {
    const legacy = new HashEmbeddingProvider(128);
    const unicode = new HashEmbeddingProvider(128, 'v2');
    expect(legacy.id).toBe('hashing-trick-v1');
    expect(unicode.id).toBe('hashing-trick-v2');
    expect(legacy.embedQuery('CAFÉ')).toEqual(legacy.embedQuery('caf'));
    expect(unicode.embedQuery('ＣＡＦÉ')).toEqual(unicode.embedQuery('café'));
    expect(unicode.embedQuery('আমার নাম')).not.toEqual(legacy.embedQuery('আমার নাম'));
  });
});
