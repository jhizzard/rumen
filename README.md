# Rumen

**The LLM is stateless. Rumen isn't.**

Rumen is an async learning layer that runs on top of any pgvector memory store (such as [Mnestra](https://github.com/jhizzard/mnestra)). It wakes up on a schedule, looks at what you did recently, cross-references it with everything you've ever done, and writes the connections back into your memory store as insights.

A rumen is the first chamber of a ruminant's stomach where food is continuously broken down and re-processed long after the animal stops eating. The word _ruminate_ literally comes from it. The metaphor IS the product: your thoughts keep getting processed after you stop working.

---

## Safety Warning

> **WARNING:** Rumen v0.1 writes to a `rumen_insights` table. It does NOT modify or delete any existing memory rows. Run against a TEST instance for the first two weeks of use. Do NOT point at production memory stores until validated.

Rumen is **non-destructive by design**. It only ever INSERTs (or, for its own rows, UPDATEs) into its own tables — `rumen_jobs`, `rumen_insights`, `rumen_questions`, and, as of Sprint 79, `doctrine_registry` / `doctrine_jobs`. Nothing in your existing memory store is modified. Validate on a non-critical database first.

Two deliberate, narrow, documented amendments to that rule (full detail in [`docs/MNESTRA-COMPATIBILITY.md`](docs/MNESTRA-COMPATIBILITY.md) § What Rumen writes):

- the insight cycle stamps `memory_sessions.rumen_processed_at` (its idempotency guard);
- the **inbox promotion pass** (`src/promote.ts`, Sprint 76) INSERTs new rows into `memory_items` — promoting quarantined web-chat proposals from `memory_inbox` to canonical — and UPDATEs ONLY `memory_inbox` status/metadata fields on rows it claimed.

Rumen still **never modifies or deletes existing memory rows**.

---

## What Rumen does (v0.4)

The full **Extract → Relate → Synthesize → Surface** pipeline is live as of v0.4.0.

The loop:

1. **Extract** — pull recent session memories (last 24–72 hours) from Mnestra. Filter out trivial sessions (<3 events).
2. **Relate** — for each signal, run a hybrid keyword + semantic search (via OpenAI `text-embedding-3-large` embeddings) across all historical memories. Falls back to keyword-only gracefully when `OPENAI_API_KEY` is unset. Keep top-5 candidates with similarity > 0.7.
3. **Synthesize** — pass related memories through Claude Haiku to produce real insight text with confidence scoring.
4. **Surface** — write a new row into `rumen_insights` for each signal, with `source_memory_ids[]` populated so the connection is traceable.

---

## Pairs with Mnestra

Rumen is a **reasoning layer**, not a memory store. It assumes the schema exposed by [Mnestra](https://github.com/jhizzard/mnestra):

- `memory_items(id, content, source_type, project, created_at, embedding vector(1536))`
- `memory_sessions(id, project, summary, created_at)`
- `memory_hybrid_search(query_text, query_embedding, limit_count, project_filter)` SQL function

See [`docs/MNESTRA-COMPATIBILITY.md`](docs/MNESTRA-COMPATIBILITY.md) for the full compatibility contract. Rumen currently only works with Mnestra-compatible schemas.

Mnestra stores your developer memory. Rumen learns from it while you're not looking, and writes new memories back into the store with `source_type='insight'` so every existing Mnestra consumer automatically benefits.

---

## Install

```bash
npm install @jhizzard/rumen
```

Peer requirement: a Postgres database with the `vector` extension and the Mnestra schema (migrations in the Mnestra repo).

---

## Deploy as a Supabase Edge Function

Rumen is designed to run as a scheduled Supabase Edge Function, triggered by `pg_cron` every 15 minutes.

1. Apply the Rumen tables:

   ```bash
   psql "$DATABASE_URL" -f migrations/001_rumen_tables.sql
   ```

2. Deploy the Edge Function:

   ```bash
   supabase functions deploy rumen-tick
   supabase secrets set DATABASE_URL="$DATABASE_URL"
   ```

3. Schedule it via `pg_cron`:

   ```bash
   psql "$DATABASE_URL" -f migrations/002_pg_cron_schedule.sql
   ```

   (Edit the function URL in the SQL file first.)

4. Verify:

   ```sql
   SELECT * FROM rumen_jobs ORDER BY started_at DESC LIMIT 5;
   ```

### Optional: the memory-inbox promotion pass (`inbox-promote`)

If your store uses Mnestra's `memory_inbox` quarantine (engram migration 026 — web chats
write proposals, CLIs write canonical), a second sibling Edge Function drains it
asynchronously: dedup vs canonical (`match_memories`, remember.ts thresholds),
kitchen-vs-recipe classification via Claude Haiku, then promote-or-reject with a full audit
trail. Proposals become recallable on this cadence — by design, never synchronously.

```bash
supabase functions deploy inbox-promote
supabase secrets set DATABASE_URL="$DATABASE_URL"
supabase secrets set OPENAI_API_KEY="$OPENAI_API_KEY"        # dedup-gate embeddings
supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"  # kitchen-vs-recipe gate
psql "$DATABASE_URL" -f migrations/003_pg_cron_inbox_promote.sql   # edit the URL first
```

Both model keys are required — without them the pass skips entirely rather than half-gating.
Tuning knobs (defaults): `RUMEN_PROMOTE_BATCH` (25), `RUMEN_PROMOTE_RATE_CAP_24H` (50 per
connector), `RUMEN_PROMOTE_MAX_ATTEMPTS` (5), `RUMEN_PROMOTE_CLAIM_LEASE_MINUTES` (10).

### Optional: the doctrine-scan pass (`doctrine-scan`)

A third sibling Edge Function turns repeated kitchen-level lessons (decision / architecture /
preference / bug_fix memories) into ratified, recallable doctrine. It runs DB-side density
clustering over graph-inference's `memory_relationships` edges, then Haiku-synthesizes a
title/doctrine_text/evidence for each qualifying cluster into its own `doctrine_registry`
table. This pass **detects and drafts only** — it never writes `memory_items`; materializing
a doctrine PR and ratifying it into recallable memory is a separate downstream tool.

```bash
supabase functions deploy doctrine-scan
supabase secrets set DATABASE_URL="$DATABASE_URL"
supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"  # optional — see below
psql "$DATABASE_URL" -f migrations/004_doctrine_registry.sql       # doctrine_registry + doctrine_jobs tables
psql "$DATABASE_URL" -f migrations/005_pg_cron_doctrine_scan.sql   # edit the URL first
```

Unlike `inbox-promote`, `ANTHROPIC_API_KEY` is optional, not required: without it, detection
(density clustering + candidate rows) still runs in full every scan — new candidates simply
park at `status='candidate'` until a key is available, distinguishable in `doctrine_jobs.note`
from a genuine flatline. Tuning knobs (defaults): `DOCTRINE_SCAN_MAX_LLM_CALLS` (10 per scan),
`DOCTRINE_SCAN_BUDGET_MS` (110000).

### Connection URL convention

Per [`docs/MNESTRA-COMPATIBILITY.md`](docs/MNESTRA-COMPATIBILITY.md) and the operational lessons inherited from Podium, Rumen always uses Supabase **Shared Pooler IPv4** URLs, never Dedicated Pooler. The URL format:

```
postgresql://postgres.<project-ref>:<encoded-pw>@aws-0-<region>.pooler.supabase.com:6543/postgres?connection_limit=1
```

Do **not** append `?pgbouncer=true` — that parameter is Prisma-specific and rejected by `node-postgres`/libpq.

Set it as `DATABASE_URL` in your Supabase function secrets.

---

## Run locally (development)

```bash
cp .env.example .env   # then fill in DATABASE_URL
npm install
npm run test:local
```

`scripts/test-locally.ts` runs a single Rumen job against a local or test Postgres, printing all `[rumen-*]` log output to stdout. Use this to validate extract/relate behavior without deploying.

---

## Logging convention

Every log line in Rumen uses one of these tags:

| Tag | Phase |
|---|---|
| `[rumen]` | General job lifecycle |
| `[rumen-extract]` | Pulling structured events from session memories |
| `[rumen-relate]` | Semantic search for prior art |
| `[rumen-synthesize]` | LLM synthesis via Claude Haiku |
| `[rumen-question]` | Follow-up question generation |
| `[rumen-surface]` | Writing insights back to DB |
| `[rumen-promote]` | memory_inbox promotion pass (proposals → canonical or rejected) |
| `[rumen-doctrine-scan]` | Density clustering + Haiku synthesis into `doctrine_registry` |

This makes Supabase Edge Function logs trivially greppable.

---

## Cost controls

Guardrails in place:

- Max 10 sessions per run (override with `MAX_SESSIONS_PER_RUN`)
- Skip sessions with fewer than 3 events
- Skip sessions that already have a `rumen_jobs` row referencing them

---

## Roadmap

| Version | Adds | Status |
|---|---|---|
| **v0.1** | Extract + Relate + Surface. Read-only cross-reference. | Shipped |
| **v0.2** | Synthesize step via Claude Haiku. Real insight text, confidence scoring, batching. | Shipped |
| **v0.3** | Questions. Rumen starts asking the developer things. Morning briefing surface. | Shipped |
| **v0.4** | Vector embeddings in Relate (hybrid keyword+semantic search via OpenAI `text-embedding-3-large`), per-signal error tolerance, graceful fallback when `OPENAI_API_KEY` is unset. | **This release** |

---

## Why

Nothing else does this:

- Obsidian plugins index notes — they don't run when you stop editing.
- Mem0 stores memories — it doesn't cross-reference or synthesize.
- LangGraph orchestrates agents — it doesn't have persistent cross-project memory.
- Cursor / Copilot are in-editor assistants — they forget when you close the editor.

Rumen keeps working when you stop. It cross-references across all your projects automatically, and (in future versions) asks you follow-up questions about work you thought was done. The moat is the loop: your memory store captures → Rumen learns → insights land in Rumen's own store (`rumen_insights`), queryable alongside Mnestra's. Each pass makes your combined memory smarter about you specifically.

(Rumen's own write boundary is narrower than that framing implies: `rumen_insights` rows are never copied into `memory_items` by Rumen itself. Two deliberate, narrow exceptions do write into Mnestra's tables from within this repo — the `memory_sessions.rumen_processed_at` stamp and the Sprint 76 promotion pass — see the Safety Warning above and [`docs/MNESTRA-COMPATIBILITY.md`](docs/MNESTRA-COMPATIBILITY.md) § What Rumen writes for the exhaustive list. As of Sprint 79, Rumen also detects and drafts candidate doctrine into its own `doctrine_registry` table; the actual `memory_items` flow-back for a *ratified* doctrine is performed by a separate downstream tool, not by Rumen.)

---

## License

MIT © 2026 Joshua Izzard
