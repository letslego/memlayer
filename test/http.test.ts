import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/http/server.js';
import { testMemory } from './helpers.js';

describe('http api', () => {
  it('rejects a missing key and a payload tenant that does not match the key', async () => {
    const memory = await testMemory();
    const app = buildServer({
      memory,
      apiKeys: { 'key-acme': 'acme', 'key-globex': 'globex' },
    });
    try {
      const open = await app.inject({ method: 'GET', url: '/health' });
      expect(open.statusCode).toBe(200);

      const showcase = await app.inject({ method: 'GET', url: '/showcase' });
      expect(showcase.statusCode).toBe(200);
      expect(showcase.headers['content-type']).toContain('text/html');
      expect(showcase.body).toContain('five memory layers');

      const missing = await app.inject({ method: 'GET', url: '/v1/users/u1/profile' });
      expect(missing.statusCode).toBe(401);

      await memory.ingestDocument('acme', {
        title: 'Acme doc',
        text: 'alpha-marker-acme zebrapayroll for acme',
      });
      await memory.ingestDocument('globex', {
        title: 'Globex doc',
        text: `${'zebrapayroll '.repeat(30)} beta-marker-globex`,
      });

      const mismatch = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/search',
        headers: { 'x-api-key': 'key-acme', 'content-type': 'application/json' },
        payload: { tenantId: 'globex', query: 'zebrapayroll' },
      });
      expect(mismatch.statusCode).toBe(403);
      expect(mismatch.json().error.code).toBe('tenant_mismatch');

      const search = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/search?tenantId=globex',
        headers: { 'x-api-key': 'key-acme', 'content-type': 'application/json' },
        payload: { query: 'zebrapayroll', topK: 5 },
      });
      expect(search.statusCode).toBe(403);

      const allowed = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/search',
        headers: { authorization: 'Bearer key-acme', 'content-type': 'application/json' },
        payload: { query: 'zebrapayroll', topK: 5 },
      });
      expect(allowed.statusCode).toBe(200);
      const hits = allowed.json().hits as Array<{ text: string; documentId: string }>;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.text.includes('alpha-marker-acme'))).toBe(true);
      expect(hits.some((hit) => hit.text.includes('beta-marker-globex'))).toBe(false);

      const context = await app.inject({
        method: 'POST',
        url: '/v1/context',
        headers: { 'x-api-key': 'key-acme', 'content-type': 'application/json' },
        payload: { userId: 'u1', sessionId: 's1', query: 'zebrapayroll', tenantId: 'acme' },
      });
      expect(context.statusCode).toBe(200);
      expect(context.json().prompt).not.toContain('beta-marker-globex');
    } finally {
      await app.close();
      await memory.close();
    }
  });
});
