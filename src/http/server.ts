import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import { MemoryError, TenantMismatchError, UnauthorizedError, ValidationError } from '../errors.js';
import type { MemoryService } from '../service.js';
import { requireId } from '../validate.js';

export interface HttpServerOptions {
  memory: MemoryService;
  /** Raw API key -> tenant id. The model never supplies the tenant. */
  apiKeys: Record<string, string>;
  logger?: boolean;
  requestTimeoutMs?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

const showcaseHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'showcase.html'), 'utf8');

function isPublicPath(path: string): boolean {
  return path === '/' || path === '/health' || path === '/showcase';
}

const turnSchema = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string().min(1).max(32_000),
  toolName: z.string().min(1).max(64).optional(),
  toolCallId: z.string().min(1).max(128).optional(),
});
const factSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'json']),
  value: z.unknown(),
});
const ingestSchema = z.object({
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(500_000),
  source: z.string().max(500).optional(),
  acl: z
    .object({
      visibility: z.enum(['tenant', 'restricted']).optional(),
      userIds: z.array(z.string()).max(100).optional(),
      roles: z.array(z.string()).max(50).optional(),
    })
    .optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
const searchSchema = z.object({
  query: z.string().min(1).max(8_000),
  topK: z.number().int().min(1).max(20).optional(),
  userId: z.string().optional(),
  roles: z.array(z.string()).max(50).optional(),
});
const episodeSchema = z.object({
  userId: z.string(),
  sessionId: z.string().optional(),
  type: z.string(),
  summary: z.string().min(1).max(4_000),
  payload: z.record(z.unknown()).optional(),
  occurredAt: z.number().optional(),
});
const episodeQuerySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  type: z.string().optional(),
  since: z.coerce.number().optional(),
  until: z.coerce.number().optional(),
  limit: z.coerce.number().int().optional(),
});
const auditSchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  action: z.string(),
  toolName: z.string().optional(),
  detail: z.record(z.unknown()).optional(),
  costUnits: z.number().optional(),
  steps: z.number().int().optional(),
});
const capsSchema = z.object({
  scope: z.enum(['tenant', 'user', 'session']),
  targetId: z.string(),
  maxSteps: z.number().int().nullable(),
  maxSpendUnits: z.number().nullable(),
});
const capsQuerySchema = z.object({
  userId: z.string().optional(),
  sessionId: z.string().optional(),
});
const killSchema = z.object({
  scope: z.enum(['tenant', 'user', 'session']),
  targetId: z.string(),
  enabled: z.boolean(),
  reason: z.string().max(500).nullable().optional(),
});
const contextSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  query: z.string().max(8_000).optional(),
  tokenBudget: z.number().int().optional(),
  knowledgeTopK: z.number().int().optional(),
  episodeLimit: z.number().int().optional(),
  roles: z.array(z.string()).max(50).optional(),
  includeOperational: z.boolean().optional(),
  timeoutMs: z.number().int().optional(),
});

