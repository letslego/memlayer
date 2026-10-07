import { openMemoryService } from '../service.js';

interface Sample {
  name: string;
  opsPerSec: number;
  p50: number;
  p99: number;
  samples: number;
}

async function main(): Promise<void> {
  const memory = await openMemoryService({
    databasePath: ':memory:',
    l1TtlMs: 500,
    l1Max: 10_000,
    embeddingDim: 128,
  });
  const tenant = 'acme';
  const user = 'u_bench';
  const session = 's_bench';

  for (let i = 0; i < 8; i++) {
    await memory.appendTurn(tenant, session, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Turn ${i} discusses refund window, enterprise plan, and ticket ${i}.`,
    });
  }
  for (const [key, value] of [
    ['preferred_name', 'Ada'],
    ['plan', 'enterprise'],
    ['locale', 'en'],
    ['team', 'billing'],
    ['channel', 'email'],
  ] as const) {
    await memory.setProfileFact(tenant, user, { key, type: 'string', value });
  }
  for (let i = 0; i < 60; i++) {
    await memory.ingestDocument(tenant, {
      title: `Policy ${i}`,
      text: `Document ${i} covers topic token${i} for enterprise billing. Refund window is 30 days for plan tier ${i % 5}.`,
    });
  }

  const getSession = await measure('getSession', 400, 4_000, () => memory.getWorkingMemory(tenant, session));
  const appendTurn = await measure('appendTurn', 200, 2_000, () =>
    memory.appendTurn(tenant, session, {
      role: 'user',
      content: 'Follow-up on the enterprise refund window.',
    }),
  );
  const getProfile = await measure('getProfile', 400, 4_000, () => memory.getProfile(tenant, user));
  const searchKnowledge = await measure('searchKnowledge', 40, 400, () =>
    memory.searchKnowledge(tenant, { query: 'enterprise refund window 30 days', topK: 5 }),
  );

  console.log(`memlayer bench  node=${process.version}  redis=memory  db=sqlite  embed=hashing-trick-v1  dim=128`);
  console.log('hot path: getSession and getProfile are L1 hits after warmup; appendTurn writes through; searchKnowledge runs HNSW+BM25');
  const header = `${pad('op', 18)}${pad('ops/sec', 14)}${pad('p50_ms', 12)}${pad('p99_ms', 12)}samples`;
  console.log(header);
  for (const row of [getSession, appendTurn, getProfile, searchKnowledge]) {
    console.log(
      `${pad(row.name, 18)}${pad(formatOps(row.opsPerSec), 14)}${pad(formatMs(row.p50), 12)}${pad(formatMs(row.p99), 12)}${row.samples}`,
    );
  }
  await memory.close();
}

async function measure(
  name: string,
  warmup: number,
  samples: number,
  fn: () => Promise<unknown>,
): Promise<Sample> {
  for (let i = 0; i < warmup; i++) await fn();
  const latencies = new Array<number>(samples);
  const started = process.hrtime.bigint();
  for (let i = 0; i < samples; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    latencies[i] = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  latencies.sort((a, b) => a - b);
  return {
    name,
    opsPerSec: samples / (elapsedMs / 1000),
    p50: percentile(latencies, 50),
    p99: percentile(latencies, 99),
    samples,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function formatOps(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatMs(value: number): string {
  if (value >= 10) return value.toFixed(2);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
