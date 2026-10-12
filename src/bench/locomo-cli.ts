import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { GeminiEmbeddingProvider } from '../embed/gemini.js';
import { retryTransient } from '../adk/retry.js';
import { openMemoryService } from '../service.js';
import { DEFAULT_MODEL, MemlayerAdapter, runAdkAnswer } from '../adk/adapter.js';
import { average, answerScore, evidenceIds, ingestSample, parseLocomo, retrieve, scoreEvidence } from './locomo.js';
import type { Metrics } from './locomo.js';
import type { EvaluationMode } from '../knowledge/rerank.js';

interface AnswerResult { prediction?: string; error?: string; exactMatch: number; tokenF1: number; latencyMs: number }
type AnswerPair = Record<'memory' | 'noMemory', AnswerResult>;
function summarizeAnswers(pairs: AnswerPair[]) {
  return Object.fromEntries(['memory','noMemory'].map(label=>{
    const results = pairs.map(p=>p[label as keyof AnswerPair]);
    return [label,{ attempts:results.length, failures:results.filter(r=>r.error).length,
      exactMatch:results.length ? results.reduce((n,r)=>n+r.exactMatch,0)/results.length : null,
      tokenF1:results.length ? results.reduce((n,r)=>n+r.tokenF1,0)/results.length : null }];
  }));
}
async function main() {
  const { values } = parseArgs({ options: {
    data: { type:'string', default:'data/locomo10.json' }, out: { type:'string', default:'reports/locomo.json' },
    embeddings: { type:'string', default:'hash' },
    answers: { type:'boolean', default:false }, model: { type:'string', default: DEFAULT_MODEL },
    limit: { type:'string' }, 'min-recall10': { type:'string' }, mode: { type:'string', default:'hybrid' },
  } });
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
  const threshold = values['min-recall10'] === undefined ? undefined : Number(values['min-recall10']);
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) throw new Error('--min-recall10 must be 0..1');
  if (!['hybrid','bm25','vector','hybrid-rerank'].includes(values.mode)) throw new Error('--mode must be hybrid, bm25, vector or hybrid-rerank');
  const mode = values.mode as EvaluationMode;
  if (values.answers && !process.env.GOOGLE_API_KEY && process.env.GOOGLE_GENAI_USE_VERTEXAI !== 'true') throw new Error('Answer benchmark requires GOOGLE_API_KEY or configured Vertex AI');
  if (!['hash','gemini'].includes(values.embeddings)) throw new Error('--embeddings must be hash or gemini');
  const embeddings = values.embeddings === 'gemini' ? new GeminiEmbeddingProvider() : undefined;
  const bytes = await readFile(values.data);
  const samples = parseLocomo(JSON.parse(bytes.toString()));
  const memory = await openMemoryService({ databasePath: ':memory:', hnswSeed: 42, embeddings });
  const rows: { sample: string; question: string; category: number; evidenceLabels: string[]; gold: string[]; retrieved: string[]; metrics: Metrics | null; skipReason: string | null; latencyMs: number; answers?: AnswerPair }[] = [];
  let attempted = 0;
  let answerFailures = 0;
  try {
    for (const sample of samples) {
      if (attempted >= limit) break;
      console.error(`Indexing ${sample.id}: ${sample.turns.length} dialogues`);
      await ingestSample(memory,sample);
      const valid = new Set(sample.turns.map(t=>t.id));
      for (const qa of sample.qa) {
        if (attempted >= limit) break;
        attempted++;
        const gold = evidenceIds(qa.evidence);
        const skipReason = qa.category === 5 ? 'adversarial' : !gold.length ? 'no_evidence' : gold.some(id=>!valid.has(id)) ? 'unresolved_evidence' : null;
        const start = performance.now();
        const hits = await retrieve(memory,sample.id,qa.question,mode);
        const retrieved = hits.map(h=>h.source!);
        const row = { sample: sample.id, question: qa.question, category: qa.category, evidenceLabels: qa.evidence, gold, retrieved,
          metrics: skipReason ? null : scoreEvidence(retrieved,gold), skipReason, latencyMs: performance.now()-start };
        let answers: AnswerPair | undefined;
        // Adversarial questions have no ordinary reference answer; don't invent one.
        if (values.answers && qa.category !== 5 && qa.answer !== undefined) {
          const pair = {} as AnswerPair;
          for (const enabled of [false,true]) {
            const label = enabled ? 'memory' : 'noMemory';
            const t0 = performance.now();
            try {
              const prediction = await retryTransient(()=>runAdkAnswer({ question: qa.question, model: values.model,
                adapter: enabled ? new MemlayerAdapter(memory,{tenantId:sample.id,userId:'benchmark'},mode) : undefined,
                context: enabled ? JSON.stringify(hits.map(h=>({id:h.source,text:h.text}))) : undefined }));
              pair[label] = { prediction, ...answerScore(prediction,qa.answer), latencyMs:performance.now()-t0 };
            } catch { answerFailures++; pair[label] = { error: 'model_call_failed', exactMatch:0, tokenF1:0, latencyMs:performance.now()-t0 }; }
          }
          answers = pair;
        }
        rows.push({ ...row, ...(answers ? { answers } : {}) });
      }
    }
  } finally { await memory.close(); }
  const scored = rows.flatMap(r=>r.metrics ? [r.metrics] : []);
  const overall = average(scored);
  const report = { schemaVersion:1, answerSummary:summarizeAnswers(rows.flatMap(r=>r.answers?[r.answers]:[])), datasetSha256:createHash('sha256').update(bytes).digest('hex'),
    embedding:embeddings?.id ?? 'hashing-trick-v1', dimensions:embeddings?.dimensions ?? 128, hnswSeed:42, mode, model:values.answers ? values.model : null,
    answerEvaluator: values.answers ? 'normalized-exact-match-and-token-f1 (not official LoCoMo scoring)' : null,
    questions:rows.length, scoredQuestions:scored.length, answerFailures, overall,
    byCategory:Object.fromEntries([1,2,3,4,5].map(c=>[c,{ questions:rows.filter(r=>r.category===c).length, scoredQuestions:rows.filter(r=>r.category===c&&r.metrics).length,
      metrics:average(rows.flatMap(r=>r.category===c&&r.metrics?[r.metrics]:[])),
      answers:summarizeAnswers(rows.flatMap(r=>r.category===c&&r.answers?[r.answers]:[])) }])),
    skipped: rows.filter(r=>r.skipReason).reduce<Record<string,number>>((a,r)=>{a[r.skipReason!]=(a[r.skipReason!]??0)+1;return a;},{}), rows };
  await mkdir(dirname(values.out),{recursive:true});
  await writeFile(values.out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({questions:report.questions,scoredQuestions:report.scoredQuestions,overall,skipped:report.skipped,answerFailures,out:values.out},null,2));
  if (answerFailures || !overall || (threshold !== undefined && overall.recall10 < threshold)) process.exitCode = 1;
}
main().catch(error=>{ console.error(error.message); process.exitCode=1; });
