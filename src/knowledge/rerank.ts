import { tokenize } from '../text.js';
import type { KnowledgeHit, RetrievalMode } from '../types.js';

export type EvaluationMode = RetrievalMode | 'hybrid-rerank';
/** Cheap lexical coverage reranker; a baseline, not a learned cross-encoder. */
export function lexicalRerank(query: string, hits: KnowledgeHit[]): KnowledgeHit[] {
  const tokens = new Set(tokenize(query));
  const score = (hit: KnowledgeHit) => {
    const words = new Set(tokenize(hit.text));
    const coverage = [...tokens].filter(t=>words.has(t)).length / Math.max(1,tokens.size);
    return coverage + 0.1*hit.score;
  };
  return [...hits].sort((a,b)=>score(b)-score(a)||(a.source??'').localeCompare(b.source??''));
}
