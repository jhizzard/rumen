/**
 * Rumen Sprint 79 — doctrine-scan (detect + synthesize).
 *
 * DB-side density clustering over the curated memory pool (decision /
 * architecture / preference / bug_fix — the source_types the Sprint 76
 * promotion pass already gates to kitchen-level) → Haiku synthesis →
 * doctrine_registry staging rows.
 *
 * HARD BOUNDARY (CONTRIBUTING.md ground rule 1): this module DETECTS and
 * DRAFTS only. It never writes memory_items. Flow-back on ratification is
 * Sprint 79 T3's job (termdeck `doctrine ratify`, direct-INSERT with
 * source_type='doctrine'). Every write in this file targets doctrine_registry
 * or doctrine_jobs (migrations/004_doctrine_registry.sql) — new, rumen-owned
 * tables, not Mnestra's existing schema.
 *
 * Pipeline per scan:
 *   1. Fetch the curated pool's size (heartbeat only) and the graph-inference
 *      edges (memory_relationships, first consumer — Sprint 38/42) that
 *      connect two curated-pool members. Only 'relates_to' and 'elaborates'
 *      are consumed: 'supersedes' is a temporal replacement (not co-doctrine),
 *      'contradicts' is semantically OPPOSED (must never cluster together),
 *      'caused_by' is a causal chain (not "the same lesson"), and
 *      'cross_project_link' / 'blocks' are the still-dormant migration-009
 *      types. Most edges are 'relates_to' by default (GRAPH_LLM_CLASSIFY is
 *      env-gated off), so this filter captures the large majority of signal.
 *   2. Structural candidates = connected components over those edges.
 *   3. Each component is verified, not trusted: bare connected-components
 *      gives transitive-chain mush (A-B-C linked pairwise doesn't mean A and
 *      C are alike). A component qualifies only if the MEAN PAIRWISE cosine
 *      similarity across ALL its members (not just edge-adjacent pairs) is
 *      >= 0.85. A component that fails this is split (splitIncoherentComponent)
 *      by repeatedly cutting its weakest edge and re-verifying the resulting
 *      pieces — single-linkage partitioning, average-linkage verified.
 *   4. Each verified group must still qualify structurally: N >= 3 AND
 *      (>= 2 distinct projects OR >= 21 days of date spread) — a tight
 *      cluster of near-duplicate notes from one afternoon isn't a doctrine.
 *   5. Centroid-fingerprint dedup against existing doctrine_registry rows
 *      (cosine similarity of L2-renormalized mean embeddings, threshold
 *      0.90 — tighter than the 0.85 cluster threshold because centroids are
 *      already-smoothed vectors). A match reinforces the existing row
 *      (occurrence_count++, cluster_member_ids/projects union, centroid
 *      streaming-updated) instead of drafting a duplicate. AMEND-13:
 *      reinforcement that adds a NEW project is scope expansion — the
 *      project is appended and, for an already-'ratified' row,
 *      reinforced_after_ratification also increments. No flag either way;
 *      this is expected, not anomalous.
 *   6. New (non-dedup-matched) groups get an immediate doctrine_registry
 *      INSERT at status='candidate' — detection is durable even before a
 *      single LLM token is spent. Haiku synthesis (capped at
 *      DOCTRINE_SCAN_MAX_LLM_CALLS_PER_SCAN, biggest components first) then
 *      either drafts it (status='drafted'), rejects it ('recipe-level',
 *      'incoherent-cluster-unresolved'), or — for an incoherent cluster
 *      Haiku can cleanly partition — recurses one level into sub-clusters
 *      (MAX_SPLIT_DEPTH = 1; a still-incoherent sub-cluster is rejected, not
 *      split further). Rejected rows are KEPT, never deleted — the next
 *      scan's centroid dedup finds them and skips a repeat Haiku call
 *      (anti-rescan).
 *   7. Fail-soft, no key: without ANTHROPIC_API_KEY, Phase A (steps 1-6's
 *      detection/reinforcement) still runs in full; every would-be-drafted
 *      candidate parks at status='candidate' and doctrine_jobs.note records
 *      'no_api_key_phase_b_skipped' — distinguishable from a genuine
 *      flatline (Phase A ran, found nothing).
 *
 * trigger_hints are shadow-mode ONLY pre-ratification: Haiku proposes them,
 * they are stored, but nothing reads them for recall-boosting until T3
 * ratifies the row. evidence is always {date, gist} pairs — Haiku is
 * instructed never to echo a verbatim quote from a source memory.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { PgPool } from './db.js';
import { formatVectorLiteral } from './relate.js';
import { tryParseInsight } from './synthesize.js';
import type { AnthropicLike, AnthropicMessageResponse } from './synthesize.js';

export const CURATED_SOURCE_TYPES = ['decision', 'architecture', 'preference', 'bug_fix'] as const;
// Positive-affinity edge types only — see the file header for why the other
// four active types (supersedes/contradicts/caused_by/cross_project_link)
// and the still-dormant 'blocks' are excluded.
export const CLUSTER_EDGE_TYPES = ['relates_to', 'elaborates'] as const;

const MEAN_PAIRWISE_THRESHOLD = 0.85;
const MIN_CLUSTER_SIZE = 3;
const MIN_PROJECT_SPAN = 2;
const MIN_DATE_SPREAD_DAYS = 21;
const CENTROID_DEDUP_THRESHOLD = 0.9;
const DEFAULT_MAX_LLM_CALLS_PER_SCAN = 10;
const DEFAULT_BUDGET_MS = 110_000;
const HASH_DRIFT_RESYNTH_COOLDOWN_DAYS = 30;
// One level of Haiku-driven splitting per originally-detected component. A
// sub-cluster that Haiku STILL finds incoherent is rejected, not split
// again — bounds worst-case LLM spend per component to roughly its
// resulting sub-cluster count, not an unbounded recursion.
const MAX_SPLIT_DEPTH = 1;

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const SYNTH_MAX_TOKENS = 900;
const CONTENT_TRUNCATE_CHARS = 500;

const SYSTEM_PROMPT =
  'You are the doctrine-scan synthesizer for a developer\'s long-term memory store. ' +
  'You will be shown a cluster of memories (decisions, architecture notes, preferences, ' +
  'or bug fixes) that a density-clustering pass grouped together by semantic similarity ' +
  'and graph co-reference. Work in this order:\n' +
  '1. COHERENCE — does this cluster express ONE genuinely unified principle, or is it ' +
  '2+ unrelated things grouped by coincidence (e.g. a shared word that means different ' +
  'things in different contexts)? If incoherent, partition the member ids into 2+ ' +
  'coherent sub-groups instead of synthesizing — every id provided must appear in ' +
  'exactly one group.\n' +
  '2. KITCHEN-VS-RECIPE (apply to the SYNTHESIZED doctrine, not the raw members — the ' +
  'members were already gated kitchen-level individually; this checks the aggregate): ' +
  '(a) Would it still be true if the codebase were rewritten? (b) Would it apply to a ' +
  'different project? (c) Could someone just grep git log to find this? (d) Does it name ' +
  'a specific file:line or version number? (a)/(b) lean kitchen; (c)/(d) lean recipe.\n' +
  '3. If coherent and kitchen-level, synthesize: a short title; 2-5 sentences of ' +
  'doctrine_text stating the general transferable principle (the WHY, not a recap of any ' +
  'one incident); evidence as {date, gist} pairs where gist is a SHORT PARAPHRASE and ' +
  'NEVER a verbatim quote from a source memory; up to 8 trigger_hints — short keywords or ' +
  'phrases that would suggest this doctrine is relevant in a future conversation.\n' +
  'Respond with a single JSON object and no prose outside it, exactly one of:\n' +
  '{"coherent": false, "groups": [["<id>", ...], ["<id>", ...]], "rationale": "<why incoherent>"}\n' +
  '{"coherent": true, "verdict": "recipe", "rationale": "<why still recipe-level>"}\n' +
  '{"coherent": true, "verdict": "kitchen", "title": "...", "doctrine_text": "...", ' +
  '"evidence": [{"date": "YYYY-MM-DD", "gist": "..."}], "trigger_hints": ["...", ...], ' +
  '"rationale": "<short synthesis note>"}';

export interface DoctrineScanOptions {
  triggeredBy?: 'schedule' | 'manual';
  /** Default DOCTRINE_SCAN_MAX_LLM_CALLS_PER_SCAN env, then 10. */
  maxLlmCalls?: number;
  /**
   * Whole-scan wall-clock budget in ms. Default DOCTRINE_SCAN_BUDGET_MS env,
   * then 110_000 — same margin as runRumenJob under the Supabase Edge
   * Function 150s wall. Ten sequential Haiku calls at the default 30s
   * per-call timeout (RUMEN_LLM_TIMEOUT_MS) could otherwise sum to ~300s;
   * past the deadline, remaining candidates simply stay at their current
   * status (still visible, picked up by a later scan) instead of riding
   * the platform kill — the exact incident class rumen-tick hit pre-0.6.1.
   */
  budgetMs?: number;
}

