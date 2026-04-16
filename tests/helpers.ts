/**
 * Shared test helpers for Rumen unit tests.
 *
 * Everything here is purely in-memory: no real `pg` connections, no real
 * Anthropic HTTP calls. Tests import these to keep each test file terse.
 */

import type { PgPool } from '../src/db.ts';
import type {
  AnthropicLike,
  AnthropicMessageResponse,
} from '../src/synthesize.ts';
import type {
  RelatedMemory,
  RelatedSignal,
  RumenSignal,
} from '../src/types.ts';

export interface QueryCall {
  sql: string;
  params: unknown[];
}

export interface MockPoolOptions {
  /**
   * Either a fixed list of responses consumed in order, or a function that
   * inspects each query and returns the row set to use. A function lets tests
   * branch on which SQL the pool just saw (extract's 3 separate SELECTs, etc).
   */
  responses:
    | Array<{ rows: unknown[] } | Error>
    | ((call: QueryCall, index: number) => { rows: unknown[] } | Error);
}

export interface MockPool {
  pool: PgPool;
  calls: QueryCall[];
}

/**
 * Build a mock pg.Pool whose `query` records every call and returns canned
 * responses. Throw an Error from the responses array / function to simulate
 * a rejected query.
 */
export function makeMockPool(opts: MockPoolOptions): MockPool {
  const calls: QueryCall[] = [];
  let index = 0;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      const call: QueryCall = { sql, params };
      calls.push(call);
      let result: { rows: unknown[] } | Error;
      if (typeof opts.responses === 'function') {
        result = opts.responses(call, index);
      } else {
        result = opts.responses[index] ?? { rows: [] };
      }
      index += 1;
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
    end: async () => {},
  } as unknown as PgPool;
  return { pool, calls };
}

/**
 * Build an AnthropicLike test double whose `messages.create` returns the
 * supplied text verbatim (or iterates through an array, one entry per call).
 */
export function makeMockAnthropic(
  texts: string | string[],
  usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 10,
    output_tokens: 5,
  },
): { client: AnthropicLike; callCount: () => number; lastPrompt: () => string } {
  let calls = 0;
  let lastPrompt = '';
  const client: AnthropicLike = {
    messages: {
      create: async (args) => {
        calls += 1;
        const content = args.messages[args.messages.length - 1]?.content;
        if (typeof content === 'string') lastPrompt = content;
        const text = Array.isArray(texts)
          ? texts[Math.min(calls - 1, texts.length - 1)] ?? ''
          : texts;
        const response: AnthropicMessageResponse = {
          content: [{ type: 'text', text }],
          usage,
        };
        return response;
      },
    },
  };
  return {
    client,
    callCount: () => calls,
    lastPrompt: () => lastPrompt,
  };
}

/** Build a RelatedSignal with sensible defaults; override any subset. */
export function makeRelatedSignal(overrides: {
  key?: string;
  project?: string | null;
  description?: string;
  related?: RelatedMemory[];
} = {}): RelatedSignal {
  const signal: RumenSignal = {
    key: overrides.key ?? 'session:sess-1',
    session_id: overrides.key?.replace('session:', '') ?? 'sess-1',
    project: overrides.project ?? 'alpha',
    description: overrides.description ?? 'did a thing',
    search_text: 'some search text',
    event_count: 5,
  };
  return {
    signal,
    related: overrides.related ?? [makeRelatedMemory({})],
  };
}

export function makeRelatedMemory(
  overrides: Partial<RelatedMemory> = {},
): RelatedMemory {
  return {
    id: overrides.id ?? '11111111-1111-1111-1111-111111111111',
    content: overrides.content ?? 'memory content',
    source_type: overrides.source_type ?? 'session',
    project: overrides.project ?? 'alpha',
    created_at: overrides.created_at ?? '2026-04-10T00:00:00Z',
    similarity: overrides.similarity ?? 0.8,
  };
}

/**
 * Silence console.log/warn/error for the duration of `fn`. Tests that exercise
 * error paths don't need the noise. Returns whatever `fn` returned.
 */
export async function quiet<T>(fn: () => Promise<T> | T): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  const err = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
    console.error = err;
  }
}
