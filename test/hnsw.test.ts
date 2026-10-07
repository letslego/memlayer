import { describe, expect, it } from 'vitest';
import { Bm25Index } from '../src/knowledge/bm25.js';
import { HnswIndex } from '../src/knowledge/hnsw.js';
import { l2Normalize } from '../src/vector.js';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('hnsw', () => {
  it('finds each inserted vector as its nearest neighbor', () => {
    const dim = 32;
    const rng = mulberry32(7);
    const index = new HnswIndex(16, 64, 64, () => 0);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < 48; i++) {
      const vector = new Float32Array(dim);
      for (let d = 0; d < dim; d++) vector[d] = rng() * 2 - 1;
      const normalized = l2Normalize(vector);
      vectors.push(normalized);
      index.add(normalized);
    }
    for (let i = 0; i < vectors.length; i++) {
      const hits = index.search(vectors[i]!, 1, 128);
      expect(hits[0]?.id).toBe(i);
      expect(hits[0]?.distance ?? 1).toBeLessThan(1e-5);
    }
  });
});

describe('bm25', () => {
  it('ranks the document with the higher term frequency first', () => {
    const index = new Bm25Index();
    index.add(0, 'quartzwidget appears once');
    index.add(1, 'quartzwidget quartzwidget quartzwidget in the runbook');
    index.add(2, 'unrelated payroll calendar');
    const hits = index.search('quartzwidget', 3);
    expect(hits[0]?.id).toBe(1);
    expect(hits.some((hit) => hit.id === 2)).toBe(false);
  });
});
