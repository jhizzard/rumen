# Changelog

All notable changes to Rumen will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes._

## [0.11.1] - 2026-08-01

### Fixed — graph-consolidation nightly writes were zeroed by the category CHECK
- **`src/graph-consolidation.ts` community-summary INSERT no longer stamps `category='consolidation'`** — the value was never legal: `memory_items_category_check` allows only the topical taxonomy (`technical`/`business`/`workflow`/`debugging`/`architecture`/`convention`/`relationship`) or NULL, and S83's I4-b ruling (a) deliberately widened only the **source_type** check (034 added `consolidation_summary`), never category. The S83 dry-run masked it (dry-run skips writes); the first live cron fire (2026-08-01 04:00 UTC, jobid 29) computed `edges=5074 communities=72/555` then threw `23514` on the first insert → `written=0`. Category now stays NULL — provenance already lives in `source_type='consolidation_summary'` + `metadata.consolidation`. Row shape verified against the live constraints pre-release (rolled-back probe insert).
- **`supabase/functions/graph-consolidation/index.ts` repinned `npm:@jhizzard/rumen@0.10.0` → `@0.11.1`** — the function was still importing 0.10.0 (0.11.0 only repinned `rumen-extract-sweep`). Redeploy `graph-consolidation` after this version is published; the fix is inert until then.

## [0.11.0] - 2026-07-31

