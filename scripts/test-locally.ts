/**
 * Run one Rumen job against a local or test Postgres, without Supabase.
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost:5432/rumen_test npx tsx scripts/test-locally.ts
 *
 * Prerequisites:
 *   1. A Postgres database with Mnestra's schema applied (memory_items,
 *      memory_sessions, memory_hybrid_search). See docs/MNESTRA-COMPATIBILITY.md.
 *   2. Rumen's own migrations applied:
 *        psql "$DATABASE_URL" -f migrations/001_rumen_tables.sql
 *
 * This script prints every [rumen-*] log line to stdout and exits with code 1
 * on failure.
 *
 * This file lives outside the main tsconfig because it pulls in Node globals;
 * run it with `tsx` (which handles TS natively) rather than `tsc`.
 */

import 'dotenv/config';
import { runRumenJob, getPool } from '../src/index.js';

async function main(): Promise<void> {
  const pool = getPool();
  try {
    console.log('[rumen] test-locally starting');
    const summary = await runRumenJob(pool, {
      triggeredBy: 'manual',
    });
    console.log('[rumen] test-locally summary:', JSON.stringify(summary, null, 2));
    if (summary.status !== 'done') {
      console.error('[rumen] test-locally: job did not complete successfully');
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[rumen] test-locally threw:', err);
  process.exit(1);
});
