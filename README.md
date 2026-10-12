# Memlayer

Multi-tenant memory for an enterprise chatbot. Five layers, one TypeScript service, a hot path that stays in process when the session is warm.

Working memory and profile facts are read from a small in-process LRU, then a Redis-compatible store (embedded by default, ioredis when `REDIS_URL` is set). Profile facts, episodes, the audit log, and knowledge metadata live in SQLite. Knowledge search uses a **separate HNSW + BM25 index per tenant**, so another tenant's vectors are never scored.

The memory service, tests, and default retrieval benchmarks run offline. **Atlas chat and Gemini answer benchmarks require Google credentials.**

## Quick start

Use **Node.js >=22.13** (Node 24 recommended), Git, and **pnpm 11.25.0**. These examples use Bash. Authenticate with GitHub before cloning this private repository.

```bash
npm install -g pnpm@11.25.0
git clone https://github.com/letslego/memlayer.git
cd memlayer
pnpm install --frozen-lockfile
cp .env.example .env
pnpm typecheck
pnpm test
```

Already cloned it? Pull the latest `main`, run `pnpm install --frozen-lockfile`, and keep your existing `.env`.

| Goal | Command | Google credentials? |
| --- | --- | --- |
| Talk to Atlas in the terminal | `pnpm adk:dev` | Yes |
| Open the memory API and showcase | `pnpm dev` | No |
| Try the mock chatbot | `pnpm example` | No |
| Measure operation speed | `pnpm bench` | No |
| Measure long-term evidence retrieval | `pnpm bench:locomo` | No, with default hash embeddings |
| Compare Gemini answers with and without memory | `pnpm bench:adk --limit 20` | Yes |

## Start Atlas with Google ADK

