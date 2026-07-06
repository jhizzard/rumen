/**
 * Confidence calibration primitives for Rumen synthesis.
 *
 * Two orthogonal concerns live here:
 *
 *   1. normalizeSimilarity — maps a raw memory_hybrid_search score onto 0..1.
 *      Mnestra's hybrid search returns Reciprocal-Rank-Fusion (RRF) scores with
 *      recency decay that land in a NARROW 0.01–0.3 band, NOT the 0..1 range a
 *      cosine similarity would occupy (see src/index.ts DEFAULT_MIN_SIMILARITY
 *      and src/relate.ts). If computeConfidence treats that raw score as if it
 *      were 0..1, the similarity term contributes ~0.05 while a single flat
 *      cross-project bonus adds 0.30 — a ~6:1 domination that drowns the actual
 *      relevance signal. Normalizing the band onto 0..1 FIRST is the fix.
 *
 *   2. normalize — maps a composite confidence onto a cluster-size-aware ceiling.
 *      A small relate-cluster (few citations) caps at lower confidence even with
 *      a high raw score, because we have less evidence. A large cluster can reach
 *      the full range. Below a minimum context size we clamp aggressively.
 */

/**
 * RRF band bounds. memory_hybrid_search scores cluster in [RRF_FLOOR, RRF_CEILING].
 * Scores at/above the ceiling saturate to 1.0; at/below the floor map to 0.
 * Bump NORMALIZE_VERSION when these change.
 */
export const RRF_FLOOR = 0.01;
export const RRF_CEILING = 0.3;

/**
 * Map a raw memory_hybrid_search (RRF) score onto 0..1 across the observed band.
 *
 *   score <= RRF_FLOOR    → 0
 *   score >= RRF_CEILING  → 1   (saturates — robust to the occasional true
 *                                0..1 cosine a future keyword-weight change
 *                                might surface; anything "clearly relevant"
 *                                simply pins at 1.0)
 *   in between            → linear
 *
 * Non-finite input (NaN / Infinity) is treated as 0.
 */
export function normalizeSimilarity(rrfScore: number): number {
  if (!Number.isFinite(rrfScore)) return 0;
  const t = (rrfScore - RRF_FLOOR) / (RRF_CEILING - RRF_FLOOR);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

/**
 * Map a raw Rumen confidence score onto a normalized 0..1 value that is
 * comparable across runs and context sizes.
 *
 * Curve (calibration can iterate; bump NORMALIZE_VERSION when this changes):
 *   contextSize <= 1   →  raw * 0.4   (single-source, low ceiling)
 *   contextSize <  5   →  raw * 0.7   (small cluster)
 *   contextSize < 15   →  raw * 0.9   (medium cluster)
 *   contextSize >= 15  →  raw         (large cluster — full range)
 *
 * Out-of-range and non-finite raw scores are clamped: NaN/Infinity → 0,
 * raw > 1 → 1, raw < 0 → 0.
 */
export function normalize(rawScore: number, contextSize: number): number {
  if (!Number.isFinite(rawScore)) return 0;
  const clamped = Math.max(0, Math.min(1, rawScore));
  if (contextSize <= 1) return clamped * 0.4;
  if (contextSize < 5) return clamped * 0.7;
  if (contextSize < 15) return clamped * 0.9;
  return clamped;
}

/**
 * Bump when the confidence calibration changes — the RRF band, the composite
 * weights in computeConfidence, or the normalize curve. Written into insight
 * metadata so downstream consumers can distinguish calibration generations.
 *
 *   v1 — 0.5*maxSim + 0.3*crossProject + 0.2*ageSpread (maxSim read as 0..1).
 *   v2 — RRF-band-normalized similarity (0.55) + crossProject (0.30) +
 *        ageSpread (0.15), scaled by a near-duplicate novelty factor.
 */
export const NORMALIZE_VERSION = 2;
