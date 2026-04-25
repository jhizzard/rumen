/**
 * Rumen v0.2 — Synthesize phase.
 *
 * Takes RelatedSignal[] (the output of Relate) and produces Insight[] with
 * real Claude Haiku generated insight_text, a confidence score, and a cited
 * subset of source memory IDs.
 *
 * Guardrails:
 *   - Hard cap (default 500): throws, aborts the job.
 *   - Soft cap (default 100): logs a warning and falls back to the v0.1
 *     placeholder template for any remaining signals.
 *   - Missing ANTHROPIC_API_KEY: logs once and falls back to the v0.1
 *     placeholder for every signal. The Rumen loop still completes.
 *   - Batching: up to BATCH_SIZE (default 3) signals per Haiku call. The
 *     model is asked to return `{ insights: [{ key, text, cited_ids }, ...] }`
 *     and we match results back by signal key.
 *
 * Confidence score:
 *   confidence = clamp01(
 *       0.5 * maxSimilarity                      (0..0.5)
 *     + 0.3 * crossProjectBonus                  (0 or 0.3)
 *     + 0.2 * ageSpreadBonus                     (0..0.2)
 *   )
 *   - maxSimilarity: highest similarity across related memories (already 0..1).
 *   - crossProjectBonus: 1 if the signal is supported by ≥2 distinct projects
 *     (cross-project prior art is Rumen's whole pitch), else 0.
 *   - ageSpreadBonus: 1 if the oldest related memory is ≥14 days older than
 *     the newest, else scaled linearly. Older-than-newest stretches suggest
 *     durable, recurring patterns rather than a one-off.
 */

import Anthropic from '@anthropic-ai/sdk';
import { normalize as normalizeConfidence } from './confidence.js';
import type {
  Insight,
  RelatedMemory,
  RelatedSignal,
  SynthesizeContext,
} from './types.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_SOFT_CAP = 100;
const DEFAULT_HARD_CAP = 500;
const BATCH_SIZE = 3;
const MAX_TOKENS = 600;

const SYSTEM_PROMPT =
  'You are Rumen, an async learning layer that surfaces cross-project prior art ' +
  'from a developer memory store. For each signal you receive, write ONE short ' +
  'insight (1–3 sentences, max 60 words) that names the pattern in the related ' +
  'memories and connects it to the current signal. Cite the specific memories ' +
  'you drew from using short IDs in the form [#xxxxxxxx] (first 8 characters of ' +
  'the memory UUID). Do not cite a memory you did not use. Do not invent details ' +
  'not present in the provided content. Respond with a single JSON object of the ' +
  'exact shape {"insights": [{"key": "<signal_key>", "text": "<insight_text>", ' +
  '"cited_ids": ["<full-uuid>", ...]}, ...]}. No prose outside the JSON.';

/**
 * Create a fresh SynthesizeContext, reading budget knobs from env.
 * Exposed so callers (runRumenJob, tests) can share context across phases.
 */
export function createSynthesizeContext(
  overrides: Partial<SynthesizeContext> = {},
): SynthesizeContext {
  const softFromEnv = readIntEnv('RUMEN_MAX_LLM_CALLS_SOFT', DEFAULT_SOFT_CAP);
  const hardFromEnv = readIntEnv('RUMEN_MAX_LLM_CALLS_HARD', DEFAULT_HARD_CAP);
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  return {
    maxLlmCallsSoft: overrides.maxLlmCallsSoft ?? softFromEnv,
    maxLlmCallsHard: overrides.maxLlmCallsHard ?? hardFromEnv,
    llmCallsMade: overrides.llmCallsMade ?? 0,
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    softCapTripped: overrides.softCapTripped ?? false,
    apiKeyMissing: overrides.apiKeyMissing ?? apiKey.length === 0,
  };
}

/**
 * Synthesize insights for every RelatedSignal that has at least one related
 * memory. Signals with no related memories are dropped (nothing to synthesize).
 *
 * Throws if the hard cap is exceeded mid-run. Rows already returned in the
 * caller's accumulator up to that point are preserved; runRumenJob surfaces
 * what it has before rethrowing.
 */
