# Rumen

**The LLM is stateless. Rumen isn't.**

Rumen is an async learning layer that runs on top of any pgvector memory store (such as [Mnemos](https://github.com/jhizzard/mnemos)). It wakes up on a schedule, looks at what you did recently, cross-references it with everything you've ever done, and writes the connections back into your memory store as insights.

A rumen is the first chamber of a ruminant's stomach where food is continuously broken down and re-processed long after the animal stops eating. The word _ruminate_ literally comes from it. The metaphor IS the product: your thoughts keep getting processed after you stop working.

---

## Safety Warning

> **WARNING:** Rumen v0.1 writes to a `rumen_insights` table. It does NOT modify or delete any existing memory rows. Run against a TEST instance for the first two weeks of use. Do NOT point at production memory stores until validated.

Rumen is **non-destructive by design**. It only ever INSERTs new rows into its own tables (`rumen_jobs`, `rumen_insights`, `rumen_questions`). Nothing in your existing memory store is modified. But the v0.1 extract logic is new — validate it on a non-critical database first.

---

## What v0.1 does

v0.1 = **Extract + Relate + Surface only**. No LLM synthesis, no question generation. This release is deliberately boring so it can be validated against a real memory store without burning tokens.

The loop:

1. **Extract** — pull recent session memories (last 24–72 hours) from Mnemos. Filter out trivial sessions (<3 events).
2. **Relate** — for each signal, run a hybrid search across all historical memories via the `memory_hybrid_search` SQL function Mnemos already exposes. Keep top-5 candidates with similarity > 0.7.
3. **Surface** — write a new row into `rumen_insights` for each signal, with `source_memory_ids[]` populated so the connection is traceable. For v0.1 the `insight_text` is a concatenation like `"Found 5 related memories from project X about Y"`. v0.2 replaces this with real LLM synthesis.

No Anthropic/OpenAI calls are present in the v0.1 codebase. This is intentional.

---

## Pairs with Mnemos

Rumen is a **reasoning layer**, not a memory store. It assumes the schema exposed by [Mnemos](https://github.com/jhizzard/mnemos):

- `memory_items(id, content, source_type, project, created_at, embedding vector(1536))`
- `memory_sessions(id, project, summary, created_at)`
- `memory_hybrid_search(query_text, query_embedding, limit_count, project_filter)` SQL function

See [`docs/MNEMOS-COMPATIBILITY.md`](docs/MNEMOS-COMPATIBILITY.md) for the full compatibility contract. Future Rumen versions may abstract this; v0.1 only works with Mnemos-compatible schemas.

Mnemos stores your developer memory. Rumen learns from it while you're not looking, and writes new memories back into the store with `source_type='insight'` so every existing Mnemos consumer automatically benefits.

---

## Install

```bash
npm install @jhizzard/rumen
```

Peer requirement: a Postgres database with the `vector` extension and the Mnemos schema (migrations in the Mnemos repo).

---

## Deploy as a Supabase Edge Function

Rumen is designed to run as a scheduled Supabase Edge Function, triggered by `pg_cron` every 15 minutes.

1. Apply the Rumen tables:

   ```bash
   psql "$DIRECT_URL" -f migrations/001_rumen_tables.sql
   ```

2. Deploy the Edge Function:

   ```bash
   supabase functions deploy rumen-tick
   supabase secrets set DATABASE_URL="$DATABASE_URL"
   ```

3. Schedule it via `pg_cron`:

   ```bash
   psql "$DIRECT_URL" -f migrations/002_pg_cron_schedule.sql
   ```

   (Edit the function URL in the SQL file first.)

4. Verify:

   ```sql
   SELECT * FROM rumen_jobs ORDER BY started_at DESC LIMIT 5;
   ```

### Connection URL convention

Per [`docs/MNEMOS-COMPATIBILITY.md`](docs/MNEMOS-COMPATIBILITY.md) and the operational lessons inherited from Podium, Rumen always uses Supabase **Shared Pooler IPv4** URLs, never Dedicated Pooler. The URL format:

```
postgresql://postgres.<project-ref>:<encoded-pw>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
```

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
| `[rumen-synthesize]` | LLM synthesis (reserved for v0.2) |
| `[rumen-question]` | Follow-up question generation (reserved for v0.3) |
| `[rumen-surface]` | Writing insights back to DB |

This makes Supabase Edge Function logs trivially greppable.

---

## Cost controls

Even though v0.1 makes no LLM calls, the guardrails are already in place:

- Max 10 sessions per run (override with `MAX_SESSIONS_PER_RUN`)
- Skip sessions with fewer than 3 events
- Skip sessions that already have a `rumen_jobs` row referencing them

v0.2 will layer LLM budget caps on top (100 calls/day soft, 500/day hard).

---

## Roadmap

| Version | Adds | Status |
|---|---|---|
| **v0.1** | Extract + Relate + Surface. Read-only cross-reference. | This release |
| **v0.2** | Synthesize step via Claude Haiku. Real insight text, confidence scoring, batching. | Planned |
| **v0.3** | Questions. Rumen starts asking the developer things. Morning briefing surface. | Planned |
| **v0.4** | Self-tuning. Per-developer insight preference weights, A/B testing of prompt templates. | Planned |

---

## Why

Nothing else does this:

- Obsidian plugins index notes — they don't run when you stop editing.
- Mem0 stores memories — it doesn't cross-reference or synthesize.
- LangGraph orchestrates agents — it doesn't have persistent cross-project memory.
- Cursor / Copilot are in-editor assistants — they forget when you close the editor.

Rumen keeps working when you stop. It cross-references across all your projects automatically, and (in future versions) asks you follow-up questions about work you thought was done. The moat is the loop: your memory store captures → Rumen learns → insights flow back into the store. Each pass makes the store smarter about you specifically.

---

## License

MIT © 2026 Joshua Izzard
