# Google ADK + Memlayer + LoCoMo

The chatbot uses the versioned [Atlas persona](atlas-persona.md), with profile/history context and host-reviewed lesson proposals. Answer benchmarks remain persona-neutral by default.

The optional TypeScript adapter uses Google ADK 2.2.1 and Gemini for orchestration. Memlayer owns historical knowledge, profiles, recent working memory, and episodic records. ADK sessions are intentionally ephemeral; each invocation receives recent Memlayer turns and can call scoped memory tools. Profiles, indexed exchanges, and episodes survive process restarts in SQLite. Recent working turns require Redis for persistence across process restarts; the default in-memory Redis substitute does not persist them.

## Run the chatbot

Requires Node >=22.13 and pnpm 11.25.0 (the checked-in package manager version).

```bash
pnpm install --frozen-lockfile
cp .env.example .env
# Set GOOGLE_API_KEY in .env, or configure Google's Vertex AI environment.
pnpm adk:dev
```

`/session another-session` starts a new conversational session while retaining access to the user's historical exchanges. `/exit` quits. The CLI is a local demonstration, not an authenticated hosted service. A hosted application must derive tenant/user IDs from its verified authentication context and construct a separate adapter for that identity. Do not accept model-supplied identity IDs. Session keys incorporate user identity, and chat documents have restricted user ACLs.

Memory tools are `recall_memory`, `get_profile`, and `remember_fact`. The model may store explicitly stated profile facts; the adapter does not claim deterministic automatic fact extraction. Successful chat answers are written as working turns, an indexed exchange, and an episode. These writes are sequential, not a single transaction. A persistence failure can leave partial records; do not blindly retry chat writes. Answer evaluation uses read-only tools and never persists its questions or answers.

Hash embeddings are the default and need no credentials. Set `MEMLAYER_EMBEDDINGS=gemini` for semantic retrieval using `gemini-embedding-001`, 768 dimensions. Use a different `MEMLAYER_DB` when switching embedding providers: Memlayer rejects incompatible stored embeddings. Remote calls incur provider usage. Credentials are loaded from the local `.env` or process environment and never committed.

## Reproduce retrieval evaluation

```bash
pnpm bench                            # Existing operation latency/throughput
pnpm bench:locomo:download             # Pinned download with SHA-256 verification
pnpm bench:locomo --mode hybrid --out reports/hybrid.json
pnpm bench:locomo --mode bm25 --out reports/bm25.json
pnpm bench:locomo --mode vector --out reports/vector.json
pnpm bench:locomo --mode hybrid-rerank --out reports/rerank.json
```

