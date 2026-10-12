export interface ResolvedConfig {
  databasePath: string;
  redisUrl: string | undefined;
  redisPoolSize: number;
  l1TtlMs: number;
  l1Max: number;
  workingTtlSec: number;
  profileTtlSec: number;
  workingMaxTurns: number;
  workingMaxTokens: number;
  embeddingDim: number;
  defaultTimeoutMs: number;
  defaultTokenBudget: number;
  hnswM: number;
  hnswEfConstruction: number;
  hnswEfSearch: number;
  profileFactLimit: number;
  hnswSeed?: number;
}

export interface MemoryServiceOptions {
  /** Fixed ANN construction seed for reproducible evaluations. */
  hnswSeed?: number;
  databasePath?: string;
  redisUrl?: string;
  redisPoolSize?: number;
  l1TtlMs?: number;
  l1Max?: number;
  workingTtlSec?: number;
  profileTtlSec?: number;
  workingMaxTurns?: number;
  workingMaxTokens?: number;
  embeddingDim?: number;
  defaultTimeoutMs?: number;
  defaultTokenBudget?: number;
  /** Injected Redis client. When set, REDIS_URL is ignored and the caller owns close(). */
  redis?: import('./redis/client.js').RedisClient;
  embeddings?: import('./embed/provider.js').EmbeddingProvider;
}

export function resolveConfig(options: MemoryServiceOptions = {}): ResolvedConfig {
  return {
    databasePath: options.databasePath ?? 'data/memlayer.sqlite',
    redisUrl: options.redisUrl?.trim() ? options.redisUrl.trim() : undefined,
    redisPoolSize: clampInt(options.redisPoolSize ?? 4, 1, 32),
    l1TtlMs: clampInt(options.l1TtlMs ?? 500, 1, 60_000),
    l1Max: clampInt(options.l1Max ?? 10_000, 1, 1_000_000),
    workingTtlSec: clampInt(options.workingTtlSec ?? 86_400, 1, 2_592_000),
    profileTtlSec: clampInt(options.profileTtlSec ?? 604_800, 1, 2_592_000),
    workingMaxTurns: clampInt(options.workingMaxTurns ?? 40, 1, 500),
    workingMaxTokens: clampInt(options.workingMaxTokens ?? 8_000, 1, 200_000),
    embeddingDim: clampInt(options.embeddingDim ?? 128, 16, 1_024),
    defaultTimeoutMs: clampInt(options.defaultTimeoutMs ?? 2_000, 1, 60_000),
    defaultTokenBudget: clampInt(options.defaultTokenBudget ?? 4_096, 32, 200_000),
    hnswSeed: options.hnswSeed,
    hnswM: 16,
    hnswEfConstruction: 64,
    hnswEfSearch: 64,
    profileFactLimit: 200,
  };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
