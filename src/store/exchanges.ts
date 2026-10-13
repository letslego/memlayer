import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Exchange, ExchangeInput, ExchangeQuery } from '../types.js';
import { tokenize } from '../text.js';
import type { ConversationAnnotations } from '../knowledge/conversation.js';

export const EXCHANGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS exchanges (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 session_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 question TEXT NOT NULL, answer TEXT NOT NULL, topic TEXT, entities_json TEXT NOT NULL,
 created_at INTEGER NOT NULL, UNIQUE(tenant_id,user_id,session_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_exchange_owner_time ON exchanges(tenant_id,user_id,created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS exchange_fts USING fts5(exchange_id UNINDEXED, question, answer);
CREATE TABLE IF NOT EXISTS exchange_annotations (
 exchange_id TEXT PRIMARY KEY REFERENCES exchanges(id), extractor_id TEXT NOT NULL,
 annotations_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS annotation_fts USING fts5(exchange_id UNINDEXED, labels);
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
      if (value !== undefined) {
        if (column === 'topic') {
          clauses.push(`(e.topic=? OR EXISTS(SELECT 1 FROM exchange_annotations a,json_each(a.annotations_json,'$.topics') t WHERE a.exchange_id=e.id AND json_extract(t.value,'$.key')=?))`);
          params.push(value, value);
        } else { clauses.push(`e.${column}=?`); params.push(value); }
      }
    }
    if (query.since !== undefined) { clauses.push('e.created_at>=?'); params.push(query.since); }
    if (query.until !== undefined) { clauses.push('e.created_at<=?'); params.push(query.until); }
    if (query.entity !== undefined) {
      clauses.push(`(EXISTS(SELECT 1 FROM json_each(e.entities_json) WHERE value=?) OR EXISTS(
        SELECT 1 FROM exchange_annotations a,json_each(a.annotations_json,'$.entities') n
        WHERE a.exchange_id=e.id AND json_extract(n.value,'$.label')=?))`); params.push(query.entity, query.entity);
    }
    const baseClauses = [...clauses];
    const baseParams = [...params];
    if (terms.length) { clauses.push('exchange_fts MATCH ?'); params.push(terms.map(t => `"${t}"`).join(' OR ')); }
    const join = terms.length ? 'JOIN exchange_fts ON exchange_fts.exchange_id=e.id' : '';
    const order = terms.length ? 'bm25(exchange_fts), e.created_at DESC, e.rowid DESC' : 'e.created_at DESC, e.rowid DESC';
    const raw = this.db.prepare(`SELECT e.* FROM exchanges e ${join} WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...params, query.limit ?? 10).map(row => this.map(row));
    if (!terms.length || raw.length >= (query.limit ?? 10)) return raw;
    const routed = this.db.prepare(`SELECT e.* FROM exchanges e JOIN annotation_fts ON annotation_fts.exchange_id=e.id
      WHERE ${baseClauses.join(' AND ')} AND annotation_fts MATCH ? ORDER BY bm25(annotation_fts),e.created_at DESC,e.rowid DESC LIMIT ?`)
      .all(...baseParams, terms.map(t => `"${t}"`).join(' OR '), query.limit ?? 10).map(row => this.map(row));
    const seen = new Set(raw.map(e => e.id));
    return [...raw, ...routed.filter(e => !seen.has(e.id))].slice(0, query.limit ?? 10);
  }

  annotate(exchange: Exchange, annotations: ConversationAnnotations, extractorId: string): void {
    this.db.prepare(`INSERT INTO exchange_annotations VALUES(?,?,?,?) ON CONFLICT(exchange_id)
      DO UPDATE SET extractor_id=excluded.extractor_id,annotations_json=excluded.annotations_json,created_at=excluded.created_at`)
      .run(exchange.id, extractorId, JSON.stringify(annotations), Date.now());
    this.db.prepare('DELETE FROM annotation_fts WHERE exchange_id=?').run(exchange.id);
    this.db.prepare('INSERT INTO annotation_fts(exchange_id,labels) VALUES(?,?)').run(exchange.id,
      [...annotations.topics.flatMap(t => [t.key, t.label]), ...annotations.entities.map(e => e.label)].join(' '));
  }

  read(tenantId: string, userId: string, exchangeId: string): Exchange | null {
    const row = this.db.prepare('SELECT * FROM exchanges WHERE tenant_id=? AND user_id=? AND id=?').get(tenantId, userId, exchangeId);
    return row ? this.map(row) : null;
  }

  unannotated(tenantId: string, userId: string, limit: number): Exchange[] {
    return this.db.prepare(`SELECT e.* FROM exchanges e LEFT JOIN exchange_annotations a ON a.exchange_id=e.id
      WHERE e.tenant_id=? AND e.user_id=? AND a.exchange_id IS NULL ORDER BY e.rowid LIMIT ?`)
      .all(tenantId, userId, limit).map(row => this.map(row));
  }

  hierarchy(tenantId: string, userId: string, limit: number, sessionId?: string) {
    const condition = sessionId === undefined ? '' : ' AND e.session_id=?';
    const params = sessionId === undefined ? [tenantId, userId] : [tenantId, userId, sessionId];
    const rows = this.db.prepare(`SELECT e.*,a.annotations_json,a.extractor_id FROM exchanges e
      LEFT JOIN exchange_annotations a ON a.exchange_id=e.id WHERE e.tenant_id=? AND e.user_id=?${condition}
      ORDER BY e.created_at DESC,e.rowid DESC LIMIT ?`).all(...params, limit + 1);
    const sessions = new Map<string, Map<string, { key: string; label: string; leaves: Array<{
      exchangeId: string; occurredAt: number; extractorId: string | null; support: Array<{ role: 'user' | 'assistant'; quote: string }>;
    }> }>>();
    for (const row of rows.slice(0, limit)) {
      const e = this.map(row);
      const annotations = row.annotations_json ? JSON.parse(String(row.annotations_json)) as ConversationAnnotations : { topics: [], entities: [] };
      const topics = annotations.topics.length ? annotations.topics : [{ key: e.topic ?? 'unclassified', label: e.topic ?? 'Unclassified', role: 'user' as const, quote: e.question.slice(0, 300) }];
      let session = sessions.get(e.sessionId);
      if (!session) { session = new Map(); sessions.set(e.sessionId, session); }
      for (const topic of topics) {
        let node = session.get(topic.key);
        if (!node) { node = { key: topic.key, label: topic.label, leaves: [] }; session.set(topic.key, node); }
        node.leaves.push({ exchangeId: e.id, occurredAt: e.createdAt,
          extractorId: row.extractor_id ? String(row.extractor_id) : null, support: [{ role: topic.role, quote: topic.quote }] });
      }
    }
    return { tenantId, userId, truncated: rows.length > limit,
      sessions: [...sessions].map(([id, topics]) => ({ sessionId: id, topics: [...topics.values()] })) };
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
