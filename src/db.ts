/**
 * Postgres Pool factory for Rumen v0.1.
 *
 * Rumen uses raw `pg` (node-postgres), NOT Prisma. See
 * docs/MNEMOS-COMPATIBILITY.md for the reasoning.
 *
 * Connection URL MUST be a Supabase Shared Pooler IPv4 URL. Never use the
 * Dedicated Pooler URL — it is IPv6-only and will silently fail from
 * serverless runtimes. The Shared Pooler URL has three distinguishing marks:
 *
 *   1. Hostname is aws-0-<region>.pooler.supabase.com
 *   2. Username is postgres.<project-ref> (note the dot)
 *   3. Must append ?pgbouncer=true&connection_limit=1
 *
 * Example:
 *   postgresql://postgres.abcdef:encoded-pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
 */

import pg from 'pg';

const { Pool } = pg;
export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

let sharedPool: PgPool | null = null;

/**
 * Returns a shared Pool, creating it on first call.
 * Reads DATABASE_URL from process.env (Node) — the Edge Function has its own
 * factory that calls createPoolFromUrl directly with Deno.env.get('DATABASE_URL').
 */
export function getPool(): PgPool {
  if (sharedPool) {
    return sharedPool;
  }
  const url = process.env['DATABASE_URL'];
  if (!url || url.length === 0) {
    throw new Error(
      '[rumen] DATABASE_URL is not set. Rumen requires a Supabase Shared Pooler IPv4 URL.',
    );
  }
  sharedPool = createPoolFromUrl(url);
  return sharedPool;
}

/**
 * Build a Pool from an explicit connection URL. Used by the Edge Function
 * where environment access goes through Deno.env rather than process.env.
 */
export function createPoolFromUrl(url: string): PgPool {
  assertLooksLikeSharedPooler(url);
  const pool = new Pool({
    connectionString: url,
    // Keep the pool tiny. Rumen runs one job at a time and every invocation
    // in Edge Function mode is a fresh cold start, so extra connections
    // just waste Pooler slots.
    max: 2,
    // Transaction-mode pgbouncer requires statements to not rely on session
    // state. Keep queries simple and don't use prepared statements.
    idleTimeoutMillis: 10_000,
  });
  pool.on('error', (err: Error) => {
    console.error('[rumen] pg pool error:', err);
  });
  return pool;
}

/**
 * Light sanity check so we fail loudly instead of silently connecting to
 * the wrong URL. We only warn — we do not reject — because local dev may
 * use a plain postgresql:// URL against a local database.
 */
function assertLooksLikeSharedPooler(url: string): void {
  const isSharedPooler = /pooler\.supabase\.com/.test(url);
  const isDedicatedPooler = /db\.[a-z0-9]+\.supabase\.co/.test(url);
  if (isDedicatedPooler) {
    console.error(
      '[rumen] DATABASE_URL looks like a Dedicated Pooler URL (db.<ref>.supabase.co). ' +
        'This is IPv6-only and will fail from Edge Functions and Vercel. ' +
        'Use the Shared Pooler URL (aws-0-<region>.pooler.supabase.com:6543) instead.',
    );
  }
  if (isSharedPooler && !/pgbouncer=true/.test(url)) {
    console.error(
      '[rumen] DATABASE_URL is a Shared Pooler URL but does not have ?pgbouncer=true. ' +
        'Append ?pgbouncer=true&connection_limit=1 for transaction-mode compatibility.',
    );
  }
}

/** Run a function inside a borrowed client. Always releases. */
export async function withClient<T>(
  pool: PgPool,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
