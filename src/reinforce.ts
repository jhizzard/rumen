/**
 * Rumen Sprint 81 — Reinforce phase (recall-feedback loop).
 *
 * The read side of the memory fabric can now observe WHICH memories a session
 * actually pulled and used: engram migration 027 denormalizes `recall_count` /
 * `last_recalled_at` onto memory_items and stamps `cited` per hit into
 * `memory_recall_log`; migration 031 (Sprint 81) fixes the provenance wiring.
 * Reinforce consumes that signal and writes a single bounded reinforcement
 * weight per memory — `memory_items.recall_boost` — so genuinely-useful memories
 * rank a little higher next time they are recalled.
 *
 * Doctrine-clean (see docs/MNESTRA-COMPATIBILITY.md § What Rumen writes and
 * CONTRIBUTING.md ground rule 1): reinforce writes ONLY recall_boost, and only
 * through the service-role `set_recall_boost` RPC (engram migration 032). It
 * NEVER writes ranking content, NEVER mutates any other memory column, NEVER
 * updates/deletes an existing memory row's content. recall_boost is a dedicated
 * reinforcement column analogous to doctrine_registry.occurrence_count.
 *
 * Guardrails against a rich-get-richer runaway:
 *   - The weight is BOUNDED: [minBoost=1.0, maxBoost=2.0]. 1.0 is a strict
 *     no-op multiplier, so a never-recalled memory is untouched (this honors the
 *     pruning moratorium — absence of telemetry is never a penalty).
 *   - Usage SATURATES: a saturating (1 - e^-x) curve means the 50th recall
 *     barely moves the needle past the 5th. Popularity can't compound without
 *     limit.
 *   - Usage DECAYS with recency: an exponential half-life on days-since-last-
 *     recall relaxes stale popularity back toward the no-op floor.
 *   - The run is EWMA-SMOOTHED against the previous boost so ranking never
 *     thrashes on a single bursty window.
 *
 * Sibling of rumen-tick / inbox-promote / doctrine-scan by design — independent
 * cadence, budget isolation, failure isolation. It is NOT a step inside the
 * insight tick.
 */

import type { PgPool } from './db.js';

const DEFAULT_WINDOW_DAYS = 90; // memory_recall_log raw rows purge at 90d.
const DEFAULT_BATCH = 500;
const DEFAULT_BUDGET_MS = 110_000; // under the Edge Function 150s wall.
// Below this absolute change we skip the write — no point churning a row from
// 1.000 to 1.000 (or 1.412 to 1.413).
const WRITE_EPSILON = 0.005;

/**
 * Tunables for the reinforcement weight. Exposed so `computeRecallBoost` is a
 * pure function of its inputs (deterministic under test) and the runner can
 * override any knob from the environment.
 */
export interface ReinforceTunables {
  /** No-op floor. recall_boost never drops below this. */
  minBoost: number;
  /** Hard ceiling. The bound that stops rich-get-richer runaway. */
  maxBoost: number;
  /** A citation (cited=true) counts this many usage points — the strong signal. */
  citedWeight: number;
  /** A mere surfacing (recalled but not cited) counts this many points. */
  surfacedWeight: number;
  /** Older, pre-window recalls (from the durable denorm) count this many points. */
  alltimeWeight: number;
  /** Usage-count scale for the saturating curve; larger → slower saturation. */
  usageScale: number;
  /** Days for the recency multiplier to halve. */
  halflifeDays: number;
  /** EWMA blend of the new target against the previous boost, in [0, 1]. */
  alpha: number;
}

export const DEFAULT_TUNABLES: ReinforceTunables = {
  minBoost: 1.0,
  maxBoost: 2.0,
  citedWeight: 3,
  surfacedWeight: 1,
  alltimeWeight: 0.5,
  usageScale: 12,
  halflifeDays: 30,
  alpha: 0.5,
};

/** Per-memory inputs to the reinforcement weight. */
export interface RecallBoostInput {
  /** All-time surfaced count (denorm memory_items.recall_count — survives purge). */
  recallCount: number;
  /** Cited hits within the window (memory_recall_log, cited=true). */
  citedCount: number;
  /** Total hits within the window (memory_recall_log rows). */
  surfacedCount: number;
  /** Days since memory_items.last_recalled_at (clamped ≥ 0 by the callee). */
  daysSinceLastRecall: number;
  /** The memory's current recall_boost, for EWMA smoothing. */
  prevBoost: number;
}

