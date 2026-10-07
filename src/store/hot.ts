import { encode, decode } from '@msgpack/msgpack';
import type { LRUCache } from 'lru-cache';
import { KeyMutex, SingleFlight } from '../async.js';
import type { RedisClient } from '../redis/client.js';
import { GetBatcher } from '../redis/batcher.js';

export interface HotCacheStats {
  l1Hits: number;
  l1Misses: number;
  redisHits: number;
  durableLoads: number;
  singleFlightJoins: number;
}

export interface HotCacheOptions<T> {
  prefix: string;
  ttlSec: number;
  empty: () => T;
  /** When true, redis is deleted before mutate so a crash reloads the durable row. */
  invalidateFirst: boolean;
  isEmpty?: (value: T) => boolean;
  loadDurable?: (id: string) => T | Promise<T>;
}

/**
 * L1 (decoded objects) in front of Redis blobs.
 * L1 hits do not take the lock. Misses and writes share a per-key mutex,
 * and identical concurrent misses share one SingleFlight promise.
 */
export class HotCache<T extends object> {
  readonly stats: HotCacheStats = {
    l1Hits: 0,
    l1Misses: 0,
    redisHits: 0,
    durableLoads: 0,
    singleFlightJoins: 0,
  };

  private readonly flights = new SingleFlight();
  private readonly mutex = new KeyMutex();
  private readonly batcher: GetBatcher;

  constructor(
    private readonly l1: LRUCache<string, T>,
    private readonly redis: RedisClient,
    private readonly options: HotCacheOptions<T>,
  ) {
    this.batcher = new GetBatcher(redis);
  }

  peek(id: string): T | undefined {
    const hit = this.l1.get(this.key(id));
    if (hit !== undefined) this.stats.l1Hits++;
    return hit;
  }

  get(id: string): Promise<T> {
    const key = this.key(id);
    const hit = this.l1.get(key);
    if (hit !== undefined) {
      this.stats.l1Hits++;
      return Promise.resolve(hit);
    }
    this.stats.l1Misses++;
    if (this.flights.has(key)) this.stats.singleFlightJoins++;
    return this.flights.do(key, () => this.mutex.run(key, () => this.load(key, id)));
  }

  update(id: string, mutate: (current: T) => T | Promise<T>): Promise<T> {
    const key = this.key(id);
    return this.mutex.run(key, async () => {
      const current = await this.readThrough(key, id);
      if (this.options.invalidateFirst) {
        this.l1.delete(key);
        await this.redis.del(key);
      }
      const next = await mutate(current);
      await this.redis.setBuffer(key, encodeBlob(next), this.options.ttlSec);
      this.l1.set(key, next);
      return next;
    });
  }

  remove(id: string): Promise<void> {
    const key = this.key(id);
    return this.mutex.run(key, async () => {
      this.l1.delete(key);
      await this.redis.del(key);
    });
  }

  private async load(key: string, id: string): Promise<T> {
    const hot = this.l1.get(key);
    if (hot !== undefined) return hot;
    const buf = await this.batcher.get(key);
    if (buf) {
      this.stats.redisHits++;
      const value = decodeBlob<T>(buf);
      this.l1.set(key, value);
      return value;
    }
    const value = await this.loadOrEmpty(id);
    if (!this.options.isEmpty?.(value)) {
      await this.redis.setBuffer(key, encodeBlob(value), this.options.ttlSec);
    }
    this.l1.set(key, value);
    return value;
  }

  private async readThrough(key: string, id: string): Promise<T> {
    const hot = this.l1.get(key);
    if (hot !== undefined) return hot;
    const buf = await this.redis.getBuffer(key);
    if (buf) {
      this.stats.redisHits++;
      return decodeBlob<T>(buf);
    }
    return this.loadOrEmpty(id);
  }

  private async loadOrEmpty(id: string): Promise<T> {
    if (!this.options.loadDurable) return this.options.empty();
    this.stats.durableLoads++;
    return this.options.loadDurable(id);
  }

  private key(id: string): string {
    return this.options.prefix + id;
  }
}

function encodeBlob(value: unknown): Buffer {
  return Buffer.from(encode(value));
}

function decodeBlob<T>(buf: Buffer): T {
  return decode(buf) as T;
}
