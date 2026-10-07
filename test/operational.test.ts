import { describe, expect, it } from 'vitest';
import { CapExceededError, KillSwitchError } from '../src/errors.js';
import { testMemory } from './helpers.js';

describe('operational memory', () => {
  it('enforces step caps without counting the rejected call', async () => {
    const memory = await testMemory();
    try {
      await memory.setCaps('acme', { scope: 'tenant', targetId: 'acme', maxSteps: 1, maxSpendUnits: null });
      await memory.recordAudit('acme', { userId: 'u1', action: 'tool_call', toolName: 'search', steps: 1 });
      await expect(
        memory.recordAudit('acme', { userId: 'u1', action: 'tool_call', toolName: 'search', steps: 1 }),
      ).rejects.toBeInstanceOf(CapExceededError);
      const caps = await memory.getCaps('acme', { userId: 'u1' });
      const tenant = caps.buckets.find((bucket) => bucket.scope === 'tenant');
      expect(tenant?.stepsUsed).toBe(1);
      const events = await memory.listAudit('acme', {});
      expect(events.map((event) => event.action)).toContain('cap_exceeded');
      expect(events.filter((event) => event.action === 'tool_call')).toHaveLength(1);
    } finally {
      await memory.close();
    }
  });

  it('blocks tool audit when the kill switch is on', async () => {
    const memory = await testMemory();
    try {
      await memory.setKillSwitch('acme', {
        scope: 'user',
        targetId: 'u1',
        enabled: true,
        reason: 'incident 19',
      });
      await expect(
        memory.recordAudit('acme', {
          userId: 'u1',
          action: 'tool_call',
          toolName: 'wire_transfer_tool',
          steps: 1,
          costUnits: 2,
        }),
      ).rejects.toBeInstanceOf(KillSwitchError);
      const caps = await memory.getCaps('acme', { userId: 'u1' });
      expect(caps.blocked).toBe(true);
      expect(caps.killSwitch?.reason).toBe('incident 19');
      expect(caps.buckets.find((bucket) => bucket.scope === 'user')?.stepsUsed).toBe(0);
      const events = await memory.listAudit('acme', { userId: 'u1' });
      expect(events[0]?.action).toBe('kill_switch_blocked');
      expect(events[0]?.detail.attemptedAction).toBe('tool_call');
    } finally {
      await memory.close();
    }
  });
});