/**
 * Pure reinforcement-weight function. Maps a memory's recall telemetry onto a
 * bounded recall_boost in [minBoost, maxBoost].
 *
 *   weightedUsage = citedWeight·cited
 *                 + surfacedWeight·(surfaced − cited)      (recent, not cited)
 *                 + alltimeWeight·max(0, recallCount − surfaced)  (older floor)
 *   usage   = 1 − e^(−weightedUsage / usageScale)          (saturating, 0..1)
 *   recency = 0.5^(daysSinceLastRecall / halflifeDays)     (decaying, 0..1]
 *   target  = minBoost + (maxBoost − minBoost)·usage·recency
 *   boost   = prevBoost + alpha·(target − prevBoost)        (EWMA smoothing)
 *
 * Every term is bounded, so the result is bounded. Non-finite inputs are
 * sanitized (treated as 0, except prevBoost which falls back to minBoost) so a
 * malformed denorm read can never produce a NaN write.
 */
export function computeRecallBoost(
  input: RecallBoostInput,
  tunables: ReinforceTunables = DEFAULT_TUNABLES,
): number {
  const {
    minBoost,
    maxBoost,
    citedWeight,
    surfacedWeight,
    alltimeWeight,
    usageScale,
    halflifeDays,
    alpha,
  } = tunables;

  const cited = finiteOr(input.citedCount, 0);
  const surfaced = finiteOr(input.surfacedCount, 0);
  const recallCount = finiteOr(input.recallCount, 0);
  // NaN → 0 (fresh; a safe default for a genuinely malformed value). A
  // deliberate Infinity (the daysSince sentinel for a NULL last_recalled_at)
  // passes THROUGH so recency decays fully to 0 — an unknown recall time must
  // never read as "recalled today".
  const days = Number.isNaN(input.daysSinceLastRecall)
    ? 0
    : Math.max(0, input.daysSinceLastRecall);
  const prevBoost = clamp(finiteOr(input.prevBoost, minBoost), minBoost, maxBoost);

  const recentSurfacedNotCited = Math.max(0, surfaced - cited);
  const olderRecalls = Math.max(0, recallCount - surfaced);
  const weightedUsage =
    citedWeight * cited +
    surfacedWeight * recentSurfacedNotCited +
    alltimeWeight * olderRecalls;

  const usage = 1 - Math.exp(-weightedUsage / usageScale); // 0..1
  const recency = Math.pow(0.5, days / halflifeDays); // (0..1]
  const target = minBoost + (maxBoost - minBoost) * usage * recency;

  const smoothed = prevBoost + alpha * (target - prevBoost);
  return clamp(smoothed, minBoost, maxBoost);
}

/** One candidate memory pulled from the denorm rollup. */
interface CandidateRow {
  id: string;
  recall_count: number | string | null;
  last_recalled_at: Date | string | null;
  recall_boost: number | string | null;
}

/** Windowed cited/surfaced tallies keyed by memory id. */
interface WindowTally {
  citedCount: number;
  surfacedCount: number;
}

/** One (id, boost) pair queued for the set_recall_boost RPC. */
export interface BoostUpdate {
  id: string;
  boost: number;
}

export interface ReinforceOptions {
  /** Lookback window in days for the memory_recall_log tally. Default 90. */
  windowDays?: number;
  /** Max candidate memories per pass. Default 500. */
  batch?: number;
  /** Wall-clock budget in ms. Default 110_000. */
  budgetMs?: number;
  /** Tunable overrides (else DEFAULT_TUNABLES, further overridden by env). */
  tunables?: Partial<ReinforceTunables>;
  /**
   * Compute + log but do NOT write. Set by RUMEN_REINFORCE_DRY_RUN=1. Useful for
   * the cold-vs-warm proof harness and first-run validation on a live store.
   */
  dryRun?: boolean;
  /** Injected clock (epoch ms) for deterministic tests. Default Date.now(). */
  nowMs?: number;
}

export interface ReinforceSummary {
  status: 'done' | 'failed';
  candidates_scanned: number;
  boosts_written: number;
  /** True when the candidate query hit `batch` — more memories remain for the next pass. */
  batch_saturated: boolean;
  skipped_reason: string | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}

/**
 * Run one reinforcement pass: scan recently-recalled (or currently-boosted)
 * memories, recompute each one's bounded recall_boost from its telemetry, and
 * batch-write the changed ones via the set_recall_boost RPC.
 *
 * Fail-soft at the pass level: any thrown error is caught and returned as
 * status='failed' with a message (the Edge Function surfaces it as a non-200),
 * never rethrown into the caller.
 */
