import { ValidationError } from '../errors.js';
import type { EmbeddingProvider } from '../embed/provider.js';
import { resolveVector, resolveVectors } from '../embed/provider.js';
import type { DurableStore, StoredChunk } from '../store/sqlite.js';
import { chunkText, estimateTokens } from '../text.js';
import type { Acl, IngestDocumentInput, IngestResult, KnowledgeHit, RetrievalMode } from '../types.js';
import { aclAllows, assertMetadata, createId, normalizeAcl } from '../validate.js';
import { Bm25Index } from './bm25.js';
import { HnswIndex } from './hnsw.js';

interface IndexedChunk {
  id: string;
  documentId: string;
  title: string;
  source: string | null;
  text: string;
  tokenEstimate: number;
  acl: Acl;
}

interface TenantIndex {
  hnsw: HnswIndex;
  bm25: Bm25Index;
  chunks: IndexedChunk[];
}

const VECTOR_WEIGHT = 0.35;
const MIN_VECTOR_SCORE = 0.42;

function squashBm25(score: number): number {
  if (score <= 0) return 0;
  return score / (score + 1.5);
}

/**
 * Knowledge lives in a separate ANN + BM25 index per tenant.
 * Search never receives another tenant's vectors, so a missing filter cannot leak them.
 */
export class KnowledgeEngine {
  private readonly tenants = new Map<string, TenantIndex>();

  constructor(
    private readonly store: DurableStore,
    private readonly embedder: EmbeddingProvider,
    private readonly hnsw: { m: number; efConstruction: number; efSearch: number; seed?: number },
  ) {}

  loadFromDisk(): void {
    for (const row of this.store.listChunks()) this.addRow(row);
  }

  async ingest(tenantId: string, input: IngestDocumentInput): Promise<IngestResult> {
    const title = input.title?.trim() ?? '';
    const text = input.text?.trim() ?? '';
    if (!title || title.length > 300) throw new ValidationError('title must be 1-300 characters');
    if (!text) throw new ValidationError('Document text is empty');
    if (text.length > 500_000) throw new ValidationError('Document text exceeds 500000 characters');
    const parts = chunkText(text);
    if (parts.length === 0) throw new ValidationError('Document text is empty');
    if (parts.length > 200) throw new ValidationError('Document produced too many chunks');
    const acl = normalizeAcl(input.acl);
    const metadata = assertMetadata(input.metadata);
    const source = input.source?.trim() ? input.source.trim().slice(0, 500) : null;
    const vectors = await resolveVectors(this.embedder.embedDocuments(parts));
    if (vectors.length !== parts.length) {
      throw new ValidationError('Embedder returned the wrong number of vectors');
    }
    for (const vector of vectors) {
      if (vector.length !== this.embedder.dimensions) {
        throw new ValidationError(`Expected embedding dimension ${this.embedder.dimensions}`);
      }
    }
    const documentId = createId('doc');
    const createdAt = Date.now();
    const chunks = parts.map((part, ordinal) => ({
      id: createId('chk'),
      ordinal,
      text: part,
      tokenEstimate: estimateTokens(part),
      vector: vectors[ordinal]!,
    }));
    this.store.insertDocument({
      id: documentId,
      tenantId,
      title,
      source,
      acl,
      metadata,
      createdAt,
      chunks,
    });
    for (const chunk of chunks) {
      this.addRow({
        id: chunk.id,
        tenantId,
        documentId,
        title,
        source,
        ordinal: chunk.ordinal,
        text: chunk.text,
        tokenEstimate: chunk.tokenEstimate,
        vector: chunk.vector,
        acl,
      });
    }
    return {
      documentId,
      chunkCount: chunks.length,
      tokenEstimate: chunks.reduce((sum, chunk) => sum + chunk.tokenEstimate, 0),
    };
  }

  async search(
    tenantId: string,
    query: string,
    topK: number,
    userId?: string,
    roles?: string[],
    mode: RetrievalMode = 'hybrid',
  ): Promise<KnowledgeHit[]> {
    if (!['hybrid', 'bm25', 'vector'].includes(mode)) throw new ValidationError('Invalid retrieval mode');
    const index = this.tenants.get(tenantId);
    if (!index || index.chunks.length === 0) return [];
    const text = query.trim();
    if (!text) throw new ValidationError('query is empty');
    if (text.length > 8_000) throw new ValidationError('query exceeds 8000 characters');
    const vector = mode === 'bm25' ? null : await resolveVector(this.embedder.embedQuery(text));
    if (vector && vector.length !== this.embedder.dimensions) {
      throw new ValidationError(`Expected embedding dimension ${this.embedder.dimensions}`);
    }
    const pool = Math.max(topK * 8, 32);
    const ann = vector ? index.hnsw.search(vector, pool, Math.max(this.hnsw.efSearch, pool)) : [];
    const keywords = mode === 'vector' ? [] : index.bm25.search(text, pool);
    const vectorScores = new Map<number, number>();
    for (const hit of ann) vectorScores.set(hit.id, 1 - hit.distance);
    const keywordScores = new Map<number, number>();
    for (const hit of keywords) keywordScores.set(hit.id, hit.score);
    const ids = new Set<number>([...vectorScores.keys(), ...keywordScores.keys()]);
    const ranked: KnowledgeHit[] = [];
    for (const id of ids) {
      const chunk = index.chunks[id];
      if (!chunk || !aclAllows(chunk.acl, userId, roles)) continue;
      const vectorScore = Math.max(0, vectorScores.get(id) ?? 0);
      const keywordScore = squashBm25(keywordScores.get(id) ?? 0);
      // A lone chunk used to min-max to 1.0 and match every query.
      // Keep a keyword hit, or a vector hit that is actually close.
      if (keywordScore === 0 && vectorScore < MIN_VECTOR_SCORE) continue;
      ranked.push({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        title: chunk.title,
        source: chunk.source,
        text: chunk.text,
        score: mode === 'bm25' ? keywordScore : mode === 'vector' ? vectorScore : VECTOR_WEIGHT * vectorScore + (1 - VECTOR_WEIGHT) * keywordScore,
        vectorScore,
        keywordScore,
        tokenEstimate: chunk.tokenEstimate,
      });
    }
    ranked.sort((a, b) => b.score - a.score || (a.source ?? '').localeCompare(b.source ?? '') || a.chunkId.localeCompare(b.chunkId));
    return ranked.slice(0, topK);
  }

  private addRow(row: StoredChunk): void {
    if (row.vector.length !== this.embedder.dimensions) {
      throw new ValidationError(
        `Stored vector dim ${row.vector.length} does not match embedder dim ${this.embedder.dimensions}`,
      );
    }
    const index = this.tenant(row.tenantId);
    const internal = index.chunks.length;
    index.chunks.push({
      id: row.id,
      documentId: row.documentId,
      title: row.title,
      source: row.source,
      text: row.text,
      tokenEstimate: row.tokenEstimate,
      acl: row.acl,
    });
    index.hnsw.add(row.vector);
    index.bm25.add(internal, `${row.title}\n${row.text}`);
  }

  private tenant(tenantId: string): TenantIndex {
    let index = this.tenants.get(tenantId);
    if (!index) {
      index = {
        hnsw: new HnswIndex(this.hnsw.m, this.hnsw.efConstruction, this.hnsw.efSearch, this.hnsw.seed === undefined ? Math.random : seededRandom(this.hnsw.seed)),
        bm25: new Bm25Index(),
        chunks: [],
      };
      this.tenants.set(tenantId, index);
    }
    return index;
  }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
