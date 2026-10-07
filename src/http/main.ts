import { loadEnvFile, parseApiKeys, readPositiveInt } from '../env.js';
import { openMemoryService } from '../service.js';
import { buildServer } from './server.js';

const DEV_KEYS = 'dev_acme_key:acme,dev_globex_key:globex';

async function main(): Promise<void> {
  loadEnvFile();
  if (!process.env.API_KEYS) {
    console.warn('API_KEYS is unset; using the local dev placeholders from .env.example');
  }
  const apiKeys = parseApiKeys(process.env.API_KEYS ?? DEV_KEYS);
  if (Object.keys(apiKeys).length === 0) {
    throw new Error('Set API_KEYS to at least one key:tenant pair');
  }
  const memory = await openMemoryService({
    databasePath: process.env.DATABASE_PATH ?? 'data/memlayer.sqlite',
    ...(process.env.REDIS_URL ? { redisUrl: process.env.REDIS_URL } : {}),
    redisPoolSize: readPositiveInt(process.env.REDIS_POOL_SIZE, 4, 'REDIS_POOL_SIZE'),
    l1TtlMs: readPositiveInt(process.env.L1_TTL_MS, 500, 'L1_TTL_MS'),
    l1Max: readPositiveInt(process.env.L1_MAX, 10_000, 'L1_MAX'),
    workingTtlSec: readPositiveInt(process.env.WORKING_MEMORY_TTL_SEC, 86_400, 'WORKING_MEMORY_TTL_SEC'),
    profileTtlSec: readPositiveInt(process.env.PROFILE_TTL_SEC, 604_800, 'PROFILE_TTL_SEC'),
    workingMaxTurns: readPositiveInt(process.env.WORKING_MEMORY_MAX_TURNS, 40, 'WORKING_MEMORY_MAX_TURNS'),
    embeddingDim: readPositiveInt(process.env.EMBEDDING_DIM, 128, 'EMBEDDING_DIM'),
    defaultTimeoutMs: readPositiveInt(process.env.REQUEST_TIMEOUT_MS, 2_000, 'REQUEST_TIMEOUT_MS'),
    defaultTokenBudget: readPositiveInt(process.env.TOKEN_BUDGET, 4_096, 'TOKEN_BUDGET'),
  });
  const port = readPositiveInt(process.env.PORT, 43_123, 'PORT');
  const host = process.env.HOST ?? '127.0.0.1';
  const app = buildServer({
    memory,
    apiKeys,
    logger: true,
    requestTimeoutMs: readPositiveInt(process.env.REQUEST_TIMEOUT_MS, 5_000, 'REQUEST_TIMEOUT_MS'),
  });
  const shutdown = async () => {
    await app.close();
    await memory.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await app.listen({ port, host });
  console.log(`memlayer listening on http://${host}:${port}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
