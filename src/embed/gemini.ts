import { GoogleGenAI } from '@google/genai';
import type { EmbeddingProvider } from './provider.js';
import { l2Normalize } from '../vector.js';
import { retryTransient } from '../adk/retry.js';

/** Use a separate SQLite file when changing embedding provider or dimensionality. */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  constructor(readonly dimensions = 768, readonly model = 'gemini-embedding-001', private readonly client = new GoogleGenAI({})) {
    if (!Number.isInteger(dimensions) || dimensions < 16 || dimensions > 1024) throw new Error('Embedding dimensions must be 16..1024');
    this.id = `google:${model}:${dimensions}:retrieval-v1`;
  }
  async embedDocuments(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i=0;i<texts.length;i+=32) out.push(...await this.embed(texts.slice(i,i+32),'RETRIEVAL_DOCUMENT'));
    return out;
  }
  async embedQuery(text: string): Promise<Float32Array> { return (await this.embed([text],'RETRIEVAL_QUERY'))[0]!; }
  private async embed(texts: readonly string[], taskType: string): Promise<Float32Array[]> {
    const response = await retryTransient(()=>this.client.models.embedContent({
      model:this.model, contents:[...texts], config:{taskType,outputDimensionality:this.dimensions,abortSignal:AbortSignal.timeout(15000)},
    }));
    if (response.embeddings?.length !== texts.length) throw new Error('Gemini returned an incorrect embedding count');
    return response.embeddings.map(e=>{
      if (e.values?.length !== this.dimensions || e.values.some(v=>!Number.isFinite(v))) throw new Error('Invalid Gemini embedding');
      return l2Normalize(Float32Array.from(e.values));
    });
  }
}
