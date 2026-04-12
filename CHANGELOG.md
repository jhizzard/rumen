# Changelog

All notable changes to Rumen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-11

Initial release. Extract + Relate + Surface only — no LLM synthesis, no question generation.

> **WARNING:** Rumen v0.1 writes to a `rumen_insights` table. It does NOT modify or delete any existing memory rows. Run against a TEST instance for the first two weeks of use. Do NOT point at production memory stores until validated.

### Added
- `runRumenJob(db, options)` entry point that runs the Extract, Relate, and Surface phases end-to-end.
- Extract phase (`src/extract.ts`): pulls session memories from the last 24–72 hours out of Engram's `memory_sessions` + `memory_items` tables, filters out sessions with fewer than 3 events, and returns structured signals.
- Relate phase (`src/relate.ts`): for each signal, runs `memory_hybrid_search` across all historical memories and keeps top-5 candidates with similarity > 0.7.
- Surface phase (`src/surface.ts`): writes a non-destructive `rumen_insights` row per signal with `source_memory_ids[]` populated. v0.1 uses placeholder insight text; v0.2 will replace this with LLM synthesis.
- SQL migrations:
  - `migrations/001_rumen_tables.sql` — `rumen_jobs`, `rumen_insights`, `rumen_questions` with indexes.
  - `migrations/002_pg_cron_schedule.sql` — `pg_cron` schedule that calls the Edge Function every 15 minutes.
- Supabase Edge Function entry point at `supabase/functions/rumen-tick/index.ts`. Deno-compatible, reads `DATABASE_URL` via `Deno.env.get`.
- Local development script at `scripts/test-locally.ts`.
- Raw `pg` Pool factory at `src/db.ts` wired for Supabase Shared Pooler IPv4 URLs.
- `[rumen-*]` logging convention enforced across the codebase (`[rumen]`, `[rumen-extract]`, `[rumen-relate]`, `[rumen-surface]`, with `[rumen-synthesize]` and `[rumen-question]` reserved).
- Cost guardrails (hardcoded in v0.1): max 10 sessions per run via `MAX_SESSIONS_PER_RUN`, skip sessions with <3 events, skip sessions that already have a `rumen_jobs` row.
- Engram compatibility document at `docs/ENGRAM-COMPATIBILITY.md`.
- CI workflow that runs `tsc --noEmit` and a basic SQL syntax check.

### Not included (by design)
- No LLM calls. Rumen v0.1 makes zero network calls to Anthropic, OpenAI, or any other model provider.
- No synthesis — insight text is placeholder in v0.1.
- No question generation.
- No self-tuning.