export interface DoctrineScanDeps {
  /** Override the Anthropic client (tests inject a fake). */
  anthropic?: AnthropicLike;
}

export interface DoctrineScanSummary {
  job_id: string;
  status: 'done' | 'failed';
  pool_size: number;
  edge_count: number;
  components_scanned: number;
  clusters_qualified: number;
  clusters_split: number;
  candidates_drafted: number;
  candidates_reinforced: number;
  llm_calls_made: number;
  note: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

/** A curated-pool memory_items row as read by doctrine-scan. */
export interface PoolNode {
  id: string;
  project: string;
  created_at: string;
  content: string;
  content_hash: string;
  embedding: number[];
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  weight: number | null;
}

interface ExistingDoctrineRow {
  id: string;
  status: string;
  cluster_member_ids: string[];
  member_content_hashes: string[];
  projects: string[];
  occurrence_count: number;
  doctrine_text: string | null;
  synthesized_at: string | null;
  centroid: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported and unit tested in isolation (tests/doctrine-scan.test.ts).
// ---------------------------------------------------------------------------

/** Inverse of relate.ts's formatVectorLiteral: '[0.1,-0.2,...]' -> number[]. */
export function parseVectorLiteral(raw: string): number[] {
  const trimmed = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (trimmed.length === 0) return [];
  return trimmed.split(',').map((s) => Number.parseFloat(s));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Mean cosine similarity across every distinct pair. A single vector (or none) is trivially coherent. */
export function meanPairwiseSimilarity(vectors: number[][]): number {
  if (vectors.length < 2) return 1;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosineSimilarity(vectors[i]!, vectors[j]!);
      count++;
    }
  }
  return count === 0 ? 1 : sum / count;
}

/** Element-wise mean, then L2-renormalized so the result is a valid point for cosine comparison. */
export function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0]!.length;
  const sum = new Array<number>(dims).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
  }
  const mean = sum.map((s) => s / vectors.length);
  const norm = Math.sqrt(mean.reduce((acc, x) => acc + x * x, 0));
  if (norm === 0) return mean;
  return mean.map((x) => x / norm);
}

