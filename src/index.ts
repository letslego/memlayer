export { buildContextPack } from './assemble.js';
export { HashEmbeddingProvider } from './embed/hash.js';
export { LocalConversationEnricher, validateAnnotations } from './knowledge/conversation.js';
export type { ConversationEnricher, ConversationAnnotations } from './knowledge/conversation.js';
export type { EmbeddingProvider } from './embed/provider.js';
export {
  CapExceededError,
  KillSwitchError,
  MemoryError,
  NotFoundError,
  TenantMismatchError,
  TimeoutError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';
export { buildServer, hashApiKey } from './http/server.js';
export type { HttpServerOptions } from './http/server.js';
export { Bm25Index } from './knowledge/bm25.js';
export { HnswIndex } from './knowledge/hnsw.js';
export { MemoryRedis } from './redis/memory.js';
export type { RedisClient } from './redis/client.js';
export { MemoryService, openMemoryService } from './service.js';
export type { MemoryServiceOptions } from './config.js';
export type {
  AssembleOptions,
  AuditEvent,
  AuditFilter,
  AuditInput,
  CallOptions,
  CapBucket,
  CapsInput,
  CapsQuery,
  CapsSnapshot,
  ContextPack,
  ControlScope,
  Episode,
  EpisodeFilter,
  EpisodeInput,
  Exchange,
  ExchangeInput,
  ExchangeQuery,
  FactInput,
  FactType,
  IngestDocumentInput,
  IngestResult,
  KillSwitchInput,
  KillSwitchState,
  KnowledgeHit,
  KnowledgeQuery,
  RetrievalMode,
  Profile,
  ProfileFact,
  Turn,
  TurnInput,
  TurnRole,
  WorkingMemory,
} from './types.js';

// ADK is opt-in: import src/adk/adapter.js directly to avoid loading its SDK in core users.