### Added — extraction sweep + inbox-promote cron restore (Sprint 84 T3)
- **`src/extract-sweep.ts` + exported `runExtractionSweep`** (from `src/index.ts`, ~640 LOC) — the write-time-extraction **backstop sweep**: finds `memory_items` rows that never had entities/typed edges extracted and extracts them through engram 034's drop-invalid RPCs (`upsert_memory_entities` / `upsert_memory_edges`), reading the vocabulary live from the FK tables (never transcribed into rumen — the same rule `extract_write.ts` states for itself). Selects on **memory-item state, never on who wrote the row**, so it covers all three extraction-less origins for free: panel `memory_remember` where `MNESTRA_EXTRACT_ENABLED` never reached the stdio MCP server (the majority of the miss — 94 of 95 rows in the dispatch-time 24h window), SQL-direct `ingest_capture` (no TS in the path, structurally unfixable by any env change), and the promoter's own raw INSERT (`promote.ts` — which means every proposal T1/T2's intake ramps promote would otherwise land extraction-less; the sweep upgraded from hygiene to prerequisite mid-sprint). **Sibling module with its own Edge Function + cadence, NOT a phase inside `runRumenJob`** (ORCH ruling R5): one model call per item against the tick's 110s whole-job budget would starve extract/relate/synthesize and present as "insights stopped" — the same reasoning `reinforce.ts` documents in its own header. Idempotency via a rumen-owned ledger (below), never by stamping the corpus (no third amendment to "Rumen never modifies existing memory rows"). Deterministic `same_pattern_as` edges land with no model/key at all; errored items retry while `attempts < 3`; `RUMEN_SWEEP_*` env namespace disjoint from every sibling; `RUMEN_SWEEP_DRY_RUN=1` writes nothing, not even ledger rows. Anthropic client constructed only when there is work (an empty-backlog nightly pass costs one SELECT and never loads the SDK). Per-pass report carries `triples_found` + a 10-row `triples_sample` — the SR-7 (entity↔entity table) decision becomes a query against real density instead of a guess.
- **Migration `006_pg_cron_inbox_promote.sql`** — restores the inbox-promote pg_cron (never scheduled at Activation Day — deliberate ratify-first mode, now satisfied) as canonical jobname **`rumen-inbox-promote` @ `*/10`** (ORCH ruling R3b: `*/15` would double-fire with rumen-tick on every tick). `cron.unschedule`s **both** legacy names before scheduling, collapsing the two-name re-registration hazard; supersedes the immutable shipped `003` (already in the 0.10.0 tarball) rather than editing it. Restoring this cron is what starts the Phase-4 promotion **dry-run clock** — it does not flip auto-promote (Josh's ~08-13 gate).
- **Migration `007_extraction_sweep_ledger.sql`** — `rumen_extraction_sweep` idempotency ledger (`memory_id` PK, `status`, `attempts`, `entities_written`, `mentions_written`, `same_pattern_edges`, `triples_found`, `error`): RLS on, zero policies, anon/authenticated hold zero table grants, service_role only. Doubles as the sweep's telemetry.
- **Migration `008_pg_cron_extract_sweep.sql`** — `rumen-extract-sweep` @ 04:40 UTC (after graph-consolidation's 04:00, so consolidation always reads a graph stable since the previous sweep).
- **Edge Function `supabase/functions/rumen-extract-sweep/`** — thin Deno wrapper, sibling-standard watchdog racing the platform's 150s kill; a capability skip (missing 007 ledger / missing 034 RPCs) returns **HTTP 500, never a healthy-looking 200** (the Sprint-66 silent-no-op lesson). Pinned `npm:@jhizzard/rumen@0.11.0` — deploy only after this version is published.
- `tests/extract-sweep.test.ts` (22 cases) **wired into `npm run test`** — 219 tests total (218 pass / 1 pre-existing real-PG skip / 0 fail).

### Notes
- Sprint 84 ("Write-Side Completion") T3 rumen half, **FINAL-VERDICT GREEN** (T4 Codex adversarial auditor; T4's two audit catches — sweep suite not release-gated, and a test-harness Anthropic-SDK handle keeping the runner open — both fixed in-flight, the latter yielding the lazy-client production improvement above). `npm run test` **219 (218 pass / 1 pre-existing skip)**, `npm run typecheck` clean, gitleaks 0. Non-superuser replay green for 006/007/008 (T3 and T4 independently), incl. the seeded double-fire state collapsing to exactly one `rumen-inbox-promote` row.
- **Apply order at close (ORCH/Josh):** rumen 006 → 007 → deploy `rumen-extract-sweep` → 008 (cron only after the function exists). First live sweep in `RUMEN_SWEEP_DRY_RUN=1`.
- Known historical divergence, documented not fixed: the termdeck-vendored rumen chain's `003` is `graph_inference_schedule` while this repo's `003` is `pg_cron_inbox_promote` — 006 supersedes repo-003 anyway, so the vendored chain never needs it; do not renumber either chain.
- Companions: `@jhizzard/mnestra@0.12.0` (migrations 035/036) + `@jhizzard/termdeck@1.17.0` + `@jhizzard/termdeck-stack@1.15.0`.

## [0.10.0] - 2026-07-31

### Added — graph consolidation (Sprint 83 T3)
- **`src/graph-consolidation.ts` + exported `runGraphConsolidation`** (from `src/index.ts`) — the doctrine-scan split: logic in `src/` (testable by the tsx suite, injectable `PgPool`/`AnthropicLike`/`embed`), thin Deno wrapper at `supabase/functions/graph-consolidation/` (watchdog racing the platform's 150 s kill, per rumen-tick's v0.6.1 lesson). Three phases:
  - **Entity resolution** over Mnestra 0.11.0's `memory_entities`: group by `(entity_type, entity_key)`, oldest `first_seen_at` (then `id`) wins. Honest scope note: 034's `UNIQUE(entity_type, entity_key)` collapses exact duplicates at write time, so on a healthy store this phase reports `candidates: 0` rather than dressing that up as work — it is the repair path for what the constraint cannot cover (pre-constraint rows, restores, future key widening). Merges entity records only; never touches memory rows.
  - **Community detection** = connected components over live (`invalid_at IS NULL`) typed edges — deterministic, so an unchanged graph writes nothing; over-large components are **skipped and reported, never truncated** (Leiden documented as the upgrade path, deliberately not built).
  - **One provenance-marked community-summary memory per community**: `source_type = 'consolidation_summary'` (034's widened CHECK — enforcement, not metadata-only convention), anchor-keyed idempotency that skips BEFORE spending an LLM call, `ON CONFLICT` against 034's partial unique community-key index.
- **Owned-row guard on every mutating statement — including the `ON CONFLICT DO UPDATE` arm** (`WHERE memory_items.source_type = 'consolidation_summary' AND metadata->'consolidation'->>'kind' = 'community_summary'`) **+ affected-row checks**: 034's partial unique index is metadata-only, so an unguarded upsert could rewrite a canonical row that merely carries the same metadata shape (T4 audit catch). An unowned conflict now updates nothing, is counted as `summaries_conflict_unowned` (its own field — non-zero means something *else* is writing rows with this shape), and is never reported as a write.
- **Budget isolation**: `GRAPH_CONSOLIDATION_*` env namespace disjoint from `GRAPH_INFERENCE_*`; **`GRAPH_CONSOLIDATION_DRY_RUN=1`** reports without writing — required for the first live run, which must report the component size distribution before any cron is installed (the giant-component risk is unmeasured).

### Changed — self-amplification defense in graph-inference (Sprint 83 T3)
- `fetchCandidatePairs` (`supabase/functions/graph-inference/index.ts`) now excludes `source_type = 'consolidation_summary'` on **both** LATERAL sides. A community summary is by construction semantically near-identical to its members, so it would clear the 0.85 cosine threshold on the next nightly tick, acquire edges to everything it summarizes, and be summarized again the night after — compounding derivative content that never looks broken from the outside. Consolidation's own member-selection exclusion stops the loop; this stops the edge-count inflation.

### Notes
- Sprint 83 T3 (rumen half), **FINAL-VERDICT GREEN + GREEN-REAFFIRMED** (T4 Codex adversarial auditor). `npm test` **197 (196 pass / 1 explicit DB skip)**, `tsc --noEmit` clean, gitleaks 0. Consolidation has never run against real data (mock-pool-verified) — first live run in `GRAPH_CONSOLIDATION_DRY_RUN=1` is the acceptance step for deliverable value.
- **Deploy tail (operator, strictly post-publish):** the `graph-consolidation` wrapper pins `npm:@jhizzard/rumen@0.10.0` — deploy it ONLY after this version is published (deploying against a pre-export pin is a silent no-op, the Sprint-66 Brad-Rumen-zero shape). Cron decision pending: 03:30 UTC proposed but collides with doctrine-scan; ORCH staggers.
- Known follow-up (BACKLOG'd in termdeck): `tests/graph-consolidation.test.ts:184-195`'s alternate-guard assertion is weaker than the source proof (accepts the `'community_summary'` string as an alternative to `OWNED_ROW_PREDICATE`) — tighten.
- Companions: `@jhizzard/mnestra@0.11.0` (migration 034 graph layer) + `@jhizzard/termdeck@1.16.0` + `@jhizzard/termdeck-stack@1.14.0`.

## [0.9.0] - 2026-07-30

### Changed — confidence v3: derived RRF band + quantile-anchored normalization (Sprint 82 T3)
- **`RRF_CEILING = 0.3` → derived `RRF_BAND_MAX = 0.0737704918`** (`src/confidence.ts`): the analytic ceiling of engram's `memory_hybrid_search` RRF composite, `2/(rrf_k+1) × 1.5 × 1.5` at `rrf_k=60` — confirmed by live telemetry hitting it to 7 significant figures (~39k `memory_recall_log` rows, deployed max 0.0737700719…). The 0.3 assumption meant normalized confidence topped out ≈0.22 and the similarity term was structurally drowned. `RRF_BAND_MIN = 0.00308726` (observed floor — empirical, a function of candidate-pool depth). Old names kept as `@deprecated` aliases.
- **Linear band map → 14-knot quantile-anchored piecewise-linear map** (`RRF_QUANTILE_KNOTS`): RRF is ordinal, so the only honest cardinalization is position in the observed distribution. Knots are a **pinned snapshot** — 2026-07-30 20:11 ET, n = 39,048, `graph` surface + smoke rows excluded — with the exact `percentile_cont` refresh SQL, snapshot provenance, and live-drift note in the docstring (body knots p10–p90 drift ≤0.09%; the p99 tail 2.16%; refreshing knots without bumping the version marker in the same change is explicitly forbidden). **`NORMALIZE_VERSION` 2 → 3** tags the cohort. Knot table byte-identical with engram 0.10.0's `scoreBandPercentile` — the two packages must not disagree about what an RRF score means.
- Outcome: `normalizeSimilarity(p50 = 0.0219)` = **0.489** (was 0.041); median-strength single-memory `computeConfidence` **0.023 → 0.275** — the similarity term now sits alongside the 0.30 cross-project bonus instead of 13× under it, which is the outcome the v2 recalibration was written to produce and did not.

### Notes
- Sprint 82 T3, **FINAL-VERDICT-4 GREEN** (T4 Codex adversarial auditor; independent SELECT-only reproduction of the band + per-knot drift to the digit). `npm test` **161 pass / 0 fail / 1 pre-existing skip**, typecheck clean, gitleaks 0. One test fixture moved (`tests/synthesize.test.ts`: `similarity: 0.155` "band midpoint" → the real p50 knot 0.02188507 — under the corrected band 0.155 is 2× the maximum attainable score and saturates; the asserted 0.275 is unchanged, an independent check that the new map puts the live median where the old test believed its midpoint was). Companions: `@jhizzard/mnestra@0.10.0` (migration 033 `semantic_similarity` + calibration contract) + `@jhizzard/termdeck@1.15.0` + `@jhizzard/termdeck-stack@1.13.0`.

## [0.8.0] - 2026-07-05

### Added — recall-feedback learning loop (Sprint 81 T2)
- **`src/reinforce.ts`** + Edge Function **`rumen-reinforce`** (thin-wrapper, npm-pin `@jhizzard/rumen@0.8.0`, watchdog, `DATABASE_URL` fallback, fail-soft, `RUMEN_REINFORCE_DRY_RUN=1`): windows over engram's `memory_recall_log` + the durable denorm (`recall_count`/`last_recalled_at`, which survives the 90-day raw-log purge), computes a smoothed EWMA reinforcement weight per memory (`target = 1 + (2−1)·usage·recency`; usage saturates with `cited` weighted 3× `surfaced`; 30-day recency half-life; bounded `[1.0, 2.0]`, strict no-op at 1.0 so never-recalled memories stay untouched), and writes changed rows via ONE `set_recall_boost` call. **Doctrine-clean**: writes ONLY `memory_items.recall_boost` via the column-scoped RPC — never ranking content, never a raw `UPDATE memory_items`; builds on the auto-populated `cited` signal, not the manual `acted_upon`. Closes the memory→recall→reinjection→**learning** loop (engram 032's `recall_boost` factor consumes it).

### Changed — synthesis quality (Sprint 81 T2)
- `computeConfidence` (`src/synthesize.ts`) recalibrated against the RRF fusion band (0.01–0.3) via a new `normalizeSimilarity()` (`src/confidence.ts`) so a strong same-project match no longer loses to a weak cross-project one (the pre-v2 drown bug); a new `noveltyFactor()` down-ranks near-duplicate prior art (union-find on normalized-content equality OR token-Jaccard ≥ 0.85, bounded `[0.5, 1]` asymptotic floor); `buildUserPrompt` enriched with per-memory age, cross-project spread, and recency.
- `docs/MNESTRA-COMPATIBILITY.md` / `CONTRIBUTING.md` document `recall_boost` as Rumen's fourth (bounded, RPC-only) `memory_items` write surface.

### Notes
- Sprint 81 T2, FINAL-VERDICT green (T7 Codex auditor). `npm test` **156** (0 fail, 1 real-PG skip), `tsc` clean, gitleaks 0. `rumen-reinforce` deploys after this publish + engram 032 live (`recall_boost` col + `set_recall_boost` RPC); its pg_cron schedule is a follow-on (manually invocable meanwhile). Companions: `@jhizzard/mnestra@0.9.0` + `@jhizzard/termdeck@1.14.0`.

## [0.7.0] - 2026-07-05

### Added — doctrine-scan (detect + synthesize)
- Migration `004_doctrine_registry.sql`: `doctrine_registry` (status enum `candidate|drafted|proposed|ratified|rejected|superseded`, `cluster_member_ids`, `centroid vector(1536)`, `occurrence_count`, `projects[]`, `reinforced_after_ratification`, member content-hash snapshot, `origin`) + a `doctrine_jobs` heartbeat — RLS enabled on both, no PUBLIC write path. Migration `005_pg_cron_doctrine_scan.sql`: 03:30 UTC schedule (after graph-inference's 03:00), reuses the `rumen_service_role_key` Vault secret.
- Edge Function `doctrine-scan` (`src/doctrine-scan.ts` + `supabase/functions/doctrine-scan/`): density clustering over the curated pool (mean pairwise ≥ 0.85; N ≥ 3 and ≥ 2 projects or ≥ 21d spread), centroid-fingerprint dedup, Haiku synthesis (cap 10 calls/scan, kitchen-vs-recipe classifier, evidence = dates + gists, no verbatim quotes), `trigger_hints` **shadow-mode only**, fail-soft no-key path parks `status='candidate'`, per-scan substrate-sanity heartbeat. **DB-detect-only inside `rumen_*` tables** (CONTRIBUTING ground-rule-1) — flow-back to `memory_items` is termdeck's job, never rumen's.
- `README.md` / `MNESTRA-COMPATIBILITY.md` flow-back claims corrected.

### Notes
- Sprint 79 T2, FINAL-VERDICT GREEN on code/tests; live-landedness pending ORCH apply. `npm test` **126/127** (+1 skip), typecheck/build clean. Companions: `@jhizzard/mnestra@0.8.0` + `@jhizzard/termdeck@1.13.0`.

## [0.6.1] - 2026-07-01

### Fixed — rumen-tick 150s Edge-Function wall (tick 504'd every 15 min on a field deployment for 3+ days)

- **Whole-job wall-clock budget** (`RUMEN_TICK_BUDGET_MS`, default 110s). `runRumenJob` now computes a deadline; past it, Relate skips remaining signals (`related: []`) and Synthesize falls back to placeholder insights instead of making further LLM calls. The job always completes, stamps its sessions, and writes the job row — no more platform-kill mid-flight leaving `rumen_jobs` rows stuck in `running` and sessions unstamped.
- **Bounded DB I/O.** `createPoolFromUrl` sets `connectionTimeoutMillis` (default 15s, `RUMEN_DB_CONNECT_TIMEOUT_MS`) and `query_timeout` (default 30s, `RUMEN_DB_QUERY_TIMEOUT_MS`). node-postgres defaults both to 0 = wait forever, so an unreachable pooler endpoint previously rode every invocation to the platform's 150s kill.
- **Bounded LLM I/O.** The Anthropic client now sets `timeout` (default 30s, `RUMEN_LLM_TIMEOUT_MS`) and `maxRetries: 1` instead of the SDK defaults (10 min / 2 retries). A failed batch already falls back to placeholders.
- **Edge wrapper watchdog.** `supabase/functions/rumen-tick/index.ts` races `runRumenJob` against a 140s timer (`RUMEN_TICK_WATCHDOG_MS`) and returns a real JSON 500 (`rumen-tick watchdog: …`) instead of an opaque platform 504 if anything upstream of the package-level guards hangs. Wrapper's npm pin bumped `0.1.0` → `0.6.1` (the bundled TermDeck copy keeps its `__RUMEN_VERSION__` placeholder).

### Redeploy note for existing installs

The package-level guards only take effect after the Edge Function is redeployed (the `npm:` pin freezes the package version at deploy time): `supabase functions deploy rumen-tick --project-ref <your-project-ref>`, or re-run the stack installer's Rumen refresh.

## [0.4.4] - 2026-04-29

### Changed — Sprint 42 T1: graph-inference Edge Function rewrite (LATERAL + HNSW)

- **`fetchCandidatePairs` rewritten from naive nested-loop to LATERAL+HNSW per-row top-K.** The old shape (`FROM memory_items m1 JOIN memory_items m2 ON m1.id < m2.id WHERE (m1.embedding <=> m2.embedding) <= cutoff`) put the cosine constraint as a **post-join Filter**, never as an `ORDER BY <=>` LIMIT-K, so the HNSW index `memory_items_embedding_idx` was never consulted. EXPLAIN confirmed `Nested Loop` over `Seq Scan(m1) × IndexScan(memory_items_pkey, m2)` with 3.6M estimated rows — the source of the 150s+ Edge Function timeouts that have kept the cron disabled since Sprint 38 close. New shape: `FROM memory_items m1 CROSS JOIN LATERAL (SELECT ... FROM memory_items m2 WHERE ... ORDER BY m2.embedding <=> m1.embedding LIMIT $perRowK) nbr` — HNSW serves per-row top-K, `O(N²) → O(N log K)`. Symmetry handled via `LEAST/GREATEST(m1.id, nbr.id)` canonicalization + `DISTINCT ON` so pairs found from either direction dedupe. `since` filter applies only to outer `m1` (recent updates seed LATERAL searches; pairs where m2 was recently updated are caught when m2 is the outer in a different iteration).
- **NEW `GRAPH_INFERENCE_PER_ROW_K` env var** (default 8) threads the LATERAL `LIMIT` through `runGraphInference`. Lower values risk missing pairs in the 0.85-0.90 similarity band; default 8 was empirically sufficient on the daily-driver project.
- **Live validation against the daily-driver project corpus** (5,822 active memory_items, threshold=0.85, since=NULL, perRowK=8, maxPairs=5000): **360 unique pairs returned in 13.5s wall-clock** (vs 150s+ timeout pre-rewrite — **11x perf**), similarity range 0.850-1.000, 45 of 360 are cross-project edges (the cohort the cron exists to surface — intra-project edges are already written in real time by rag-system's MCP-side classifier). EXPLAIN ANALYZE confirmed `Index Scan using memory_items_embedding_idx, Order By: (embedding <=> m1.embedding), Limit 8`. Steady-state runs will be sub-second once `since` filter kicks in (only re-scans recently-updated rows). 13.5s exceeds the 10s acceptance target by ~3s on cold start; vastly within Edge Function 150s wall-clock.

### Notes

- **Pairs with the TermDeck v0.11.0 ship.** TermDeck Sprint 42 T3 paired with this lane: `init-rumen.js::applySchedule` now applies BOTH 002 (rumen-tick) and 003 (graph-inference-tick) with the new `applyTemplating` helper. Before T3, migration 003 was bundled but never applied during fresh install — so the cron schedule never landed for greenfield users. Now it does.
- **Operational deploy steps after publish (Joshua's Passkey required for cron re-enable):**
  ```
  cd ~/Documents/Graciella/rumen
  supabase functions deploy graph-inference --project-ref <your-project-ref>
  # then re-enable the cron via the now-correctly-templated migration 003
  # then manually fire once via cron's pg_net path to confirm the ~360 cross-project edges land
  ```
- **Tests:** `node --test tests/graph-inference.test.js` → **24/24 green**. Full Rumen suite **58/58 green**. Deno check clean.

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