/**
 * Union-find connected components. Edges referencing an id outside
 * `nodeIds` are ignored (defensive — callers should already scope edges to
 * known nodes).
 */
export function findConnectedComponents(
  nodeIds: string[],
  edges: Array<{ source_id: string; target_id: string }>,
): string[][] {
  const parent = new Map<string, string>();
  for (const id of nodeIds) parent.set(id, id);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  for (const e of edges) {
    if (!parent.has(e.source_id) || !parent.has(e.target_id)) continue;
    const ra = find(e.source_id);
    const rb = find(e.target_id);
    if (ra !== rb) parent.set(ra, rb);
  }

  const groups = new Map<string, string[]>();
  for (const id of nodeIds) {
    const root = find(id);
    const arr = groups.get(root);
    if (arr) arr.push(id);
    else groups.set(root, [id]);
  }
  return Array.from(groups.values());
}

/**
 * A connected component whose mean pairwise similarity falls below
 * threshold gets split: repeatedly cut the weakest remaining internal edge
 * and re-verify the resulting pieces, until every piece either qualifies
 * (mean >= threshold) or drops below MIN_CLUSTER_SIZE (discarded — not
 * enough edges/evidence to justify a partition). Single-linkage split,
 * average-linkage (mean pairwise) verified — this is what keeps a long
 * transitive chain (A-B-C-D each pairwise-linked but A/D unrelated) from
 * being accepted as one cluster just because connected-components says so.
 */
export function splitIncoherentComponent(
  memberIds: string[],
  localEdges: EdgeRow[],
  embeddingById: Map<string, number[]>,
  threshold: number = MEAN_PAIRWISE_THRESHOLD,
): string[][] {
  const workingEdges = localEdges
    .slice()
    .sort((a, b) => (a.weight ?? -1) - (b.weight ?? -1));

  const frontier: string[][] = [memberIds];
  const accepted: string[][] = [];
  // Each non-terminal iteration removes exactly one edge from a strictly
  // shrinking pool; each terminal iteration retires one group. Bounded by
  // construction — this cap is defense-in-depth, not the real limiter.
  let safetyCounter = workingEdges.length + memberIds.length + 1;

  while (frontier.length > 0) {
    const group = frontier.shift()!;
    if (safetyCounter-- <= 0) {
      console.error(
        '[rumen-doctrine-scan] splitIncoherentComponent safety cap hit — abandoning remainder',
      );
      break;
    }
    if (group.length < MIN_CLUSTER_SIZE) continue;

    const vectors = group.map((id) => embeddingById.get(id)!);
    if (meanPairwiseSimilarity(vectors) >= threshold) {
      accepted.push(group);
      continue;
    }

    const groupSet = new Set(group);
    const idx = workingEdges.findIndex(
      (e) => groupSet.has(e.source_id) && groupSet.has(e.target_id),
    );
    if (idx === -1) {
      // Incoherent but no internal edges left to cut — the remaining
      // linkage is purely transitive through already-removed edges. No
      // structural basis for a further partition; drop it.
      continue;
    }
    workingEdges.splice(idx, 1);
    const remainingEdges = workingEdges.filter(
      (e) => groupSet.has(e.source_id) && groupSet.has(e.target_id),
    );
    for (const sub of findConnectedComponents(group, remainingEdges)) {
      frontier.push(sub);
    }
  }

  return accepted;
}

/** N >= 3 AND (>= 2 distinct projects OR >= 21 days of created_at spread). */
export function qualifiesStructurally(
  members: Array<{ project: string; created_at: string }>,
): boolean {
  if (members.length < MIN_CLUSTER_SIZE) return false;
  const projects = new Set(members.map((m) => m.project).filter((p) => p.length > 0));
  if (projects.size >= MIN_PROJECT_SPAN) return true;
  const times = members.map((m) => Date.parse(m.created_at)).filter((n) => !Number.isNaN(n));
  if (times.length < 2) return false;
  const spreadDays = (Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24);
  return spreadDays >= MIN_DATE_SPREAD_DAYS;
}

// ---------------------------------------------------------------------------
// Haiku synthesis
// ---------------------------------------------------------------------------

