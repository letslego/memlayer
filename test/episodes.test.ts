import { describe, expect, it } from 'vitest';
import { testMemory } from './helpers.js';

describe('episodic memory', () => {
  it('filters by tenant, user, and time', async () => {
    const memory = await testMemory();
    try {
      await memory.recordEpisode('acme', {
        userId: 'u1',
        type: 'decision',
        summary: 'Ship the billing change',
        occurredAt: 1_000,
      });
      await memory.recordEpisode('acme', {
        userId: 'u2',
        type: 'ticket_resolved',
        summary: 'Closed ticket 44',
        occurredAt: 2_000,
      });
      await memory.recordEpisode('globex', {
        userId: 'u1',
        type: 'decision',
        summary: 'Globex-only acquisition note',
        occurredAt: 1_500,
      });
      const acme = await memory.listEpisodes('acme', {});
      expect(acme.map((episode) => episode.summary)).toEqual(['Closed ticket 44', 'Ship the billing change']);
      const user = await memory.listEpisodes('acme', { userId: 'u1', since: 500, until: 1_200 });
      expect(user).toHaveLength(1);
      expect(user[0]?.type).toBe('decision');
      const globex = await memory.listEpisodes('globex', { type: 'decision' });
      expect(globex.map((episode) => episode.summary)).toEqual(['Globex-only acquisition note']);
    } finally {
      await memory.close();
    }
  });
});
