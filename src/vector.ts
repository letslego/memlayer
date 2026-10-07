export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i] ?? 0;
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (norm === 0) {
    if (out.length > 0) out[0] = 1;
    return out;
  }
  const inv = 1 / norm;
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] ?? 0) * inv;
  return out;
}

/** Cosine distance for L2-normalized vectors. Range is [0, 2]. */
export function cosineDistance(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  const n = left.length;
  let i = 0;
  for (; i + 7 < n; i += 8) {
    dot +=
      (left[i] ?? 0) * (right[i] ?? 0) +
      (left[i + 1] ?? 0) * (right[i + 1] ?? 0) +
      (left[i + 2] ?? 0) * (right[i + 2] ?? 0) +
      (left[i + 3] ?? 0) * (right[i + 3] ?? 0) +
      (left[i + 4] ?? 0) * (right[i + 4] ?? 0) +
      (left[i + 5] ?? 0) * (right[i + 5] ?? 0) +
      (left[i + 6] ?? 0) * (right[i + 6] ?? 0) +
      (left[i + 7] ?? 0) * (right[i + 7] ?? 0);
  }
  for (; i < n; i++) dot += (left[i] ?? 0) * (right[i] ?? 0);
  if (dot > 1) dot = 1;
  else if (dot < -1) dot = -1;
  return 1 - dot;
}

export function vectorToBytes(vector: Float32Array): Uint8Array {
  const copy = new Uint8Array(vector.byteLength);
  copy.set(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength));
  return copy;
}

export function bytesToVector(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) throw new Error('Vector blob length is not a multiple of 4');
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}
