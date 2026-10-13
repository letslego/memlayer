export interface RedisStats {
  gets: number;
  sets: number;
  dels: number;
  mgets: number;
  pipelines: number;
}

export interface RedisPipeline {
  getBuffer(key: string): this;
  setBuffer(key: string, value: Buffer, ttlSec?: number): this;
  del(key: string): this;
  exec(): Promise<unknown[]>;
}

export interface RedisClient {
  readonly kind: 'memory' | 'ioredis';
  readonly stats: RedisStats;
  getBuffer(key: string): Promise<Buffer | null>;
  setBuffer(key: string, value: Buffer, ttlSec?: number): Promise<void>;
  compareAndSet(key: string, expected: Buffer | null, value: Buffer, ttlSec?: number): Promise<boolean>;
  del(key: string): Promise<number>;
  mgetBuffer(keys: readonly string[]): Promise<Array<Buffer | null>>;
  pipeline(): RedisPipeline;
  clearPrefix(prefix: string): Promise<void>;
  ping(): Promise<string>;
  close(): Promise<void>;
}

export function emptyStats(): RedisStats {
  return { gets: 0, sets: 0, dels: 0, mgets: 0, pipelines: 0 };
}

export function asBufferOrNull(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Unexpected Redis value');
}
