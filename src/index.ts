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
import { surfaceInsights } from './surface.js';
import type { PgPool } from './db.js';
import type { RumenJobSummary, RunRumenJobOptions } from './types.js';

export { getPool, createPoolFromUrl, withClient } from './db.js';
export { extractSignals } from './extract.js';
export { relateSignals } from './relate.js';
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
} from './types.js';

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_LOOKBACK_HOURS = 72;
const DEFAULT_MIN_SIMILARITY = 0.7;
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

    // 4. Surface.
    const surfaceResult = await surfaceInsights(pool, related, { jobId });

    // 5. Mark the job done.
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
  const res = await pool.query<CreatedJobRow>(
    `
      INSERT INTO rumen_jobs (triggered_by, status)
      VALUES ($1, 'running')
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
