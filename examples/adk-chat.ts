import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { GeminiEmbeddingProvider } from '../src/embed/gemini.js';
import { openMemoryService } from '../src/service.js';
import { MemlayerAdapter, runAdkAnswer } from '../src/adk/adapter.js';

async function main() {
  if (!process.env.GOOGLE_API_KEY && process.env.GOOGLE_GENAI_USE_VERTEXAI !== 'true') throw new Error('Set GOOGLE_API_KEY or configure Vertex AI before running adk:dev');
  const memory = await openMemoryService({ databasePath: process.env.MEMLAYER_DB ?? 'data/adk.sqlite',
    embeddings: process.env.MEMLAYER_EMBEDDINGS === 'gemini' ? new GeminiEmbeddingProvider() : undefined });
  const adapter = new MemlayerAdapter(memory, {
    tenantId: process.env.MEMLAYER_TENANT ?? 'local', userId: process.env.MEMLAYER_USER ?? 'user',
  });
  let session = process.env.MEMLAYER_SESSION ?? 'session-1';
  const terminal = createInterface({ input: stdin, output: stdout });
  console.log('ADK + Memlayer. /session NAME changes sessions; /exit quits.');
  try {
    for (;;) {
      const question = await terminal.question(`[${session}] > `);
      if (question === '/exit') break;
      if (question.startsWith('/session ')) { const next = question.slice(9).trim(); adapter.sessionKey(next); session = next; continue; }
      if (!question.trim()) continue;
      try { console.log(await runAdkAnswer({ question, adapter, persistSession: session, model: process.env.ADK_MODEL })); }
      catch (error) { console.error(error instanceof Error ? error.message : 'Chat failed'); }
    }
  } finally { terminal.close(); await memory.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