export async function synthesizeInsights(
  relatedSignals: RelatedSignal[],
  ctx: SynthesizeContext,
  client: AnthropicLike | null = null,
): Promise<Insight[]> {
  const withRelated = relatedSignals.filter((rs) => rs.related.length > 0);

  console.log(
    '[rumen-synthesize] starting: signals=' +
      withRelated.length +
      ' softCap=' +
      ctx.maxLlmCallsSoft +
      ' hardCap=' +
      ctx.maxLlmCallsHard +
      ' apiKeyMissing=' +
      ctx.apiKeyMissing,
  );

  if (ctx.apiKeyMissing) {
    console.log(
      '[rumen-synthesize] no API key, falling back to placeholder for ' +
        withRelated.length +
        ' signals',
    );
    return withRelated.map((rs) => makePlaceholderInsight(rs));
  }

  const anthropic = client ?? createAnthropicClient();
  const out: Insight[] = [];

  for (let i = 0; i < withRelated.length; i += BATCH_SIZE) {
    const batch = withRelated.slice(i, i + BATCH_SIZE);

    if (ctx.softCapTripped) {
      for (const rs of batch) {
        out.push(makePlaceholderInsight(rs));
      }
      continue;
    }

    if (ctx.llmCallsMade + 1 > ctx.maxLlmCallsHard) {
      throw new Error(
        '[rumen-synthesize] hard cap exceeded (' +
          ctx.maxLlmCallsHard +
          ' LLM calls) — aborting job',
      );
    }

    if (ctx.llmCallsMade + 1 > ctx.maxLlmCallsSoft) {
      console.warn(
        '[rumen-synthesize] soft cap of ' +
          ctx.maxLlmCallsSoft +
          ' LLM calls crossed — falling back to placeholder for remaining signals',
      );
      ctx.softCapTripped = true;
      for (const rs of batch) {
        out.push(makePlaceholderInsight(rs));
      }
      continue;
    }

    try {
      const batchInsights = await synthesizeBatch(anthropic, batch, ctx);
      for (const insight of batchInsights) {
        out.push(insight);
      }
    } catch (err) {
      console.error(
        '[rumen-synthesize] batch failed, falling back to placeholder for ' +
          batch.length +
          ' signals:',
        err,
      );
      for (const rs of batch) {
        out.push(makePlaceholderInsight(rs));
      }
    }
  }

  console.log(
    '[rumen-synthesize] done: produced=' +
      out.length +
      ' llmCalls=' +
      ctx.llmCallsMade +
      ' inputTokens=' +
      ctx.inputTokens +
      ' outputTokens=' +
      ctx.outputTokens,
  );

  return out;
}

async function synthesizeBatch(
  client: AnthropicLike,
  batch: RelatedSignal[],
  ctx: SynthesizeContext,
): Promise<Insight[]> {
  const userPrompt = buildUserPrompt(batch);
  ctx.llmCallsMade += 1;

  const response = await client.messages.create({
    model: process.env['RUMEN_SYNTH_MODEL'] ?? DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const usage = response.usage;
  if (usage) {
    ctx.inputTokens += usage.input_tokens ?? 0;
    ctx.outputTokens += usage.output_tokens ?? 0;
    console.log(
      '[rumen-synthesize] tokens=' +
        ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)) +
        ' (in=' +
        (usage.input_tokens ?? 0) +
        ' out=' +
        (usage.output_tokens ?? 0) +
        ')',
    );
  }

  const text = extractText(response);
  const parsed = parseBatchResponse(text);

  const out: Insight[] = [];
  for (const rs of batch) {
    const match = parsed.get(rs.signal.key);
    if (!match || match.text.length === 0) {
      console.warn(
        '[rumen-synthesize] no parsed result for signal ' +
          rs.signal.key +
          ', falling back to placeholder',
      );
      out.push(makePlaceholderInsight(rs));
      continue;
    }
    const validCitedIds = filterValidCitations(match.cited_ids, rs.related);
    out.push({
      source: rs,
      insight_text: match.text,
      confidence: normalizeConfidence(computeConfidence(rs), rs.related.length),
      source_memory_ids:
        validCitedIds.length > 0 ? validCitedIds : rs.related.map((r) => r.id),
      synthesized: true,
    });
  }
  return out;
}

function buildUserPrompt(batch: RelatedSignal[]): string {
  const parts: string[] = [];
  parts.push(
    'Here are ' +
      batch.length +
      ' signal(s) and their related memories. Write one insight per signal.',
  );
  parts.push('');

  for (const rs of batch) {
    parts.push('=== SIGNAL key=' + rs.signal.key + ' ===');
    parts.push('project: ' + (rs.signal.project ?? 'unknown'));
    parts.push('description: ' + rs.signal.description);
    parts.push('');
    parts.push('Related memories (use these for citations):');
    for (const r of rs.related) {
      parts.push(
        '- id=' +
          r.id +
          ' short=#' +
          shortId(r.id) +
          ' project=' +
          (r.project ?? 'unknown') +
          ' similarity=' +
          r.similarity.toFixed(2) +
          ' source_type=' +
          r.source_type,
      );
      parts.push('  content: ' + truncate(r.content, 500));
    }
    parts.push('');
  }

  parts.push(
    'Return the JSON object now. Use the exact signal `key` strings above. ' +
      'Every cited_id must be one of the full UUIDs from the memories above.',
  );
  return parts.join('\n');
}

