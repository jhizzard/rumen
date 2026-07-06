/**
 * Rumen Sprint 81 — reinforce.ts test suite (the recall-feedback loop).
 *
 * Two layers, both fully offline:
 *   1. computeRecallBoost — a pure function; tested directly for boundedness,
 *      the no-op floor, cited > surfaced weighting, saturation (the
 *      rich-get-richer guard), recency decay, EWMA smoothing, and NaN safety.
 *   2. runRumenReinforce — driven through the makeMockPool seam (dispatch on
 *      SQL marker), so the candidate-scan → tally → compute → write wiring,
 *      dry-run, no-op skip, batch saturation, and fail-soft are exercised for
 *      real without touching a database.
 *
 * No test writes to a live store: the pure function has no I/O, and the runner
 * only ever sees the mock pool.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeRecallBoost,
  runRumenReinforce,
  DEFAULT_TUNABLES,
  type BoostUpdate,
} from '../src/reinforce.ts';
import { makeMockPool, quiet, type QueryCall } from './helpers.ts';

// Reinforce reads a handful of env knobs; make sure ambient env never leaks
// into a test's tunables / dry-run / budget.
for (const k of [
  'RUMEN_REINFORCE_WINDOW_DAYS',
  'RUMEN_REINFORCE_BATCH',
  'RUMEN_REINFORCE_BUDGET_MS',
  'RUMEN_REINFORCE_DRY_RUN',
  'RUMEN_REINFORCE_MAX_BOOST',
  'RUMEN_REINFORCE_CITED_WEIGHT',
  'RUMEN_REINFORCE_SURFACED_WEIGHT',
  'RUMEN_REINFORCE_ALLTIME_WEIGHT',
  'RUMEN_REINFORCE_USAGE_SCALE',
  'RUMEN_REINFORCE_HALFLIFE_DAYS',
  'RUMEN_REINFORCE_ALPHA',
]) {
  delete process.env[k];
}

const ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const MIN = DEFAULT_TUNABLES.minBoost; // 1.0
const MAX = DEFAULT_TUNABLES.maxBoost; // 2.0

// ── computeRecallBoost: pure function ───────────────────────────────────────

test('computeRecallBoost: zero usage → strict no-op floor (1.0)', () => {
  const boost = computeRecallBoost({
    recallCount: 0,
    citedCount: 0,
    surfacedCount: 0,
    daysSinceLastRecall: 0,
    prevBoost: MIN,
  });
  assert.equal(boost, MIN);
});

test('computeRecallBoost: a recent citation elevates above the floor (but stays bounded)', () => {
  const boost = computeRecallBoost({
    recallCount: 1,
    citedCount: 1,
    surfacedCount: 1,
    daysSinceLastRecall: 0,
    prevBoost: MIN,
  });
  assert.ok(boost > MIN, `expected > ${MIN}, got ${boost}`);
  assert.ok(boost < MAX, `expected < ${MAX}, got ${boost}`);
  assert.ok(Math.abs(boost - 1.111) < 1e-3, `expected ~1.111, got ${boost}`);
});

test('computeRecallBoost: a citation counts more than a mere surfacing', () => {
  const common = { recallCount: 3, daysSinceLastRecall: 0, prevBoost: MIN };
  const cited = computeRecallBoost({ ...common, citedCount: 3, surfacedCount: 3 });
  const surfacedOnly = computeRecallBoost({ ...common, citedCount: 0, surfacedCount: 3 });
  assert.ok(
    cited > surfacedOnly,
    `cited (${cited}) should exceed surfaced-only (${surfacedOnly})`,
  );
});

test('computeRecallBoost: usage saturates — 100 recalls ≈ 20 recalls (no rich-get-richer)', () => {
  const at20 = computeRecallBoost({ recallCount: 20, citedCount: 20, surfacedCount: 20, daysSinceLastRecall: 0, prevBoost: MIN });
  const at100 = computeRecallBoost({ recallCount: 100, citedCount: 100, surfacedCount: 100, daysSinceLastRecall: 0, prevBoost: MIN });
  assert.ok(at20 <= MAX && at100 <= MAX);
  assert.ok(
    Math.abs(at100 - at20) < 0.01,
    `5x the recalls should barely move the boost (${at20} vs ${at100})`,
  );
});

test('computeRecallBoost: recency decay — stale usage yields a lower boost than fresh', () => {
  const common = { recallCount: 10, citedCount: 10, surfacedCount: 10, prevBoost: MIN };
  const fresh = computeRecallBoost({ ...common, daysSinceLastRecall: 0 });
  const stale = computeRecallBoost({ ...common, daysSinceLastRecall: 60 }); // two half-lives
  assert.ok(fresh > stale, `fresh (${fresh}) should exceed stale (${stale})`);
});

test('computeRecallBoost: an above-floor boost relaxes back DOWN when usage fades, never below the floor', () => {
  const boost = computeRecallBoost({
    recallCount: 0,
    citedCount: 0,
    surfacedCount: 0,
    daysSinceLastRecall: 0,
    prevBoost: 1.5, // previously boosted, now no usage
  });
  assert.ok(boost < 1.5, `should decay from 1.5, got ${boost}`);
  assert.ok(boost >= MIN, `must never drop below the floor, got ${boost}`);
  assert.equal(boost, 1.25); // EWMA: 1.5 + 0.5*(1.0 - 1.5)
});

test('computeRecallBoost: always bounded to [minBoost, maxBoost] under extreme inputs', () => {
  const huge = computeRecallBoost({ recallCount: 1e9, citedCount: 1e9, surfacedCount: 1e9, daysSinceLastRecall: 0, prevBoost: MAX });
  assert.ok(huge >= MIN && huge <= MAX, `got ${huge}`);
});

test('computeRecallBoost: unknown recall time (Infinity days) fully decays recency → no boost', () => {
  // daysSince returns Infinity for a NULL last_recalled_at. recency = 0.5^Inf = 0,
  // so even a memory with usage must NOT read as freshly recalled.
  const boost = computeRecallBoost({
    recallCount: 10,
    citedCount: 5,
    surfacedCount: 5,
    daysSinceLastRecall: Number.POSITIVE_INFINITY,
    prevBoost: MIN,
  });
  assert.equal(boost, MIN);
});

test('computeRecallBoost: non-finite inputs are sanitized (never returns NaN)', () => {
  const boost = computeRecallBoost({
    recallCount: Number.NaN,
    citedCount: Number.NaN,
    surfacedCount: Number.NaN,
    daysSinceLastRecall: Number.NaN,
    prevBoost: Number.NaN,
  });
  assert.ok(Number.isFinite(boost));
  assert.equal(boost, MIN); // all-zero usage, prevBoost falls back to floor
});

// ── runRumenReinforce: mock-pool wiring ─────────────────────────────────────

interface CandidateFixture {
  id: string;
  recall_count: number;
  last_recalled_at: string | null;
  recall_boost: string; // NUMERIC comes back from pg as a string
}
interface TallyFixture {
  memory_id: string;
  cited_count: number | string;
  surfaced_count: number | string;
}

/**
 * Build a mock pool that dispatches on SQL marker: candidate scan → `candidates`,
 * recall-log tally → `tallies`, set_recall_boost → `{updated: writeReturn}`. Any
 * SQL matching `failOn` throws instead.
 */
