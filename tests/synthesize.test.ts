/**
 * Rumen v0.3 — synthesize.ts test suite.
 *
 * parseBatchResponse, filterValidCitations, and computeConfidence are module-
 * private, so we exercise them end-to-end by feeding crafted Haiku responses
 * through `synthesizeInsights` with an injected `AnthropicLike`. That also
 * validates the mock interface, the placeholder fallback path, and the
 * soft/hard cap wiring in one pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserPrompt,
  computeConfidence,
  createSynthesizeContext,
  makePlaceholderInsight,
  noveltyFactor,
  repairCommonJsonIssues,
  sliceFirstJsonBlock,
  synthesizeInsights,
  tryParseInsight,
} from '../src/synthesize.ts';
import {
  normalize as normalizeConfidence,
  normalizeSimilarity,
  RRF_BAND_MAX,
  RRF_BAND_MIN,
  RRF_QUANTILE_KNOTS,
} from '../src/confidence.ts';
import {
  makeMockAnthropic,
  makeRelatedMemory,
  makeRelatedSignal,
  quiet,
} from './helpers.ts';

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';
const HALLUCINATED = '99999999-9999-9999-9999-999999999999';

function ctx(overrides: Partial<ReturnType<typeof createSynthesizeContext>> = {}) {
  return createSynthesizeContext({
    apiKeyMissing: false,
    maxLlmCallsSoft: 100,
    maxLlmCallsHard: 500,
    ...overrides,
  });
}

// ── parseBatchResponse: Stage 1 (strict parse) ──────────────────────────────

test('parseBatchResponse (stage 1): valid JSON with one insight returns correct map', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  const body = JSON.stringify({
    insights: [
      { key: 'session:a', text: 'the one insight', cited_ids: [ID_A] },
    ],
  });
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights([rs], ctx(), mock.client));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.insight_text, 'the one insight');
  assert.equal(out[0]!.synthesized, true);
  assert.equal(mock.callCount(), 1);
});

test('parseBatchResponse (stage 1): valid JSON with three insights returns all three keys', async () => {
  const signals = [
    makeRelatedSignal({
      key: 'session:a',
      related: [makeRelatedMemory({ id: ID_A })],
    }),
    makeRelatedSignal({
      key: 'session:b',
      related: [makeRelatedMemory({ id: ID_B })],
    }),
    makeRelatedSignal({
      key: 'session:c',
      related: [makeRelatedMemory({ id: ID_C })],
    }),
  ];
  const body = JSON.stringify({
    insights: [
      { key: 'session:a', text: 'first', cited_ids: [ID_A] },
      { key: 'session:b', text: 'second', cited_ids: [ID_B] },
      { key: 'session:c', text: 'third', cited_ids: [ID_C] },
    ],
  });
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights(signals, ctx(), mock.client));
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map((i) => i.insight_text),
    ['first', 'second', 'third'],
  );
  // One LLM call — all three fit in one batch (BATCH_SIZE=3).
  assert.equal(mock.callCount(), 1);
});

// ── parseBatchResponse: Stage 2 (trailing-comma strip) ──────────────────────

test('parseBatchResponse (stage 2): trailing comma before ] is stripped and recovered', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  const body =
    '{"insights":[{"key":"session:a","text":"recovered","cited_ids":["' +
    ID_A +
    '"]},]}';
  const warnLog: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  const origErr = console.error;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = () => {};
  console.error = () => {};
  let out;
  try {
    const mock = makeMockAnthropic(body);
    out = await synthesizeInsights([rs], ctx(), mock.client);
  } finally {
    console.warn = origWarn;
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(out.length, 1);
  assert.equal(out[0]!.insight_text, 'recovered');
  assert.ok(
    warnLog.some((l) => l.includes('recovered via trailing-comma strip')),
    'expected "recovered via trailing-comma strip" log',
  );
});

test('parseBatchResponse (stage 2): trailing comma before } is stripped and recovered', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  // Trailing comma after cited_ids field, before the closing brace of the object.
  const body =
    '{"insights":[{"key":"session:a","text":"still ok","cited_ids":["' +
    ID_A +
    '"],}]}';
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights([rs], ctx(), mock.client));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.insight_text, 'still ok');
});

// ── parseBatchResponse: Stage 3 (per-object regex salvage) ──────────────────

test('parseBatchResponse (stage 3): salvages valid sibling objects when outer array is malformed', async () => {
  const signals = [
    makeRelatedSignal({
      key: 'session:a',
      related: [makeRelatedMemory({ id: ID_A })],
    }),
    makeRelatedSignal({
      key: 'session:b',
      related: [makeRelatedMemory({ id: ID_B })],
    }),
  ];
  // No outer wrapper and garbage between the two objects so the array-level
  // parse fails and stage 3's per-object scanner is the only thing that can
  // recover the valid siblings.
  const body =
    '{"key":"session:a","text":"first","cited_ids":["' +
    ID_A +
    '"]} NOT_JSON_GARBAGE_TOKEN {"key":"session:b","text":"second","cited_ids":["' +
    ID_B +
    '"]}';
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights(signals, ctx(), mock.client));
  assert.equal(out.length, 2);
  assert.equal(out[0]!.insight_text, 'first');
  assert.equal(out[1]!.insight_text, 'second');
});

test('parseBatchResponse (stage 3): one malformed sibling does not poison the whole batch', async () => {
  const signals = [
    makeRelatedSignal({
      key: 'session:a',
      related: [makeRelatedMemory({ id: ID_A })],
    }),
    makeRelatedSignal({
      key: 'session:b',
      related: [makeRelatedMemory({ id: ID_B })],
    }),
  ];
  // First object is well-formed; second is corrupt (missing comma between
  // fields) but still brace-balanced, so the salvage walker will try it and
  // drop it without touching the first.
  const body =
    '{"key":"session:a","text":"good","cited_ids":["' +
    ID_A +
    '"]} {"key":"session:b" "text":"bad" "cited_ids":[]}';
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights(signals, ctx(), mock.client));
  // a salvaged; b has no parsed result, falls back to placeholder.
  assert.equal(out.length, 2);
  assert.equal(out[0]!.insight_text, 'good');
  assert.equal(out[0]!.synthesized, true);
  assert.equal(out[1]!.synthesized, false, 'session:b should fall back to placeholder');
});

test('parseBatchResponse: complete failure logs "JSON parse failed at all three stages" and returns empty map', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  // Present a brace so extractJsonBlock returns a string but the contents
  // defeat all three recovery stages (truly unparseable, no balanced inner
  // objects to salvage).
  const body = '{ this is absolutely not json at all ::: }';
  const warnLog: string[] = [];
  const origWarn = console.warn;
  const origLog = console.log;
  const origErr = console.error;
  console.warn = (...args: unknown[]) => {
    warnLog.push(args.map((a) => String(a)).join(' '));
  };
  console.log = () => {};
  console.error = () => {};
  let out;
  try {
    const mock = makeMockAnthropic(body);
    out = await synthesizeInsights([rs], ctx(), mock.client);
  } finally {
    console.warn = origWarn;
    console.log = origLog;
    console.error = origErr;
  }
  // Falls back to placeholder — one output, synthesized:false.
  assert.equal(out.length, 1);
  assert.equal(out[0]!.synthesized, false);
  assert.ok(
    warnLog.some((l) => l.includes('JSON parse failed at all three stages')),
    'expected "JSON parse failed at all three stages" log',
  );
});

// ── extractJsonBlock: markdown fencing ──────────────────────────────────────

test('extractJsonBlock: ```json ... ``` fence is unwrapped and the parser succeeds', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  const body =
    '```json\n{"insights":[{"key":"session:a","text":"fenced","cited_ids":["' +
    ID_A +
    '"]}]}\n```';
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights([rs], ctx(), mock.client));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.insight_text, 'fenced');
});

// ── filterValidCitations ────────────────────────────────────────────────────

test('filterValidCitations: hallucinated UUIDs not in rs.related are filtered out', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  const body = JSON.stringify({
    insights: [
      {
        key: 'session:a',
        text: 'cites a ghost',
        // Haiku invents a UUID that was never in the related set.
        cited_ids: [HALLUCINATED],
      },
    ],
  });
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights([rs], ctx(), mock.client));
  assert.equal(out.length, 1);
  // Hallucinated ID filtered → empty → fallback uses all rs.related IDs.
  assert.deepEqual(out[0]!.source_memory_ids, [ID_A]);
});

test('filterValidCitations: valid UUIDs are preserved and hallucinated ones are dropped', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [
      makeRelatedMemory({ id: ID_A }),
      makeRelatedMemory({ id: ID_B }),
    ],
  });
  const body = JSON.stringify({
    insights: [
      {
        key: 'session:a',
        text: 'mixed cites',
        cited_ids: [ID_B, HALLUCINATED, ID_A],
      },
    ],
  });
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights([rs], ctx(), mock.client));
  assert.deepEqual(out[0]!.source_memory_ids, [ID_B, ID_A]);
});

test('filterValidCitations: empty cited_ids falls back to all related IDs', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [
      makeRelatedMemory({ id: ID_A }),
      makeRelatedMemory({ id: ID_B }),
    ],
  });
  const body = JSON.stringify({
    insights: [{ key: 'session:a', text: 'no cites', cited_ids: [] }],
  });
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights([rs], ctx(), mock.client));
  assert.deepEqual(out[0]!.source_memory_ids, [ID_A, ID_B]);
});

// ── computeConfidence ───────────────────────────────────────────────────────

test('computeConfidence: single-project same-day → only RRF-normalized similarity contributes', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        content: 'distinct one',
        similarity: 0.02188507, // the live median of the RRF band (v3 knot)
        created_at: '2026-04-10T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'alpha',
        content: 'distinct two',
        similarity: 0.012,
        created_at: '2026-04-10T00:00:00Z',
      }),
    ],
  });
  // maxRrf 0.02188507 is the p50 knot → simScore 0.5; cross 0; ageSpread 0;
  // novelty 1.0 → 0.55 * 0.5 = 0.275. (Pre-v2 this was 0.5*maxRrf = 0.011;
  // under v2's ~4x-too-high ceiling it was 0.55*0.041 = 0.023 — the drown bug
  // survived v2 and is only actually fixed in v3.)
  assert.equal(computeConfidence(rs), 0.275);
});

test('computeConfidence: cross-project ceiling-similarity → similarity leads, cross-project adds', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        content: 'aaa distinct',
        similarity: 0.9, // saturates above the RRF ceiling
        created_at: '2026-04-10T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'beta',
        content: 'bbb distinct',
        similarity: 0.7,
        created_at: '2026-04-10T00:00:00Z',
      }),
    ],
  });
  // simScore 1.0 + cross 1 + ageSpread 0, novelty 1.0 → 0.55 + 0.30 = 0.85
  assert.equal(computeConfidence(rs), 0.85);
});

test('computeConfidence: same-project wide-age-spread → ageSpreadBonus maxes', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        content: 'ccc distinct',
        similarity: 0.3, // at the RRF ceiling → simScore 1.0
        created_at: '2026-01-01T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'alpha',
        content: 'ddd distinct',
        similarity: 0.155,
        created_at: '2026-03-01T00:00:00Z',
      }),
    ],
  });
  // simScore 1.0 + cross 0 + ageSpread (59d/14 → 1.0), novelty 1.0 → 0.55 + 0.15 = 0.70
  assert.equal(computeConfidence(rs), 0.7);
});

test('computeConfidence: all three terms + distinct content → saturates at 1.0', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        content: 'eee distinct',
        similarity: 1.0,
        created_at: '2026-01-01T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'beta',
        content: 'fff distinct',
        similarity: 0.9,
        created_at: '2026-03-01T00:00:00Z',
      }),
    ],
  });
  // simScore 1.0 + cross 1 + ageSpread 1, novelty 1.0 → 0.55 + 0.30 + 0.15 = 1.0
  assert.equal(computeConfidence(rs), 1.0);
});

test('computeConfidence: zero related memories → 0 confidence', () => {
  const rs = makeRelatedSignal({ related: [] });
  assert.equal(computeConfidence(rs), 0);
});

// ── RRF-band recalibration (v3) ─────────────────────────────────────────────

test('normalizeSimilarity: deployed RRF band maps onto 0..1 with saturation', () => {
  assert.equal(normalizeSimilarity(RRF_BAND_MIN), 0); // observed floor
  assert.equal(normalizeSimilarity(RRF_BAND_MAX), 1); // derived ceiling
  assert.equal(normalizeSimilarity(0.9), 1); // above ceiling saturates
  assert.equal(normalizeSimilarity(0), 0); // below floor
  assert.equal(normalizeSimilarity(Number.NaN), 0); // non-finite
  assert.equal(normalizeSimilarity(Number.POSITIVE_INFINITY), 0); // non-finite
});

test('normalizeSimilarity: the derived ceiling is the analytic one, not a guess', () => {
  // 2/(rrf_k+1) x 1.5 type x 1.5 project, rrf_k = 60. Live telemetry max over
  // 39,048 rows was 0.0737700719567695 — the same number to 7 s.f.
  assert.ok(Math.abs(RRF_BAND_MAX - (2 / 61) * 1.5 * 1.5) < 1e-12);
  // Guard the specific regression this replaced: the old ceiling of 0.3 was
  // ~4x too high, which is what made the v2 weight rebalance inert.
  assert.ok(RRF_BAND_MAX < 0.1);
});

test('normalizeSimilarity: a live-median score lands mid-band, not near-floor', () => {
  // Live p50 over the 90-day retention window is 0.0219; 0.0216 is the value
  // quoted in the Sprint 82 brief. Under the old [0.01, 0.3] band this
  // normalized to 0.041 — indistinguishable from noise, and 13x dominated by
  // the flat cross-project bonus inside computeConfidence.
  const mid = normalizeSimilarity(0.0216);
  assert.ok(mid > 0.45 && mid < 0.55, `expected mid-band, got ${mid}`);
  // The exact median knot pins to exactly 0.5 by construction.
  assert.ok(Math.abs(normalizeSimilarity(0.02188507) - 0.5) < 1e-9);
  // A genuinely weak hit still reads weak, and a top-decile hit still reads
  // strong — the map moves the middle, it does not flatten the ends.
  assert.ok(normalizeSimilarity(0.0095) < 0.1);
  assert.ok(normalizeSimilarity(0.035) > 0.9);
});

test('normalizeSimilarity: monotonic non-decreasing across the whole band', () => {
  let prev = -1;
  for (let s = 0; s <= 0.08; s += 0.0005) {
    const v = normalizeSimilarity(s);
    assert.ok(v >= prev, `not monotonic at ${s}: ${v} < ${prev}`);
    assert.ok(v >= 0 && v <= 1, `out of range at ${s}: ${v}`);
    prev = v;
  }
});

test('normalizeSimilarity: every quantile knot maps to its own quantile', () => {
  for (const [score, q] of RRF_QUANTILE_KNOTS) {
    assert.ok(
      Math.abs(normalizeSimilarity(score) - q) < 1e-9,
      `knot ${score} should map to ${q}, got ${normalizeSimilarity(score)}`
    );
  }
  // Knots must stay sorted ascending in BOTH coordinates — that is what makes
  // the interpolation monotonic. Guards a bad telemetry refresh.
  for (let i = 1; i < RRF_QUANTILE_KNOTS.length; i++) {
    assert.ok(RRF_QUANTILE_KNOTS[i][0] > RRF_QUANTILE_KNOTS[i - 1][0]);
    assert.ok(RRF_QUANTILE_KNOTS[i][1] > RRF_QUANTILE_KNOTS[i - 1][1]);
  }
});

test('computeConfidence: RRF floor contributes ~0, ceiling saturates the similarity term', () => {
  const floor = makeRelatedSignal({
    related: [makeRelatedMemory({ id: ID_A, project: 'alpha', similarity: RRF_BAND_MIN })],
  });
  const ceil = makeRelatedSignal({
    related: [makeRelatedMemory({ id: ID_A, project: 'alpha', similarity: RRF_BAND_MAX })],
  });
  // single memory: cross 0, ageSpread 0, novelty 1.0 → confidence == 0.55 * simScore
  assert.equal(computeConfidence(floor), 0);
  assert.equal(computeConfidence(ceil), 0.55);
});

test('computeConfidence: a median-strength hit is no longer drowned by the flat bonus', () => {
  // The design intent in confidence.ts is that the similarity term must be
  // comparable to the 0.30 cross-project bonus for a typical match. Single
  // memory, one project: cross 0, ageSpread 0, novelty 1.0 → 0.55 * simScore.
  const median = makeRelatedSignal({
    related: [makeRelatedMemory({ id: ID_A, project: 'alpha', similarity: 0.02188507 })],
  });
  const contribution = computeConfidence(median);
  assert.ok(Math.abs(contribution - 0.275) < 0.005, `got ${contribution}`);
  // Pre-Sprint-82 this was 0.55 * 0.041 = 0.023, a 13:1 domination.
  assert.ok(contribution > 0.2);
});

test('computeConfidence: strong same-project match now outranks weak cross-project (the drown fix)', () => {
  const strongSameProject = makeRelatedSignal({
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha', content: 'xxx one', similarity: 0.3 }),
      makeRelatedMemory({ id: ID_B, project: 'alpha', content: 'yyy two', similarity: 0.28 }),
    ],
  });
  const weakCrossProject = makeRelatedSignal({
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha', content: 'xxx one', similarity: 0.02 }),
      makeRelatedMemory({ id: ID_B, project: 'beta', content: 'yyy two', similarity: 0.02 }),
    ],
  });
  const strong = computeConfidence(strongSameProject); // 0.55 * 1.0 = 0.55
  const weak = computeConfidence(weakCrossProject); // 0.55*~0.034 + 0.30 ≈ 0.319
  // Pre-v2: weak (0.5*0.02 + 0.3 = 0.31) BEAT strong (0.5*0.3 = 0.15). Now fixed.
  assert.ok(
    strong > weak,
    `expected strong same-project (${strong}) > weak cross-project (${weak})`,
  );
});

// ── noveltyFactor: down-rank near-duplicate prior art ───────────────────────

test('computeConfidence: identical related content is down-ranked vs distinct content', () => {
  const distinct = makeRelatedSignal({
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha', content: 'a distinct note', similarity: 1.0, created_at: '2026-04-10T00:00:00Z' }),
      makeRelatedMemory({ id: ID_B, project: 'beta', content: 'a different note', similarity: 0.9, created_at: '2026-04-10T00:00:00Z' }),
    ],
  });
  const duplicated = makeRelatedSignal({
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha', content: 'the very same memory text', similarity: 1.0, created_at: '2026-04-10T00:00:00Z' }),
      makeRelatedMemory({ id: ID_B, project: 'beta', content: 'the very same memory text', similarity: 0.9, created_at: '2026-04-10T00:00:00Z' }),
    ],
  });
  // both: simScore 1.0 + cross 1 + ageSpread 0 = composite 0.85
  // distinct novelty 1.0 → 0.85; duplicated novelty 0.75 → 0.85*0.75 = 0.6375 → 0.638
  assert.equal(computeConfidence(distinct), 0.85);
  assert.equal(computeConfidence(duplicated), 0.638);
  assert.ok(computeConfidence(duplicated) < computeConfidence(distinct));
});

test('noveltyFactor: all-distinct content → 1.0 (no penalty)', () => {
  const related = [
    makeRelatedMemory({ id: ID_A, content: 'alpha beta gamma' }),
    makeRelatedMemory({ id: ID_B, content: 'delta epsilon zeta' }),
    makeRelatedMemory({ id: ID_C, content: 'eta theta iota' }),
  ];
  assert.equal(noveltyFactor(related), 1);
});

test('noveltyFactor: all-identical content → 1 cluster / N', () => {
  const related = [
    makeRelatedMemory({ id: ID_A, content: 'same text here' }),
    makeRelatedMemory({ id: ID_B, content: 'same text here' }),
    makeRelatedMemory({ id: ID_C, content: 'same text here' }),
  ];
  // 1 distinct / 3 = 0.333 → 0.5 + 0.5*0.333
  assert.ok(Math.abs(noveltyFactor(related) - (0.5 + 0.5 * (1 / 3))) < 1e-9);
});

test('noveltyFactor: whitespace/case-only differences count as duplicates', () => {
  const related = [
    makeRelatedMemory({ id: ID_A, content: 'Fixed The Bug' }),
    makeRelatedMemory({ id: ID_B, content: 'fixed   the   bug' }),
  ];
  // both normalize to "fixed the bug" → 1 cluster / 2 → 0.75
  assert.equal(noveltyFactor(related), 0.75);
});

test('noveltyFactor: high token-overlap (Jaccard ≥ 0.85) counts as near-duplicate', () => {
  const related = [
    makeRelatedMemory({ id: ID_A, content: 'one two three four five six seven eight' }),
    makeRelatedMemory({ id: ID_B, content: 'one two three four five six seven eight nine' }),
  ];
  // Jaccard 8/9 ≈ 0.889 ≥ 0.85 → 1 cluster / 2 → 0.75
  assert.equal(noveltyFactor(related), 0.75);
});

test('noveltyFactor: disjoint token sets stay distinct', () => {
  const related = [
    makeRelatedMemory({ id: ID_A, content: 'one two three four' }),
    makeRelatedMemory({ id: ID_B, content: 'five six seven eight' }),
  ];
  assert.equal(noveltyFactor(related), 1);
});

test('noveltyFactor: single or empty related set → 1.0', () => {
  assert.equal(noveltyFactor([makeRelatedMemory({})]), 1);
  assert.equal(noveltyFactor([]), 1);
});

test('noveltyFactor: mixed — two dups + one distinct → 2 clusters / 3', () => {
  const related = [
    makeRelatedMemory({ id: ID_A, content: 'duplicated body text' }),
    makeRelatedMemory({ id: ID_B, content: 'duplicated body text' }),
    makeRelatedMemory({ id: ID_C, content: 'a completely separate note' }),
  ];
  // 2 clusters / 3 = 0.667 → 0.5 + 0.5*0.667
  assert.ok(Math.abs(noveltyFactor(related) - (0.5 + 0.5 * (2 / 3))) < 1e-9);
});

// ── buildUserPrompt enrichment: recency/age + cross-project spread ──────────

test('buildUserPrompt: includes per-memory age, cross-project spread, and recency window', () => {
  const now = Date.parse('2026-04-13T00:00:00Z');
  const rs = makeRelatedSignal({
    key: 'session:a',
    project: 'alpha',
    description: 'did a thing',
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha', content: 'newer note', similarity: 0.2, created_at: '2026-04-10T00:00:00Z' }),
      makeRelatedMemory({ id: ID_B, project: 'beta', content: 'older note', similarity: 0.1, created_at: '2026-03-14T00:00:00Z' }),
    ],
  });
  const prompt = buildUserPrompt([rs], now);
  assert.ok(
    prompt.includes('cross-project spread: 2 projects (alpha, beta) across 2 memories'),
    prompt,
  );
  assert.ok(prompt.includes('recency: newest 3d ago, oldest 30d ago'), prompt);
  assert.ok(prompt.includes('age=3d'), 'newer memory age');
  assert.ok(prompt.includes('age=30d'), 'older memory age');
  assert.ok(prompt.includes('similarity=0.20'), 'similarity still rendered');
});

test('buildUserPrompt: single-project single-memory spread wording is singular', () => {
  const now = Date.parse('2026-04-13T00:00:00Z');
  const rs = makeRelatedSignal({
    project: 'alpha',
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha', content: 'x', created_at: '2026-04-12T00:00:00Z' }),
    ],
  });
  const prompt = buildUserPrompt([rs], now);
  assert.ok(
    prompt.includes('cross-project spread: 1 project (alpha) across 1 memory'),
    prompt,
  );
  assert.ok(prompt.includes('age=1d'), prompt);
});

test('buildUserPrompt: unparseable created_at → age=unknown and no recency line', () => {
  const now = Date.parse('2026-04-13T00:00:00Z');
  const rs = makeRelatedSignal({
    project: 'alpha',
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha', content: 'x', created_at: 'not-a-date' }),
    ],
  });
  const prompt = buildUserPrompt([rs], now);
  assert.ok(prompt.includes('age=unknown'), prompt);
  assert.ok(!prompt.includes('recency:'), 'no recency line when no dates parse');
});

// ── Confidence normalization integration ────────────────────────────────────

test('makePlaceholderInsight: confidence is normalized by cluster size', () => {
  // 2 DISTINCT related memories with all bonuses → raw 1.0 → normalize(1.0, 2) = 0.7
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        content: 'ggg distinct',
        similarity: 1.0,
        created_at: '2026-01-01T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'beta',
        content: 'hhh distinct',
        similarity: 0.9,
        created_at: '2026-03-01T00:00:00Z',
      }),
    ],
  });
  const raw = computeConfidence(rs);
  const expected = normalizeConfidence(raw, rs.related.length);
  assert.equal(makePlaceholderInsight(rs).confidence, expected);
  assert.equal(raw, 1.0);
  assert.equal(expected, 0.7); // documents the curve at size=2 (clamped to 0.7 ceiling for size <5)
});

test('makePlaceholderInsight: zero related → confidence 0 even after normalize', () => {
  const rs = makeRelatedSignal({ related: [] });
  // computeConfidence returns 0; normalize(0, 0) returns 0 * 0.4 = 0
  assert.equal(makePlaceholderInsight(rs).confidence, 0);
});

// ── Budget caps ─────────────────────────────────────────────────────────────

test('synthesizeBatch: soft cap → falls back to placeholders for remaining batches', async () => {
  // Two signals, BATCH_SIZE=3, so ONE batch. softCap=0 trips on the first
  // batch: ctx.llmCallsMade(0) + 1 > 0 → true, fallback.
  const signals = [
    makeRelatedSignal({
      key: 'session:a',
      related: [makeRelatedMemory({ id: ID_A })],
    }),
    makeRelatedSignal({
      key: 'session:b',
      related: [makeRelatedMemory({ id: ID_B })],
    }),
  ];
  const mock = makeMockAnthropic('{"insights":[]}'); // should not be consumed
  const out = await quiet(() =>
    synthesizeInsights(signals, ctx({ maxLlmCallsSoft: 0 }), mock.client),
  );
  assert.equal(out.length, 2);
  assert.equal(out.every((i) => i.synthesized === false), true);
  assert.equal(mock.callCount(), 0, 'soft cap should prevent any LLM calls');
});

test('synthesizeBatch: hard cap → throws and aborts the job', async () => {
  const signals = [
    makeRelatedSignal({
      key: 'session:a',
      related: [makeRelatedMemory({ id: ID_A })],
    }),
  ];
  const mock = makeMockAnthropic('{"insights":[]}');
  await quiet(async () => {
    await assert.rejects(
      () =>
        synthesizeInsights(
          signals,
          ctx({ maxLlmCallsSoft: 0, maxLlmCallsHard: 0 }),
          mock.client,
        ),
      /hard cap exceeded/,
    );
  });
});

// ── Placeholder fallback ────────────────────────────────────────────────────

test('makePlaceholderInsight: produces a well-formed Insight from a RelatedSignal', () => {
  const rs = makeRelatedSignal({
    key: 'session:x',
    description: 'did a thing',
    related: [
      makeRelatedMemory({ id: ID_A, project: 'alpha' }),
      makeRelatedMemory({ id: ID_B, project: 'beta' }),
    ],
  });
  const ins = makePlaceholderInsight(rs);
  assert.equal(ins.source, rs);
  assert.equal(ins.synthesized, false);
  assert.deepEqual(ins.source_memory_ids, [ID_A, ID_B]);
  assert.ok(ins.insight_text.includes('2 related memories'));
  assert.ok(ins.insight_text.includes('alpha'));
  assert.ok(ins.insight_text.includes('beta'));
  assert.ok(ins.insight_text.includes('did a thing'));
  assert.ok(ins.confidence >= 0 && ins.confidence <= 1);
});

// ── AnthropicLike mock + apiKeyMissing short-circuit ────────────────────────

test('AnthropicLike: apiKeyMissing=true falls back to placeholders without touching the mock', async () => {
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  let touched = false;
  const mock = {
    messages: {
      create: async () => {
        touched = true;
        throw new Error('mock should not be called when apiKeyMissing=true');
      },
    },
  };
  const out = await quiet(() =>
    synthesizeInsights([rs], ctx({ apiKeyMissing: true }), mock),
  );
  assert.equal(touched, false);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.synthesized, false);
});

test('AnthropicLike: the exported interface is sufficient for a test double', async () => {
  // This test exists as a compile/type proof that AnthropicLike can be
  // implemented without importing the real SDK. If this file type-checks and
  // the assertion below passes, the interface is honoured.
  const rs = makeRelatedSignal({
    key: 'session:a',
    related: [makeRelatedMemory({ id: ID_A })],
  });
  const mock = makeMockAnthropic(
    JSON.stringify({
      insights: [
        { key: 'session:a', text: 'via test double', cited_ids: [ID_A] },
      ],
    }),
  );
  const out = await quiet(() => synthesizeInsights([rs], ctx(), mock.client));
  assert.equal(out[0]!.insight_text, 'via test double');
  assert.equal(mock.callCount(), 1);
});

// ── Signals with no related memories are dropped ────────────────────────────

// ── tryParseInsight: 3-pass JSON hardening (Sprint 26 T2) ───────────────────
//
// These six fixtures exercise the recovery passes in isolation. They run
// against `tryParseInsight` directly rather than going through the full
// synthesizeInsights pipeline, so a regression in any single pass surfaces as
// a focused failure.

test('tryParseInsight (pass 1): clean JSON parses on the strict path', () => {
  const raw = '{"insights":[{"key":"a","text":"hi","cited_ids":[]}]}';
  const parsed = tryParseInsight(raw) as { insights: unknown[] } | null;
  assert.ok(parsed && Array.isArray(parsed.insights));
  assert.equal(parsed.insights.length, 1);
});

test('tryParseInsight (pass 2 slice): trailing prose after the JSON is ignored', () => {
  const raw =
    '{"insights":[{"key":"a","text":"hi","cited_ids":[]}]} \n\nLet me know if you need anything else!';
  const parsed = tryParseInsight(raw) as { insights: unknown[] } | null;
  assert.ok(parsed, 'expected slice pass to recover the JSON block');
  assert.ok(Array.isArray(parsed!.insights));
  assert.equal(parsed!.insights.length, 1);
  // Sanity: sliceFirstJsonBlock returns just the brace-balanced prefix.
  const sliced = sliceFirstJsonBlock(raw);
  assert.equal(
    sliced,
    '{"insights":[{"key":"a","text":"hi","cited_ids":[]}]}',
  );
});

test('tryParseInsight (pass 2 fence): ```json\\n...\\n``` markdown fences are stripped', () => {
  const raw =
    '```json\n{"insights":[{"key":"a","text":"fenced","cited_ids":[]}]}\n```';
  const parsed = tryParseInsight(raw) as
    | { insights: Array<{ text: string }> }
    | null;
  assert.ok(parsed, 'expected fence pass to recover the JSON');
  assert.equal(parsed!.insights[0]!.text, 'fenced');
});

test('tryParseInsight (pass 3 repair): trailing comma is stripped', () => {
  const raw = '{ "x": 1, }';
  // Suppress the "recovered via trailing-comma strip / newline escape" warn.
  const origWarn = console.warn;
  console.warn = () => {};
  let parsed: unknown;
  try {
    parsed = tryParseInsight(raw);
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(parsed, { x: 1 });
});

test('tryParseInsight (pass 3 repair): literal newline inside a string value is escaped', () => {
  const raw = '{ "msg": "line1\nline2" }';
  // Pass 1 fails because raw \n inside a JSON string is invalid; pass 3
  // walks string state and escapes it to \\n.
  const origWarn = console.warn;
  console.warn = () => {};
  let parsed: unknown;
  try {
    parsed = tryParseInsight(raw);
  } finally {
    console.warn = origWarn;
  }
  assert.deepEqual(parsed, { msg: 'line1\nline2' });
});

test('tryParseInsight: unrecoverable truncation returns null (caller falls back to placeholder)', () => {
  const raw = '{ "broken: "missing quote';
  const parsed = tryParseInsight(raw);
  assert.equal(parsed, null);
});

// repairCommonJsonIssues smoke test — make sure the helper is importable and
// behaves as documented when called directly. Belt-and-braces protection
// against future regressions if tryParseInsight grows another pass.
test('repairCommonJsonIssues: applies both repairs in one pass', () => {
  const repaired = repairCommonJsonIssues('{ "msg": "a\nb", }');
  assert.equal(repaired, '{ "msg": "a\\nb" }');
});

test('synthesizeInsights: signals with zero related memories are filtered out upfront', async () => {
  const signals = [
    makeRelatedSignal({
      key: 'session:empty',
      related: [],
    }),
    makeRelatedSignal({
      key: 'session:a',
      related: [makeRelatedMemory({ id: ID_A })],
    }),
  ];
  const body = JSON.stringify({
    insights: [{ key: 'session:a', text: 'kept', cited_ids: [ID_A] }],
  });
  const mock = makeMockAnthropic(body);
  const out = await quiet(() => synthesizeInsights(signals, ctx(), mock.client));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.source.signal.key, 'session:a');
});
