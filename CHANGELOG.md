# Changelog

All notable changes to Rumen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Synthesize phase (`src/synthesize.ts`)** — replaces v0.1's placeholder
  insight text with real Claude Haiku generation. Wired into `runRumenJob`
  between Relate and Surface.
  - Batching: up to 3 signals per model call, returned as a single JSON
    object for token efficiency.
  - Confidence scoring combines max similarity, cross-project bonus, and
    age spread of related memories.
  - Citations: the Haiku prompt asks for `[#xxxxxxxx]` short-ID citations
    inside the insight text and returns the matching full UUIDs in
    `cited_ids[]`. Only IDs that appear in the related-memory set survive
    into `rumen_insights.source_memory_ids`.
- **LLM budget guardrails.** `RUMEN_MAX_LLM_CALLS_SOFT` (default 100) logs a
  warning and falls back to the v0.1 placeholder template for the remaining
  signals; `RUMEN_MAX_LLM_CALLS_HARD` (default 500) aborts the job cleanly
  (rows already written stay, no corruption). Token counts are logged per
  call as `[rumen-synthesize] tokens=<n>`.
- **Graceful degradation when `ANTHROPIC_API_KEY` is missing.** Rumen logs
  `[rumen-synthesize] no API key, falling back to placeholder` and produces
  the same insight rows as v0.1 — so the loop remains testable without a
  Anthropic account.
- **CI integration test.** New `integration-test` job in `.github/workflows/ci.yml`
  spins up an ephemeral Postgres 16, applies `tests/fixtures/engram-minimal.sql`
  + `migrations/001_rumen_tables.sql`, and runs `scripts/test-locally.ts`
  end-to-end. Asserts at least one `rumen_insights` row is produced.
- `Insight` and `SynthesizeContext` types exported from `src/types.ts` for
  consumers that want to drive Synthesize independently of the full loop.

### Changed
- `surfaceInsights` now accepts `Insight[]` rather than `RelatedSignal[]`,
  so the placeholder and real-Haiku paths share a single write layer.
  External callers that were passing `RelatedSignal[]` directly must either
  move to `runRumenJob` (which still takes care of Relate → Synthesize →
  Surface) or wrap their signals with `makePlaceholderInsight` first.

### Dependencies
- Added `@anthropic-ai/sdk@^0.30.1`.

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
