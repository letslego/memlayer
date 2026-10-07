import { Redis } from 'ioredis';
import { asBufferOrNull, emptyStats, type RedisClient, type RedisPipeline, type RedisStats } from './client.js';

/**
 * Real Redis adapter. Each pooled connection has auto-pipelining enabled.
 * Explicit pipelines are still used when one logical read must share a connection.
 */
export class IoredisPool implements RedisClient {
  readonly kind = 'ioredis' as const;
  readonly stats: RedisStats = emptyStats();
  private cursor = 0;

  private constructor(private readonly clients: Redis[]) {}

  static async connect(url: string, poolSize: number): Promise<IoredisPool> {
    const clients = Array.from({ length: poolSize }, () => createClient(url));
    await Promise.all(clients.map((client) => client.connect()));
    return new IoredisPool(clients);
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    this.stats.gets++;
    return this.next().getBuffer(key);
  }

  async setBuffer(key: string, value: Buffer, ttlSec?: number): Promise<void> {
    this.stats.sets++;
    if (ttlSec && ttlSec > 0) await this.next().set(key, value, 'EX', ttlSec);
    else await this.next().set(key, value);
  }

  async del(key: string): Promise<number> {
    this.stats.dels++;
    return this.next().del(key);
  }

  async mgetBuffer(keys: readonly string[]): Promise<Array<Buffer | null>> {
    this.stats.mgets++;
    if (keys.length === 0) return [];
    const values: Array<Buffer | null> = await this.next().mgetBuffer(...keys);
    return values.map((value) => asBufferOrNull(value));
  }

  pipeline(): RedisPipeline {
    const client = this.next();
    const pipe = client.pipeline();
    const wrapper: RedisPipeline = {
      getBuffer: (key) => {
        this.stats.gets++;
        pipe.getBuffer(key);
        return wrapper;
      },
      setBuffer: (key, value, ttlSec) => {
        this.stats.sets++;
        if (ttlSec && ttlSec > 0) pipe.set(key, value, 'EX', ttlSec);
        else pipe.set(key, value);
        return wrapper;
      },
      del: (key) => {
        this.stats.dels++;
        pipe.del(key);
        return wrapper;
      },
      exec: async () => {
        this.stats.pipelines++;
        const rows: Array<[Error | null, unknown]> | null = await pipe.exec();
        if (!rows) return [];
        return rows.map(([error, value]) => {
          if (error) throw error;
          return value;
        });
      },
    };
    return wrapper;
  }

  async clearPrefix(prefix: string): Promise<void> {
    const client = this.clients[0];
    if (!client) return;
    let cursor = '0';
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        this.stats.dels += keys.length;
        await client.del(...keys);
      }
    } while (cursor !== '0');
  }

  async ping(): Promise<string> {
    return this.next().ping();
  }

  async close(): Promise<void> {
    await Promise.all(
      this.clients.map(async (client) => {
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }),
    );
  }

  private next(): Redis {
    const client = this.clients[this.cursor % this.clients.length];
    this.cursor++;
    if (!client) throw new Error('Redis pool is empty');
    return client;
  }
}

function createClient(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableAutoPipelining: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
    retryStrategy(times: number) {
      if (times > 3) return null;
      return Math.min(times * 50, 200);
    },
  });
}
