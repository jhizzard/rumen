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
  createSynthesizeContext,
  makePlaceholderInsight,
  synthesizeInsights,
} from '../src/synthesize.ts';
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

test('computeConfidence: single-project same-day → only maxSimilarity contributes', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        similarity: 0.8,
        created_at: '2026-04-10T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'alpha',
        similarity: 0.6,
        created_at: '2026-04-10T00:00:00Z',
      }),
    ],
  });
  // 0.5 * 0.8 + 0.3 * 0 + 0.2 * 0 = 0.4
  assert.equal(makePlaceholderInsight(rs).confidence, 0.4);
});

test('computeConfidence: cross-project recent → crossProjectBonus is full', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        similarity: 0.9,
        created_at: '2026-04-10T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'beta',
        similarity: 0.7,
        created_at: '2026-04-10T00:00:00Z',
      }),
    ],
  });
  // 0.5 * 0.9 + 0.3 * 1 + 0.2 * 0 = 0.75
  assert.equal(makePlaceholderInsight(rs).confidence, 0.75);
});

test('computeConfidence: same-project wide-age-spread → ageSpreadBonus maxes', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        similarity: 0.5,
        created_at: '2026-01-01T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'alpha',
        similarity: 0.3,
        created_at: '2026-03-01T00:00:00Z',
      }),
    ],
  });
  // 0.5 * 0.5 + 0.3 * 0 + 0.2 * 1 = 0.45
  assert.equal(makePlaceholderInsight(rs).confidence, 0.45);
});

test('computeConfidence: all bonuses → composite of all three terms', () => {
  const rs = makeRelatedSignal({
    related: [
      makeRelatedMemory({
        id: ID_A,
        project: 'alpha',
        similarity: 1.0,
        created_at: '2026-01-01T00:00:00Z',
      }),
      makeRelatedMemory({
        id: ID_B,
        project: 'beta',
        similarity: 0.9,
        created_at: '2026-03-01T00:00:00Z',
      }),
    ],
  });
  // 0.5 * 1.0 + 0.3 * 1 + 0.2 * 1 = 1.0 (clamped)
  assert.equal(makePlaceholderInsight(rs).confidence, 1.0);
});

test('computeConfidence: zero related memories → 0 confidence', () => {
  const rs = makeRelatedSignal({ related: [] });
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
