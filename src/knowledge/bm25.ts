import { tokenize } from '../text.js';

const K1 = 1.2;
const B = 0.75;

/** In-process BM25 index. Document ids are dense and append-only. */
export class Bm25Index {
  private readonly df = new Map<string, number>();
  private readonly postings = new Map<string, Array<{ id: number; tf: number }>>();
  private readonly docLengths: number[] = [];
  private totalLength = 0;

  get size(): number {
    return this.docLengths.length;
  }

  add(id: number, text: string): void {
    if (id !== this.docLengths.length) {
      throw new Error('BM25 document ids must be appended in order');
    }
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let length = 0;
    for (const [token, tf] of counts) {
      length += tf;
      this.df.set(token, (this.df.get(token) ?? 0) + 1);
      const list = this.postings.get(token);
      if (list) list.push({ id, tf });
      else this.postings.set(token, [{ id, tf }]);
    }
    this.docLengths.push(length);
    this.totalLength += length;
  }

  search(query: string, k: number): Array<{ id: number; score: number }> {
    const total = this.docLengths.length;
    if (total === 0 || k <= 0) return [];
    const avgdl = this.totalLength / total || 1;
    const scores = new Map<number, number>();
    const seen = new Set<string>();
    for (const token of tokenize(query)) {
      if (seen.has(token)) continue;
      seen.add(token);
      const df = this.df.get(token);
      const postings = this.postings.get(token);
      if (!df || !postings) continue;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      for (const posting of postings) {
        const dl = this.docLengths[posting.id] ?? 0;
        const denom = posting.tf + K1 * (1 - B + B * (dl / avgdl));
        const increment = idf * ((posting.tf * (K1 + 1)) / (denom || 1));
        scores.set(posting.id, (scores.get(posting.id) ?? 0) + increment);
      }
    }
    const ranked = [...scores.entries()].map(([id, score]) => ({ id, score }));
    ranked.sort((a, b) => b.score - a.score || a.id - b.id);
    return ranked.slice(0, k);
  }
}