export interface DoctrineVerdict {
  coherent: boolean;
  groups: string[][] | null;
  verdict: 'kitchen' | 'recipe' | null;
  title: string | null;
  doctrine_text: string | null;
  evidence: Array<{ date: string; gist: string }>;
  trigger_hints: string[];
  rationale: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function buildDoctrinePrompt(members: PoolNode[]): string {
  const parts: string[] = [];
  parts.push(
    'Cluster of ' +
      members.length +
      ' memories, grouped by density clustering (similarity + graph co-reference).',
  );
  parts.push('');
  for (const m of members) {
    parts.push('=== id=' + m.id + ' ===');
    parts.push('project: ' + m.project);
    parts.push('date: ' + m.created_at.slice(0, 10));
    parts.push('content: ' + truncate(m.content, CONTENT_TRUNCATE_CHARS));
    parts.push('');
  }
  parts.push(
    'Return the JSON object now. If using "groups", every id above must appear in ' +
      'exactly one group.',
  );
  return parts.join('\n');
}

function validatePartition(raw: unknown, validIds: Set<string>): string[][] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const g of raw) {
    if (!Array.isArray(g)) return null;
    const groupIds = g.filter((id): id is string => typeof id === 'string' && validIds.has(id));
    if (groupIds.length === 0) return null;
    for (const id of groupIds) {
      if (seen.has(id)) return null; // an id claimed by 2+ groups — malformed
      seen.add(id);
    }
    groups.push(groupIds);
  }
  if (seen.size !== validIds.size) return null; // every id must be placed exactly once
  return groups;
}

/** Exported for direct unit testing (tests/doctrine-scan.test.ts). */
export function validateVerdict(raw: unknown, validIds: Set<string>): DoctrineVerdict | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 500) : '';

  if (obj.coherent === false) {
    const groups = validatePartition(obj.groups, validIds);
    if (!groups) return null;
    return {
      coherent: false,
      groups,
      verdict: null,
      title: null,
      doctrine_text: null,
      evidence: [],
      trigger_hints: [],
      rationale,
    };
  }

  if (obj.coherent !== true) return null;

  if (obj.verdict === 'recipe') {
    return {
      coherent: true,
      groups: null,
      verdict: 'recipe',
      title: null,
      doctrine_text: null,
      evidence: [],
      trigger_hints: [],
      rationale,
    };
  }

  if (obj.verdict !== 'kitchen') return null;
  if (typeof obj.title !== 'string' || typeof obj.doctrine_text !== 'string') return null;

  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence
        .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
        .map((e) => ({
          date: typeof e.date === 'string' ? e.date : '',
          gist: typeof e.gist === 'string' ? e.gist.trim().slice(0, 300) : '',
        }))
        .filter((e) => e.gist.length > 0)
        .slice(0, 20)
    : [];

  const triggerHints = Array.isArray(obj.trigger_hints)
    ? obj.trigger_hints
        .filter((h): h is string => typeof h === 'string')
        .map((h) => h.trim().slice(0, 80))
        .filter((h) => h.length > 0)
        .slice(0, 8)
    : [];

  return {
    coherent: true,
    groups: null,
    verdict: 'kitchen',
    title: obj.title.trim().slice(0, 200),
    doctrine_text: obj.doctrine_text.trim().slice(0, 2000),
    evidence,
    trigger_hints: triggerHints,
    rationale,
  };
}

function extractText(response: AnthropicMessageResponse): string {
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

async function synthesizeCluster(
  client: AnthropicLike,
  members: PoolNode[],
): Promise<DoctrineVerdict | null> {
  const validIds = new Set(members.map((m) => m.id));
  const response = await client.messages.create({
    model: process.env['RUMEN_SYNTH_MODEL'] ?? DEFAULT_MODEL,
    max_tokens: SYNTH_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildDoctrinePrompt(members) }],
  });

  const text = extractText(response);
  const parsed = tryParseInsight(text);
  const verdict = validateVerdict(parsed, validIds);
  if (!verdict) {
    console.warn('[rumen-doctrine-scan] verdict unparseable/invalid: ' + text.slice(0, 160));
  }
  return verdict;
}

