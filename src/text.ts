const MIN_TOKEN = 2;

/** Alphanumeric tokenizer shared by BM25 and the hashing embedder. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    const code = i < lower.length ? lower.charCodeAt(i) : 0;
    const isWord =
      i < lower.length && ((code >= 48 && code <= 57) || (code >= 97 && code <= 122));
    if (isWord) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= MIN_TOKEN) out.push(lower.slice(start, i));
      start = -1;
    }
  }
  return out;
}

export function chunkText(text: string, size = 800, overlap = 120): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < clean.length && chunks.length < 200) {
    let end = Math.min(clean.length, cursor + size);
    if (end < clean.length) {
      const space = clean.lastIndexOf(' ', end);
      if (space > cursor + Math.floor(size / 2)) end = space;
    }
    const slice = clean.slice(cursor, end).trim();
    if (slice) chunks.push(slice);
    if (end >= clean.length) break;
    const next = Math.max(end - overlap, cursor + 1);
    if (next <= cursor) break;
    cursor = next;
  }
  return chunks;
}

/** ~4 characters per token. Stable, local, and good enough for budgeting. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
