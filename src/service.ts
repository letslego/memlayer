import { LRUCache } from 'lru-cache';
import { buildContextPack } from './assemble.js';
import { resolveConfig, type MemoryServiceOptions, type ResolvedConfig } from './config.js';
import { HashEmbeddingProvider } from './embed/hash.js';
import type { EmbeddingProvider } from './embed/provider.js';
import {
  CapExceededError,
  KillSwitchError,
  MemoryError,
  NotFoundError,
  ValidationError,
} from './errors.js';
import { KnowledgeEngine } from './knowledge/engine.js';
import type { RedisClient } from './redis/client.js';
import { createRedisClient } from './redis/create.js';
import { HotCache } from './store/hot.js';
import { DurableStore } from './store/sqlite.js';
import { estimateTokens } from './text.js';
import { withTimeout } from './timeout.js';
import type {
  AssembleOptions,
  AuditEvent,
  AuditFilter,
  AuditInput,
  CallOptions,
  CapBucket,
  CapsInput,
  CapsQuery,
  CapsSnapshot,
  ContextPack,
  ControlScope,
  Episode,
  EpisodeFilter,
  EpisodeInput,
  Exchange,
  ExchangeInput,
  ExchangeQuery,
  FactInput,
  IngestDocumentInput,
  IngestResult,
  KillSwitchInput,
  KillSwitchState,
  KnowledgeHit,
  KnowledgeQuery,
  Profile,
  ProfileFact,
  Turn,
  TurnInput,
  WorkingMemory,
} from './types.js';
import {
  assertFact,
  createId,
  jsonClone,
  pairKey,
  requireFactKey,
  requireId,
  requireLabel,
} from './validate.js';

interface WorkingBlob {
  v: 1;
  turns: Turn[];
}

interface ProfileBlob {
  v: 1;
  facts: ProfileFact[];
}

interface ScopeRef {
  scope: ControlScope;
  targetId: string;
}

class LimitRejection {
  constructor(readonly kind: 'steps' | 'spend') {}
}

export class MemoryService {
  readonly config: ResolvedConfig;
  private readonly redis: RedisClient;
  private readonly ownsRedis: boolean;
  private readonly store: DurableStore;
  private readonly l1: LRUCache<string, WorkingBlob | ProfileBlob>;
  private readonly working: HotCache<WorkingBlob>;
  private readonly profiles: HotCache<ProfileBlob>;
  private readonly knowledge: KnowledgeEngine;
  private readonly embedder: EmbeddingProvider;
  private closed = false;
  private readonly workerStops = new Set<() => void>();

  private constructor(
    config: ResolvedConfig,
    redis: RedisClient,
    ownsRedis: boolean,
    store: DurableStore,
    embedder: EmbeddingProvider,
  ) {
    this.config = config;
    this.redis = redis;
    this.ownsRedis = ownsRedis;
    this.store = store;
    this.embedder = embedder;
    this.l1 = new LRUCache<string, WorkingBlob | ProfileBlob>({
      max: config.l1Max,
      ttl: config.l1TtlMs,
      updateAgeOnGet: true,
    });
    this.working = new HotCache<WorkingBlob>(this.l1 as LRUCache<string, WorkingBlob>, redis, {
      prefix: 'ml:wm:',
      atomic:true,
      ttlSec: config.workingTtlSec,
      empty: () => ({ v: 1, turns: [] }),
      invalidateFirst: false,
      isEmpty: (blob) => blob.turns.length === 0,
    });
    this.profiles = new HotCache<ProfileBlob>(this.l1 as LRUCache<string, ProfileBlob>, redis, {
      prefix: 'ml:pf:',
      version:id=>{const {tenantId,second}=splitPair(id);return this.store.profileRevision(tenantId,second);},
      ttlSec: config.profileTtlSec,
      empty: () => ({ v: 1, facts: [] }),
      invalidateFirst: true,
      isEmpty: (blob) => blob.facts.length === 0,
      loadDurable: (id) => {
        const { tenantId, second } = splitPair(id);
        return { v: 1, facts: this.store.loadFacts(tenantId, second) };
      },
    });
    this.knowledge = new KnowledgeEngine(store, embedder, {
      m: config.hnswM,
      efConstruction: config.hnswEfConstruction,
      efSearch: config.hnswEfSearch,
      seed: config.hnswSeed,
    });
    this.knowledge.loadFromDisk();
  }

