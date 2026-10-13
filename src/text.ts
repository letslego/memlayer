const MIN_TOKEN = 2;

/** Unicode lexical tokenizer shared by BM25 and the opt-in v2 hash embedder. */
export function tokenize(text: string): string[] {
  return (text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [])
    .filter(token => token.length >= MIN_TOKEN);
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