export function buildServer(options: HttpServerOptions): FastifyInstance {
  const keys = new Map<string, string>();
  for (const [raw, tenant] of Object.entries(options.apiKeys)) {
    keys.set(hashApiKey(raw), requireId(tenant, 'tenantId'));
  }
  const app = Fastify({
    logger: options.logger ?? false,
    requestTimeout: options.requestTimeoutMs ?? 5_000,
    bodyLimit: 2_000_000,
  });
  const memory = options.memory;

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (isPublicPath(path)) return;
    const presented = readApiKey(request);
    if (!presented) throw new UnauthorizedError();
    const tenantId = keys.get(hashApiKey(presented));
    if (!tenantId) throw new UnauthorizedError();
    request.tenantId = tenantId;
  });

  app.addHook('preHandler', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    if (isPublicPath(path)) return;
    if (!request.tenantId) throw new UnauthorizedError();
    rejectForeignTenant(request.body, request.tenantId);
    rejectForeignTenant(request.query, request.tenantId);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MemoryError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation',
          message: 'Invalid request',
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        },
      });
    }
    const statusCode =
      typeof error === 'object' && error && 'statusCode' in error ? Number(error.statusCode) : 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'validation', message: 'Invalid request' } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: 'internal', message: 'Internal error' } });
  });

  app.get('/', async () => ({
    service: 'memlayer',
    health: '/health',
    showcase: '/showcase',
    api: '/v1',
  }));

  app.get('/health', async () => memory.health());

  app.get('/showcase', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(showcaseHtml);
  });

  app.post('/v1/sessions/:sessionId/turns', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    const sessionId = paramId(request, 'sessionId');
    const body = turnSchema.parse(request.body);
    return memory.appendTurn(tenantId, sessionId, body);
  });

  app.get('/v1/sessions/:sessionId/memory', async (request) => {
    rejectForeignTenant(request.query, tenantOf(request));
    return memory.getWorkingMemory(tenantOf(request), paramId(request, 'sessionId'));
  });

  app.delete('/v1/sessions/:sessionId', async (request) => {
    rejectForeignTenant(request.query, tenantOf(request));
    await memory.clearSession(tenantOf(request), paramId(request, 'sessionId'));
    return { ok: true };
  });

  app.put('/v1/users/:userId/facts/:key', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    const body = factSchema.parse(request.body);
    return memory.setProfileFact(tenantId, paramId(request, 'userId'), {
      key: paramId(request, 'key'),
      type: body.type,
      value: body.value,
    });
  });

  app.get('/v1/users/:userId/profile', async (request) => {
    rejectForeignTenant(request.query, tenantOf(request));
    return memory.getProfile(tenantOf(request), paramId(request, 'userId'));
  });

  app.delete('/v1/users/:userId/facts/:key', async (request) => {
    rejectForeignTenant(request.query, tenantOf(request));
    await memory.forgetFact(tenantOf(request), paramId(request, 'userId'), paramId(request, 'key'));
    return { ok: true };
  });

  app.post('/v1/knowledge/documents', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    const body = ingestSchema.parse(request.body);
    return memory.ingestDocument(tenantId, body);
  });

  app.post('/v1/knowledge/search', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    const body = searchSchema.parse(request.body);
    const hits = await memory.searchKnowledge(tenantId, body);
    return { hits };
  });

  app.post('/v1/episodes', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    return memory.recordEpisode(tenantId, episodeSchema.parse(request.body));
  });

  app.get('/v1/episodes', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.query, tenantId);
    const query = episodeQuerySchema.parse(request.query);
    return { episodes: await memory.listEpisodes(tenantId, query) };
  });

  app.post('/v1/audit', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    return memory.recordAudit(tenantId, auditSchema.parse(request.body));
  });

  app.get('/v1/audit', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.query, tenantId);
    const query = capsQuerySchema.extend({ limit: z.coerce.number().int().optional() }).parse(request.query);
    return { events: await memory.listAudit(tenantId, query) };
  });

  app.get('/v1/caps', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.query, tenantId);
    return memory.getCaps(tenantId, capsQuerySchema.parse(request.query));
  });

  app.put('/v1/caps', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    return memory.setCaps(tenantId, capsSchema.parse(request.body));
  });

  app.put('/v1/kill-switch', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    return memory.setKillSwitch(tenantId, killSchema.parse(request.body));
  });

  app.post('/v1/context', async (request) => {
    const tenantId = tenantOf(request);
    rejectForeignTenant(request.body, tenantId);
    const body = contextSchema.parse(request.body);
    return memory.assembleContext(tenantId, body.userId, body.sessionId, body.query, {
      ...(body.tokenBudget !== undefined ? { tokenBudget: body.tokenBudget } : {}),
      ...(body.knowledgeTopK !== undefined ? { knowledgeTopK: body.knowledgeTopK } : {}),
      ...(body.episodeLimit !== undefined ? { episodeLimit: body.episodeLimit } : {}),
      ...(body.roles !== undefined ? { roles: body.roles } : {}),
      ...(body.includeOperational !== undefined ? { includeOperational: body.includeOperational } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
    });
  });

  return app;
}

function tenantOf(request: FastifyRequest): string {
  if (!request.tenantId) throw new UnauthorizedError();
  return request.tenantId;
}

function paramId(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  const value = params[name];
  if (typeof value !== 'string') throw new ValidationError(`Missing ${name}`);
  return value;
}

function readApiKey(request: FastifyRequest): string | undefined {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  return undefined;
}

function rejectForeignTenant(value: unknown, tenantId: string): void {
  if (!value || typeof value !== 'object' || !('tenantId' in value)) return;
  const claimed = (value as { tenantId?: unknown }).tenantId;
  if (claimed === undefined) return;
  if (claimed !== tenantId) throw new TenantMismatchError();
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}