export async function runRumenReinforce(
  pool: PgPool,
  options: ReinforceOptions = {},
): Promise<ReinforceSummary> {
  const nowMs = options.nowMs ?? Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const windowDays = options.windowDays ?? readIntEnv('RUMEN_REINFORCE_WINDOW_DAYS', DEFAULT_WINDOW_DAYS);
  const batch = options.batch ?? readIntEnv('RUMEN_REINFORCE_BATCH', DEFAULT_BATCH);
  const budgetMs = options.budgetMs ?? readIntEnv('RUMEN_REINFORCE_BUDGET_MS', DEFAULT_BUDGET_MS);
  const dryRun = options.dryRun ?? readBoolEnv('RUMEN_REINFORCE_DRY_RUN');
  const tunables = resolveTunables(options.tunables);
  // Budget is REAL wall-clock elapsed during the pass, deliberately independent
  // of `nowMs` (which is a logical reference time for age math and may be pinned
  // to the past under test). Measuring it off nowMs would let an injected clock
  // spuriously trip the guard.
  const deadlineAt = Date.now() + budgetMs;

  console.log(
    '[rumen-reinforce] starting: windowDays=' +
      windowDays +
      ' batch=' +
      batch +
      ' dryRun=' +
      dryRun,
  );

  try {
    // 1. Candidate scan: memories recalled within the window OR already carrying
    //    an above-floor boost (so a stale boost relaxes back down even if the
    //    memory has gone quiet). Read from the DURABLE denorm — raw log rows
    //    purge at 90d, but recall_count/last_recalled_at persist.
    const candidates = await scanCandidates(pool, windowDays, batch, tunables.minBoost);
    const batchSaturated = candidates.length >= batch;
    if (batchSaturated) {
      console.warn(
        '[rumen-reinforce] candidate scan hit the batch cap (' +
          batch +
          ') — more memories remain for the next pass (not silently dropped)',
      );
    }

    if (candidates.length === 0) {
      console.log('[rumen-reinforce] no candidates — nothing to reinforce');
      return done(startedAt, nowMs, 0, 0, batchSaturated, null);
    }

    // 2. Windowed cited/surfaced tally for exactly these candidates.
    const ids = candidates.map((c) => c.id);
    const tallies = await tallyWindow(pool, ids, windowDays);

    // 3. Compute the new bounded boost per candidate; keep only real changes.
    const updates: BoostUpdate[] = [];
    for (const row of candidates) {
      const prevBoost = numOr(row.recall_boost, tunables.minBoost);
      const tally = tallies.get(row.id) ?? { citedCount: 0, surfacedCount: 0 };
      const daysSinceLastRecall = daysSince(row.last_recalled_at, nowMs);
      const next = round3(
        computeRecallBoost(
          {
            recallCount: numOr(row.recall_count, 0),
            citedCount: tally.citedCount,
            surfacedCount: tally.surfacedCount,
            daysSinceLastRecall,
            prevBoost,
          },
          tunables,
        ),
      );
      if (Math.abs(next - prevBoost) >= WRITE_EPSILON) {
        updates.push({ id: row.id, boost: next });
      }
    }

    console.log(
      '[rumen-reinforce] computed: candidates=' +
        candidates.length +
        ' changed=' +
        updates.length,
    );

    if (dryRun) {
      return done(startedAt, nowMs, candidates.length, 0, batchSaturated, 'dry_run');
    }
    if (updates.length === 0) {
      return done(startedAt, nowMs, candidates.length, 0, batchSaturated, null);
    }
    if (Date.now() > deadlineAt) {
      console.warn('[rumen-reinforce] budget exceeded before write — skipping write this pass');
      return done(startedAt, nowMs, candidates.length, 0, batchSaturated, 'budget_exceeded');
    }

    // 4. Single bounded write through the service-role RPC. The RPC clamps each
    //    boost to [1.0, maxBoost] server-side and touches ONLY recall_boost.
    const written = await writeBoosts(pool, updates);
    console.log('[rumen-reinforce] wrote ' + written + ' recall_boost updates');
    return done(startedAt, nowMs, candidates.length, written, batchSaturated, null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen-reinforce] pass failed:', err);
    return {
      status: 'failed',
      candidates_scanned: 0,
      boosts_written: 0,
      batch_saturated: false,
      skipped_reason: null,
      started_at: startedAt,
      completed_at: new Date(Date.now()).toISOString(),
      error_message: message,
    };
  }
}

async function scanCandidates(
  pool: PgPool,
  windowDays: number,
  batch: number,
  minBoost: number,
): Promise<CandidateRow[]> {
  const res = await pool.query<CandidateRow>(
    `
      SELECT id, recall_count, last_recalled_at, recall_boost
      FROM memory_items
      WHERE (
              recall_count > 0
              AND last_recalled_at IS NOT NULL
              AND last_recalled_at >= NOW() - ($1 || ' days')::interval
            )
         OR recall_boost > $3
      ORDER BY last_recalled_at DESC NULLS LAST
      LIMIT $2
    `,
    [String(windowDays), batch, minBoost],
  );
  return res.rows;
}