  static async open(options: MemoryServiceOptions = {}): Promise<MemoryService> {
    const config = resolveConfig(options);
    const embedder = options.embeddings ?? new HashEmbeddingProvider(config.embeddingDim);
    const ownsRedis = options.redis === undefined;
    const redis = options.redis ?? (await createRedisClient(config.redisUrl, config.redisPoolSize));
    const store = new DurableStore(config.databasePath);
    try {
      assertEmbeddingMeta(store, embedder);
      return new MemoryService(config, redis, ownsRedis, store, embedder);
    } catch (error) {
      store.close();
      if (ownsRedis) await redis.close();
      throw error;
    }
  }

  get stats(): {
    working: HotCache<WorkingBlob>['stats'];
    profile: HotCache<ProfileBlob>['stats'];
    redis: RedisClient['stats'];
    l1Size: number;
  } {
    return {
      working: { ...this.working.stats },
      profile: { ...this.profiles.stats },
      redis: { ...this.redis.stats },
      l1Size: this.l1.size,
    };
  }

  async appendTurn(
    tenantId: string,
    sessionId: string,
    input: TurnInput,
    opts?: CallOptions,
  ): Promise<Turn> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const session = requireId(sessionId, 'sessionId');
    const turn = normalizeTurn(input);
    return this.run(opts, 'appendTurn', async () => {
      await this.working.update(pairKey(tenant, session), (current) => {
        const turns = current.turns.slice();
        turns.push(turn);
        while (turns.length > this.config.workingMaxTurns) turns.shift();
        let tokens = turns.reduce((sum, item) => sum + item.tokenEstimate, 0);
        while (turns.length > 1 && tokens > this.config.workingMaxTokens) {
          const removed = turns.shift();
          tokens -= removed?.tokenEstimate ?? 0;
        }
        return { v: 1, turns };
      });
      return turn;
    });
  }

  async getWorkingMemory(tenantId: string, sessionId: string, opts?: CallOptions): Promise<WorkingMemory> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const session = requireId(sessionId, 'sessionId');
    const id = pairKey(tenant, session);
    const hot = this.working.peek(id);
    if (hot) return viewWorking(tenant, session, hot);
    return this.run(opts, 'getWorkingMemory', async () => viewWorking(tenant, session, await this.working.get(id)));
  }

  async clearSession(tenantId: string, sessionId: string, opts?: CallOptions): Promise<void> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const session = requireId(sessionId, 'sessionId');
    await this.run(opts, 'clearSession', () => this.working.remove(pairKey(tenant, session)));
  }

  async setProfileFact(
    tenantId: string,
    userId: string,
    input: FactInput,
    opts?: CallOptions,
  ): Promise<ProfileFact> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const user = requireId(userId, 'userId');
    assertFact(input);
    const fact: ProfileFact = {
      key: input.key,
      type: input.type,
      value: input.type === 'json' ? JSON.parse(jsonClone(input.value)) : input.value,
      updatedAt: Date.now(),
    };
    return this.run(opts, 'setProfileFact', async () => {
      this.store.transaction(()=>{
        const current=this.store.loadFacts(tenant,user);
        if(!current.some(f=>f.key===fact.key)&&current.length>=this.config.profileFactLimit)throw new ValidationError(`Profile fact limit is ${this.config.profileFactLimit}`);
        this.store.upsertFact(tenant,user,fact);
      });
      return { ...fact };
    });
  }

  async getProfile(tenantId: string, userId: string, opts?: CallOptions): Promise<Profile> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const user = requireId(userId, 'userId');
    const id = pairKey(tenant, user);
    const hot = this.profiles.peek(id);
    if (hot) return viewProfile(tenant, user, hot);
    return this.run(opts, 'getProfile', async () => viewProfile(tenant, user, await this.profiles.get(id)));
  }

  async forgetFact(tenantId: string, userId: string, key: string, opts?: CallOptions): Promise<void> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const user = requireId(userId, 'userId');
    const factKey = requireFactKey(key);
    await this.run(opts,'forgetFact',async()=>this.store.transaction(()=>{
      if(!this.store.loadFacts(tenant,user).some(f=>f.key===factKey))throw new NotFoundError('fact',factKey);
      this.store.deleteFact(tenant,user,factKey);
    }));
  }

  /** Commits raw evidence, lexical index, episode reference and pending job together. */
  async commitExchange(tenantId: string, input: ExchangeInput): Promise<Exchange> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const normalized: ExchangeInput = { ...input,
      userId: requireId(input.userId, 'userId'), sessionId: requireId(input.sessionId, 'sessionId'),
      requestId: requireId(input.requestId, 'requestId') };
    for (const key of ['question', 'answer'] as const) {
      if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 32000)
        throw new ValidationError(`${key} must be 1-32000 characters`);
    }
    if (input.topic !== undefined) normalized.topic = requireLabel(input.topic, 'topic');
    if (input.entities !== undefined) {
      if (!Array.isArray(input.entities) || input.entities.length > 32) throw new ValidationError('entities must contain at most 32 labels');
      normalized.entities = input.entities.map(entity => requireLabel(entity, 'entity'));
    }
    if (input.createdAt !== undefined && (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0))
      throw new ValidationError('createdAt must be a nonnegative safe integer');
    return this.store.transaction(() => this.store.exchanges.commit(tenant, normalized));
  }

  async searchExchanges(tenantId: string, query: ExchangeQuery): Promise<Exchange[]> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const normalized = { ...query, userId: requireId(query.userId, 'userId') };
    if (query.sessionId !== undefined) normalized.sessionId = requireId(query.sessionId, 'sessionId');
    if (query.topic !== undefined) normalized.topic = requireLabel(query.topic, 'topic');
    if (query.entity !== undefined) normalized.entity = requireLabel(query.entity, 'entity');
    if (query.query !== undefined && (typeof query.query !== 'string' || query.query.length > 8000)) throw new ValidationError('query must be at most 8000 characters');
    for (const key of ['since', 'until'] as const) if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || query[key]! < 0)) throw new ValidationError(`${key} must be a nonnegative safe integer`);
    if (query.since !== undefined && query.until !== undefined && query.since > query.until) throw new ValidationError('since must not exceed until');
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50)) throw new ValidationError('limit must be 1-50');
    return this.store.exchanges.search(tenant, normalized);
  }

  indexingStatus(): Record<string, number> { this.assertOpen(); return this.store.exchanges.status(); }

  /** Explicit host-side worker API. A lost lease fences off late model responses. */
  async drainIndexing(options: { limit?: number; leaseMs?: number } = {}): Promise<{ indexed: number; failed: number; stale: number }> {
    this.assertOpen();
    const limit = options.limit ?? 10;
    const leaseMs = options.leaseMs ?? 120000;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit must be 1-100');
    if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 600000) throw new ValidationError('leaseMs must be 1-600000');
    const result = { indexed: 0, failed: 0, stale: 0 };
    for (let i = 0; i < limit && !this.closed; i++) {
      const job = this.store.transaction(() => this.store.exchanges.claim(Date.now(), leaseMs));
      if (!job) break;
      try {
        const e = job.exchange;
        const doc = await this.knowledge.prepareDocument(e.tenantId, {
          title: e.topic ?? 'Conversation exchange', text: `User: ${e.question}\nAssistant: ${e.answer}`,
          source: `chat:${e.id}`, acl: { visibility: 'restricted', userIds: [e.userId] },
          metadata: { exchangeId: e.id, sessionId: e.sessionId, occurredAt: e.createdAt },
        }, `doc_${e.id}`);
        if (this.closed) { result.stale++; break; }
        const committed = this.store.transaction(() => {
          if (!this.store.exchanges.owns(job, Date.now())) return false;
          this.store.insertDocument(doc, false);
          this.store.exchanges.complete(job, doc.id);
          return true;
        });
        if (committed) result.indexed++; else result.stale++;
      } catch {
        if (!this.closed) this.store.exchanges.retry(job);
        result.failed++;
      }
    }
    return result;
  }

  /** One job at a time. Stop prevents new claims; close also fences in-flight writes. */
  startIndexingWorker(options: { pollMs?: number; onError?: (error: unknown) => void } = {}): () => void {
    this.assertOpen();
    const pollMs = options.pollMs ?? 1000;
    if (!Number.isInteger(pollMs) || pollMs < 10) throw new ValidationError('pollMs must be at least 10');
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => { stopped = true; clearTimeout(timer); this.workerStops.delete(stop); };
    const tick = async () => {
      if (stopped || this.closed) return;
      try { await this.drainIndexing({ limit: 1 }); } catch (error) { options.onError?.(error); }
      if (!stopped && !this.closed) { timer = setTimeout(() => { void tick(); }, pollMs); timer.unref(); }
    };
    this.workerStops.add(stop);
    timer = setTimeout(() => { void tick(); }, 0); timer.unref();
    return stop;
  }

  ingestDocument(tenantId: string, input: IngestDocumentInput, opts?: CallOptions): Promise<IngestResult> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    return this.run(opts, 'ingestDocument', () => this.knowledge.ingest(tenant, input));
  }

  searchKnowledge(tenantId: string, query: KnowledgeQuery, opts?: CallOptions): Promise<KnowledgeHit[]> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const topK = clampTopK(query.topK ?? 5, 20);
    const userId = query.userId ? requireId(query.userId, 'userId') : undefined;
    const roles = query.roles?.map((role) => requireLabel(role, 'role'));
    return this.run(opts, 'searchKnowledge', () =>
      this.knowledge.search(tenant, query.query, topK, userId, roles, query.mode),
    );
  }

  recordEpisode(tenantId: string, input: EpisodeInput, opts?: CallOptions): Promise<Episode> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const episode = normalizeEpisode(tenant, input);
    return this.run(opts, 'recordEpisode', async () => {
      this.store.insertEpisode(episode);
      return episode;
    });
  }

  listEpisodes(tenantId: string, filter: EpisodeFilter = {}, opts?: CallOptions): Promise<Episode[]> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const userId = filter.userId ? requireId(filter.userId, 'userId') : undefined;
    const sessionId = filter.sessionId ? requireId(filter.sessionId, 'sessionId') : undefined;
    const type = filter.type ? requireLabel(filter.type, 'type') : undefined;
    const limit = clampTopK(filter.limit ?? 50, 200);
    return this.run(opts, 'listEpisodes', async () =>
      this.store.listEpisodes(tenant, {
        ...(userId ? { userId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(type ? { type } : {}),
        ...(filter.since !== undefined ? { since: filter.since } : {}),
        ...(filter.until !== undefined ? { until: filter.until } : {}),
        limit,
      }),
    );
  }

  recordAudit(tenantId: string, input: AuditInput, opts?: CallOptions): Promise<AuditEvent> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const event = normalizeAudit(tenant, input);
    const steps = event.steps;
    const cost = event.costUnits;
    return this.run(opts, 'recordAudit', async () => {
      const scopes = applicableScopes(tenant, event.userId, event.sessionId);
      const kill = this.activeKillSwitch(tenant, scopes);
      if (kill?.enabled) {
        this.store.insertAudit({
          ...event,
          id: createId('aud'),
          action: 'kill_switch_blocked',
          steps: 0,
          costUnits: 0,
          detail: { ...event.detail, attemptedAction: event.action },
        });
        throw new KillSwitchError(kill.reason);
      }
      try {
        return this.store.transaction(() => {
          for (const scope of scopes) {
            const cap = this.store.getCap(tenant, scope.scope, scope.targetId);
            if (!cap) continue;
            if (cap.maxSteps !== null && cap.stepsUsed + steps > cap.maxSteps) {
              throw new LimitRejection('steps');
            }
            if (cap.maxSpendUnits !== null && cap.spendUsed + cost > cap.maxSpendUnits + 1e-9) {
              throw new LimitRejection('spend');
            }
          }
          const now = event.createdAt;
          if (steps > 0 || cost > 0) {
            for (const scope of scopes) {
              this.store.addUsage(tenant, scope.scope, scope.targetId, steps, cost, now);
            }
          }
          this.store.insertAudit(event);
          return event;
        });
      } catch (error) {
        if (error instanceof LimitRejection) {
          this.store.insertAudit({
            ...event,
            id: createId('aud'),
            action: 'cap_exceeded',
            steps: 0,
            costUnits: 0,
            detail: {
              ...event.detail,
              attemptedAction: event.action,
              attemptedSteps: steps,
              attemptedCostUnits: cost,
              limit: error.kind,
            },
          });
          throw new CapExceededError(error.kind);
        }
        throw error;
      }
    });
  }

  listAudit(tenantId: string, filter: AuditFilter = {}, opts?: CallOptions): Promise<AuditEvent[]> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const userId = filter.userId ? requireId(filter.userId, 'userId') : undefined;
    const sessionId = filter.sessionId ? requireId(filter.sessionId, 'sessionId') : undefined;
    const limit = clampTopK(filter.limit ?? 50, 200);
    return this.run(opts, 'listAudit', async () =>
      this.store.listAudit(tenant, {
        ...(userId ? { userId } : {}),
        ...(sessionId ? { sessionId } : {}),
        limit,
      }),
    );
  }

  getCaps(tenantId: string, scope: CapsQuery = {}, opts?: CallOptions): Promise<CapsSnapshot> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const userId = scope.userId ? requireId(scope.userId, 'userId') : undefined;
    const sessionId = scope.sessionId ? requireId(scope.sessionId, 'sessionId') : undefined;
    return this.run(opts, 'getCaps', async () => this.readCaps(tenant, userId ?? null, sessionId ?? null));
  }

  setCaps(tenantId: string, input: CapsInput, opts?: CallOptions): Promise<CapBucket> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const target = this.resolveTarget(tenant, input.scope, input.targetId);
    if (input.maxSteps !== null && (!Number.isInteger(input.maxSteps) || input.maxSteps < 0)) {
      throw new ValidationError('maxSteps must be a non-negative integer or null');
    }
    if (input.maxSpendUnits !== null && (!Number.isFinite(input.maxSpendUnits) || input.maxSpendUnits < 0)) {
      throw new ValidationError('maxSpendUnits must be a non-negative number or null');
    }
    return this.run(opts, 'setCaps', async () =>
      this.store.upsertCapLimits(tenant, input.scope, target, input.maxSteps, input.maxSpendUnits, Date.now()),
    );
  }

  setKillSwitch(tenantId: string, input: KillSwitchInput, opts?: CallOptions): Promise<KillSwitchState> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const target = this.resolveTarget(tenant, input.scope, input.targetId);
    const reason = input.reason == null || input.reason === '' ? null : String(input.reason).slice(0, 500);
    const state: KillSwitchState = {
      scope: input.scope,
      targetId: target,
      enabled: input.enabled,
      reason,
      updatedAt: Date.now(),
    };
    return this.run(opts, 'setKillSwitch', async () => {
      this.store.upsertKillSwitch({ ...state, tenantId: tenant });
      return state;
    });
  }

  /**
   * Budgeted context for the model. Tenant id is an argument of the trusted
   * app server. The HTTP layer overwrites it with the API-key tenant.
   */
  async assembleContext(
    tenantId: string,
    userId: string,
    sessionId: string,
    query?: string,
    options?: AssembleOptions,
  ): Promise<ContextPack> {
    this.assertOpen();
    const tenant = requireId(tenantId, 'tenantId');
    const user = requireId(userId, 'userId');
    const session = requireId(sessionId, 'sessionId');
    const budget = options?.tokenBudget ?? this.config.defaultTokenBudget;
    if (!Number.isInteger(budget) || budget < 32 || budget > 200_000) {
      throw new ValidationError('tokenBudget must be an integer from 32 to 200000');
    }
    const topK = clampTopK(options?.knowledgeTopK ?? 5, 20);
    const episodeLimit = clampTopK(options?.episodeLimit ?? 5, 20);
    const roles = options?.roles?.map((role) => requireLabel(role, 'role'));
    const text = query?.trim() ?? '';
    if (text.length > 8_000) throw new ValidationError('query exceeds 8000 characters');
    return this.run(options, 'assembleContext', async () => {
      const [memory, profile, episodes, hits, operational] = await Promise.all([
        this.getWorkingMemory(tenant, session),
        this.getProfile(tenant, user),
        this.listEpisodes(tenant, { userId: user, limit: episodeLimit }),
        text
          ? this.searchKnowledge(tenant, {
              query: text,
              topK,
              userId: user,
              ...(roles ? { roles } : {}),
            })
          : Promise.resolve([] as KnowledgeHit[]),
        options?.includeOperational
          ? this.operationalSlice(tenant, user, session)
          : Promise.resolve(undefined),
      ]);
      return buildContextPack({
        tenantId: tenant,
        userId: user,
        sessionId: session,
        budget,
        turns: memory.turns,
        facts: profile.facts,
        hits,
        episodes,
        ...(operational ? { operational } : {}),
      });
    });
  }

  clearL1Cache(): void {
    this.assertOpen();
    this.l1.clear();
  }

  async dropHotCaches(): Promise<void> {
    this.assertOpen();
    this.l1.clear();
    await this.redis.clearPrefix('ml:');
  }

  async health(): Promise<{ ok: true; redis: RedisClient['kind']; database: 'sqlite' }> {
    this.assertOpen();
    this.store.ping();
    await this.redis.ping();
    return { ok: true, redis: this.redis.kind, database: 'sqlite' };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.workerStops) stop();
    this.l1.clear();
    this.store.close();
    if (this.ownsRedis) await this.redis.close();
  }

  private async operationalSlice(tenantId: string, userId: string, sessionId: string) {
    const [caps, recentAudit] = await Promise.all([
      this.readCaps(tenantId, userId, sessionId),
      Promise.resolve(this.store.listAudit(tenantId, { userId, sessionId, limit: 10 })),
    ]);
    return { caps, recentAudit };
  }

  private readCaps(tenantId: string, userId: string | null, sessionId: string | null): CapsSnapshot {
    const scopes = applicableScopes(tenantId, userId, sessionId);
    const buckets = scopes.map((scope) => {
      const row = this.store.getCap(tenantId, scope.scope, scope.targetId);
      return (
        row ?? {
          scope: scope.scope,
          targetId: scope.targetId,
          maxSteps: null,
          maxSpendUnits: null,
          stepsUsed: 0,
          spendUsed: 0,
        }
      );
    });
    const killSwitch = this.activeKillSwitch(tenantId, scopes);
    return { buckets, killSwitch, blocked: killSwitch?.enabled === true };
  }

  /** Most specific enabled switch wins: session, then user, then tenant. */
  private activeKillSwitch(tenantId: string, scopes: ScopeRef[]): KillSwitchState | null {
    for (const scope of [...scopes].reverse()) {
      const row = this.store.getKillSwitch(tenantId, scope.scope, scope.targetId);
      if (row?.enabled) return row;
    }
    return null;
  }

  private resolveTarget(tenantId: string, scope: ControlScope, targetId: string): string {
    if (scope === 'tenant') {
      const target = requireId(targetId, 'targetId');
      if (target !== tenantId) throw new ValidationError('tenant kill-switch target must equal tenantId');
      return target;
    }
    return requireId(targetId, 'targetId');
  }

  private run<T>(opts: CallOptions | undefined, operation: string, fn: () => Promise<T>): Promise<T> {
    const explicit = opts?.timeoutMs;
    if (explicit !== undefined) {
      if (!Number.isFinite(explicit) || explicit < 1 || explicit > 60_000) {
        return Promise.reject(new ValidationError('timeoutMs must be between 1 and 60000'));
      }
      return withTimeout(fn(), explicit, operation);
    }
    if (this.redis.kind === 'ioredis') return withTimeout(fn(), this.config.defaultTimeoutMs, operation);
    return fn();
  }

  private assertOpen(): void {
    if (this.closed) throw new MemoryError('closed', 'MemoryService is closed', 503);
  }
}

