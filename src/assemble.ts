import { estimateTokens } from './text.js';
import type {
  AuditEvent,
  CapsSnapshot,
  ContextPack,
  Episode,
  KnowledgeHit,
  ProfileFact,
  Turn,
} from './types.js';

export interface AssembleSources {
  tenantId: string;
  userId: string;
  sessionId: string;
  budget: number;
  turns: Turn[];
  facts: ProfileFact[];
  hits: KnowledgeHit[];
  episodes: Episode[];
  operational?: {
    caps: CapsSnapshot;
    recentAudit: AuditEvent[];
  };
}

interface Fitted<T> {
  header: string;
  items: T[];
}

/**
 * Packs layers into a character budget (4 chars ≈ 1 token).
 * Operational memory is omitted unless the caller attached it.
 * Working memory receives whatever budget the smaller layers do not use.
 */
export function buildContextPack(sources: AssembleSources): ContextPack {
  const budget = sources.budget;
  let remaining = budget * 4;
  let truncated = false;
  const blocks: string[] = [];

  const profileItems = [...sources.facts]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
    .map((fact) => ({ value: fact, text: `- ${fact.key}: ${formatValue(fact.value)}` }));
  const profile = fit(profileItems, '## Profile', 0.15, true);

  const episodeItems = sources.episodes.map((episode) => ({
    value: episode,
    text: `- ${new Date(episode.occurredAt).toISOString()} ${episode.type}: ${episode.summary}`,
  }));
  const episodes = fit(episodeItems, '## Episodes', 0.15, true);

  const knowledgeItems = sources.hits.map((hit) => ({
    value: hit,
    text: `- [${hit.title}] ${hit.text}`,
  }));
  const knowledge = sources.hits.length
    ? fit(knowledgeItems, '## Knowledge', 0.35, true)
    : { header: '', items: [] as KnowledgeHit[] };

  const turnItems = sources.turns.map((turn) => ({ value: turn, text: formatTurn(turn) }));
  const working = fitSuffix(turnItems, '## Conversation');

  if (sources.operational) {
    const line = formatOperational(sources.operational.caps, sources.operational.recentAudit.length);
    fit([{ value: line, text: line }], '## Operational', 0.1, true);
  }

  const prompt = blocks.join('\n\n');
  return {
    tenantId: sources.tenantId,
    userId: sources.userId,
    sessionId: sources.sessionId,
    working: working.items,
    profile: profile.items,
    knowledge: knowledge.items,
    episodes: episodes.items,
    ...(sources.operational ? { operational: sources.operational } : {}),
    prompt,
    tokenEstimate: estimateTokens(prompt),
    tokenBudget: budget,
    truncated,
  };

  function fit<T>(
    items: Array<{ value: T; text: string }>,
    header: string,
    ratio: number,
    markTruncation: boolean,
  ): Fitted<T> {
    if (items.length === 0) return { header, items: [] };
    const separator = blocks.length > 0 ? 2 : 0;
    const available = remaining - separator;
    const cap = Math.min(available, Math.floor(budget * ratio) * 4);
    const headerCost = header.length + 1;
    if (cap <= headerCost) {
      if (markTruncation) truncated = true;
      return { header, items: [] };
    }
    const kept: Array<{ value: T; text: string }> = [];
    let used = headerCost;
    for (const item of items) {
      const cost = item.text.length + 1;
      if (used + cost > cap) {
        if (markTruncation) truncated = true;
        break;
      }
      kept.push(item);
      used += cost;
    }
    if (kept.length === 0) {
      if (markTruncation) truncated = true;
      return { header, items: [] };
    }
    if (kept.length < items.length && markTruncation) truncated = true;
    const lines = [header, ...kept.map((item) => item.text)];
    blocks.push(lines.join('\n'));
    remaining -= lines.join('\n').length + separator;
    return { header, items: kept.map((item) => item.value) };
  }

  function fitSuffix(items: Array<{ value: Turn; text: string }>, header: string): Fitted<Turn> {
    if (items.length === 0) return { header, items: [] };
    const separator = blocks.length > 0 ? 2 : 0;
    const cap = remaining - separator;
    const headerCost = header.length + 1;
    if (cap <= headerCost) {
      truncated = true;
      return { header, items: [] };
    }
    const kept: Array<{ value: Turn; text: string }> = [];
    let used = headerCost;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      const cost = item.text.length + 1;
      if (used + cost > cap) {
        truncated = true;
        break;
      }
      kept.push(item);
      used += cost;
    }
    if (kept.length === 0) {
      truncated = true;
      return { header, items: [] };
    }
    kept.reverse();
    const lines = [header, ...kept.map((item) => item.text)];
    blocks.push(lines.join('\n'));
    remaining -= lines.join('\n').length + separator;
    return { header, items: kept.map((item) => item.value) };
  }
}

function formatTurn(turn: Turn): string {
  const who = turn.role === 'tool' ? `tool:${turn.toolName ?? 'tool'}` : turn.role;
  return `${who}: ${turn.content}`;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatOperational(caps: CapsSnapshot, auditCount: number): string {
  const kill = caps.blocked ? 'on' : 'off';
  const bucket = caps.buckets.map((item) => `${item.scope} steps ${item.stepsUsed}`).join(', ');
  return `kill_switch=${kill}; audit_events=${auditCount}; ${bucket}`;
}
