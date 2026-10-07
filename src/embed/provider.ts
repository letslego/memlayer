/**
 * Pluggable embeddings. Local providers may return Float32Array synchronously
 * so search does not pay a microtask. Remote providers return a Promise.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embedDocuments(texts: readonly string[]): Float32Array[] | Promise<Float32Array[]>;
  embedQuery(text: string): Float32Array | Promise<Float32Array>;
}

export async function resolveVectors(
  value: Float32Array[] | Promise<Float32Array[]>,
): Promise<Float32Array[]> {
  return value instanceof Promise ? value : value;
}

export async function resolveVector(value: Float32Array | Promise<Float32Array>): Promise<Float32Array> {
  return value instanceof Promise ? value : value;
}
