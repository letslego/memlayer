import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Acl, AuditEvent, CapBucket, ControlScope, Episode, KillSwitchState, ProfileFact } from '../types.js';
import { bytesToVector, vectorToBytes } from '../vector.js';
import { isFactType, jsonClone, parseAclJson, parseJsonObject } from '../validate.js';

export interface StoredChunk {
  id: string;
  tenantId: string;
  documentId: string;
  title: string;
  source: string | null;
  ordinal: number;
  text: string;
  tokenEstimate: number;
  vector: Float32Array;
  acl: Acl;
}

export interface NewChunk {
  id: string;
  ordinal: number;
  text: string;
  tokenEstimate: number;
  vector: Float32Array;
}

export interface NewDocument {
  id: string;
  tenantId: string;
  title: string;
  source: string | null;
  acl: Acl;
  metadata: Record<string, string | number | boolean | null>;
  createdAt: number;
  chunks: NewChunk[];
}

interface CapRow {
  scope: ControlScope;
  targetId: string;
  maxSteps: number | null;
  maxSpendUnits: number | null;
  stepsUsed: number;
  spendUsed: number;
}

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_facts (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, fact_key)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT,
  acl_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents(tenant_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  vector BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON chunks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  episode_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_user_time ON episodes(tenant_id, user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodes_tenant_time ON episodes(tenant_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  session_id TEXT,
  action TEXT NOT NULL,
  tool_name TEXT,
  detail_json TEXT NOT NULL,
  cost_units REAL NOT NULL,
  steps INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_log(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS control_caps (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL,
  max_steps INTEGER,
  max_spend_units REAL,
  steps_used INTEGER NOT NULL DEFAULT 0,
  spend_used REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, scope, target_id)
);

CREATE TABLE IF NOT EXISTS kill_switches (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, scope, target_id)
);
`;

export class DurableStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 2000;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec(SCHEMA);
  }

  ping(): number {
    const row = rowOf(this.db.prepare('SELECT 1 AS ok').get());
    return num(row, 'ok');
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The connection may already be rolled back.
      }
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    if (!row) return null;
    return str(rowOf(row), 'value');
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  loadFacts(tenantId: string, userId: string): ProfileFact[] {
    const rows = this.db
      .prepare(
        `SELECT fact_key, fact_type, value_json, updated_at
         FROM profile_facts WHERE tenant_id = ? AND user_id = ?
         ORDER BY fact_key`,
      )
      .all(tenantId, userId);
    return rows.map((raw) => {
      const row = rowOf(raw);
      const type = str(row, 'fact_type');
      if (!isFactType(type)) throw new Error(`Corrupt fact type for ${str(row, 'fact_key')}`);
      return {
        key: str(row, 'fact_key'),
        type,
        value: JSON.parse(str(row, 'value_json')) as unknown,
        updatedAt: num(row, 'updated_at'),
      };
    });
  }

  upsertFact(tenantId: string, userId: string, fact: ProfileFact): void {
    this.db
      .prepare(
        `INSERT INTO profile_facts(tenant_id, user_id, fact_key, fact_type, value_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, user_id, fact_key) DO UPDATE SET
           fact_type = excluded.fact_type,
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(tenantId, userId, fact.key, fact.type, jsonClone(fact.value), fact.updatedAt);
  }

  deleteFact(tenantId: string, userId: string, key: string): void {
    this.db
      .prepare('DELETE FROM profile_facts WHERE tenant_id = ? AND user_id = ? AND fact_key = ?')
      .run(tenantId, userId, key);
  }

  insertDocument(doc: NewDocument): void {
    const insertDoc = this.db.prepare(
      `INSERT INTO documents(id, tenant_id, title, source, acl_json, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks(id, tenant_id, document_id, ordinal, text, token_estimate, vector, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      insertDoc.run(
        doc.id,
        doc.tenantId,
        doc.title,
        doc.source,
        JSON.stringify(doc.acl),
        JSON.stringify(doc.metadata),
        doc.createdAt,
      );
      for (const chunk of doc.chunks) {
        insertChunk.run(
          chunk.id,
          doc.tenantId,
          doc.id,
          chunk.ordinal,
          chunk.text,
          chunk.tokenEstimate,
          vectorToBytes(chunk.vector),
          doc.createdAt,
        );
      }
    });
  }

  listChunks(): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS id, c.tenant_id AS tenant_id, c.document_id AS document_id,
                c.ordinal AS ordinal, c.text AS text, c.token_estimate AS token_estimate,
                c.vector AS vector, d.title AS title, d.source AS source, d.acl_json AS acl_json
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         ORDER BY c.tenant_id, c.created_at, c.ordinal, c.id`,
      )
      .all();
    return rows.map((raw) => {
      const row = rowOf(raw);
      const vectorRaw = row.vector;
      if (!(vectorRaw instanceof Uint8Array)) throw new Error('Corrupt vector blob');
      return {
        id: str(row, 'id'),
        tenantId: str(row, 'tenant_id'),
        documentId: str(row, 'document_id'),
        title: str(row, 'title'),
        source: strOrNull(row, 'source'),
        ordinal: num(row, 'ordinal'),
        text: str(row, 'text'),
        tokenEstimate: num(row, 'token_estimate'),
        vector: bytesToVector(vectorRaw),
        acl: parseAclJson(str(row, 'acl_json')),
      };
    });
  }

  insertEpisode(episode: Episode): void {
    this.db
      .prepare(
        `INSERT INTO episodes(id, tenant_id, user_id, session_id, episode_type, summary, payload_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        episode.id,
        episode.tenantId,
        episode.userId,
        episode.sessionId,
        episode.type,
        episode.summary,
        JSON.stringify(episode.payload),
        episode.occurredAt,
      );
  }

  listEpisodes(
    tenantId: string,
    filter: {
      userId?: string;
      sessionId?: string;
      type?: string;
      since?: number;
      until?: number;
      limit: number;
    },
  ): Episode[] {
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [tenantId];
    if (filter.userId) {
      clauses.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter.type) {
      clauses.push('episode_type = ?');
      params.push(filter.type);
    }
    if (filter.since !== undefined) {
      clauses.push('occurred_at >= ?');
      params.push(filter.since);
    }
    if (filter.until !== undefined) {
      clauses.push('occurred_at <= ?');
      params.push(filter.until);
    }
    params.push(filter.limit);
    const sql = `SELECT id, tenant_id, user_id, session_id, episode_type, summary, payload_json, occurred_at
      FROM episodes WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_at DESC, id DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...params)
      .map((raw) => mapEpisode(rowOf(raw)));
  }

  insertAudit(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_log(id, tenant_id, user_id, session_id, action, tool_name, detail_json, cost_units, steps, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.tenantId,
        event.userId,
        event.sessionId,
        event.action,
        event.toolName,
        JSON.stringify(event.detail),
        event.costUnits,
        event.steps,
        event.createdAt,
      );
  }

  listAudit(
    tenantId: string,
    filter: { userId?: string; sessionId?: string; limit: number },
  ): AuditEvent[] {
    const clauses = ['tenant_id = ?'];
    const params: Array<string | number> = [tenantId];
    if (filter.userId) {
      clauses.push('user_id = ?');
      params.push(filter.userId);
    }
    if (filter.sessionId) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    params.push(filter.limit);
    const sql = `SELECT id, tenant_id, user_id, session_id, action, tool_name, detail_json, cost_units, steps, created_at
      FROM audit_log WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    return this.db
      .prepare(sql)
      .all(...params)
      .map((raw) => mapAudit(rowOf(raw)));
  }

  getCap(tenantId: string, scope: ControlScope, targetId: string): CapRow | null {
    const raw = this.db
      .prepare(
        `SELECT scope, target_id, max_steps, max_spend_units, steps_used, spend_used
         FROM control_caps WHERE tenant_id = ? AND scope = ? AND target_id = ?`,
      )
      .get(tenantId, scope, targetId);
    if (!raw) return null;
    return mapCap(rowOf(raw));
  }

  upsertCapLimits(
    tenantId: string,
    scope: ControlScope,
    targetId: string,
    maxSteps: number | null,
    maxSpendUnits: number | null,
    updatedAt: number,
  ): CapBucket {
    this.db
      .prepare(
        `INSERT INTO control_caps(tenant_id, scope, target_id, max_steps, max_spend_units, steps_used, spend_used, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?)
         ON CONFLICT(tenant_id, scope, target_id) DO UPDATE SET
           max_steps = excluded.max_steps,
           max_spend_units = excluded.max_spend_units,
           updated_at = excluded.updated_at`,
      )
      .run(tenantId, scope, targetId, maxSteps, maxSpendUnits, updatedAt);
    const row = this.getCap(tenantId, scope, targetId);
    if (!row) throw new Error('cap row missing after upsert');
    return row;
  }

  addUsage(
    tenantId: string,
    scope: ControlScope,
    targetId: string,
    steps: number,
    spend: number,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO control_caps(tenant_id, scope, target_id, max_steps, max_spend_units, steps_used, spend_used, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT(tenant_id, scope, target_id) DO UPDATE SET
           steps_used = steps_used + excluded.steps_used,
           spend_used = spend_used + excluded.spend_used,
           updated_at = excluded.updated_at`,
      )
      .run(tenantId, scope, targetId, steps, spend, updatedAt);
  }

  getKillSwitch(tenantId: string, scope: ControlScope, targetId: string): KillSwitchState | null {
    const raw = this.db
      .prepare(
        `SELECT scope, target_id, enabled, reason, updated_at
         FROM kill_switches WHERE tenant_id = ? AND scope = ? AND target_id = ?`,
      )
      .get(tenantId, scope, targetId);
    if (!raw) return null;
    return mapKill(rowOf(raw));
  }

  upsertKillSwitch(state: KillSwitchState & { tenantId: string }): void {
    this.db
      .prepare(
        `INSERT INTO kill_switches(tenant_id, scope, target_id, enabled, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, scope, target_id) DO UPDATE SET
           enabled = excluded.enabled,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.tenantId,
        state.scope,
        state.targetId,
        state.enabled ? 1 : 0,
        state.reason,
        state.updatedAt,
      );
  }
}

function mapEpisode(row: Row): Episode {
  return {
    id: str(row, 'id'),
    tenantId: str(row, 'tenant_id'),
    userId: str(row, 'user_id'),
    sessionId: strOrNull(row, 'session_id'),
    type: str(row, 'episode_type'),
    summary: str(row, 'summary'),
    payload: parseJsonObject(str(row, 'payload_json'), 'episode payload'),
    occurredAt: num(row, 'occurred_at'),
  };
}

function mapAudit(row: Row): AuditEvent {
  return {
    id: str(row, 'id'),
    tenantId: str(row, 'tenant_id'),
    userId: strOrNull(row, 'user_id'),
    sessionId: strOrNull(row, 'session_id'),
    action: str(row, 'action'),
    toolName: strOrNull(row, 'tool_name'),
    detail: parseJsonObject(str(row, 'detail_json'), 'audit detail'),
    costUnits: num(row, 'cost_units'),
    steps: num(row, 'steps'),
    createdAt: num(row, 'created_at'),
  };
}

function mapCap(row: Row): CapRow {
  const scope = str(row, 'scope');
  if (scope !== 'tenant' && scope !== 'user' && scope !== 'session') {
    throw new Error('Corrupt cap scope');
  }
  return {
    scope,
    targetId: str(row, 'target_id'),
    maxSteps: numOrNull(row, 'max_steps'),
    maxSpendUnits: numOrNull(row, 'max_spend_units'),
    stepsUsed: num(row, 'steps_used'),
    spendUsed: num(row, 'spend_used'),
  };
}

function mapKill(row: Row): KillSwitchState {
  const scope = str(row, 'scope');
  if (scope !== 'tenant' && scope !== 'user' && scope !== 'session') {
    throw new Error('Corrupt kill-switch scope');
  }
  return {
    scope,
    targetId: str(row, 'target_id'),
    enabled: num(row, 'enabled') !== 0,
    reason: strOrNull(row, 'reason'),
    updatedAt: num(row, 'updated_at'),
  };
}

function rowOf(value: unknown): Row {
  if (value && typeof value === 'object') return value as Row;
  throw new Error('Expected SQL row');
}

function str(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  throw new Error(`Expected string column ${key}`);
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new Error(`Expected string column ${key}`);
}

function num(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Expected number column ${key}`);
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Expected number column ${key}`);
}