function reinforcePool(opts: {
  candidates: CandidateFixture[];
  tallies?: TallyFixture[];
  writeReturn?: number;
  failOn?: RegExp;
}) {
  return makeMockPool({
    responses: (call: QueryCall) => {
      const sql = call.sql;
      if (opts.failOn && opts.failOn.test(sql)) return new Error('simulated query failure');
      if (/set_recall_boost/i.test(sql)) {
        return { rows: [{ updated: opts.writeReturn ?? 0 }] };
      }
      if (/memory_recall_log/i.test(sql)) {
        return { rows: opts.tallies ?? [] };
      }
      if (/FROM memory_items/i.test(sql)) {
        return { rows: opts.candidates };
      }
      return { rows: [] };
    },
  });
}

/** Find the set_recall_boost write call and return its parsed JSON payload. */
function writePayload(calls: QueryCall[]): BoostUpdate[] | null {
  const call = calls.find((c) => /set_recall_boost/i.test(c.sql));
  if (!call) return null;
  return JSON.parse(call.params[0] as string) as BoostUpdate[];
}

const NOW = Date.parse('2026-07-05T12:00:00Z');

test('runRumenReinforce: scans, computes, and writes only the changed boosts', async () => {
  const { pool, calls } = reinforcePool({
    candidates: [
      // Recently + repeatedly recalled, one cited → boosts UP from 1.0.
      { id: ID_A, recall_count: 5, last_recalled_at: '2026-07-05T11:00:00Z', recall_boost: '1.0' },
      // No recent recall but a stale above-floor boost → relaxes DOWN toward 1.0.
      { id: ID_B, recall_count: 0, last_recalled_at: null, recall_boost: '1.5' },
    ],
    tallies: [{ memory_id: ID_A, cited_count: 1, surfaced_count: 2 }],
    writeReturn: 2,
  });

  const summary = await quiet(() => runRumenReinforce(pool, { nowMs: NOW }));

  assert.equal(summary.status, 'done');
  assert.equal(summary.candidates_scanned, 2);
  assert.equal(summary.boosts_written, 2);
  assert.equal(summary.skipped_reason, null);

  const payload = writePayload(calls);
  assert.ok(payload, 'expected a set_recall_boost write');
  assert.equal(payload!.length, 2);
  const byId = new Map(payload!.map((u) => [u.id, u.boost]));
  // A elevated above the floor; B decayed below its prior 1.5. Both bounded.
  assert.ok(byId.get(ID_A)! > 1.0 && byId.get(ID_A)! <= MAX, `A=${byId.get(ID_A)}`);
  assert.ok(byId.get(ID_B)! < 1.5 && byId.get(ID_B)! >= MIN, `B=${byId.get(ID_B)}`);
});