Supply `--data /path/to/locomo10.json` for an existing dataset. The downloader pins the public [LoCoMo fork](https://github.com/letslego/locomo) at `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376` and expects SHA-256 `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`. The original dataset and its terms remain upstream; it is not vendored here. A synthetic fixture is included for tests.

The harness ingests dialogue only, one source document per dialogue ID, preserving speaker, session and session timestamp. Image captions, where supplied by the dataset, are included as text. No QA annotations, reference answers, or evidence labels from the QA section are used as indexed content. Each conversation is a separate tenant, and all its sessions are indexed before questions are evaluated. This is retrospective recall, not time-causal online evaluation.

Metrics use unique dialogue evidence IDs, collapsing duplicate chunk hits. Recall@K is the fraction of annotated supporting IDs found among the first K evidence items. MRR is reciprocal rank of the first supporting ID. Precision@10 divides relevant evidence count by 10, counting unfilled positions as misses. Values are macro-averaged per question and broken down by category (1 multi-hop, 2 temporal, 3 open-domain, 4 single-hop, 5 adversarial). There are no relevance judgments for non-annotated evidence; precision can underestimate useful retrieved context.

Combined IDs and obvious formatting variations are normalized and deduplicated. Questions with no supporting IDs or unresolved IDs are excluded from evidence metrics and explicitly counted. Category 5 adversarial questions are excluded from ordinary retrieval and answer accuracy aggregates; adversarial abstention evaluation is not implemented. The full dataset contains 1,986 questions, of which 1,533 are scored for evidence retrieval. Exclusions: 446 adversarial, four without evidence, and three with unresolved evidence.

HNSW construction uses seed 42 for this harness. Stable source IDs break score ties. `hybrid-rerank` applies a deterministic lexical coverage reranker to up to 20 retrieved chunks; it is a cheap baseline, not a learned cross-encoder. Retrieval can return fewer than ten unique evidence IDs after chunk deduplication. The vector mode retains Memlayer's existing minimum similarity threshold of 0.42.

## Measured offline baseline

| Configuration | Recall@1 | Recall@5 | Recall@10 | MRR |
|---|---:|---:|---:|---:|
| BM25 | 28.13% | 47.93% | 55.21% | 0.4060 |
| Hybrid | 20.60% | 38.46% | 46.60% | 0.3170 |
| Hybrid + lexical reranking | 25.34% | 41.87% | 48.91% | 0.3613 |
| Vector (hash embeddings) | 2.24% | 2.72% | 2.78% | 0.0258 |

These are local `hashing-trick-v1`, 128-dimensional retrieval results, not Gemini answer accuracy. Hash vectors encode token features rather than semantic meaning; BM25 wins this comparison. The adapter keeps hybrid as the default to preserve Memlayer's established behavior. For an application using the offline provider, BM25 is a reasonable measured configuration to consider. The compact report including per-category results is in `reports/baseline.json`; full per-question JSON is generated by the commands above.

## Evaluate answers separately

```bash
pnpm bench:adk --limit 20 --mode bm25 --out reports/adk-small.json
pnpm bench:locomo:answers --mode hybrid --embeddings gemini --out reports/adk-semantic.json
```

Every eligible question runs the same fixed model twice, with temperature zero: a no-history/no-tools baseline and a memory-enabled agent. This baseline is intentionally deprived of conversation history; it is not a full-context baseline. The enabled agent receives its initial top-ten evidence and can perform further read-only retrieval using the selected retrieval mode. Each trial creates a fresh ADK session. Reference answers are used only by the evaluator, never put into model context.

The report contains predictions, normalized exact match, token F1, latency, failures, per-category aggregates, and the selected model ID. Exact match and F1 are transparent string metrics, not the official LoCoMo evaluator, a calibrated semantic judge, or proof of factual equivalence. Model-call failures count as zero scores and cause a nonzero exit. Questions without an ordinary reference answer are skipped for answer generation. `--limit` limits questions in dataset order, not per category; small prefixes can be unrepresentative.

No live Gemini runs were performed during implementation because this environment had no Google credentials. A deterministic test model does exercise the real ADK runner, function-call loop, retrieval, read-only evaluation, and chat persistence. Gemini embedding calls likewise require live verification in a credentialed environment.

## Failure handling and CI

The ADK runner has a 60-second abort signal and an eight-model-call limit. Read-only answer trials and embedding calls retry HTTP 429 and selected 5xx errors at most three times. Permanent errors and writes are not automatically retried. Retrieval/ingestion use a 60-second Memlayer timeout; remote embedding requests have a 15-second abort signal. Timeout cancellation depends on provider support. Historical context is explicitly identified as untrusted data, but prompt instructions alone are not a complete prompt-injection defense.

CI installs the frozen lockfile, typechecks, runs tests, checks the smoke fixture at Recall@10=1, downloads the checksum-pinned full dataset, and gates hash-embedding Recall@10 at 0.45 (hybrid), 0.53 (BM25), and 0.47 (lexical reranking). It publishes complete reports as workflow artifacts. Retrieval failures, empty scored sets, model failures, invalid flags, and failed thresholds exit nonzero. CI does not call paid models or require Google secrets. Upstream download failures also fail the full-data job rather than silently replacing the dataset.

TrueForge remains an independent integration. This adapter does not rewrite its existing deployment; both integrations can use the same Memlayer core.

API references: [Google ADK TypeScript](https://adk.dev/api-reference/typescript/), [Google ADK function tools](https://google.github.io/adk-docs/tools-custom/function-tools/).
