import { describe, expect, it } from 'vitest';
import { testMemory } from './helpers.js';

describe('working memory', () => {
  it('appends, reads, trims, and clears a session', async () => {
    const memory = await testMemory({ workingMaxTurns: 3, workingMaxTokens: 10_000 });
    try {
      const empty = await memory.getWorkingMemory('acme', 's1');
      expect(empty.turns).toEqual([]);
      await memory.appendTurn('acme', 's1', { role: 'user', content: 'one' });
      await memory.appendTurn('acme', 's1', { role: 'assistant', content: 'two' });
      await memory.appendTurn('acme', 's1', {
        role: 'tool',
        toolName: 'lookup',
        content: 'three',
      });
      await memory.appendTurn('acme', 's1', { role: 'user', content: 'four' });
      const view = await memory.getWorkingMemory('acme', 's1');
      expect(view.turns.map((turn) => turn.content)).toEqual(['two', 'three', 'four']);
      expect(view.tokenEstimate).toBeGreaterThan(0);
      await memory.clearSession('acme', 's1');
      expect((await memory.getWorkingMemory('acme', 's1')).turns).toEqual([]);
    } finally {
      await memory.close();
    }
  });

  it('rejects a tool turn without a tool name', async () => {
    const memory = await testMemory();
    try {
      await expect(memory.appendTurn('acme', 's1', { role: 'tool', content: 'x' })).rejects.toThrow(
        /toolName/,
      );
    } finally {
      await memory.close();
    }
  });
});
