import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testMemory } from './helpers.js';

describe('knowledge memory', () => {
  it('does not return another tenant even when that tenant repeats the query term', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memlayer-know-'));
    const databasePath = join(dir, 'mem.sqlite');
    const memory = await testMemory({ databasePath });
    const shared = 'zebrapayroll';
    const acme = await memory.ingestDocument('acme', {
      title: 'Acme payroll',
      text: `${shared} policy for acme employees only. alphamarkeracme991.`,
    });
    const globex = await memory.ingestDocument('globex', {
      title: 'Globex payroll',
      text: `${Array.from({ length: 40 }, () => shared).join(' ')} globex secret betamarkerglobex991.`,
    });
    const hits = await memory.searchKnowledge('acme', { query: shared, topK: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.documentId === acme.documentId)).toBe(true);
    expect(hits.some((hit) => hit.text.includes('betamarkerglobex991'))).toBe(false);
    expect(hits.some((hit) => hit.documentId === globex.documentId)).toBe(false);

    const otherWay = await memory.searchKnowledge('globex', { query: 'alphamarkeracme991', topK: 5 });
    expect(otherWay).toEqual([]);
    const globexHits = await memory.searchKnowledge('globex', { query: shared, topK: 5 });
    expect(globexHits.every((hit) => hit.documentId === globex.documentId)).toBe(true);
    await memory.close();

    const reloaded = await testMemory({ databasePath });
    try {
      const again = await reloaded.searchKnowledge('acme', { query: shared, topK: 5 });
      expect(again.every((hit) => hit.documentId === acme.documentId)).toBe(true);
      expect(again.some((hit) => hit.text.includes('betamarkerglobex991'))).toBe(false);
    } finally {
      await reloaded.close();
    }
  });

  it('applies within-tenant ACL', async () => {
    const memory = await testMemory();
    try {
      await memory.ingestDocument('acme', {
        title: 'Restricted runbook',
        text: 'pagerduty-escalation-77 is only for oncall users.',
        acl: { visibility: 'restricted', userIds: ['u_oncall'], roles: ['sre'] },
      });
      const stranger = await memory.searchKnowledge('acme', {
        query: 'pagerduty-escalation-77',
        userId: 'u_other',
        topK: 5,
      });
      expect(stranger).toEqual([]);
      const allowed = await memory.searchKnowledge('acme', {
        query: 'pagerduty-escalation-77',
        userId: 'u_oncall',
        topK: 5,
      });
      expect(allowed[0]?.text).toContain('pagerduty-escalation-77');
      const byRole = await memory.searchKnowledge('acme', {
        query: 'pagerduty-escalation-77',
        userId: 'u_other',
        roles: ['sre'],
        topK: 5,
      });
      expect(byRole.length).toBeGreaterThan(0);
    } finally {
      await memory.close();
    }
  });
});
