/**
 * Rumen Surface phase.
 *
 * Writes one row into rumen_insights per Insight produced by the Synthesize
 * phase. v0.1 wrote placeholder strings directly from RelatedSignal[]; v0.2
 * takes pre-built Insight[] (which may be real Haiku output OR the placeholder
 * fallback, both represented uniformly) and just persists them.
 *
 * Surface is NON-DESTRUCTIVE. It only INSERTs into rumen_insights. It never
 * touches memory_items, memory_sessions, or any other Engram table.
 */

import type { PgPool } from './db.js';
import type { Insight } from './types.js';

export interface SurfaceOptions {
  jobId: string;
}

export interface SurfaceResult {
  insightsGenerated: number;
  insightIds: string[];
}

export async function surfaceInsights(
  pool: PgPool,
  insights: Insight[],
  options: SurfaceOptions,
): Promise<SurfaceResult> {
  const { jobId } = options;

  console.log(
    '[rumen-surface] starting: job_id=' + jobId + ' insights=' + insights.length,
  );

  const insightIds: string[] = [];

  for (const insight of insights) {
    if (insight.source_memory_ids.length === 0) {
      continue;
    }

    const projects = uniqueNonNull([
      insight.source.signal.project,
      ...insight.source.related.map((r) => r.project),
    ]);

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
        [
          jobId,
          insight.source_memory_ids,
          projects,
          insight.insight_text,
          insight.confidence,
        ],
      );
      const inserted = res.rows[0];
      if (inserted) {
        insightIds.push(inserted.id);
      }
    } catch (err) {
      console.error(
        '[rumen-surface] failed to insert insight for signal ' +
          insight.source.signal.key +
          ':',
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

function uniqueNonNull(values: Array<string | null>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v !== null && v.length > 0) {
      out.add(v);
    }
  }
  return Array.from(out);
}