async function tallyWindow(
  pool: PgPool,
  ids: string[],
  windowDays: number,
): Promise<Map<string, WindowTally>> {
  const res = await pool.query<{
    memory_id: string;
    cited_count: number | string;
    surfaced_count: number | string;
  }>(
    `
      SELECT
        memory_id,
        COUNT(*) FILTER (WHERE cited) AS cited_count,
        COUNT(*)                      AS surfaced_count
      FROM memory_recall_log
      WHERE memory_id = ANY($1::uuid[])
        AND created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY memory_id
    `,
    [ids, String(windowDays)],
  );
  const out = new Map<string, WindowTally>();
  for (const row of res.rows) {
    out.set(row.memory_id, {
      citedCount: numOr(row.cited_count, 0),
      surfacedCount: numOr(row.surfaced_count, 0),
    });
  }
  return out;
}

async function writeBoosts(pool: PgPool, updates: BoostUpdate[]): Promise<number> {
  const res = await pool.query<{ updated: number | string | null }>(
    `SELECT set_recall_boost($1::jsonb) AS updated`,
    [JSON.stringify(updates)],
  );
  return numOr(res.rows[0]?.updated, updates.length);
}

function done(
  startedAt: string,
  nowMs: number,
  scanned: number,
  written: number,
  batchSaturated: boolean,
  skippedReason: string | null,
): ReinforceSummary {
  return {
    status: 'done',
    candidates_scanned: scanned,
    boosts_written: written,
    batch_saturated: batchSaturated,
    skipped_reason: skippedReason,
    started_at: startedAt,
    completed_at: new Date(Date.now()).toISOString(),
    error_message: null,
  };
}

function resolveTunables(overrides?: Partial<ReinforceTunables>): ReinforceTunables {
  return {
    minBoost: DEFAULT_TUNABLES.minBoost, // floor is a contract, not an env knob.
    maxBoost: overrides?.maxBoost ?? readFloatEnv('RUMEN_REINFORCE_MAX_BOOST', DEFAULT_TUNABLES.maxBoost),
    citedWeight: overrides?.citedWeight ?? readFloatEnv('RUMEN_REINFORCE_CITED_WEIGHT', DEFAULT_TUNABLES.citedWeight),
    surfacedWeight: overrides?.surfacedWeight ?? readFloatEnv('RUMEN_REINFORCE_SURFACED_WEIGHT', DEFAULT_TUNABLES.surfacedWeight),
    alltimeWeight: overrides?.alltimeWeight ?? readFloatEnv('RUMEN_REINFORCE_ALLTIME_WEIGHT', DEFAULT_TUNABLES.alltimeWeight),
    usageScale: overrides?.usageScale ?? readFloatEnv('RUMEN_REINFORCE_USAGE_SCALE', DEFAULT_TUNABLES.usageScale),
    halflifeDays: overrides?.halflifeDays ?? readFloatEnv('RUMEN_REINFORCE_HALFLIFE_DAYS', DEFAULT_TUNABLES.halflifeDays),
    alpha: overrides?.alpha ?? readFloatEnv('RUMEN_REINFORCE_ALPHA', DEFAULT_TUNABLES.alpha),
  };
}

// ── small helpers ───────────────────────────────────────────────────────────

function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function finiteOr(x: number, fallback: number): number {
  return Number.isFinite(x) ? x : fallback;
}

/** Coerce a possibly-string/NULL pg value (NUMERIC/bigint come back as strings). */
function numOr(v: number | string | null | undefined, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Days between last_recalled_at (Date or ISO string) and nowMs, clamped ≥ 0. */
function daysSince(lastRecalledAt: Date | string | null, nowMs: number): number {
  if (lastRecalledAt === null) return Number.POSITIVE_INFINITY;
  const ms = lastRecalledAt instanceof Date ? lastRecalledAt.getTime() : Date.parse(lastRecalledAt);
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - ms) / 86_400_000);
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error('[rumen-reinforce] ' + name + '=' + raw + ' is not a positive integer; using default ' + fallback);
    return fallback;
  }
  return parsed;
}

function readFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error('[rumen-reinforce] ' + name + '=' + raw + ' is not a non-negative number; using default ' + fallback);
    return fallback;
  }
  return parsed;
}

function readBoolEnv(name: string): boolean {
  const raw = process.env[name];
  return raw === '1' || raw === 'true';
}
