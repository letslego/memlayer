import { describe, expect, it } from 'vitest';
import { TimeoutError } from '../src/errors.js';
import { MemoryRedis } from '../src/redis/memory.js';
import { testMemory } from './helpers.js';

describe('redis batching', () => {
  it('pipelines concurrent working-memory misses', async () => {
    const redis = new MemoryRedis();
    const memory = await testMemory({ redis, l1TtlMs: 60_000 });
    try {
      await memory.appendTurn('acme', 's1', { role: 'user', content: 'alpha' });
      await memory.appendTurn('acme', 's2', { role: 'user', content: 'beta' });
      const pipelinesBefore = redis.stats.pipelines;
      memory.clearL1Cache();
      const [first, second] = await Promise.all([
        memory.getWorkingMemory('acme', 's1'),
        memory.getWorkingMemory('acme', 's2'),
      ]);
      expect(first.turns[0]?.content).toBe('alpha');
      expect(second.turns[0]?.content).toBe('beta');
      expect(redis.stats.pipelines - pipelinesBefore).toBe(1);
    } finally {
      await memory.close();
    }
  });

  it('times out a hung redis read when timeoutMs is set', async () => {
    const redis = new MemoryRedis();
    redis.getBuffer = () => new Promise(() => {});
    const memory = await testMemory({ redis });
    try {
      await expect(memory.getProfile('acme', 'u1', { timeoutMs: 30 })).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      await memory.close();
    }
  });
});
