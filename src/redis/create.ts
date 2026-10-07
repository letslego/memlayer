import type { RedisClient } from './client.js';
import { MemoryRedis } from './memory.js';

export async function createRedisClient(url: string | undefined, poolSize: number): Promise<RedisClient> {
  if (!url) return new MemoryRedis();
  const { IoredisPool } = await import('./ioredis.js');
  return IoredisPool.connect(url, poolSize);
}