export async function openMemoryService(options?: MemoryServiceOptions): Promise<MemoryService> {
  return MemoryService.open(options);
}

function assertEmbeddingMeta(store: DurableStore, embedder: EmbeddingProvider): void {
  const dim = store.getMeta('embedding_dim');
  const id = store.getMeta('embedding_id');
  if (dim === null || id === null) {
    store.setMeta('embedding_dim', String(embedder.dimensions));
    store.setMeta('embedding_id', embedder.id);
    return;
  }
  if (dim !== String(embedder.dimensions) || id !== embedder.id) {
    throw new MemoryError(
      'embedding_mismatch',
      `Database was built with ${id} dim ${dim}; refusing ${embedder.id} dim ${embedder.dimensions}. Use a new database file.`,
      500,
    );
  }
}

function viewWorking(tenantId: string, sessionId: string, blob: WorkingBlob): WorkingMemory {
  const turns = blob.turns.map((turn) => ({ ...turn }));
  return {
    tenantId,
    sessionId,
    turns,
    tokenEstimate: turns.reduce((sum, turn) => sum + turn.tokenEstimate, 0),
  };
}

function viewProfile(tenantId: string, userId: string, blob: ProfileBlob): Profile {
  return {
    tenantId,
    userId,
    facts: blob.facts.map((fact) => ({ ...fact })),
  };
}