test('runRumenReinforce: dry run computes but never writes', async () => {
  const { pool, calls } = reinforcePool({
    candidates: [{ id: ID_A, recall_count: 5, last_recalled_at: '2026-07-05T11:00:00Z', recall_boost: '1.0' }],
    tallies: [{ memory_id: ID_A, cited_count: 3, surfaced_count: 3 }],
  });

  const summary = await quiet(() => runRumenReinforce(pool, { nowMs: NOW, dryRun: true }));

  assert.equal(summary.status, 'done');
  assert.equal(summary.candidates_scanned, 1);
  assert.equal(summary.boosts_written, 0);
  assert.equal(summary.skipped_reason, 'dry_run');
  assert.equal(writePayload(calls), null, 'dry run must not call set_recall_boost');
});

test('runRumenReinforce: no candidates → done, nothing scanned or written', async () => {
  const { pool, calls } = reinforcePool({ candidates: [] });
  const summary = await quiet(() => runRumenReinforce(pool, { nowMs: NOW }));
  assert.equal(summary.status, 'done');
  assert.equal(summary.candidates_scanned, 0);
  assert.equal(summary.boosts_written, 0);
  assert.equal(writePayload(calls), null);
  // Only the candidate scan ran — no tally, no write.
  assert.equal(calls.length, 1);
});

test('runRumenReinforce: a candidate whose boost is unchanged is not re-written', async () => {
  const { pool, calls } = reinforcePool({
    // recall_count 0 + no recent recall + already at the 1.0 floor → target 1.0,
    // no change → skipped (below WRITE_EPSILON).
    candidates: [{ id: ID_A, recall_count: 0, last_recalled_at: null, recall_boost: '1.0' }],
    tallies: [],
  });
  const summary = await quiet(() => runRumenReinforce(pool, { nowMs: NOW }));
  assert.equal(summary.status, 'done');
  assert.equal(summary.candidates_scanned, 1);
  assert.equal(summary.boosts_written, 0);
  assert.equal(writePayload(calls), null, 'no-op change must not write');
});

test('runRumenReinforce: fail-soft — a query error returns status=failed, never throws', async () => {
  const { pool } = reinforcePool({ candidates: [], failOn: /FROM memory_items/i });
  const summary = await quiet(() => runRumenReinforce(pool, { nowMs: NOW }));
  assert.equal(summary.status, 'failed');
  assert.ok(summary.error_message && summary.error_message.includes('simulated query failure'));
  assert.equal(summary.boosts_written, 0);
});

test('runRumenReinforce: hitting the batch cap sets batch_saturated (no silent drop)', async () => {
  const { pool } = reinforcePool({
    candidates: [
      { id: ID_A, recall_count: 5, last_recalled_at: '2026-07-05T11:00:00Z', recall_boost: '1.0' },
      { id: ID_B, recall_count: 4, last_recalled_at: '2026-07-05T10:00:00Z', recall_boost: '1.0' },
    ],
    tallies: [],
    writeReturn: 2,
  });
  const summary = await quiet(() => runRumenReinforce(pool, { nowMs: NOW, batch: 2 }));
  assert.equal(summary.status, 'done');
  assert.equal(summary.batch_saturated, true);
});

test('runRumenReinforce: the write payload is bounded to [minBoost, maxBoost]', async () => {
  const { pool, calls } = reinforcePool({
    candidates: [
      { id: ID_A, recall_count: 999, last_recalled_at: '2026-07-05T11:59:00Z', recall_boost: '1.0' },
    ],
    tallies: [{ memory_id: ID_A, cited_count: 999, surfaced_count: 999 }],
    writeReturn: 1,
  });
  await quiet(() => runRumenReinforce(pool, { nowMs: NOW }));
  const payload = writePayload(calls);
  assert.ok(payload && payload.length === 1);
  for (const u of payload!) {
    assert.ok(u.boost >= MIN && u.boost <= MAX, `boost ${u.boost} out of range`);
  }
});
