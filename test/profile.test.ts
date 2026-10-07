import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../src/errors.js';
import { testMemory } from './helpers.js';

describe('profile memory', () => {
  it('round-trips typed facts through redis and sqlite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memlayer-profile-'));
    const databasePath = join(dir, 'mem.sqlite');
    const first = await testMemory({ databasePath });
    await first.setProfileFact('acme', 'u1', { key: 'plan', type: 'string', value: 'enterprise' });
    await first.setProfileFact('acme', 'u1', { key: 'seats', type: 'number', value: 12 });
    await first.setProfileFact('acme', 'u1', {
      key: 'flags',
      type: 'json',
      value: { beta: true },
    });
    first.clearL1Cache();
    const warmRedis = await first.getProfile('acme', 'u1');
    expect(warmRedis.facts.map((fact) => fact.key).sort()).toEqual(['flags', 'plan', 'seats']);
    await first.dropHotCaches();
    const fromDisk = await first.getProfile('acme', 'u1');
    expect(fromDisk.facts.find((fact) => fact.key === 'seats')?.value).toBe(12);
    await first.forgetFact('acme', 'u1', 'seats');
    await expect(first.forgetFact('acme', 'u1', 'seats')).rejects.toBeInstanceOf(NotFoundError);
    await first.close();

    const second = await testMemory({ databasePath });
    const reloaded = await second.getProfile('acme', 'u1');
    expect(reloaded.facts.find((fact) => fact.key === 'plan')?.value).toBe('enterprise');
    expect(reloaded.facts.find((fact) => fact.key === 'seats')).toBeUndefined();
    expect(reloaded.facts.find((fact) => fact.key === 'flags')?.value).toEqual({ beta: true });
    await second.close();
  });

  it('single-flights concurrent durable loads', async () => {
    const memory = await testMemory();
    try {
      await memory.setProfileFact('acme', 'u1', { key: 'locale', type: 'string', value: 'fr' });
      await memory.dropHotCaches();
      const before = memory.stats.profile.durableLoads;
      await Promise.all(Array.from({ length: 25 }, () => memory.getProfile('acme', 'u1')));
      expect(memory.stats.profile.durableLoads - before).toBe(1);
      expect(memory.stats.profile.singleFlightJoins).toBeGreaterThanOrEqual(24);
    } finally {
      await memory.close();
    }
  });
});
