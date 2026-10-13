export type TurnRole = 'user' | 'assistant' | 'tool' | 'system';

export interface ExchangeInput {
  userId: string;
  sessionId: string;
  /** Host-generated request ID; reuse the same ID and payload when retrying. */
  requestId: string;
  question: string;
  answer: string;
  topic?: string;
  entities?: string[];
  createdAt?: number;
}
export interface Exchange extends Omit<ExchangeInput, 'topic' | 'entities' | 'createdAt'> {
  id: string;
  tenantId: string;
  topic: string | null;
  entities: string[];
  createdAt: number;
}
export interface ExchangeQuery {
  userId: string;
  query?: string;
  sessionId?: string;
  topic?: string;
  entity?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export interface Turn {
  id: string;
  role: TurnRole;
  content: string;
  toolName?: string;
  toolCallId?: string;
  createdAt: number;
  tokenEstimate: number;
}

export interface TurnInput {
  role: TurnRole;
  content: string;
  toolName?: string;
  toolCallId?: string;
  createdAt?: number;
}

export interface WorkingMemory {
  tenantId: string;
  sessionId: string;
  turns: Turn[];
  tokenEstimate: number;
}

export type FactType = 'string' | 'number' | 'boolean' | 'json';

export interface ProfileFact {
  key: string;
  type: FactType;
  value: unknown;
  updatedAt: number;
}

export interface FactInput {
  key: string;
  type: FactType;
  value: unknown;
}

export interface Profile {
  tenantId: string;
  userId: string;
  facts: ProfileFact[];
}

export interface Acl {
  visibility: 'tenant' | 'restricted';
  userIds: string[];
  roles: string[];
}

export interface IngestDocumentInput {
  title: string;
  text: string;
  source?: string;
  acl?: {
    visibility?: 'tenant' | 'restricted';
    userIds?: string[];
    roles?: string[];
  };
  metadata?: Record<string, string | number | boolean | null>;
}

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  tokenEstimate: number;
}

export type RetrievalMode = 'hybrid' | 'bm25' | 'vector';

export interface KnowledgeQuery {
  mode?: RetrievalMode;
  query: string;
  topK?: number;
  userId?: string;
  roles?: string[];
}

export interface KnowledgeHit {
  exchange?: { id: string; sessionId: string; occurredAt: number; topic: string | null; entities: string[] };
  chunkId: string;
  documentId: string;
  title: string;
  source: string | null;
  text: string;
  score: number;
  vectorScore: number;
  keywordScore: number;
  tokenEstimate: number;
}

export interface EpisodeInput {
  userId: string;
  sessionId?: string;
  type: string;
  summary: string;
  payload?: Record<string, unknown>;
  occurredAt?: number;
}

export interface Episode {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string | null;
  type: string;
  summary: string;
  payload: Record<string, unknown>;
  occurredAt: number;
}

export interface EpisodeFilter {
  userId?: string;
  sessionId?: string;
  type?: string;
  since?: number;
  until?: number;
  limit?: number;
}

export type ControlScope = 'tenant' | 'user' | 'session';

export interface AuditInput {
  userId?: string;
  sessionId?: string;
  action: string;
  toolName?: string;
  detail?: Record<string, unknown>;
  costUnits?: number;
  steps?: number;
}

export interface AuditEvent {
  id: string;
  tenantId: string;
  userId: string | null;
  sessionId: string | null;
  action: string;
  toolName: string | null;
  detail: Record<string, unknown>;
  costUnits: number;
  steps: number;
  createdAt: number;
}

export interface AuditFilter {
  userId?: string;
  sessionId?: string;
  limit?: number;
}

export interface CapsInput {
  scope: ControlScope;
  targetId: string;
  maxSteps: number | null;
  maxSpendUnits: number | null;
}

export interface CapsQuery {
  userId?: string;
  sessionId?: string;
}

export interface CapBucket {
  scope: ControlScope;
  targetId: string;
  maxSteps: number | null;
  maxSpendUnits: number | null;
  stepsUsed: number;
  spendUsed: number;
}

export interface KillSwitchInput {
  scope: ControlScope;
  targetId: string;
  enabled: boolean;
  reason?: string | null;
}

export interface KillSwitchState {
  scope: ControlScope;
  targetId: string;
  enabled: boolean;
  reason: string | null;
  updatedAt: number;
}

export interface CapsSnapshot {
  buckets: CapBucket[];
  killSwitch: KillSwitchState | null;
  blocked: boolean;
}

export interface CallOptions {
  timeoutMs?: number;
}

export interface AssembleOptions extends CallOptions {
  tokenBudget?: number;
  knowledgeTopK?: number;
  episodeLimit?: number;
  roles?: string[];
  includeOperational?: boolean;
}

export interface ContextPack {
  tenantId: string;
  userId: string;
  sessionId: string;
  working: Turn[];
  profile: ProfileFact[];
  knowledge: KnowledgeHit[];
  episodes: Episode[];
  operational?: {
    caps: CapsSnapshot;
    recentAudit: AuditEvent[];
  };
  prompt: string;
  tokenEstimate: number;
  tokenBudget: number;
  truncated: boolean;
}
