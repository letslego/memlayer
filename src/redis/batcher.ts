import { asBufferOrNull, type RedisClient } from './client.js';

interface Waiter {
  key: string;
  resolve: (value: Buffer | null) => void;
  reject: (error: unknown) => void;
}

/**
 * Coalesces cache misses from the same turn into one pipelined round trip.
 * A single key uses GET; two or more use PIPELINE so the hot miss path stays small.
 */
export class GetBatcher {
  private queue: Waiter[] = [];
  private scheduled = false;

  constructor(private readonly redis: RedisClient) {}

  get(key: string): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      this.queue.push({ key, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    });
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    this.scheduled = false;
    if (batch.length === 0) return;
    try {
      if (batch.length === 1) {
        const only = batch[0]!;
        only.resolve(await this.redis.getBuffer(only.key));
        return;
      }
      const pipe = this.redis.pipeline();
      for (const item of batch) pipe.getBuffer(item.key);
      const values = await pipe.exec();
      for (let i = 0; i < batch.length; i++) {
        batch[i]!.resolve(asBufferOrNull(values[i]));
      }
    } catch (error) {
      for (const item of batch) item.reject(error);
    }
  }
}