interface ParsedInsight {
  text: string;
  cited_ids: string[];
}

function parseBatchResponse(text: string): Map<string, ParsedInsight> {
  const out = new Map<string, ParsedInsight>();

  // Primary path: three-pass parse — strict → fence/slice → repair.
  let parsed: unknown | null = tryParseInsight(text);

  // Per-object salvage runs when the primary path either failed or produced an
  // unexpected shape (e.g. the slice pass returned a single bare insight
  // object instead of the {insights:[...]} envelope). It scans the raw text
  // for balanced `{...}` blocks and rescues the well-formed ones, so a single
  // malformed sibling can no longer poison the whole batch.
  if (!hasInsightsArray(parsed)) {
    const salvaged = salvageInsightObjects(text);
    if (salvaged.length > 0) {
      console.warn(
        '[rumen-synthesize] recovered ' +
          salvaged.length +
          ' insight(s) via per-object regex fallback',
      );
      parsed = { insights: salvaged };
    }
  }

  if (!hasInsightsArray(parsed)) {
    console.warn('[rumen-synthesize] JSON parse failed at all three stages');
    return out;
  }

  for (const row of parsed.insights) {
    if (typeof row !== 'object' || row === null) continue;
    const obj = row as { key?: unknown; text?: unknown; cited_ids?: unknown };
    if (typeof obj.key !== 'string' || typeof obj.text !== 'string') continue;
    const citedIds = Array.isArray(obj.cited_ids)
      ? obj.cited_ids.filter((x): x is string => typeof x === 'string')
      : [];
    out.set(obj.key, { text: obj.text.trim(), cited_ids: citedIds });
  }
  return out;
}

function hasInsightsArray(p: unknown): p is { insights: unknown[] } {
  return (
    typeof p === 'object' &&
    p !== null &&
    Array.isArray((p as { insights?: unknown }).insights)
  );
}

/**
 * Three-pass tolerant JSON parser for Haiku-synthesized insight responses.
 *
 *   Pass 1 — strict `JSON.parse` of the raw response. Fast path for clean
 *            responses (the common case).
 *   Pass 2 — strip a markdown ```json fence; failing that, slice the first
 *            balanced `{...}` or `[...]` block and ignore everything around
 *            it. Handles "trailing prose after the JSON" and "fenced JSON".
 *   Pass 3 — light repair of the sliced block (or the raw response if the
 *            slice failed): strip trailing commas, escape literal newlines /
 *            CRs / tabs that appear unescaped inside string values.
 *
 * Returns the first parse that succeeds, or `null` if all three passes fail.
 * The caller is expected to fall back to a placeholder insight on `null`.
 *
 * Exported so it can be unit-tested in isolation — see tests/synthesize.test.ts.
 */
export function tryParseInsight(raw: string): unknown | null {
  // Pass 1: strict.
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }

  // Pass 2a: ```json ... ``` fence.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }

  // Pass 2b: slice the first balanced `{...}` or `[...]` block.
  const sliced = sliceFirstJsonBlock(raw);
  if (sliced) {
    try {
      return JSON.parse(sliced);
    } catch {
      /* fall through */
    }
  }

  // Pass 3: light repair on the sliced block (or raw, if slicing failed).
  const repaired = repairCommonJsonIssues(sliced ?? raw);
  if (repaired) {
    try {
      const result = JSON.parse(repaired);
      console.warn(
        '[rumen-synthesize] recovered via trailing-comma strip / newline escape',
      );
      return result;
    } catch {
      /* give up */
    }
  }

  return null;
}

/**
 * Walk `s` from the first `{` or `[` and return the substring through the
 * matching closing brace/bracket. Tracks string state and backslash escapes
 * so braces inside string values do not throw the depth count off. Returns
 * `null` if no opener is found or the block never closes (truncation).
 *
 * Exported for direct unit testing.
 */
export function sliceFirstJsonBlock(s: string): string | null {
  let openChar: '{' | '[' | null = null;
  let closeChar: '}' | ']' | null = null;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '[') {
      openChar = ch;
      closeChar = ch === '{' ? '}' : ']';
      start = i;
      break;
    }
  }
  if (start === -1 || !openChar || !closeChar) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Apply two common JSON repairs and return the result. The repairs are:
 *
 *   1. Strip trailing commas immediately before `}` or `]`. Trailing commas
 *      are valid JS but invalid JSON, and Haiku emits them often.
 *   2. Escape literal newlines, carriage returns, and tabs that appear
 *      unescaped inside string values. Walks character-by-character and
 *      tracks string state so non-string whitespace is left alone.
 *
 * Always returns a string (possibly identical to the input). Returns `null`
 * only when the input is empty.
 *
 * Exported for direct unit testing.
 */
