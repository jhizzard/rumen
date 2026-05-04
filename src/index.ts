/**
 * Rumen v0.1 — entry point.
 *
 * Exports `runRumenJob`, which executes one end-to-end Extract + Relate +
 * Surface cycle and returns a summary.
 *
 * v0.1 scope:
 *   - NO LLM synthesis  (reserved for v0.2)
 *   - NO question generation  (reserved for v0.3)
 *   - Non-destructive: only INSERTs into rumen_jobs and rumen_insights.
 *
 * WARNING: Rumen v0.1 writes to a `rumen_insights` table. It does NOT modify
 * or delete any existing memory rows. Run against a TEST instance for the
 * first two weeks of use. Do NOT point at production memory stores until
 * validated.
 */

import { extractSignals } from './extract.js';
import { relateSignals } from './relate.js';
import {
  createSynthesizeContext,
  synthesizeInsights,
  makePlaceholderInsight,
} from './synthesize.js';
import { surfaceInsights } from './surface.js';
import type { PgPool } from './db.js';
import type { Insight, RumenJobSummary, RunRumenJobOptions } from './types.js';

export { getPool, createPoolFromUrl, withClient } from './db.js';
export { extractSignals } from './extract.js';
export { relateSignals } from './relate.js';
export {
  createSynthesizeContext,
  synthesizeInsights,
  makePlaceholderInsight,
} from './synthesize.js';
export { surfaceInsights } from './surface.js';
export type {
  RumenJob,
  RumenInsight,
  RumenSignal,
  RumenJobSummary,
  RelatedMemory,
  RelatedSignal,
  RunRumenJobOptions,
  MemoryItem,
  MemorySession,
  Insight,
  SynthesizeContext,
} from './types.js';

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_LOOKBACK_HOURS = 72;
// Mnestra's memory_hybrid_search returns RRF-fused scores with recency decay,
// which land in a 0.01–0.3 range — NOT 0–1 similarity. A 0.7 threshold is
// unreachable and causes every signal to match 0 memories. 0.01 is the
// effective floor for "better than nothing" under this scoring model.
const DEFAULT_MIN_SIMILARITY = 0.01;
const DEFAULT_MIN_EVENT_COUNT = 3;

export async function runRumenJob(
  pool: PgPool,
  options: RunRumenJobOptions = {},
): Promise<RumenJobSummary> {
  const triggeredBy = options.triggeredBy ?? 'manual';
  const maxSessions = options.maxSessions ?? readMaxSessionsFromEnv();
  const lookbackHours = options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const minEventCount = options.minEventCount ?? DEFAULT_MIN_EVENT_COUNT;

  console.log(
    '[rumen] starting job triggeredBy=' +
      triggeredBy +
      ' maxSessions=' +
      maxSessions +
      ' lookbackHours=' +
      lookbackHours,
  );

  // 1. Create the job row in 'running' state.
  const jobRow = await createJob(pool, triggeredBy);
  const jobId = jobRow.id;
  console.log('[rumen] created job ' + jobId);

  try {
    // 2. Extract.
    const extractResult = await extractSignals(pool, {
      lookbackHours,
      maxSessions,
      minEventCount,
    });

    // Persist the session IDs we actually picked so future jobs can skip them.
    const sourceSessionIds = extractResult.signals.map((s) => s.session_id);

    // 3. Relate.
    const related = await relateSignals(pool, extractResult.signals, {
      minSimilarity,
    });

    // 4. Synthesize. Hard-cap errors bubble up; on any other error we fall
    //    back to v0.1-style placeholder insights so the job still surfaces
    //    something.
    const synthCtx = createSynthesizeContext();
    let insights: Insight[];
    try {
      insights = await synthesizeInsights(related, synthCtx);
    } catch (err) {
      if (err instanceof Error && err.message.includes('hard cap')) {
        throw err;
      }
      console.error(
        '[rumen] synthesize failed, falling back to placeholder insights:',
        err,
      );
      insights = related
        .filter((rs) => rs.related.length > 0)
        .map((rs) => makePlaceholderInsight(rs));
    }

    // 4b. Stamp `memory_sessions.rumen_processed_at = now()` BEFORE surface.
    //     Picker filters `WHERE rumen_processed_at IS NULL`, so this is the
    //     idempotency guard against double-emit on retry. Order is critical
    //     (T4-CODEX 17:25 ET pre-FIX audit):
    //       - stamp before surface → if stamp fails, throw aborts the job
    //         BEFORE any insights are written; next tick re-picks cleanly
    //         (zero double-emit risk because surface never ran).
    //       - stamp on extractResult.pickedSessionIds (not just signal IDs)
    //         so any buildSignal dropout still gets stamped — closes the
    //         "empty-summary candidates re-pick forever" infinite-loop class.
    //     Surface has no de-dupe constraint on rumen_insights, so any
    //     scheme that allows surface to run before stamp is unsafe.
    if (extractResult.pickedSessionIds.length > 0) {
      await stampSessionsProcessed(pool, extractResult.pickedSessionIds);
    }

    // 5. Surface.
    const surfaceResult = await surfaceInsights(pool, insights, { jobId });

    // 6. Mark the job done.
    const done = await completeJob(pool, {
      jobId,
      status: 'done',
      sessionsProcessed: extractResult.signals.length,
      insightsGenerated: surfaceResult.insightsGenerated,
      questionsGenerated: 0, // reserved for v0.3
      sourceSessionIds,
      errorMessage: null,
    });

    console.log(
      '[rumen] job ' +
        jobId +
        ' complete: sessions=' +
        done.sessions_processed +
        ' insights=' +
        done.insights_generated,
    );

    return toSummary(done);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[rumen] job ' + jobId + ' failed:', err);
    try {
      const failed = await completeJob(pool, {
        jobId,
        status: 'failed',
        sessionsProcessed: 0,
        insightsGenerated: 0,
        questionsGenerated: 0,
        sourceSessionIds: [],
        errorMessage: message,
      });
      return toSummary(failed);
    } catch (markErr) {
      console.error('[rumen] job ' + jobId + ' also failed to mark as failed:', markErr);
      throw err;
    }
  }
}

