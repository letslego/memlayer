import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { openMemoryService } from '../service.js';

// Hand-authored routing checks, deliberately not a representative answer benchmark.
const cases = [
  { text: 'We chose PostgreSQL.', query: 'database', positive: true },
  { text: 'We deployed Kubernetes.', query: 'engineering', positive: true },
  { text: 'My name is Amitabha.', query: 'personal', positive: true },
  { text: 'Our portfolio includes Solana.', query: 'finance', positive: true },
  { text: 'Book a flight to Kolkata.', query: 'travel', positive: true },
  { text: 'A sparrow visited the garden.', query: 'database', positive: false },
];

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'reports/conversation-routing.json' } } });
  const memory = await openMemoryService({ databasePath: ':memory:' });
  const rows: Array<{ query: string; expected: boolean; rawHit: boolean; enrichedHit?: boolean }> = [];
  const commitMs: number[] = [];
  try {
    for (const [i, sample] of cases.entries()) {
      const start = performance.now();
      await memory.commitExchange('fixture', { userId: 'user', sessionId: `case-${i}`, requestId: `request-${i}`,
        question: sample.text, answer: 'Noted.' });
      commitMs.push(performance.now() - start);
      const raw = await memory.searchExchanges('fixture', { userId: 'user', sessionId: `case-${i}`, query: sample.query, limit: 5 });
      rows.push({ query: sample.query, expected: sample.positive, rawHit: raw.length > 0 });
    }
    const indexing = await memory.drainIndexing();
    for (const [i, sample] of cases.entries()) {
      const enriched = await memory.searchExchanges('fixture', { userId: 'user', sessionId: `case-${i}`, query: sample.query, limit: 5 });
      rows[i]!.enrichedHit = enriched.length > 0;
    }
    const leaked = await memory.searchExchanges('fixture', { userId: 'other-user', query: 'database' });
    const report = { schemaVersion: 1, fixture: 'six-hand-authored-topic-routing-checks-v1',
      limitations: 'Synthetic routing checks, not live-model answer accuracy or representative LoCoMo quality. Commit timings use an empty in-memory SQLite database and no remote provider.',
      extractor: 'local-grounded-taxonomy-v1', indexing, rows, commitMs,
      enrichedRoutingPassed: rows.every(row => row.enrichedHit === row.expected), crossUserLeakCount: leaked.length };
    await mkdir(dirname(values.out), { recursive: true });
    await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (!report.enrichedRoutingPassed || leaked.length || indexing.failed || indexing.stale) process.exitCode = 1;
  } finally { await memory.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Conversation benchmark failed'); process.exitCode = 1; });
