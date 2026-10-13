import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Exchange, ExchangeInput, ExchangeQuery } from '../types.js';
import { tokenize } from '../text.js';

export const EXCHANGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS exchanges (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 session_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 question TEXT NOT NULL, answer TEXT NOT NULL, topic TEXT, entities_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(tenant_id,user_id,session_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_exchange_owner_time ON exchanges(tenant_id,user_id,created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS exchange_fts USING fts5(exchange_id UNINDEXED, question, answer);
CREATE TABLE IF NOT EXISTS indexing_jobs (
 exchange_id TEXT PRIMARY KEY REFERENCES exchanges(id), state TEXT NOT NULL DEFAULT 'pending',
 attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL DEFAULT 0,
 owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0, document_id TEXT, error_code TEXT
);`;

export interface IndexingJob { exchange: Exchange; owner: string; attempts: number }

/** Synchronous SQLite journal; callers own transactions around multi-table operations. */
export class ExchangeJournal {
  constructor(private readonly db: DatabaseSync) {}

  commit(tenantId: string, input: ExchangeInput): Exchange {
    const fingerprint = createHash('sha256').update(JSON.stringify([
      input.question, input.answer, input.topic ?? null, input.entities ?? [], input.createdAt ?? null,
    ])).digest('hex');
    const existing = this.db.prepare(`SELECT * FROM exchanges WHERE tenant_id=? AND user_id=? AND session_id=? AND request_id=?`)
      .get(tenantId, input.userId, input.sessionId, input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('Idempotency key reused with a different exchange');
      return this.map(existing);
    }
    const id = `ex_${randomUUID()}`;
    const createdAt = input.createdAt ?? Date.now();
    this.db.prepare(`INSERT INTO exchanges(id,tenant_id,user_id,session_id,request_id,fingerprint,question,answer,topic,entities_json,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, tenantId, input.userId, input.sessionId, input.requestId, fingerprint,
      input.question, input.answer, input.topic ?? null, JSON.stringify(input.entities ?? []), createdAt);
    this.db.prepare('INSERT INTO exchange_fts(exchange_id,question,answer) VALUES(?,?,?)').run(id, input.question, input.answer);
    this.db.prepare('INSERT INTO indexing_jobs(exchange_id) VALUES(?)').run(id);
    this.db.prepare(`INSERT INTO episodes VALUES(?,?,?,?,?,?,?,?)`).run(
      `ep_${id}`, tenantId, input.userId, input.sessionId, 'chat_exchange', input.question.slice(0, 500),
      JSON.stringify({ exchangeId: id }), createdAt);
    return this.get(id);
  }

  search(tenantId: string, query: ExchangeQuery): Exchange[] {
    const terms = tokenize(query.query ?? '').slice(0, 32);
    if (query.query?.trim() && !terms.length) return [];
    const clauses = ['e.tenant_id=?', 'e.user_id=?'];
    const params: Array<string | number> = [tenantId, query.userId];
    for (const [column, value] of [['session_id', query.sessionId], ['topic', query.topic]] as const) {
      if (value !== undefined) { clauses.push(`e.${column}=?`); params.push(value); }
    }
    if (query.since !== undefined) { clauses.push('e.created_at>=?'); params.push(query.since); }
    if (query.until !== undefined) { clauses.push('e.created_at<=?'); params.push(query.until); }
    if (query.entity !== undefined) {
      clauses.push('EXISTS(SELECT 1 FROM json_each(e.entities_json) WHERE value=?)'); params.push(query.entity);
    }
    if (terms.length) { clauses.push('exchange_fts MATCH ?'); params.push(terms.map(t => `"${t}"`).join(' OR ')); }
    const join = terms.length ? 'JOIN exchange_fts ON exchange_fts.exchange_id=e.id' : '';
    const order = terms.length ? 'bm25(exchange_fts), e.created_at DESC, e.rowid DESC' : 'e.created_at DESC, e.rowid DESC';
    return this.db.prepare(`SELECT e.* FROM exchanges e ${join} WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...params, query.limit ?? 10).map(row => this.map(row));
  }

  claim(now: number, leaseMs: number): IndexingJob | null {
    const row = this.db.prepare(`SELECT exchange_id FROM indexing_jobs WHERE
      (state='pending' AND available_at<=?) OR (state='running' AND lease_until<=?)
      ORDER BY available_at, exchange_id LIMIT 1`).get(now, now);
    if (!row) return null;
    const owner = randomUUID();
    this.db.prepare(`UPDATE indexing_jobs SET state='running',owner=?,lease_until=?,attempts=attempts+1 WHERE exchange_id=?`)
      .run(owner, now + leaseMs, String(row.exchange_id));
    const job = this.db.prepare('SELECT attempts FROM indexing_jobs WHERE exchange_id=?').get(String(row.exchange_id))!;
    return { exchange: this.get(String(row.exchange_id)), owner, attempts: Number(job.attempts) };
  }

  owns(job: IndexingJob, now: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM indexing_jobs WHERE exchange_id=? AND owner=? AND state='running' AND lease_until>?`)
      .get(job.exchange.id, job.owner, now);
  }

  complete(job: IndexingJob, documentId: string): void {
    this.db.prepare(`UPDATE indexing_jobs SET state='done',document_id=?,owner=NULL,lease_until=0,error_code=NULL WHERE exchange_id=? AND owner=?`)
      .run(documentId, job.exchange.id, job.owner);
  }

  retry(job: IndexingJob): void {
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(job.attempts - 1, 9));
    this.db.prepare(`UPDATE indexing_jobs SET state='pending',available_at=?,owner=NULL,lease_until=0,error_code='embedding_or_index_failure' WHERE exchange_id=? AND owner=? AND state='running'`)
      .run(Date.now() + delay, job.exchange.id, job.owner);
  }

  status(): Record<string, number> {
    return Object.fromEntries(this.db.prepare('SELECT state,count(*) AS count FROM indexing_jobs GROUP BY state').all()
      .map(row => [String(row.state), Number(row.count)]));
  }

  private get(id: string): Exchange { return this.map(this.db.prepare('SELECT * FROM exchanges WHERE id=?').get(id)!); }
  private map(row: Record<string, unknown>): Exchange {
    return { id: String(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id),
      sessionId: String(row.session_id), requestId: String(row.request_id), question: String(row.question),
      answer: String(row.answer), topic: row.topic === null ? null : String(row.topic),
      entities: JSON.parse(String(row.entities_json)) as string[], createdAt: Number(row.created_at) };
  }
}