function createAnthropicClient(apiKey: string): AnthropicLike {
  // Same bounded timeout/retry rationale as synthesize.ts's client: an Edge
  // Function has a 150s wall, the SDK defaults (10 min / 2 retries) do not.
  return new Anthropic({
    apiKey,
    timeout: readIntEnv('RUMEN_LLM_TIMEOUT_MS', 30_000),
    maxRetries: 1,
  }) as unknown as AnthropicLike;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

interface ScanStats {
  pool_size: number;
  edge_count: number;
  components_scanned: number;
  component_histogram: Record<string, number>;
  clusters_qualified: number;
  clusters_split: number;
  candidates_drafted: number;
  candidates_reinforced: number;
  llm_calls_made: number;
}

interface GroupContext {
  anthropic: AnthropicLike | null;
  llmBudget: { made: number; cap: number };
  stats: ScanStats;
  depth: number;
  deadlineAt: number;
  deadlineHit: { value: boolean };
}

export async function runDoctrineScan(
  pool: PgPool,
  options: DoctrineScanOptions = {},
  deps: DoctrineScanDeps = {},
): Promise<DoctrineScanSummary> {
  const triggeredBy = options.triggeredBy ?? 'manual';
  const maxLlmCalls =
    options.maxLlmCalls ?? readIntEnv('DOCTRINE_SCAN_MAX_LLM_CALLS', DEFAULT_MAX_LLM_CALLS_PER_SCAN);
  const budgetMs = options.budgetMs ?? readIntEnv('DOCTRINE_SCAN_BUDGET_MS', DEFAULT_BUDGET_MS);
  const deadlineAt = Date.now() + budgetMs;
  const anthropicKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  const apiKeyMissing = !deps.anthropic && anthropicKey.length === 0;

  console.log(
    '[rumen-doctrine-scan] starting scan triggeredBy=' +
      triggeredBy +
      ' maxLlmCalls=' +
      maxLlmCalls +
      ' apiKeyMissing=' +
      apiKeyMissing,
  );

  const job = await createJob(pool, triggeredBy);
  const stats: ScanStats = {
    pool_size: 0,
    edge_count: 0,
    components_scanned: 0,
    component_histogram: {},
    clusters_qualified: 0,
    clusters_split: 0,
    candidates_drafted: 0,
    candidates_reinforced: 0,
    llm_calls_made: 0,
  };

  try {
    stats.pool_size = await fetchPoolSize(pool);
    const edges = await fetchClusterEdges(pool);
    stats.edge_count = edges.length;

    if (edges.length === 0) {
      console.log('[rumen-doctrine-scan] no cluster-eligible edges — nothing to scan this run');
      const done = await completeJob(pool, {
        jobId: job.id,
        status: 'done',
        stats,
        note: apiKeyMissing ? 'no_api_key_phase_b_skipped' : null,
        errorMessage: null,
      });
      return toSummary(done);
    }

    const nodeIds = uniqueIds(edges);
    const components = findConnectedComponents(nodeIds, edges);
    stats.components_scanned = components.length;
    stats.component_histogram = buildHistogram(components);

    const nodeById = await fetchNodeDetails(pool, nodeIds);
    const anthropic = deps.anthropic ?? (apiKeyMissing ? null : createAnthropicClient(anthropicKey));
    const ctx: GroupContext = {
      anthropic,
      llmBudget: { made: 0, cap: maxLlmCalls },
      stats,
      depth: 0,
      deadlineAt,
      deadlineHit: { value: false },
    };

    // Biggest components first: under a tight LLM budget, synthesize the
    // strongest-evidence clusters before the marginal ones.
    const bySize = [...components].sort((a, b) => b.length - a.length);

    for (const componentIds of bySize) {
      if (componentIds.length < MIN_CLUSTER_SIZE) continue;

      const embeddingById = new Map<string, number[]>();
      for (const id of componentIds) {
        const node = nodeById.get(id);
        if (node) embeddingById.set(id, node.embedding);
      }
      const vectors = componentIds.map((id) => embeddingById.get(id)!);
      const mean = meanPairwiseSimilarity(vectors);

      let groups: string[][];
      if (mean >= MEAN_PAIRWISE_THRESHOLD) {
        groups = [componentIds];
      } else {
        stats.clusters_split += 1;
        const localEdges = edges.filter(
          (e) => embeddingById.has(e.source_id) && embeddingById.has(e.target_id),
        );
        groups = splitIncoherentComponent(componentIds, localEdges, embeddingById);
      }

      for (const group of groups) {
        const members = group.map((id) => nodeById.get(id)).filter((n): n is PoolNode => !!n);
        if (members.length !== group.length) continue; // defensive — should not happen
        if (!qualifiesStructurally(members)) continue;
        stats.clusters_qualified += 1;
        await processQualifyingGroup(pool, members, ctx);
      }
    }

    const note = apiKeyMissing
      ? 'no_api_key_phase_b_skipped'
      : ctx.deadlineHit.value
        ? 'wall_clock_budget_exhausted'
        : ctx.llmBudget.made >= ctx.llmBudget.cap
          ? 'llm_budget_exhausted_this_scan'
          : null;

    const done = await completeJob(pool, {
      jobId: job.id,
      status: 'done',
      stats,
      note,
      errorMessage: null,
    });
    console.log(
      '[rumen-doctrine-scan] scan ' +
        job.id +
        ' complete: qualified=' +
        stats.clusters_qualified +
        ' drafted=' +
        stats.candidates_drafted +
        ' reinforced=' +
        stats.candidates_reinforced +
        ' llmCalls=' +
        stats.llm_calls_made,
    );
    return toSummary(done);
  } catch (err) {
    console.error('[rumen-doctrine-scan] scan ' + job.id + ' failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    try {
      const failed = await completeJob(pool, {
        jobId: job.id,
        status: 'failed',
        stats,
        note: null,
        errorMessage: message,
      });
      return toSummary(failed);
    } catch (markErr) {
      console.error('[rumen-doctrine-scan] scan ' + job.id + ' also failed to mark as failed:', markErr);
      throw err;
    }
  }
}

async function processQualifyingGroup(
  pool: PgPool,
  members: PoolNode[],
  ctx: GroupContext,
): Promise<void> {
  const centroid = computeCentroid(members.map((m) => m.embedding));
  const centroidLiteral = formatVectorLiteral(centroid);
  const memberIds = members.map((m) => m.id);
  const projects = uniqueNonEmpty(members.map((m) => m.project));
  const hashes = members.map((m) => m.content_hash);

  const nearest = await findNearestDoctrine(pool, centroidLiteral);
  const isDedupMatch =
    nearest !== null &&
    cosineSimilarity(parseVectorLiteral(nearest.centroid), centroid) >= CENTROID_DEDUP_THRESHOLD;

  let targetId: string;
  let targetStatus: string;
  let existingDoctrineText: string | null;
  let existingSynthesizedAt: string | null;
  let membershipGrew: boolean;
  let hashDrifted: boolean;

  if (isDedupMatch && nearest) {
    const wasRatified = nearest.status === 'ratified';
    const mergedIds = unique([...nearest.cluster_member_ids, ...memberIds]);
    const mergedProjects = unique([...nearest.projects, ...projects]);

    const oldHashById = new Map(nearest.cluster_member_ids.map((id, i) => [id, nearest.member_content_hashes[i]]));
    hashDrifted = memberIds.some((id) => {
      const oldHash = oldHashById.get(id);
      return oldHash !== undefined && oldHash !== hashById(members, id);
    });
    membershipGrew = memberIds.some((id) => !nearest.cluster_member_ids.includes(id));

    const mergedHashById = new Map(oldHashById);
    for (const m of members) mergedHashById.set(m.id, m.content_hash);
    const mergedHashes = mergedIds.map((id) => mergedHashById.get(id) ?? '');

    // Streaming centroid update: weight the existing centroid by how many
    // occurrences it already represents rather than re-fetching every prior
    // member's embedding (which may include archived/superseded rows by now).
    const newCentroid = computeCentroid([
      ...Array(nearest.occurrence_count).fill(parseVectorLiteral(nearest.centroid)),
      ...members.map((m) => m.embedding),
    ]);

    await reinforceRow(pool, {
      id: nearest.id,
      clusterMemberIds: mergedIds,
      memberContentHashes: mergedHashes,
      projects: mergedProjects,
      centroidLiteral: formatVectorLiteral(newCentroid),
      bumpReinforcedAfterRatification: wasRatified,
    });
    ctx.stats.candidates_reinforced += 1;

    targetId = nearest.id;
    targetStatus = nearest.status;
    existingDoctrineText = nearest.doctrine_text;
    existingSynthesizedAt = nearest.synthesized_at;
  } else {
    const inserted = await insertCandidateRow(pool, {
      clusterMemberIds: memberIds,
      memberContentHashes: hashes,
      projects,
      centroidLiteral,
    });
    ctx.stats.candidates_drafted += 1;

    targetId = inserted.id;
    targetStatus = inserted.status;
    existingDoctrineText = null;
    existingSynthesizedAt = null;
    membershipGrew = true; // brand new — always eligible for a first synthesis pass
    hashDrifted = false;
  }

  const cooldownOk =
    existingSynthesizedAt === null ||
    Date.now() - Date.parse(existingSynthesizedAt) >= HASH_DRIFT_RESYNTH_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  const needsSynthesis = existingDoctrineText === null || membershipGrew || hashDrifted;
  const statusEligible = !['ratified', 'proposed', 'rejected', 'superseded'].includes(targetStatus);
  const deadlinePassed = Date.now() > ctx.deadlineAt;
  if (deadlinePassed && needsSynthesis && cooldownOk && statusEligible && ctx.anthropic !== null) {
    // Only flag "budget exhausted" if this group would otherwise have
    // spent a call — a group that wasn't eligible anyway shouldn't mark
    // the scan as deadline-constrained.
    ctx.deadlineHit.value = true;
  }
  const shouldSynthesize =
    ctx.anthropic !== null &&
    needsSynthesis &&
    cooldownOk &&
    statusEligible &&
    ctx.llmBudget.made < ctx.llmBudget.cap &&
    !deadlinePassed;

  if (!shouldSynthesize) return;

  ctx.llmBudget.made += 1;
  ctx.stats.llm_calls_made += 1;
  const verdict = await synthesizeCluster(ctx.anthropic!, members);

  if (!verdict) {
    await markRejected(pool, targetId, 'llm-verdict-unparseable');
    return;
  }

  if (!verdict.coherent) {
    if (ctx.depth < MAX_SPLIT_DEPTH && verdict.groups) {
      await markRejected(pool, targetId, 'split-into-subclusters');
      for (const subIds of verdict.groups) {
        const subMembers = members.filter((m) => subIds.includes(m.id));
        if (!qualifiesStructurally(subMembers)) continue;
        ctx.stats.clusters_qualified += 1;
        await processQualifyingGroup(pool, subMembers, { ...ctx, depth: ctx.depth + 1 });
      }
    } else {
      await markRejected(pool, targetId, 'incoherent-cluster-unresolved');
    }
    return;
  }

  if (verdict.verdict === 'recipe') {
    await markRejected(pool, targetId, 'recipe-level');
    return;
  }

  await markDrafted(pool, targetId, verdict);
}

function hashById(members: PoolNode[], id: string): string | undefined {
  return members.find((m) => m.id === id)?.content_hash;
}

function toSummary(row: {
  id: string;
  status: 'done' | 'failed';
  pool_size: number;
  edge_count: number;
  components_scanned: number;
  clusters_qualified: number;
  clusters_split: number;
  candidates_drafted: number;
  candidates_reinforced: number;
  llm_calls_made: number;
  note: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}): DoctrineScanSummary {
  return {
    job_id: row.id,
    status: row.status,
    pool_size: row.pool_size,
    edge_count: row.edge_count,
    components_scanned: row.components_scanned,
    clusters_qualified: row.clusters_qualified,
    clusters_split: row.clusters_split,
    candidates_drafted: row.candidates_drafted,
    candidates_reinforced: row.candidates_reinforced,
    llm_calls_made: row.llm_calls_made,
    note: row.note,
    error_message: row.error_message,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function buildHistogram(components: string[][]): Record<string, number> {
  const histogram: Record<string, number> = {};
  for (const c of components) {
    const key = String(c.length);
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  return histogram;
}

function uniqueIds(edges: EdgeRow[]): string[] {
  const out = new Set<string>();
  for (const e of edges) {
    out.add(e.source_id);
    out.add(e.target_id);
  }
  return Array.from(out);
}

function uniqueNonEmpty(values: string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v.length > 0) out.add(v);
  }
  return Array.from(out);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.error(
      '[rumen-doctrine-scan] ' + name + '=' + raw + ' is not a positive integer; using default ' + fallback,
    );
    return fallback;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface CreatedJobRow {
  id: string;
  started_at: string;
}

async function createJob(pool: PgPool, triggeredBy: 'schedule' | 'manual'): Promise<CreatedJobRow> {
  const res = await pool.query<CreatedJobRow>(
    `
      INSERT INTO doctrine_jobs (triggered_by, status, started_at)
      VALUES ($1, 'running', NOW())
      RETURNING id, started_at::text AS started_at
    `,
    [triggeredBy],
  );
  const row = res.rows[0];
  if (!row) throw new Error('[rumen-doctrine-scan] failed to insert doctrine_jobs row');
  return row;
}

interface CompleteJobArgs {
  jobId: string;
  status: 'done' | 'failed';
  stats: ScanStats;
  note: string | null;
  errorMessage: string | null;
}

interface CompletedJobRow {
  id: string;
  status: 'done' | 'failed';
  pool_size: number;
  edge_count: number;
  components_scanned: number;
  clusters_qualified: number;
  clusters_split: number;
  candidates_drafted: number;
  candidates_reinforced: number;
  llm_calls_made: number;
  note: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string;
}

async function completeJob(pool: PgPool, args: CompleteJobArgs): Promise<CompletedJobRow> {
  const res = await pool.query<CompletedJobRow>(
    `
      UPDATE doctrine_jobs
      SET status              = $2,
          pool_size           = $3,
          edge_count          = $4,
          components_scanned  = $5,
          component_histogram = $6::jsonb,
          clusters_qualified  = $7,
          clusters_split      = $8,
          candidates_drafted  = $9,
          candidates_reinforced = $10,
          llm_calls_made      = $11,
          note                = $12,
          error_message       = $13,
          completed_at        = NOW()
      WHERE id = $1
      RETURNING
        id, status, pool_size, edge_count, components_scanned,
        clusters_qualified, clusters_split, candidates_drafted,
        candidates_reinforced, llm_calls_made, note, error_message,
        started_at::text AS started_at, completed_at::text AS completed_at
    `,
    [
      args.jobId,
      args.status,
      args.stats.pool_size,
      args.stats.edge_count,
      args.stats.components_scanned,
      JSON.stringify(args.stats.component_histogram),
      args.stats.clusters_qualified,
      args.stats.clusters_split,
      args.stats.candidates_drafted,
      args.stats.candidates_reinforced,
      args.stats.llm_calls_made,
      args.note,
      args.errorMessage,
    ],
  );
  const row = res.rows[0];
  if (!row) throw new Error('[rumen-doctrine-scan] failed to update doctrine_jobs row ' + args.jobId);
  return row;
}

async function fetchPoolSize(pool: PgPool): Promise<number> {
  const res = await pool.query<{ pool_size: number }>(
    `
      SELECT COUNT(*)::int AS pool_size
      FROM memory_items
      WHERE source_type = ANY($1::text[])
        AND is_active = true AND archived = false AND superseded_by IS NULL
    `,
    [CURATED_SOURCE_TYPES],
  );
  return res.rows[0]?.pool_size ?? 0;
}

async function fetchClusterEdges(pool: PgPool): Promise<EdgeRow[]> {
  const res = await pool.query<EdgeRow>(
    `
      SELECT r.source_id, r.target_id, r.weight
      FROM memory_relationships r
      JOIN memory_items s ON s.id = r.source_id
      JOIN memory_items t ON t.id = r.target_id
      WHERE r.relationship_type = ANY($1::text[])
        AND s.source_type = ANY($2::text[]) AND s.is_active = true AND s.archived = false AND s.superseded_by IS NULL
        AND t.source_type = ANY($2::text[]) AND t.is_active = true AND t.archived = false AND t.superseded_by IS NULL
    `,
    [CLUSTER_EDGE_TYPES, CURATED_SOURCE_TYPES],
  );
  return res.rows;
}

async function fetchNodeDetails(pool: PgPool, ids: string[]): Promise<Map<string, PoolNode>> {
  if (ids.length === 0) return new Map();
  const res = await pool.query<{
    id: string;
    project: string;
    created_at: string;
    content: string;
    content_hash: string | null;
    embedding: string;
  }>(
    `
      SELECT id, project, created_at::text AS created_at, content, content_hash, embedding::text AS embedding
      FROM memory_items
      WHERE id = ANY($1::uuid[])
    `,
    [ids],
  );
  const out = new Map<string, PoolNode>();
  for (const row of res.rows) {
    out.set(row.id, {
      id: row.id,
      project: row.project,
      created_at: row.created_at,
      content: row.content,
      // content_hash is nullable in the schema even though currently 100%
      // populated on the curated pool; md5(content) is a defensive fallback,
      // never the primary path.
      content_hash: row.content_hash ?? md5Fallback(row.content),
      embedding: parseVectorLiteral(row.embedding),
    });
  }
  return out;
}

// Cheap non-cryptographic fallback fingerprint — only reached if
// memory_items.content_hash is unexpectedly NULL. Not used for security,
// only for detecting drift between scans.
function md5Fallback(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = (Math.imul(31, hash) + content.charCodeAt(i)) | 0;
  }
  return 'fallback:' + hash.toString(16);
}

async function findNearestDoctrine(pool: PgPool, centroidLiteral: string): Promise<ExistingDoctrineRow | null> {
  const res = await pool.query<ExistingDoctrineRow>(
    `
      SELECT id, status, cluster_member_ids, member_content_hashes, projects,
             occurrence_count, doctrine_text, synthesized_at::text AS synthesized_at, centroid::text AS centroid
      FROM doctrine_registry
      WHERE centroid IS NOT NULL
      ORDER BY centroid <=> $1::vector
      LIMIT 1
    `,
    [centroidLiteral],
  );
  return res.rows[0] ?? null;
}

interface InsertCandidateArgs {
  clusterMemberIds: string[];
  memberContentHashes: string[];
  projects: string[];
  centroidLiteral: string;
}

async function insertCandidateRow(
  pool: PgPool,
  args: InsertCandidateArgs,
): Promise<{ id: string; status: string }> {
  const res = await pool.query<{ id: string; status: string }>(
    `
      INSERT INTO doctrine_registry (
        status, cluster_member_ids, member_content_hashes, projects, centroid, occurrence_count
      )
      VALUES ('candidate', $1::uuid[], $2::text[], $3::text[], $4::vector, 1)
      RETURNING id, status
    `,
    [args.clusterMemberIds, args.memberContentHashes, args.projects, args.centroidLiteral],
  );
  const row = res.rows[0];
  if (!row) throw new Error('[rumen-doctrine-scan] failed to insert doctrine_registry row');
  return row;
}

interface ReinforceArgs {
  id: string;
  clusterMemberIds: string[];
  memberContentHashes: string[];
  projects: string[];
  centroidLiteral: string;
  bumpReinforcedAfterRatification: boolean;
}

async function reinforceRow(pool: PgPool, args: ReinforceArgs): Promise<void> {
  await pool.query(
    `
      UPDATE doctrine_registry
      SET cluster_member_ids = $2::uuid[],
          member_content_hashes = $3::text[],
          projects = $4::text[],
          centroid = $5::vector,
          occurrence_count = occurrence_count + 1,
          reinforced_after_ratification = reinforced_after_ratification + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
          updated_at = NOW()
      WHERE id = $1
    `,
    [args.id, args.clusterMemberIds, args.memberContentHashes, args.projects, args.centroidLiteral, args.bumpReinforcedAfterRatification],
  );
}

async function markDrafted(pool: PgPool, id: string, verdict: DoctrineVerdict): Promise<void> {
  await pool.query(
    `
      UPDATE doctrine_registry
      SET status = 'drafted',
          title = $2,
          doctrine_text = $3,
          evidence = $4::jsonb,
          trigger_hints = $5::text[],
          synthesized_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `,
    [id, verdict.title, verdict.doctrine_text, JSON.stringify(verdict.evidence), verdict.trigger_hints],
  );
}

/** Guarded to candidate/drafted only — T2 never flips a ratified/proposed/superseded row. */
async function markRejected(pool: PgPool, id: string, reason: string): Promise<void> {
  await pool.query(
    `
      UPDATE doctrine_registry
      SET status = 'rejected',
          rejection_reason = $2,
          synthesized_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND status IN ('candidate', 'drafted')
    `,
    [id, reason],
  );
}