function normalizeTurn(input: TurnInput): Turn {
  if (!input || (input.role !== 'user' && input.role !== 'assistant' && input.role !== 'tool' && input.role !== 'system')) {
    throw new ValidationError('role must be user, assistant, tool, or system');
  }
  if (typeof input.content !== 'string' || input.content.length === 0 || input.content.length > 32_000) {
    throw new ValidationError('content must be 1-32000 characters');
  }
  if (input.role === 'tool' && !input.toolName) throw new ValidationError('tool turns require toolName');
  const turn: Turn = {
    id: createId('trn'),
    role: input.role,
    content: input.content,
    createdAt: input.createdAt ?? Date.now(),
    tokenEstimate: estimateTokens(input.content),
  };
  if (input.toolName) turn.toolName = requireLabel(input.toolName, 'toolName');
  if (input.toolCallId) turn.toolCallId = requireId(input.toolCallId, 'toolCallId');
  if (!Number.isFinite(turn.createdAt)) throw new ValidationError('createdAt must be a finite number');
  return turn;
}

function normalizeEpisode(tenantId: string, input: EpisodeInput): Episode {
  const userId = requireId(input.userId, 'userId');
  const type = requireLabel(input.type, 'type');
  if (typeof input.summary !== 'string' || input.summary.length === 0 || input.summary.length > 4_000) {
    throw new ValidationError('summary must be 1-4000 characters');
  }
  const payload = input.payload ?? {};
  const encoded = jsonClone(payload);
  if (encoded.length > 16_000) throw new ValidationError('episode payload exceeds 16000 characters');
  return {
    id: createId('ep'),
    tenantId,
    userId,
    sessionId: input.sessionId ? requireId(input.sessionId, 'sessionId') : null,
    type,
    summary: input.summary,
    payload: JSON.parse(encoded) as Record<string, unknown>,
    occurredAt: input.occurredAt ?? Date.now(),
  };
}

