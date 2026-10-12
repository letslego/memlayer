import { expect, it, vi } from 'vitest';
import { GoogleGenAI } from '@google/genai';
import { GeminiEmbeddingProvider } from '../src/embed/gemini.js';

it('uses retrieval task types, checks provider output and normalizes vectors',async()=>{
  const client = new GoogleGenAI({apiKey:'offline-test-key'});
  const embed = vi.spyOn(client.models,'embedContent').mockResolvedValue({
    embeddings:[{values:[3,4,...Array(14).fill(0)]}],
  });
  const provider = new GeminiEmbeddingProvider(16,'test-embedding',client);
  const query = await provider.embedQuery('Princeton');
  expect(query[0]).toBeCloseTo(0.6);
  expect(query[1]).toBeCloseTo(0.8);
  expect(embed.mock.calls[0]![0].config?.taskType).toBe('RETRIEVAL_QUERY');
  await provider.embedDocuments(['A historical dialogue']);
  expect(embed.mock.calls[1]![0].config?.taskType).toBe('RETRIEVAL_DOCUMENT');
  embed.mockResolvedValue({embeddings:[{values:[1]}]});
  await expect(provider.embedQuery('x')).rejects.toThrow('Invalid Gemini embedding');
  embed.mockRestore();
});
