import { z } from 'zod';
import type { Exchange } from '../types.js';

const support = z.object({ role: z.enum(['user', 'assistant']), quote: z.string().min(1).max(300) });
export const annotationSchema = z.object({
  topics: z.array(support.extend({ key: z.string().regex(/^[a-z0-9_.-]{1,64}$/), label: z.string().min(1).max(120) }).strict()).max(8),
  entities: z.array(support.extend({ label: z.string().min(1).max(120) }).strict()).max(16),
}).strict();
export type ConversationAnnotations = z.infer<typeof annotationSchema>;
export interface ConversationEnricher {
  readonly id: string;
  extract(exchange: Exchange): ConversationAnnotations | Promise<ConversationAnnotations>;
}

/** Annotations are routing hints, never verified facts, policies or instructions. */
export function validateAnnotations(exchange: Exchange, value: unknown): ConversationAnnotations {
  const annotations = annotationSchema.parse(value);
  if (new Set(annotations.topics.map(topic => topic.key)).size !== annotations.topics.length)
    throw new Error('Duplicate topic keys');
  if (new Set(annotations.entities.map(entity => entity.label)).size !== annotations.entities.length)
    throw new Error('Duplicate entity labels');
  for (const item of [...annotations.topics, ...annotations.entities]) {
    const text = item.role === 'user' ? exchange.question : exchange.answer;
    if (!text.includes(item.quote)) throw new Error('Annotation quote is not grounded in its attributed raw message');
  }
  for (const entity of annotations.entities) if (!entity.quote.includes(entity.label)) throw new Error('Entity label is not present in its evidence quote');
  return annotations;
}

const categories: Array<[string, string, RegExp]> = [
  ['database', 'Database decisions', /postgresql|postgres|mysql|sqlite|database|ডেটাবেস|डेटाबेस/iu],
  ['engineering', 'Software and infrastructure', /typescript|python|kubernetes|software|deployment|orchestrator|api/iu],
  ['personal', 'Personal preferences', /my name|i live|i prefer|আমার নাম|मेरा नाम|preferences?/iu],
  ['finance', 'Financial discussions', /portfolio|investment|stocks?|bitcoin|solana|budget/iu],
  ['travel', 'Travel plans', /travel|flight|hotel|itinerary|vacation/iu],
];

/** Offline, conservative taxonomy. Proper-name extraction is explicitly heuristic. */
export class LocalConversationEnricher implements ConversationEnricher {
  readonly id = 'local-grounded-taxonomy-v1';
  extract(exchange: Exchange): ConversationAnnotations {
    const topics: ConversationAnnotations['topics'] = [];
    const entities: ConversationAnnotations['entities'] = [];
    for (const [role, text] of [['user', exchange.question], ['assistant', exchange.answer]] as const) {
      for (const [key, label, pattern] of categories) {
        const match = pattern.exec(text);
        if (match && !topics.some(topic => topic.key === key)) topics.push({ key, label, role, quote: match[0] });
      }
      const names = text.matchAll(/\p{Lu}[\p{L}\p{M}\p{N}_.-]{2,79}/gu);
      for (const match of names) {
        const label = match[0].replace(/[_.-]+$/u, '');
        if (['The', 'Thanks', 'Noted', 'Remembered', 'Decision', 'User', 'Assistant', 'Keep'].includes(label)) continue;
        if (entities.length < 16 && !entities.some(entity => entity.label === label)) entities.push({ label, role, quote: label });
      }
      const named = /(?:my name is|আমার নাম|मेरा नाम)\s+([\p{L}\p{M}]+)/iu.exec(text);
      if (named && entities.length < 16 && !entities.some(entity => entity.label === named[1]))
        entities.push({ label: named[1]!, role, quote: named[0] });
    }
    return validateAnnotations(exchange, { topics, entities });
  }
}