function normalizeAudit(tenantId: string, input: AuditInput): AuditEvent {
  const action = requireLabel(input.action, 'action');
  const steps = input.steps ?? 0;
  const costUnits = Math.round((input.costUnits ?? 0) * 1_000_000) / 1_000_000;
  if (!Number.isInteger(steps) || steps < 0 || steps > 10_000) {
    throw new ValidationError('steps must be an integer from 0 to 10000');
  }
  if (!Number.isFinite(costUnits) || costUnits < 0) throw new ValidationError('costUnits must be >= 0');
  const detail = input.detail ?? {};
  const encoded = jsonClone(detail);
  if (encoded.length > 16_000) throw new ValidationError('audit detail exceeds 16000 characters');
  return {
    id: createId('aud'),
    tenantId,
    userId: input.userId ? requireId(input.userId, 'userId') : null,
    sessionId: input.sessionId ? requireId(input.sessionId, 'sessionId') : null,
    action,
    toolName: input.toolName ? requireLabel(input.toolName, 'toolName') : null,
    detail: JSON.parse(encoded) as Record<string, unknown>,
    costUnits,
    steps,
    createdAt: Date.now(),
  };
}

function applicableScopes(tenantId: string, userId: string | null, sessionId: string | null): ScopeRef[] {
  const scopes: ScopeRef[] = [{ scope: 'tenant', targetId: tenantId }];
  if (userId) scopes.push({ scope: 'user', targetId: userId });
  if (sessionId) scopes.push({ scope: 'session', targetId: sessionId });
  return scopes;
}

function splitPair(id: string): { tenantId: string; second: string } {
  const index = id.indexOf(':');
  if (index <= 0) throw new ValidationError('Invalid cache id');
  return { tenantId: id.slice(0, index), second: id.slice(index + 1) };
}

function clampTopK(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`limit must be an integer from 1 to ${max}`);
  }
  return value;
}
