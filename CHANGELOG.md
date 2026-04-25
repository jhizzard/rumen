# Changelog

All notable changes to Rumen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes._

## [0.4.3] - 2026-04-25

### Changed
- **Confidence scores are now context-size-normalized.** The two `confidence: computeConfidence(rs)` call sites in `src/synthesize.ts` (lines 228 and 620) are now wrapped with `normalize(computeConfidence(rs), rs.related.length)`. Insights synthesized from small clusters (≤ 1, < 5, < 15 related memories) land at the lower ceilings the v0.4.2 `confidence.ts` curve specified — the raw `computeConfidence` output is unchanged, but the value that ends up on the Insight object now caps appropriately. Existing `rumen_insights` rows are unaffected; new ones land at the normalized scale.
- `computeConfidence` is now exported from `src/synthesize.ts` so the test suite can verify the raw function directly. The five `computeConfidence: …` tests now call `computeConfidence(rs)` instead of `makePlaceholderInsight(rs).confidence` and assert the unscaled values they were always meant to. Two new integration tests verify the wrapped-and-normalized confidence on the placeholder path.

### Notes
- This is the deferred Sprint 26 T3 integration that landed in v0.4.2 with the pure function only. Sprint 27 closed the loop. `npm test` 58/58 green.

## [0.4.2] - 2026-04-25

### Added
- **JSON parse hardening in `src/synthesize.ts`** — Haiku-synthesized-insight responses now go through a three-pass `tryParseInsight` strategy (strict JSON.parse → fence/slice extraction → comma + literal-newline repair) before falling back to the per-object regex rescue. Drops the placeholder fallback rate from the 19% (31/166) observed on the 2026-04-19 production kickstart toward < 5% on common Haiku malformations: trailing prose after the JSON, markdown code fences, trailing commas, literal newlines inside string values. Truly malformed responses still cleanly fall through to placeholder. Helpers (`tryParseInsight`, `sliceFirstJsonBlock`, `repairCommonJsonIssues`) are exported and unit-tested in isolation.
- **`src/confidence.ts`** — pure `normalize(rawScore, contextSize)` function plus `NORMALIZE_VERSION` constant. Maps a raw 0..1 score onto a context-size-aware ceiling: 0.4 at size ≤ 1, 0.7 at < 5, 0.9 at < 15, full range at ≥ 15. Clamps NaN / out-of-range inputs. Currently exported only — integration into `synthesize.ts` is the Unreleased item above. Seven unit tests in `tests/relate.test.ts` cover the curve.

### Changed
- Test count grew from 49 → 56 with the new fixtures.

## [0.4.1] - 2026-04-16

### Added
- Full test suite — 41 tests across extract, relate, synthesize, surface.
- Rumen install guide (`docs/INSTALL.md`) and kickstart script.
- README refresh covering v0.4 roadmap, hybrid Relate, and cost controls.
- Hybrid Relate documentation: embedding behaviour, failure modes, and the
  keyword-only fallback path.

## [0.4.0] - 2026-04-16

### Added
- **Hybrid embeddings in Relate.** `relate.ts` now generates OpenAI
  `text-embedding-3-large` embeddings per signal with per-signal error
  tolerance: timeouts / 4xx / 5xx responses fall back to keyword-only
  search rather than aborting the whole job.
- **Self-healing migration.** `migrations/001_rumen_tables.sql` gains
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` blocks so the schema upgrades
  cleanly from v0.2 without a separate migration file.

### Changed
- `extract.ts`, `synthesize.ts`, and `types.ts` updated to carry the new
  embedding vector through the pipeline.

## [0.2.2] - 2026-04-14

### Changed
- **Renamed references from Mnemos → Mnestra.** Final naming after Ingram
  was rejected (corporate sponsor conflict). Compatibility doc and SQL
  fixture renamed; the scoped `@jhizzard/mnemos` package is deprecated.
- SQL schema unchanged (`memory_*` tables stay the same).

## [0.2.1] - 2026-04-14

### Changed
- Mnemos branding pass through README, CHANGELOG, and the compatibility
  doc (`docs/ENGRAM-COMPATIBILITY.md` → `docs/MNEMOS-COMPATIBILITY.md`).

## [0.2.0] - 2026-04-14

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
  spins up an ephemeral Postgres 16, applies `tests/fixtures/mnestra-minimal.sql`
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
- Extract phase (`src/extract.ts`): pulls session memories from the last 24–72 hours out of Mnestra's `memory_sessions` + `memory_items` tables, filters out sessions with fewer than 3 events, and returns structured signals.
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
- Mnestra compatibility document at `docs/MNESTRA-COMPATIBILITY.md`.
- CI workflow that runs `tsc --noEmit` and a basic SQL syntax check.

### Not included (by design)
- No LLM calls. Rumen v0.1 makes zero network calls to Anthropic, OpenAI, or any other model provider.
- No synthesis — insight text is placeholder in v0.1.
- No question generation.
- No self-tuning.
