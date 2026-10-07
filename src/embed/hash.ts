import type { EmbeddingProvider } from './provider.js';
import { tokenize } from '../text.js';
import { l2Normalize } from '../vector.js';

/**
 * Signed feature hashing (no model download). Deterministic and fast.
 * Swap this for a hosted embedder by passing another EmbeddingProvider.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hashing-trick-v1';

  constructor(readonly dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions < 16) {
      throw new Error('embedding dimensions must be an integer >= 16');
    }
  }

  embedDocuments(texts: readonly string[]): Float32Array[] {
    return texts.map((text) => this.embedOne(text));
  }

  embedQuery(text: string): Float32Array {
    return this.embedOne(text);
  }

  private embedOne(text: string): Float32Array {
    const out = new Float32Array(this.dimensions);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      out[0] = 1;
      return out;
    }
    const dim = this.dimensions;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const h1 = fnv(token, 2_166_136_261);
      out[h1 % dim] = (out[h1 % dim] ?? 0) + ((h1 & 1024) === 0 ? 1 : -1);
      const h2 = fnv(token, 2_166_136_261 ^ 0x9e37_79b9);
      out[h2 % dim] = (out[h2 % dim] ?? 0) + ((h2 & 2048) === 0 ? 0.5 : -0.5);
      const next = tokens[i + 1];
      if (next) {
        const h3 = fnv(`${token}_${next}`, 2_166_136_261 ^ 0x85eb_ca6b);
        out[h3 % dim] = (out[h3 % dim] ?? 0) + ((h3 & 4096) === 0 ? 0.75 : -0.75);
      }
    }
    return l2Normalize(out);
  }
}

function fnv(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