interface CreatedJobRow {
  id: string;
  started_at: string;
}

async function createJob(
  pool: PgPool,
  triggeredBy: 'schedule' | 'session_end' | 'manual',
): Promise<CreatedJobRow> {
  // Explicitly supply started_at = NOW() (rather than relying on the column
  // default) — defense-in-depth against pre-mig-001-DEFAULT-NOW installs
  // where rumen_jobs.started_at lost its NOT NULL DEFAULT during a prior
  // bootstrap. Without this, started_at falls through to NULL on those
  // installs and breaks downstream "recent ticks" queries that ORDER BY
  // started_at DESC. T3 cross-lane callout 2026-05-04 17:33 ET; daily-driver
  // had 5 successive ticks with started_at=NULL because of this drift.
  const res = await pool.query<CreatedJobRow>(
    `
      INSERT INTO rumen_jobs (triggered_by, status, started_at)
      VALUES ($1, 'running', NOW())
      RETURNING id, started_at
    `,
    [triggeredBy],
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error('[rumen] failed to insert rumen_jobs row');
  }
  return row;
}

interface CompleteJobArgs {
  jobId: string;
  status: 'done' | 'failed';
  sessionsProcessed: number;
  insightsGenerated: number;
  questionsGenerated: number;
  sourceSessionIds: string[];
  errorMessage: string | null;
}

interface CompletedJobRow {
  id: string;
  status: 'done' | 'failed';
  sessions_processed: number;
  insights_generated: number;
  questions_generated: number;
  source_session_ids: string[];
  started_at: string;
  completed_at: string;
  error_message: string | null;
}

/**
 * Stamp `memory_sessions.rumen_processed_at = now()` for every session
 * the picker fetched in this tick. Picker filter `rumen_processed_at
 * IS NULL` makes this the idempotency guard.
 *
 * Failures here THROW (no swallow). Stamp runs BEFORE surface in
 * runRumenJob; throwing aborts the job before any rumen_insights row
 * is written, so the next tick re-picks cleanly with zero double-emit
 * risk. surface.ts has no row-level de-dupe, so swallowing a stamp
 * failure (or stamping after surface) would risk duplicate insights.
 */
async function stampSessionsProcessed(
  pool: PgPool,
  sessionIds: string[],
): Promise<void> {
  await pool.query(
    `
      UPDATE memory_sessions
      SET rumen_processed_at = NOW()
      WHERE id = ANY($1::uuid[])
    `,
    [sessionIds],
  );
}

async function completeJob(
  pool: PgPool,
  args: CompleteJobArgs,
): Promise<CompletedJobRow> {
  const res = await pool.query<CompletedJobRow>(
    `
      UPDATE rumen_jobs
      SET status              = $2,
          sessions_processed  = $3,
          insights_generated  = $4,
          questions_generated = $5,
          source_session_ids  = $6::uuid[],
          error_message       = $7,
          completed_at        = NOW()
      WHERE id = $1
      RETURNING
        id,
        status,
        sessions_processed,
        insights_generated,
        questions_generated,
        source_session_ids,
        started_at,
        completed_at,
        error_message
    `,
    [
      args.jobId,
      args.status,
      args.sessionsProcessed,
      args.insightsGenerated,
      args.questionsGenerated,
      args.sourceSessionIds,
      args.errorMessage,
    ],
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error('[rumen] failed to update rumen_jobs row ' + args.jobId);
  }
  return row;
}

function toSummary(row: CompletedJobRow): RumenJobSummary {
  return {
    job_id: row.id,
    status: row.status,
    sessions_processed: row.sessions_processed,
    insights_generated: row.insights_generated,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
  };
}

function readMaxSessionsFromEnv(): number {
  const raw = process.env['MAX_SESSIONS_PER_RUN'];
  if (!raw) {
    return DEFAULT_MAX_SESSIONS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(
      '[rumen] MAX_SESSIONS_PER_RUN=' +
        raw +
        ' is not a positive integer; falling back to default ' +
        DEFAULT_MAX_SESSIONS,
    );
    return DEFAULT_MAX_SESSIONS;
  }
  return parsed;
}
