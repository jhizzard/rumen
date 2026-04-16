/**
 * Rumen v0.3 — kickstart script.
 *
 * One-shot local run that drains all eligible historical sessions in a single
 * pass. Widens the lookback window to effectively "all time" and raises the
 * per-run session cap. Idempotent: subsequent runs skip sessions already
 * processed via the rumen_jobs.source_session_ids GIN check.
 *
 * Usage:
 *   cd ~/Documents/Graciella/rumen
 *   set -a; source .env; set +a    # exposes DATABASE_URL + ANTHROPIC_API_KEY
 *   npm run kickstart
 *
 * Optional overrides via env vars (all numeric):
 *   KICKSTART_MAX_SESSIONS   default 200
 *   KICKSTART_LOOKBACK_HOURS default 43800 (5 years)
 *   KICKSTART_MIN_EVENTS     default 3
 */

import 'dotenv/config';
import { createPoolFromUrl, runRumenJob } from '../src/index.js';

const MAX_SESSIONS = Number(process.env['KICKSTART_MAX_SESSIONS'] ?? 200);
const LOOKBACK_HOURS = Number(process.env['KICKSTART_LOOKBACK_HOURS'] ?? 43800);
const MIN_EVENTS = Number(process.env['KICKSTART_MIN_EVENTS'] ?? 3);
const MIN_SIMILARITY = Number(process.env['KICKSTART_MIN_SIMILARITY'] ?? 0.0);

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('[kickstart] DATABASE_URL not set — did you source .env?');
    process.exit(1);
  }

  console.log('[kickstart] starting rumen kickstart run');
  console.log('[kickstart]   maxSessions   = ' + MAX_SESSIONS);
  console.log('[kickstart]   lookbackHours = ' + LOOKBACK_HOURS + ' (' + Math.round(LOOKBACK_HOURS / 24) + ' days)');
  console.log('[kickstart]   minEventCount = ' + MIN_EVENTS);

  const pool = createPoolFromUrl(databaseUrl);

  try {
    const summary = await runRumenJob(pool, {
      triggeredBy: 'manual',
      maxSessions: MAX_SESSIONS,
      lookbackHours: LOOKBACK_HOURS,
      minEventCount: MIN_EVENTS,
      minSimilarity: MIN_SIMILARITY,
    });

    console.log('');
    console.log('[kickstart] === complete ===');
    console.log('[kickstart] job_id             = ' + summary.job_id);
    console.log('[kickstart] status             = ' + summary.status);
    console.log('[kickstart] sessions_processed = ' + summary.sessions_processed);
    console.log('[kickstart] insights_generated = ' + summary.insights_generated);
    if (summary.error_message) {
      console.log('[kickstart] error_message      = ' + summary.error_message);
    }

    if (summary.status !== 'done') {
      process.exit(2);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[kickstart] fatal:', err);
  process.exit(1);
});