Create a Gemini API key in Google AI Studio using [Google’s API-key guide](https://ai.google.dev/gemini-api/docs/api-key). Edit `.env` and set `GOOGLE_API_KEY` to that key. Keep these defaults for your first run:

```dotenv
GOOGLE_API_KEY=your_gemini_api_key
ADK_MODEL=gemini-2.5-flash
ADK_PERSONA_PATH=
MEMLAYER_TENANT=local
MEMLAYER_USER=user
MEMLAYER_SESSION=session-1
MEMLAYER_DB=data/adk.sqlite
MEMLAYER_EMBEDDINGS=hash
```

```bash
pnpm adk:dev
```

Run from the repository root. The terminal prints `Atlas v1.0.0` and a session prompt. Enter “My preferred name is Amitabha. We chose PostgreSQL for the project.” Then switch with `/session project-followup` and ask “Which database did we choose?” Atlas can retrieve the earlier exchange for the same tenant and user.

The ADK and answer-benchmark commands load `.env` automatically. `GOOGLE_API_KEY` authenticates Gemini; it is different from the memory HTTP server's `API_KEYS`. Store credentials in the ignored `.env` or your process environment. An already-configured Vertex AI environment is also supported with `GOOGLE_GENAI_USE_VERTEXAI=true`.

Atlas uses Memlayer directly in-process. It does not require the HTTP server, Docker, or TrueForge. This command starts a terminal chatbot, not a web chat UI.

### Sessions and reviewed lessons

| Command | Effect |
| --- | --- |
| `/session NAME` | Switch sessions while retaining the same user's shared history |
| `/reflections` | List pending preference/lesson proposals and their IDs |
| `/accept ID` | Approve a proposed lesson for future guidance |
| `/reject ID` | Record rejection and exclude it from guidance |
| `/exit` | Close the chatbot |

Try “Keep your answers concise and focus on working implementations.” Atlas may propose a lesson grounded in an exact quote from that message. Run `/reflections`, inspect the proposed text, and pass the returned `ep_...` ID to `/accept` or `/reject`. The model cannot approve its own proposals. Extraction is model-driven; every message does not necessarily produce a proposal.

Profile facts, indexed exchanges, episodes, and review decisions survive restart in `MEMLAYER_DB`. Keep the same database, tenant, and user to retain continuity. The CLI's recent working-turn cache is in-memory and resets on restart; durable historical retrieval still works. The HTTP service uses its own `DATABASE_PATH` and Redis configuration, separate from the Atlas CLI defaults.

### Customize the persona

Edit `persona.yaml` to change Atlas's name, purpose, relationship, voice, or principles. Increment its `version` and restart the chatbot. For a separate persona, copy the file and set `ADK_PERSONA_PATH=./my-persona.yaml` in `.env`.

Approved lessons personalize context without rewriting the persona. See [Atlas persona and review workflow](docs/atlas-persona.md) for the schema, boundaries, and review limits.

### Adapt to profiles and entitlements

Atlas recognizes profile settings for `language`, `verbosity`, `expertise`, `working_style`, and `preferred_role`. Only validated values affect presentation; core principles stay in `persona.yaml`.

The local CLI uses `config/entitlements.local.json` for tools, permitted models/persona roles, writes, trusted ACL roles, and the initial memory-excerpt budget. Set `ADK_ENTITLEMENTS_PATH=./my-policy.json` to use another administrative file. These grants never come from user profiles or lessons. SDK callers must provide a trusted authorization provider; missing authority is denied.

See [profile and entitlement setup](docs/profile-entitlements.md) for a read-only example, supported preferences, host integration, revocation behavior, and API migration.

To try different entitlements locally:

```bash
cp config/entitlements.local.json config/my-policy.json
```

Set `ADK_ENTITLEMENTS_PATH=./config/my-policy.json` in `.env`, then edit that policy. For a read-only analyst/tutor configuration, use:

```json
{
  "schemaVersion": 1,
  "roles": [],
  "entitlements": {
    "capabilities": ["recall_memory", "get_profile"],
    "canWrite": false,
    "allowedModels": ["gemini-2.5-flash"],
    "allowedPersonaRoles": ["analyst", "tutor"],
    "maxContextChars": 8000
  }
}
```

Run `pnpm adk:dev`. This user can read authorized memories and receive answers, but cannot store facts, propose/review lessons, or save new exchanges. The first permitted role is the fallback; an existing `preferred_role` is used only if permitted. Keep `ADK_MODEL` consistent with `allowedModels`. Policy edits are reread during execution; changes abort an in-flight turn, so submit your message again after updating the policy.

Set profile facts with the existing Memlayer SDK, or explicitly ask Atlas to remember them when `remember_fact` is allowed:

| Profile key | Supported values |
| --- | --- |
| `language` | `English`, `Bengali`, `Hindi`, `Spanish` |
| `verbosity` | `concise`, `balanced`, `detailed` |
| `expertise` | `beginner`, `intermediate`, `advanced` |
| `working_style` | `direct`, `collaborative`, `socratic` |
| `preferred_role` | `engineering_partner`, `analyst`, `tutor` |

For example, ask: “Remember my `verbosity` as `concise`, my `expertise` as `advanced`, and my `working_style` as `direct`.” Model-driven extraction is not guaranteed; host applications can set these exact keys with `setProfileFact`. Approved structured preference settings override profile values, but cannot grant permissions or weaken the core persona.

**SDK migration:** the ADK adapter requires an authorization provider, `adapter.tools()` must now be awaited, and standalone `runAdkAnswer` calls must pass `authorization`. Here is an explicit local-policy example:

```ts
import { openMemoryService } from './src/service.js';
import { MemlayerAdapter, runAdkAnswer } from './src/adk/adapter.js';
import { fileAuthorizationProvider } from './src/adk/authorization.js';

const memory = await openMemoryService({ databasePath: 'data/adk.sqlite' });
try {
  const identity = { tenantId: 'local', userId: 'user' };
  const authorization = fileAuthorizationProvider('./config/entitlements.local.json', identity);
  const adapter = new MemlayerAdapter(memory, identity, 'hybrid', authorization);
  await memory.setProfileFact(identity.tenantId, identity.userId, {
    key: 'verbosity', type: 'string', value: 'concise',
  });
  console.log(await runAdkAnswer({
    question: 'Help me plan an AI service.', adapter, persistSession: 'project-1',
  }));
} finally {
  await memory.close();
}
```

The direct SDK fact write above is a privileged host operation, not a model tool. For hosted users, replace the file provider with fresh grants from verified authentication and your IAM/subscription service. Never trust request-body permissions, profile role claims, or a user-writable policy file. This implementation does not connect a billing vendor or implement login. `maxContextChars` limits the initial historical-memory excerpt, not the complete model request or later tool responses.

### Optional semantic embeddings

The default `hash` provider is local. To use Gemini semantic embeddings, change both settings in `.env`:

```dotenv
MEMLAYER_EMBEDDINGS=gemini
MEMLAYER_DB=data/adk-gemini.sqlite
```

Restart `pnpm adk:dev`. Switching embedding provider or dimensions requires a **separate database file**. The new database starts without memories from the old file. Gemini generation and embedding calls incur provider usage.

## Run LoCoMo benchmarks

Download the checksum-pinned dataset once. It is saved at `data/locomo10.json` and is not committed to this repository.

```bash
pnpm bench:locomo:download
pnpm bench:locomo --mode hybrid --out reports/hybrid.json
pnpm bench:locomo --mode bm25 --out reports/bm25.json
pnpm bench:locomo --mode vector --out reports/vector.json
pnpm bench:locomo --mode hybrid-rerank --out reports/rerank.json
```

These commands measure annotated evidence retrieval, not answer accuracy. JSON reports include Recall@1/5/10, MRR, precision@10, category results, exclusion counts, and question-level evidence IDs. `hybrid-rerank` uses lexical coverage reranking, not a learned cross-encoder. Use `--data /path/to/locomo10.json` for an existing copy or `--limit 20` for a small subset in dataset order.

With Google credentials configured, evaluate answers separately:

```bash
pnpm bench:adk --limit 20 --mode bm25 --out reports/adk-small.json
# Equivalent answer-evaluation entry point:
pnpm bench:locomo:answers --limit 20 --out reports/answers-small.json
# Optional semantic retrieval plus Gemini answer generation:
pnpm bench:adk --limit 20 --embeddings gemini --out reports/adk-semantic-small.json
```

Each eligible question runs the same model with memory and a no-history/no-tools baseline. Reports include normalized exact match, token F1, latency, and failures; these string metrics are not the official LoCoMo answer evaluator. Trials use fresh ADK sessions, read-only tools, and no Atlas persona by default. Evaluation questions and answers are not persisted as chatbot memories.

Offline hash-embedding Recall@10 baselines: **55.21% BM25**, **46.60% hybrid**, and **48.91% hybrid with lexical reranking**, across 1,533 scored questions. See [baseline results](reports/baseline.json) and [evaluation methodology](docs/adk-locomo.md) for exclusions and limitations. Live Gemini answer quality and persona consistency still require credentialed validation.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| SQLite unavailable or unsupported Node option | Use Node >=22.13, preferably 24 |
| Frozen-lockfile install fails | Use pnpm 11.25.0 and pull the latest files |
| Atlas asks for credentials | Set a nonempty `GOOGLE_API_KEY` in `.env`; run from the repository root |
| Google authentication or quota error | Check the key, selected model access, and provider quota/billing |
| Embedding metadata mismatch | Choose a new `MEMLAYER_DB` for the new provider |
| Dataset missing | Run `pnpm bench:locomo:download` or pass `--data` |
| No pending reflection | Give explicit feedback; proposals are model-driven |
| History missing | Match the previous database, tenant, and user |

## Architecture

```mermaid
flowchart TB
  subgraph edge [Trust boundary]
    HTTP[Fastify]
    App[In-process SDK]
  end
  HTTP -->|"API key maps to tenantId"| SVC[MemoryService]
  App -->|"tenantId from app code"| SVC
  SVC --> ASM[assembleContext]
  ASM --> WM[Working memory]
  ASM --> PM[Profile memory]
  ASM --> KM[Knowledge]
  ASM --> EM[Episodes]
  SVC --> OM[Operational memory]
  WM --> L1[L1 LRU]
  PM --> L1
  L1 -->|miss, single-flight| Redis[Redis or embedded store]
  Redis -->|profile miss| SQL[(SQLite)]
  PM --> SQL
  KM --> ANN[Per-tenant HNSW + BM25]
  ANN --> SQL
  EM --> SQL
  OM --> SQL
```

`assembleContext` builds a token-budgeted pack for the model: newest working turns, profile facts, top-k knowledge, and recent episodes. Operational memory (audit, spend caps, kill switch) stays out of that pack unless `includeOperational: true`.

## Layers and stores

| Layer | What it holds | Hot path | Durable store | In the model prompt |
| --- | --- | --- | --- | --- |
| Working | Recent turns and tool results for a session | L1, then Redis (`ml:wm:{tenant}:{session}`, MessagePack, TTL) | Redis only. Sessions are ephemeral. | Yes, newest turns that fit |
| Profile | Small typed facts per user | L1, then Redis (`ml:pf:{tenant}:{user}`) | SQLite `profile_facts`. Writes delete the Redis key first, then commit SQLite, then fill Redis. | Yes, within ~15% of the budget |
| Knowledge | Document chunks | In-process HNSW + BM25 for that tenant only | SQLite `documents` + `chunks` (float32 blobs) | Top-k when a query is passed |
| Episodic | Decisions, resolved tickets, other events | SQLite by tenant, user, time | SQLite `episodes` | A few recent episodes |
| Operational | Append-only tool audit, step/spend caps, kill switch | Point reads on the caps primary key | SQLite `audit_log`, `control_caps`, `kill_switches` | Only when asked |

Token estimates use `ceil(chars / 4)`. That is a budget, not a tokenizer.

## Multi-tenancy

Every SDK call takes `tenantId`. On the HTTP server that value is **not** the one in the JSON body.

1. The client sends `X-Api-Key` or `Authorization: Bearer`.
2. The server hashes the key and maps it to a tenant (`API_KEYS=key:tenant,...`).
3. Handlers pass that tenant into the SDK.
4. If the body or query also sends `tenantId` and it differs, the response is `403 tenant_mismatch`.

The example chatbot in `examples/chat-bot.ts` is the app server: it passes `acme` itself. The mock model only sees the context pack.

Knowledge indexes are partitioned by tenant. Search loads one map entry. A missing `WHERE tenant_id` cannot leak rows that were never inserted into that index. ACL inside a tenant is `visibility: tenant` or `restricted` with `userIds` / `roles`.

## Latency targets

These are design targets for a warm local process, not a hosted SLA.

| Call | Target |
| --- | --- |
| `getWorkingMemory` L1 hit | p99 under 1 ms |
| `appendTurn` | p99 under 2 ms |
| `getProfile` L1 hit | p99 under 1 ms |
| `searchKnowledge` on about 60 local chunks | p99 under 5 ms |

`pnpm bench` prints ops/sec, p50, and p99 for `getSession` (the working-memory read), `appendTurn`, `getProfile`, and `searchKnowledge`.

One local run on Node v22.14.0 with the embedded Redis store, SQLite, the hashing embedder, and 60 chunks. `getSession` and `getProfile` are L1 hits after warmup. This is a measurement from this workspace, not a hosted SLA.

| op | ops/sec | p50 | p99 | samples |
| --- | ---: | ---: | ---: | ---: |
| getSession | 588,231 | 0.0012 ms | 0.0032 ms | 4000 |
| appendTurn | 22,078 | 0.0400 ms | 0.0796 ms | 2000 |
| getProfile | 1,081,016 | 0.0007 ms | 0.0012 ms | 4000 |
| searchKnowledge | 10,568 | 0.0766 ms | 0.3024 ms | 400 |

## Run locally

Node >=22.13 and pnpm 11.25.0. This section starts the HTTP memory service; use `pnpm adk:dev` for Atlas.

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm bench
pnpm example
pnpm dev
```

The dev server listens on `http://127.0.0.1:43123` unless `PORT` / `HOST` say otherwise. With no `.env`, it uses the placeholder keys in `.env.example` and a SQLite file at `data/memlayer.sqlite`. Copy `.env.example` to `.env` to change them. Open `http://127.0.0.1:43123/showcase` for a live walk through the five layers.

```bash
curl -s http://127.0.0.1:43123/health
curl -s -X PUT http://127.0.0.1:43123/v1/users/u_ada/facts/plan \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev_acme_key' \
  -d '{"type":"string","value":"enterprise"}'
curl -s -X POST http://127.0.0.1:43123/v1/context \
  -H 'content-type: application/json' \
  -H 'x-api-key: dev_acme_key' \
  -d '{"userId":"u_ada","sessionId":"s1","query":"refund window"}'
```

## Docker

Tests do not need Docker. To run Memlayer itself in Docker, with Redis as the hot-path store and SQLite on a volume:

```bash
docker compose up -d --build
```

The API is on `http://127.0.0.1:43123`. The layer walkthrough is `http://127.0.0.1:43123/showcase`. Placeholder keys are `dev_acme_key` (tenant `acme`) and `dev_globex_key` (tenant `globex`). Compose sets `HOST=0.0.0.0` and uses the host network: Redis is `127.0.0.1:6379` (bound to localhost) and Memlayer is `127.0.0.1:43123`.

[TrueForge](https://github.com/truefoundry/trueforge) is a separate agent harness. This repo runs the published standalone server (`@truefoundry/trueforge`, SQLite, no Redis) beside Memlayer. It does not call Memlayer; the showcase is the place that shows how Memlayer's layers are filled and assembled.

```bash
docker compose -f deploy/trueforge/docker-compose.yml up -d --build
```

TrueForge listens on `http://127.0.0.1:8791`.

Compose already sets `REDIS_URL=redis://127.0.0.1:6379` for the Memlayer container. Redis is bound to localhost only. Leave `REDIS_URL` empty when you run `pnpm dev` on the host and want the embedded store instead.

The embedded store implements the same client surface as the pool: `GET`/`SET`/`DEL`, `MGET`, and `PIPELINE`. The ioredis adapter keeps a small connection pool (`REDIS_POOL_SIZE`, default 4) with auto-pipelining, and explicit pipelines still run on one connection. Concurrent misses for different keys in the same turn are coalesced into one pipeline. Concurrent misses for the **same** key share one in-flight load (single-flight) so SQLite is hit once.

L1 TTL defaults to 500 ms and refreshes on read. That is long enough for a chat turn and short enough that another process writing Redis is not stuck behind a stale process cache. Writes update L1 in this process immediately.

## HTTP API

All `/v1` routes require the API key. Tenant comes only from that key.

| Method | Path | SDK |
| --- | --- | --- |
| `POST` | `/v1/sessions/:sessionId/turns` | `appendTurn` |
| `GET` | `/v1/sessions/:sessionId/memory` | `getWorkingMemory` |
| `DELETE` | `/v1/sessions/:sessionId` | `clearSession` |
| `PUT` | `/v1/users/:userId/facts/:key` | `setProfileFact` |
| `GET` | `/v1/users/:userId/profile` | `getProfile` |
| `DELETE` | `/v1/users/:userId/facts/:key` | `forgetFact` |
| `POST` | `/v1/knowledge/documents` | `ingestDocument` |
| `POST` | `/v1/knowledge/search` | `searchKnowledge` |
| `POST` | `/v1/episodes` | `recordEpisode` |
| `GET` | `/v1/episodes` | `listEpisodes` |
| `POST` | `/v1/audit` | `recordAudit` |
| `GET` | `/v1/audit` | `listAudit` |
| `GET` | `/v1/caps` | `getCaps` |
| `PUT` | `/v1/caps` | `setCaps` |
| `PUT` | `/v1/kill-switch` | `setKillSwitch` |
| `POST` | `/v1/context` | `assembleContext` |

Errors are `{ error: { code, message } }` with codes such as `validation`, `unauthorized`, `tenant_mismatch`, `not_found`, `kill_switch`, `cap_exceeded`, and `timeout`.

`recordAudit` appends a row, then increments step and spend counters for the tenant and, when present, the user and session. A kill switch or a cap writes a `kill_switch_blocked` or `cap_exceeded` row and does not increment usage.

## SDK sketch

```ts
import { openMemoryService } from './src/index.ts';

const memory = await openMemoryService({ databasePath: 'data/memlayer.sqlite' });
const pack = await memory.assembleContext('acme', 'u_ada', 's1', 'refund window');
// pack.prompt is what you send to the model. pack.operational is absent.
```

This repo runs TypeScript in place via `tsx`. Import from `./src/index.ts` inside the repo (see `examples/chat-bot.ts`).

## Swapping stores

**Redis.** Set `REDIS_URL`. Leave it empty to keep the in-memory implementation. The `RedisClient` interface is the seam (`src/redis/client.ts`).

**Embeddings.** Pass `embeddings` to `openMemoryService`. `HashEmbeddingProvider` is a signed feature hasher (`hashing-trick-v1`) so search works offline. A hosted embedder implements `EmbeddingProvider` and may return promises. The database records `embedding_id` and `embedding_dim` and refuses to open if they change; start a new SQLite file when you change models. Hybrid rank is `0.35 * cosine + 0.65 * squashed BM25`. Scores are absolute, not min-maxed inside the candidate set, so a tenant with one chunk does not match every query. A hit with no keyword overlap is kept only when cosine is at least 0.42. That keeps keyword recall useful while the hasher is in place.

**Vectors.** `HnswIndex` is an in-process HNSW graph. `KnowledgeEngine` builds one graph and one BM25 index per tenant and reloads them from SQLite chunk blobs on startup. To move to pgvector or Qdrant:

1. Keep `documents` / `chunks` as the source of truth (or the equivalent Postgres tables).
2. Replace `KnowledgeEngine.search` / `addRow` with a filtered ANN query whose **first predicate is `tenant_id = $authenticatedTenant`**.
3. Leave ACL as a second predicate (`visibility`, `user_ids`, `roles`).
4. Keep the `EmbeddingProvider` you already inject.

SQLite tables map directly: `profile_facts`, `documents`, `chunks`, `episodes`, `audit_log`, `control_caps`, `kill_switches`. Compose does not start Postgres. A future adapter would bring its own database.

**Durable SQL.** `DurableStore` is the only SQLite caller. A Postgres implementation of the same methods can sit behind it. Use `pgvector` in `chunks.vector` if you want the ANN next to the metadata.

## License

MIT. See [LICENSE](LICENSE).