export function repairCommonJsonIssues(s: string): string | null {
  if (s.length === 0) return null;

  // Step 1: strip trailing commas.
  const noTrailingCommas = s.replace(/,(\s*[}\]])/g, '$1');

  // Step 2: escape literal newlines/CR/TAB inside string values.
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < noTrailingCommas.length; i++) {
    const ch = noTrailingCommas[i]!;
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') {
        out += ch;
        escape = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      out += ch;
      inString = true;
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * Scan for individual insight objects inside a malformed JSON array.
 * Matches `{ "key": "...", "text": "...", "cited_ids": [...] }` regardless of
 * field order. One malformed sibling no longer poisons the whole batch.
 */
function salvageInsightObjects(
  jsonText: string,
): Array<{ key: string; text: string; cited_ids: string[] }> {
  const results: Array<{ key: string; text: string; cited_ids: string[] }> = [];
  // Find balanced { ... } blocks, then try to parse each one.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const chunk = jsonText.slice(start, i + 1);
        // Repair trailing commas inside this chunk and attempt parse.
        const repaired = chunk.replace(/,(\s*[}\]])/g, '$1');
        let obj:
          | { key?: unknown; text?: unknown; cited_ids?: unknown }
          | undefined;
        try {
          obj = JSON.parse(repaired);
        } catch {
          obj = undefined;
        }
        if (
          obj &&
          typeof obj.key === 'string' &&
          typeof obj.text === 'string'
        ) {
          const citedIds = Array.isArray(obj.cited_ids)
            ? obj.cited_ids.filter((x): x is string => typeof x === 'string')
            : [];
          results.push({ key: obj.key, text: obj.text, cited_ids: citedIds });
        }
        start = -1;
      }
    }
  }
  return results;
}

function filterValidCitations(
  citedIds: string[],
  related: RelatedMemory[],
): string[] {
  const validSet = new Set(related.map((r) => r.id));
  const out: string[] = [];
  for (const id of citedIds) {
    if (validSet.has(id) && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

export function computeConfidence(rs: RelatedSignal): number {
  if (rs.related.length === 0) return 0;

  const maxSim = rs.related.reduce((m, r) => Math.max(m, r.similarity), 0);
  const projects = new Set<string>();
  for (const r of rs.related) {
    if (r.project) projects.add(r.project);
  }
  const crossProjectBonus = projects.size >= 2 ? 1 : 0;

  let ageSpreadBonus = 0;
  const times = rs.related
    .map((r) => Date.parse(r.created_at))
    .filter((n) => !Number.isNaN(n));
  if (times.length >= 2) {
    const spreadDays =
      (Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24);
    ageSpreadBonus = Math.min(1, spreadDays / 14);
  }

  const raw = 0.5 * maxSim + 0.3 * crossProjectBonus + 0.2 * ageSpreadBonus;
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * v0.1-compatible placeholder insight, used when:
 *   - ANTHROPIC_API_KEY is missing
 *   - the soft cap is tripped
 *   - a batch fails and we fall through
 *
 * The text format matches the v0.1 Surface-phase template so downstream
 * consumers can tell the two apart (`synthesized: false`).
 */
export function makePlaceholderInsight(rs: RelatedSignal): Insight {
  const count = rs.related.length;
  const relatedProjects = uniqueNonNull(rs.related.map((r) => r.project));
  const projectList =
    relatedProjects.length > 0 ? relatedProjects.join(', ') : 'unknown';
  const description = rs.signal.description.slice(0, 180);
  const text =
    'Found ' +
    count +
    ' related ' +
    (count === 1 ? 'memory' : 'memories') +
    ' from ' +
    (relatedProjects.length === 1 ? 'project ' : 'projects ') +
    projectList +
    ' about: ' +
    description;

  return {
    source: rs,
    insight_text: text,
    confidence: normalizeConfidence(computeConfidence(rs), rs.related.length),
    source_memory_ids: rs.related.map((r) => r.id),
    synthesized: false,
  };
}

function uniqueNonNull(values: Array<string | null>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v !== null && v.length > 0) out.add(v);
  }
  return Array.from(out);
}

function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(
      '[rumen-synthesize] ' +
        name +
        '=' +
        raw +
        ' is not a positive integer; using default ' +
        fallback,
    );
    return fallback;
  }
  return parsed;
}

/** Minimal shape of the Anthropic client we use — lets tests swap in a fake. */
export interface AnthropicLike {
  messages: {
    create(args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    }): Promise<AnthropicMessageResponse>;
  };
}

export interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function createAnthropicClient(): AnthropicLike {
  return new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  }) as unknown as AnthropicLike;
}

function extractText(response: AnthropicMessageResponse): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}
