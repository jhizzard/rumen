/**
 * Rumen v0.1 — Surface phase.
 *
 * Writes one row into rumen_insights per related signal. v0.1 generates
 * placeholder insight_text via string concatenation. v0.2 will replace this
 * with real LLM synthesis using Claude Haiku for extraction and Sonnet for
 * harder synthesis.
 *
 * v0.1 is NON-DESTRUCTIVE. It only INSERTs into rumen_insights. It never
 * touches memory_items, memory_sessions, or any other Engram table.
 */

import type { PgPool } from './db.js';
import type { RelatedSignal } from './types.js';

export interface SurfaceOptions {
  jobId: string;
}

export interface SurfaceResult {
  insightsGenerated: number;
  insightIds: string[];
}

export async function surfaceInsights(
  pool: PgPool,
  relatedSignals: RelatedSignal[],
  options: SurfaceOptions,
): Promise<SurfaceResult> {
  const { jobId } = options;

  console.log(
    '[rumen-surface] starting: job_id=' +
      jobId +
      ' relatedSignals=' +
      relatedSignals.length,
  );

  const insightIds: string[] = [];

  for (const rs of relatedSignals) {
    if (rs.related.length === 0) {
      continue;
    }

    const sourceMemoryIds = rs.related.map((r) => r.id);
    const projects = uniqueNonNull([
      rs.signal.project,
      ...rs.related.map((r) => r.project),
    ]);
    const insightText = buildPlaceholderInsightText(rs);
    const confidence = averageSimilarity(rs);

    try {
      const res = await pool.query<{ id: string }>(
        `
          INSERT INTO rumen_insights (
            job_id,
            source_memory_ids,
            projects,
            insight_text,
            confidence
          )
          VALUES ($1, $2::uuid[], $3::text[], $4, $5)
          RETURNING id
        `,
        [jobId, sourceMemoryIds, projects, insightText, confidence],
      );
      const inserted = res.rows[0];
      if (inserted) {
        insightIds.push(inserted.id);
      }
    } catch (err) {
      console.error(
        '[rumen-surface] failed to insert insight for signal ' + rs.signal.key + ':',
        err,
      );
      // continue — one failed insert shouldn't kill the whole job.
    }
  }

  console.log(
    '[rumen-surface] inserted ' + insightIds.length + ' rumen_insights rows',
  );

  return {
    insightsGenerated: insightIds.length,
    insightIds,
  };
}

/**
 * v0.1 placeholder. v0.2 replaces this with Claude Haiku / Sonnet synthesis.
 *
 * Format:
 *   "Found N related memories from projects [A, B] about: <description>"
 */
function buildPlaceholderInsightText(rs: RelatedSignal): string {
  const count = rs.related.length;
  const relatedProjects = uniqueNonNull(rs.related.map((r) => r.project));
  const projectList =
    relatedProjects.length > 0 ? relatedProjects.join(', ') : 'unknown';
  const description = rs.signal.description.slice(0, 180);
  return (
    'Found ' +
    count +
    ' related ' +
    (count === 1 ? 'memory' : 'memories') +
    ' from ' +
    (relatedProjects.length === 1 ? 'project ' : 'projects ') +
    projectList +
    ' about: ' +
    description
  );
}

function averageSimilarity(rs: RelatedSignal): number {
  if (rs.related.length === 0) {
    return 0;
  }
  const sum = rs.related.reduce((acc, r) => acc + r.similarity, 0);
  const avg = sum / rs.related.length;
  // Clamp to [0, 1] and round to 3 decimals so the NUMERIC(4,3) column accepts it.
  const clamped = Math.max(0, Math.min(1, avg));
  return Math.round(clamped * 1000) / 1000;
}

function uniqueNonNull(values: Array<string | null>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v !== null && v.length > 0) {
      out.add(v);
    }
  }
  return Array.from(out);
}
