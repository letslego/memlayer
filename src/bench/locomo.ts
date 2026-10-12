import { z } from 'zod';
import type { MemoryService } from '../service.js';
import type { KnowledgeHit } from '../types.js';
import { lexicalRerank } from '../knowledge/rerank.js';
import type { EvaluationMode } from '../knowledge/rerank.js';

const turnSchema = z.object({ dia_id: z.string().min(1), speaker: z.string(), text: z.string(), blip_caption: z.string().optional() });
const qaSchema = z.object({ question: z.string().min(1), answer: z.union([z.string(), z.number()]).optional(),
  evidence: z.array(z.string()).default([]), category: z.number().int().min(1).max(5) });
const sampleSchema = z.object({ sample_id: z.string().min(1), conversation: z.record(z.unknown()), qa: z.array(qaSchema) });
export interface Dialogue { id: string; session: string; date: string; speaker: string; text: string }
export interface Sample { id: string; turns: Dialogue[]; qa: z.infer<typeof qaSchema>[] }

export function parseLocomo(value: unknown): Sample[] {
  const raw = z.array(sampleSchema).min(1).parse(value);
  const sampleIds = new Set<string>();
  return raw.map(sample => {
    if (sampleIds.has(sample.sample_id)) throw new Error(`Duplicate sample ${sample.sample_id}`);
    sampleIds.add(sample.sample_id);
    const ids = new Set<string>();
    const sessions = Object.keys(sample.conversation).filter(k => /^session_\d+$/.test(k)).sort((a,b) => Number(a.slice(8)) - Number(b.slice(8)));
    const turns = sessions.flatMap(session => {
      const date = z.string().parse(sample.conversation[`${session}_date_time`]);
      return z.array(turnSchema).parse(sample.conversation[session]).map(turn => {
        if (ids.has(turn.dia_id)) throw new Error(`Duplicate dialogue ${turn.dia_id}`);
        ids.add(turn.dia_id);
        return { id: turn.dia_id, session, date, speaker: turn.speaker,
          text: turn.text + (turn.blip_caption ? `\nImage caption: ${turn.blip_caption}` : '') };
      });
    });
    if (!turns.length) throw new Error(`No dialogue in ${sample.sample_id}`);
    return { id: sample.sample_id, turns, qa: sample.qa };
  });
}

/** Split combined IDs and normalize zero padding; unresolved labels remain auditable. */
export function evidenceIds(labels: string[]): string[] {
  return [...new Set(labels.flatMap(label => {
    const matches = [...label.matchAll(/D:?(\d+):(\d+)/g)];
    return matches.length ? matches.map(m => `D${Number(m[1])}:${Number(m[2])}`) : [label];
  }))];
}
export async function ingestSample(memory: MemoryService, sample: Sample) {
  for (const turn of sample.turns) {
    await memory.ingestDocument(sample.id, {
      title: `${turn.speaker} ${turn.session}`, source: turn.id,
      text: `[${turn.id}] ${turn.date}\n${turn.speaker}: ${turn.text}`,
      metadata: { session: turn.session, date: turn.date, speaker: turn.speaker, evidenceId: turn.id },
    }, { timeoutMs: 60000 });
  }
}
export interface Metrics { recall1: number; recall5: number; recall10: number; precision10: number; mrr: number }
export function scoreEvidence(ranked: string[], goldLabels: string[]): Metrics {
  const gold = new Set(evidenceIds(goldLabels));
  if (!gold.size) throw new Error('Evidence metrics require nonempty gold labels');
  const unique = [...new Set(ranked)];
  const count = (k: number) => unique.slice(0,k).filter(id => gold.has(id)).length;
  const first = unique.findIndex(id => gold.has(id));
  return { recall1: count(1)/gold.size, recall5: count(5)/gold.size, recall10: count(10)/gold.size,
    precision10: count(10)/10, mrr: first < 0 ? 0 : 1/(first+1) };
}
export function evidenceHits(hits: KnowledgeHit[]): KnowledgeHit[] {
  const seen = new Set<string>();
  return hits.filter(h => { if (!h.source || seen.has(h.source)) return false; seen.add(h.source); return true; });
}
export async function retrieve(memory: MemoryService, sampleId: string, query: string, mode: EvaluationMode) {
  // Over-fetch to collapse multiple chunks of one dialogue into one evidence item.
  const hits = evidenceHits(await memory.searchKnowledge(sampleId, { query, topK: 20, mode: mode === 'hybrid-rerank' ? 'hybrid' : mode }, { timeoutMs: 60000 }));
  return (mode === 'hybrid-rerank' ? lexicalRerank(query,hits) : hits).slice(0,10);
}
export function average(rows: Metrics[]): Metrics | null {
  if (!rows.length) return null;
  const out = { recall1: 0, recall5: 0, recall10: 0, precision10: 0, mrr: 0 };
  for (const key of Object.keys(out) as (keyof Metrics)[]) out[key] = rows.reduce((s,r)=>s+r[key],0)/rows.length;
  return out;
}
export function answerScore(prediction: string, answer: string | number) {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g,' ').replace(/\b(a|an|the)\b/g,' ').trim().split(/\s+/).filter(Boolean);
  const p = normalize(prediction), g = normalize(String(answer));
  const counts = new Map<string,number>(); for (const token of g) counts.set(token,(counts.get(token)??0)+1);
  let overlap = 0;
  for (const token of p) { const n = counts.get(token)??0; if(n) { overlap++; counts.set(token,n-1); } }
  return { exactMatch: p.join(' ') === g.join(' ') ? 1 : 0,
    tokenF1: p.length+g.length ? 2*overlap/(p.length+g.length) : 1 };
}
