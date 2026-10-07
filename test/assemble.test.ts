import { describe, expect, it } from 'vitest';
import { testMemory } from './helpers.js';

describe('assembleContext', () => {
  it('merges working, profile, knowledge, and episodes and skips operational memory', async () => {
    const memory = await testMemory();
    try {
      await memory.setProfileFact('acme', 'u1', { key: 'preferred_name', type: 'string', value: 'Ada' });
      await memory.ingestDocument('acme', {
        title: 'Refund policy',
        text: 'Enterprise refund window is 30 days from the invoice date.',
      });
      await memory.ingestDocument('globex', {
        title: 'Secret',
        text: 'globex-only-marker-5521 must stay inside globex.',
      });
      await memory.recordEpisode('acme', {
        userId: 'u1',
        type: 'decision',
        summary: 'Finance approves refunds over 500 USD.',
      });
      await memory.recordAudit('acme', {
        userId: 'u1',
        sessionId: 's1',
        action: 'tool_call',
        toolName: 'wire_transfer_tool',
        steps: 1,
      });
      await memory.appendTurn('acme', 's1', { role: 'user', content: 'What is the refund window?' });
      const pack = await memory.assembleContext('acme', 'u1', 's1', 'enterprise refund window');
      expect(pack.prompt).toContain('Ada');
      expect(pack.prompt).toContain('30 days');
      expect(pack.prompt).toContain('Finance approves');
      expect(pack.prompt).toContain('What is the refund window?');
      expect(pack.prompt).not.toContain('globex-only-marker-5521');
      expect(pack.prompt).not.toContain('wire_transfer_tool');
      expect(pack.operational).toBeUndefined();
      expect(pack.tokenEstimate).toBeLessThanOrEqual(pack.tokenBudget);

      const withOps = await memory.assembleContext('acme', 'u1', 's1', 'refund', { includeOperational: true });
      expect(withOps.operational?.recentAudit.length).toBeGreaterThan(0);
      expect(withOps.prompt).toContain('kill_switch=off');
    } finally {
      await memory.close();
    }
  });

  it('stays inside a tight token budget', async () => {
    const memory = await testMemory();
    try {
      const content = 'word '.repeat(80);
      for (let i = 0; i < 12; i++) {
        await memory.appendTurn('acme', 's1', { role: 'user', content: `${content} turn-${i}` });
      }
      const pack = await memory.assembleContext('acme', 'u1', 's1', undefined, { tokenBudget: 120 });
      expect(pack.tokenEstimate).toBeLessThanOrEqual(120);
      expect(pack.truncated).toBe(true);
      expect(pack.working.length).toBeLessThan(12);
      expect(pack.working.at(-1)?.content).toContain('turn-11');
    } finally {
      await memory.close();
    }
  });
});
