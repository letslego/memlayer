import { asBufferOrNull, emptyStats, type RedisClient, type RedisPipeline, type RedisStats } from './client.js';

interface Entry {
  value: Buffer;
  /** Epoch ms. 0 means no expiry. */
  expiresAt: number;
}

/**
 * In-process Redis-compatible store. Pipelines run as a single synchronous
 * batch so tests and demos exercise the same call shape as ioredis.
 */
export class MemoryRedis implements RedisClient {
  readonly kind = 'memory' as const;
  readonly stats: RedisStats = emptyStats();
  private readonly map = new Map<string, Entry>();

  async getBuffer(key: string): Promise<Buffer | null> {
    this.stats.gets++;
    return this.read(key);
  }

  async setBuffer(key: string, value: Buffer, ttlSec?: number): Promise<void> {
    this.stats.sets++;
    this.write(key, value, ttlSec);
  }

  async del(key: string): Promise<number> {
    this.stats.dels++;
    return this.map.delete(key) ? 1 : 0;
  }

  async mgetBuffer(keys: readonly string[]): Promise<Array<Buffer | null>> {
    this.stats.mgets++;
    return keys.map((key) => {
      this.stats.gets++;
      return this.read(key);
    });
  }

  pipeline(): RedisPipeline {
    const ops: Array<() => unknown> = [];
    const pipe: RedisPipeline = {
      getBuffer: (key) => {
        ops.push(() => {
          this.stats.gets++;
          return this.read(key);
        });
        return pipe;
      },
      setBuffer: (key, value, ttlSec) => {
        ops.push(() => {
          this.stats.sets++;
          this.write(key, value, ttlSec);
          return 'OK';
        });
        return pipe;
      },
      del: (key) => {
        ops.push(() => {
          this.stats.dels++;
          return this.map.delete(key) ? 1 : 0;
        });
        return pipe;
      },
      exec: async () => {
        this.stats.pipelines++;
        return ops.map((op) => op());
      },
    };
    return pipe;
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) this.map.delete(key);
    }
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async close(): Promise<void> {
    this.map.clear();
  }

  private read(key: string): Buffer | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return Buffer.from(entry.value);
  }

  private write(key: string, value: Buffer, ttlSec?: number): void {
    const expiresAt = ttlSec && ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
    this.map.set(key, { value: Buffer.from(value), expiresAt });
  }
}

export { asBufferOrNull };
