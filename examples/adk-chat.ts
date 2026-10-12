import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { GeminiEmbeddingProvider } from '../src/embed/gemini.js';
import { openMemoryService } from '../src/service.js';
import { loadPersona } from '../src/adk/persona.js';
import { pendingReflections, reviewReflection } from '../src/adk/reflection.js';
import { MemlayerAdapter, runAdkAnswer } from '../src/adk/adapter.js';

async function main() {
  if (!process.env.GOOGLE_API_KEY && process.env.GOOGLE_GENAI_USE_VERTEXAI !== 'true') throw new Error('Set GOOGLE_API_KEY or configure Vertex AI before running adk:dev');
  const persona = await loadPersona(process.env.ADK_PERSONA_PATH || undefined);
  const memory = await openMemoryService({ databasePath: process.env.MEMLAYER_DB ?? 'data/adk.sqlite',
    embeddings: process.env.MEMLAYER_EMBEDDINGS === 'gemini' ? new GeminiEmbeddingProvider() : undefined });
  const adapter = new MemlayerAdapter(memory, {
    tenantId: process.env.MEMLAYER_TENANT ?? 'local', userId: process.env.MEMLAYER_USER ?? 'user',
  });
  let session = process.env.MEMLAYER_SESSION ?? 'session-1';
  const terminal = createInterface({ input: stdin, output: stdout });
  console.log(`${persona.name} v${persona.version}. /session NAME, /reflections, /accept ID, /reject ID, /exit.`);
  try {
    for (;;) {
      const question = await terminal.question(`[${session}] > `);
      if (question === '/exit') break;
      if (question.startsWith('/session ')) { const next = question.slice(9).trim(); adapter.sessionKey(next); session = next; continue; }
      if (!question.trim()) continue;
      if (question === '/reflections') { console.log(await pendingReflections(memory,adapter.identity)); continue; }
      if (/^\/(accept|reject) /.test(question)) {
        const [command,id] = question.split(/\s+/);
        try { console.log(await reviewReflection(memory,adapter.identity,id??'',command==='/accept'?'accepted':'rejected')); }
        catch(error) { console.error(error instanceof Error ? error.message : 'Review failed'); }
        continue;
      }
      try { console.log(await runAdkAnswer({ question, adapter, persistSession: session, model: process.env.ADK_MODEL, persona })); }
      catch (error) { console.error(error instanceof Error ? error.message : 'Chat failed'); }
    }
  } finally { terminal.close(); await memory.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
