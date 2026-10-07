import { rmSync } from 'node:fs';
import { openMemoryService, type ContextPack } from '../src/index.js';

/**
 * Tiny app-server loop. Tenant id is chosen here, in trusted code.
 * The mock model only sees the context pack, never a tenant selector.
 */
const dbPath = 'data/example.sqlite';
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const tenantId = 'acme';
const userId = 'u_ada';
const sessionId = 's_demo';

const memory = await openMemoryService({ databasePath: dbPath, l1TtlMs: 500 });

await memory.ingestDocument(tenantId, {
  title: 'Refund policy',
  text: 'Enterprise customers can request a refund within 30 days of the invoice. Refunds over 500 USD need finance approval.',
});
await memory.ingestDocument('globex', {
  title: 'Globex secret',
  text: 'globex-internal-wire-token-9912 is restricted to the globex tenant and must never appear in acme context.',
});
await memory.setProfileFact(tenantId, userId, { key: 'preferred_name', type: 'string', value: 'Ada' });
await memory.setProfileFact(tenantId, userId, { key: 'plan', type: 'string', value: 'enterprise' });
await memory.recordEpisode(tenantId, {
  userId,
  sessionId,
  type: 'decision',
  summary: 'Refunds over 500 USD need finance approval.',
});

const script = [
  'What is the refund window for enterprise customers?',
  'Please remember that I want replies in French.',
];

for (const userText of script) {
  await memory.appendTurn(tenantId, sessionId, { role: 'user', content: userText });
  if (userText.includes('remember') && userText.includes('French')) {
    await memory.setProfileFact(tenantId, userId, { key: 'locale', type: 'string', value: 'fr' });
  }
  const pack = await memory.assembleContext(tenantId, userId, sessionId, userText);
  assertSafe(pack);
  const reply = mockModel(pack, userText);
  await memory.appendTurn(tenantId, sessionId, { role: 'assistant', content: reply });
  await memory.recordAudit(tenantId, {
    userId,
    sessionId,
    action: 'model_call',
    toolName: 'mock_llm',
    steps: 1,
    costUnits: 0.01,
    detail: { tokens: pack.tokenEstimate },
  });
  console.log(`\nuser: ${userText}`);
  console.log(`context tokens: ${pack.tokenEstimate} truncated=${pack.truncated}`);
  console.log(`assistant: ${reply}`);
}

const leaked = await memory.assembleContext(tenantId, userId, sessionId, 'wire token');
assertSafe(leaked);
const withOps = await memory.assembleContext(tenantId, userId, sessionId, 'refund', {
  includeOperational: true,
});
if (!withOps.operational) throw new Error('expected operational slice when requested');
const caps = await memory.getCaps(tenantId, { userId, sessionId });
console.log(`\ncaps steps=${caps.buckets.map((b) => `${b.scope}:${b.stepsUsed}`).join(' ')} blocked=${caps.blocked}`);
console.log('operational excluded from default prompt:', !leaked.prompt.includes('mock_llm'));
await memory.close();

function mockModel(pack: ContextPack, userText: string): string {
  const name = pack.profile.find((fact) => fact.key === 'preferred_name')?.value ?? 'there';
  const locale = pack.profile.find((fact) => fact.key === 'locale')?.value;
  const hit = pack.knowledge[0];
  const prefix = locale === 'fr' ? 'Bien sûr' : 'Sure';
  if (!hit) {
    return `${prefix}, ${String(name)}. I don't have a documented answer for "${userText.slice(0, 80)}".`;
  }
  return `${prefix}, ${String(name)}. Based on "${hit.title}": ${hit.text.slice(0, 240)}`;
}

function assertSafe(pack: ContextPack): void {
  const blob = `${pack.prompt}\n${pack.knowledge.map((hit) => hit.text).join('\n')}`;
  if (blob.includes('globex-internal-wire-token-9912')) {
    throw new Error('cross-tenant knowledge leaked into the context pack');
  }
  if (pack.operational) throw new Error('operational memory was included without being requested');
  if (!pack.prompt.includes('Ada')) throw new Error('profile fact missing from context');
}
