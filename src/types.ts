/**
 * Shared types for Rumen v0.1.
 *
 * The MemoryItem / MemorySession types describe the subset of Mnestra's schema
 * that Rumen reads. See docs/MNESTRA-COMPATIBILITY.md for the full contract.
 */

export type RumenTriggeredBy = 'schedule' | 'session_end' | 'manual';
export type RumenJobStatus = 'pending' | 'running' | 'done' | 'failed';

/** One row of rumen_jobs. */
export interface RumenJob {
  id: string;
  triggered_by: RumenTriggeredBy;
  status: RumenJobStatus;
  sessions_processed: number;
  insights_generated: number;
  questions_generated: number;
  error_message: string | null;
  source_session_ids: string[];
  started_at: string;
  completed_at: string | null;
}

/** One row of rumen_insights. */
export interface RumenInsight {
  id: string;
  job_id: string;
  source_memory_ids: string[];
  projects: string[];
  insight_text: string;
  confidence: number;
  acted_upon: boolean;
  created_at: string;
}

/**
 * A MemoryItem as read from Mnestra's `memory_items` table.
 * v0.1 only consumes fields; it never writes to memory_items.
 */
export interface MemoryItem {
  id: string;
  content: string;
  source_type: string;
  project: string | null;
  created_at: string;
  /**
   * The raw embedding is NOT loaded into Rumen memory (too heavy). We rely on
   * the memory_hybrid_search SQL function to do similarity matching server-side.
   */
}

/**
 * A session as seen by Rumen — since v0.3, this is a synthetic grouping over
 * memory_items by source_session_id, not a row from memory_sessions. The `id`
 * field is the source_session_id value (text, typically a UUID string);
 * `summary` is always null in v0.3 and reserved for a future LLM-generated
 * summary.
 */
export interface MemorySession {
  id: string;
  project: string | null;
  summary: string | null;
  created_at: string;
  /** Number of memory_items rows in this source_session_id grouping. */
  event_count: number;
}

/**
 * A Rumen "signal" is one interesting thing extracted from a recent session.
 * v0.1 uses a very loose definition: one signal per session, built from the
 * session summary + the concatenated content of its memory_items.
 * v0.2 will produce multiple signals per session via LLM extraction.
 */
export interface RumenSignal {
  /** Stable key so we can dedupe. */
  key: string;
  /** The session this signal came from. */
  session_id: string;
  /** Project name (nullable if Mnestra row has no project). */
  project: string | null;
  /** A short human-readable description of what happened. v0.1 uses the session summary. */
  description: string;
  /** The search query we'll feed to memory_hybrid_search in the Relate phase. */
  search_text: string;
  /** Number of events in the source session. */
  event_count: number;
}

/** A candidate memory returned by memory_hybrid_search that relates to a signal. */
export interface RelatedMemory {
  id: string;
  content: string;
  source_type: string;
  project: string | null;
  created_at: string;
  similarity: number;
}

/** The output of the Relate phase for a single signal. */
export interface RelatedSignal {
  signal: RumenSignal;
  related: RelatedMemory[];
}

/**
 * A synthesized insight produced by the Synthesize phase (v0.2+).
 * This is the transport shape between Synthesize and Surface — it is not
 * itself a rumen_insights row (Surface writes that), but its fields map 1:1
 * onto the row columns.
 */
export interface Insight {
  /** The RelatedSignal this insight was synthesized from. */
  source: RelatedSignal;
  /** 1–3 sentence human-readable insight text. */
  insight_text: string;
  /** 0..1 confidence score. */
  confidence: number;
  /** Memory UUIDs cited in insight_text (always a subset of source.related IDs). */
  source_memory_ids: string[];
  /** Whether this insight came from Haiku (true) or the v0.1 placeholder fallback (false). */
  synthesized: boolean;
}

/**
 * Runtime context passed through the Synthesize phase to track LLM budget,
 * total tokens, and fallback status across a single Rumen job.
 */
export interface SynthesizeContext {
  /** Soft cap — on cross, log a warning and fall back to the placeholder template. */
  maxLlmCallsSoft: number;
  /** Hard cap — on cross, abort the job. */
  maxLlmCallsHard: number;
  /** LLM calls made so far in this job. */
  llmCallsMade: number;
  /** Total input tokens across all LLM calls. */
  inputTokens: number;
  /** Total output tokens across all LLM calls. */
  outputTokens: number;
  /** True once the soft cap has been crossed; further calls fall back silently. */
  softCapTripped: boolean;
  /** True if no ANTHROPIC_API_KEY is set — synthesize is effectively a no-op. */
  apiKeyMissing: boolean;
}

/** Options passed into runRumenJob. All fields are optional. */
export interface RunRumenJobOptions {
  /** 'schedule' for pg_cron, 'manual' for CLI, 'session_end' for client-triggered runs. */
  triggeredBy?: RumenTriggeredBy;
  /** Override the max sessions per run. Defaults to MAX_SESSIONS_PER_RUN env, then 10. */
  maxSessions?: number;
  /** How many hours back to look for recent sessions. Defaults to 72. */
  lookbackHours?: number;
  /** Minimum similarity for a related memory to count. Defaults to 0.7. */
  minSimilarity?: number;
  /** Minimum event count for a session to count. Defaults to 3. */
  minEventCount?: number;
}

/** Summary returned from runRumenJob. */
export interface RumenJobSummary {
  job_id: string;
  status: RumenJobStatus;
  sessions_processed: number;
  insights_generated: number;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}
