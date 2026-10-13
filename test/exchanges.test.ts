import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { HashEmbeddingProvider } from '../src/embed/hash.js';
import type { EmbeddingProvider } from '../src/embed/provider.js';
import { testMemory } from './helpers.js';

const input = { userId: 'u', sessionId: 's', requestId: 'request1', question: 'We chose PostgreSQL.', answer: 'Noted.' };
const dbPath = () => join(mkdtempSync(join(tmpdir(), 'memlayer-outbox-')), 'memory.sqlite');

describe('durable exchange outbox', () => {
  it('acknowledges without calling embeddings and supports scoped read-your-writes', async () => {
    const embed: EmbeddingProvider = new HashEmbeddingProvider(128);
    const embedding = vi.spyOn(embed, 'embedDocuments');
    const memory = await testMemory({ embeddings: embed });
    try {
      const e = await memory.commitExchange('t', { ...input, topic: 'database', entities: ['PostgreSQL'], createdAt: 100 });
      expect(embedding).not.toHaveBeenCalled();
      expect(memory.indexingStatus()).toEqual({ pending: 1 });
      expect(await memory.searchExchanges('t', { userId: 'u', query: 'PostgreSQL', topic: 'database', entity: 'PostgreSQL', since: 100, until: 100 })).toEqual([e]);
      for (const query of [{ userId: 'other' }, { userId: 'u', sessionId: 'other' }, { userId: 'u', topic: 'other' }, { userId: 'u', since: 101 }])
        expect(await memory.searchExchanges('t', query)).toEqual([]);
      expect(await memory.searchExchanges('other', { userId: 'u' })).toEqual([]);
      await memory.commitExchange('t', { ...input, requestId: 'unicode', question: 'আমার নাম অমিতাভ' });
      expect((await memory.searchExchanges('t', { userId: 'u', query: 'অমিতাভ' }))[0]?.requestId).toBe('unicode');
      expect(await memory.drainIndexing()).toEqual({ indexed: 2, failed: 0, stale: 0 });
      expect((await memory.searchKnowledge('t', { query: 'PostgreSQL', userId: 'u', mode: 'bm25' }))[0]?.source).toBe(`chat:${e.id}`);
      expect(await memory.searchKnowledge('t', { query: 'PostgreSQL', userId: 'other', mode: 'bm25' })).toEqual([]);
      expect(await memory.drainIndexing()).toEqual({ indexed: 0, failed: 0, stale: 0 });
    } finally { await memory.close(); }
  });

  it('persists retryable jobs across restart and rejects conflicting idempotency payloads', async () => {
    const databasePath = dbPath();
    const embed: EmbeddingProvider = new HashEmbeddingProvider(128);
    vi.spyOn(embed, 'embedDocuments').mockRejectedValue(new Error('temporary provider failure'));
    let memory = await testMemory({ databasePath, embeddings: embed });
    const e = await memory.commitExchange('t', input);
    expect((await memory.commitExchange('t', input)).id).toBe(e.id);
    await expect(memory.commitExchange('t', { ...input, answer: 'different' })).rejects.toThrow(/Idempotency/);
    expect(await memory.listEpisodes('t', { userId: 'u' })).toHaveLength(1);
    expect(await memory.drainIndexing()).toEqual({ indexed: 0, failed: 1, stale: 0 });
    await memory.close();
    memory = await testMemory({ databasePath });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try {
      expect((await memory.searchExchanges('t', { userId: 'u', query: 'PostgreSQL' }))[0]?.id).toBe(e.id);
      expect(await memory.drainIndexing()).toEqual({ indexed: 1, failed: 0, stale: 0 });
      expect(memory.indexingStatus()).toEqual({ done: 1 });
    } finally { clock.mockRestore(); await memory.close(); }
  });

  it('rolls back raw text, lexical index and episode if queuing fails', async () => {
    const databasePath = dbPath();
    const memory = await testMemory({ databasePath });
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TRIGGER fail_queue BEFORE INSERT ON indexing_jobs BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END;`);
    try {
      await expect(memory.commitExchange('t', input)).rejects.toThrow('injected queue failure');
      expect(await memory.searchExchanges('t', { userId: 'u', query: 'PostgreSQL' })).toEqual([]);
      expect(await memory.listEpisodes('t', { userId: 'u' })).toEqual([]);
      expect(db.prepare('SELECT count(*) AS n FROM exchange_fts').get()?.n).toBe(0);
    } finally { db.close(); await memory.close(); }
  });

  it('fences a late worker after its lease is reclaimed', async () => {
    const databasePath = dbPath();
    const embed: EmbeddingProvider = new HashEmbeddingProvider(128);
    let release!: (value: Float32Array[]) => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(embed, 'embedDocuments').mockImplementation(texts => {
      started();
      const vectors = new HashEmbeddingProvider(128).embedDocuments(texts);
      return new Promise(resolve => { release = () => resolve(vectors); });
    });
    const first = await testMemory({ databasePath, embeddings: embed });
    const second = await testMemory({ databasePath });
    await first.commitExchange('t', input);
    const pending = first.drainIndexing({ leaseMs: 100 });
    await start;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 200);
    try {
      expect(await second.drainIndexing()).toEqual({ indexed: 1, failed: 0, stale: 0 });
      release([]);
      expect(await pending).toEqual({ indexed: 0, failed: 0, stale: 1 });
      const db = new DatabaseSync(databasePath);
      try { expect(db.prepare('SELECT count(*) AS n FROM documents').get()?.n).toBe(1); }
      finally { db.close(); }
    } finally { clock.mockRestore(); await first.close(); await second.close(); }
  });

  it('rolls back indexed documents when job completion fails and safely retries', async () => {
    const databasePath = dbPath();
    const memory = await testMemory({ databasePath });
    const db = new DatabaseSync(databasePath);
    await memory.commitExchange('t', input);
    db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE ON indexing_jobs WHEN NEW.state='done'
      BEGIN SELECT RAISE(ABORT, 'injected completion failure'); END;`);
    try {
      expect((await memory.drainIndexing()).failed).toBe(1);
      expect(db.prepare('SELECT count(*) AS n FROM documents').get()?.n).toBe(0);
      db.exec('DROP TRIGGER fail_completion');
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
      try { expect((await memory.drainIndexing()).indexed).toBe(1); }
      finally { clock.mockRestore(); }
      expect(db.prepare('SELECT count(*) AS n FROM documents').get()?.n).toBe(1);
    } finally { db.close(); await memory.close(); }
  });

  it('does not write a late embedding result after close', async () => {
    const databasePath = dbPath();
    const embed: EmbeddingProvider = new HashEmbeddingProvider(128);
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    vi.spyOn(embed, 'embedDocuments').mockImplementation(texts => {
      started();
      const vectors = new HashEmbeddingProvider(128).embedDocuments(texts);
      return new Promise(resolve => { release = () => resolve(vectors); });
    });
    const memory = await testMemory({ databasePath, embeddings: embed });
    await memory.commitExchange('t', input);
    const pending = memory.drainIndexing();
    await start;
    await memory.close();
    release();
    expect((await pending).stale).toBe(1);
    const db = new DatabaseSync(databasePath);
    try { expect(db.prepare('SELECT count(*) AS n FROM documents').get()?.n).toBe(0); }
    finally { db.close(); }
  });
});
