/**
 * Confidence calibration primitives for Rumen synthesis.
 *
 * Two orthogonal concerns live here:
 *
 *   1. normalizeSimilarity — maps a raw memory_hybrid_search score onto 0..1.
 *      Mnestra's hybrid search returns Reciprocal-Rank-Fusion (RRF) scores with
 *      recency decay that land in a NARROW, STRONGLY RIGHT-SKEWED band nowhere
 *      near the 0..1 range a cosine similarity would occupy (see src/index.ts
 *      DEFAULT_MIN_SIMILARITY and src/relate.ts). If computeConfidence treats
 *      that raw score as if it were 0..1, the similarity term contributes ~0.02
 *      while a single flat cross-project bonus adds 0.30 — a ~13:1 domination
 *      that drowns the actual relevance signal. Mapping the band onto 0..1
 *      FIRST is the fix.
 *
 *   2. normalize — maps a composite confidence onto a cluster-size-aware ceiling.
 *      A small relate-cluster (few citations) caps at lower confidence even with
 *      a high raw score, because we have less evidence. A large cluster can reach
 *      the full range. Below a minimum context size we clamp aggressively.
 */

/**
 * RRF band bounds — DERIVED, then confirmed against live telemetry.
 *
 * Derivation. memory_hybrid_search fuses two branches with Reciprocal Rank
 * Fusion, each contributing `1/(rrf_k + rank)` with `rrf_k = 60`. The best
 * possible row is rank 1 in BOTH branches:
 *
 *     2 / (60 + 1)                     = 0.03278688…   (base ceiling)
 *
 * On top of that the function applies at most a 1.5x source-type multiplier and
 * a 1.5x project multiplier:
 *
 *     2/(60 + 1) x 1.5 x 1.5           = 0.07377049…   (deployed ceiling)
 *
 * Confirmation (Sprint 82, read-only pass over public.memory_recall_log on the
 * daily-driver store, n = 39,048 after excluding the `graph` surface — which
 * logs on a different scale — and 71 migration smoke-test rows):
 *
 *     observed max  0.0737700719567695
 *     analytic max  0.0737704918032787
 *
 * The deployed maximum IS the analytic ceiling, to 7 significant figures. The
 * previous value of 0.3 was a guess, and it was ~4x too high: it compressed
 * every real score into the bottom fifth of the output range, so the Sprint 81
 * recalibration of the composite weights was numerically inert.
 *
 * RRF_BAND_MIN is the smallest score ever observed on a RETURNED row. It is a
 * function of candidate-pool depth (a rank-N single-branch hit scores
 * 1/(60+N)), so it is empirical rather than analytic.
 *
 * Bump NORMALIZE_VERSION when these change.
 */
export const RRF_BAND_MIN = 0.00308726;
export const RRF_BAND_MAX = 0.0737704918032787;

/**
 * Deprecated aliases for the two bounds above. Kept so that any consumer
 * pinning the old names keeps compiling; prefer RRF_BAND_MIN / RRF_BAND_MAX,
 * which say what the numbers actually are (the observed floor and the derived
 * ceiling of the deployed RRF band) rather than implying a tunable clamp.
 *
 * @deprecated use RRF_BAND_MIN
 */
export const RRF_FLOOR = RRF_BAND_MIN;
/** @deprecated use RRF_BAND_MAX */
export const RRF_CEILING = RRF_BAND_MAX;

/**
 * Empirical quantile knots of the deployed RRF score distribution: pairs of
 * [score, quantile] in ascending score order.
 *
 * PINNED SNAPSHOT — these are frozen measurements, not live values:
 *
 *   taken     2026-07-30 20:11 ET
 *   source    public.memory_recall_log, full 90-day retention window
 *   n         39,048  (after excluding the `graph` surface, which logs on a
 *                     different scale, and 71 migration smoke-test rows —
 *                     see the RRF_BAND_MAX note)
 *   query     the percentile_cont statement in "Refresh" below, verbatim
 *
 * DRIFT IS REAL AND IS EXPECTED. This table is a snapshot of a live, growing
 * distribution. An independent re-run one minute later (Sprint 82 T4, 20:12 ET)
 * measured n = 39,065 and p99 = 0.0502400456310754 against the 0.04917757
 * pinned here — a ~2% relative move in the p99 knot from 17 new rows.
 *
 * That is the honest characterisation of these constants: the BODY of the
 * distribution (p10-p90) is estimated from thousands of rows each and is
 * stable; the TAIL knots (p95, p99) sit where few rows do and are the least
 * stable. The practical effect is small — re-interpolating a score of 0.045
 * under T4's p99 instead of this one moves the normalized output by 0.002 —
 * so pinning a snapshot is safe. What would NOT be safe is treating these as
 * live values, or refreshing them without bumping NORMALIZE_VERSION, because
 * then two insights scored weeks apart would silently use different maps.
 *
 * Canonical snapshot record, shared with engram's identical knot table:
 * `engram/docs/calibration-report-2026-07-30.md` § Quantile snapshot.
 *
 * WHY THESE EXIST. RRF is an ORDINAL statistic, not a cardinal one: the gap
 * between the 1st and 2nd result carries no fixed amount of "relevance," and
 * the distribution is heavily massed at the bottom with a long thin tail. A
 * LINEAR map of that band onto 0..1 therefore sends a perfectly typical hit to
 * ~0.18 — still near-floor, still dominated by the flat cross-project bonus.
 * (There is no non-negative floor that fixes this: solving for one that sends
 * the live median to 0.5 under a linear map yields a floor of -0.032.)
 *
 * The one honest cardinalization of an ordinal score is its POSITION IN THE
 * OBSERVED DISTRIBUTION. Interpolating these knots yields exactly that: the
 * output is "this hit scored better than X of all logged recall hits."
 *
 * Refresh procedure when the corpus or the scoring function changes materially
 * (and bump NORMALIZE_VERSION when you do):
 *
 *   select q, percentile_cont(q) within group (order by score)
 *     from public.memory_recall_log,
 *          unnest(array[0,0.05,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.95,0.99,1.0]) as q
 *    where score is not null and score < 0.4 and surface <> 'graph'
 *    group by q order by q;
 */
export const RRF_QUANTILE_KNOTS: ReadonlyArray<readonly [number, number]> = [
  [0.00308726, 0.0],
  [0.00942629, 0.05],
  [0.0109489, 0.1],
  [0.01420284, 0.2],
  [0.01695351, 0.3],
  [0.01936442, 0.4],
  [0.02188507, 0.5],
  [0.024213, 0.6],
  [0.02671364, 0.7],
  [0.02951747, 0.8],
  [0.03268172, 0.9],
  [0.03486153, 0.95],
  [0.04917757, 0.99],
  [0.07377007, 1.0],
];

/**
 * Map a raw memory_hybrid_search (RRF) score onto 0..1 by its position in the
 * observed score distribution (piecewise-linear interpolation of
 * RRF_QUANTILE_KNOTS).
 *
 * The returned value is a BAND PERCENTILE, not a probability that the memory is
 * useful — nothing in this file has ever seen an outcome label. Read it as
 * "stronger than this fraction of logged recall hits."
 *
 *   score <= RRF_BAND_MIN  → 0
 *   score >= RRF_BAND_MAX  → 1   (saturates — robust to the occasional true
 *                                 0..1 cosine a future keyword-weight change
 *                                 might surface; anything "clearly relevant"
 *                                 simply pins at 1.0)
 *   in between             → interpolated between the bracketing knots
 *
 * Monotonic non-decreasing in the raw score by construction (the knots are
 * ascending in both coordinates). Non-finite input (NaN / Infinity) → 0.
 */
export function normalizeSimilarity(rrfScore: number): number {
  if (!Number.isFinite(rrfScore)) return 0;

  // Linear scan: 14 knots, called once per synthesized signal — a binary
  // search would be noise against the surrounding LLM calls. Carrying the
  // previous knot in locals (rather than indexing i-1) keeps this clean under
  // noUncheckedIndexedAccess.
  let loScore: number | undefined;
  let loQ = 0;
  for (const [hiScore, hiQ] of RRF_QUANTILE_KNOTS) {
    if (rrfScore <= hiScore) {
      // At or below the first knot — nothing to interpolate against.
      if (loScore === undefined) return 0;
      const span = hiScore - loScore;
      // Degenerate (duplicate) knot: fall back to the lower quantile rather
      // than dividing by zero.
      if (span <= 0) return loQ;
      return loQ + ((rrfScore - loScore) / span) * (hiQ - loQ);
    }
    loScore = hiScore;
    loQ = hiQ;
  }
  // Above the last knot.
  return 1;
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
 *        ageSpread (0.15), scaled by a near-duplicate novelty factor. Band
 *        assumed [0.01, 0.3]; the ceiling was ~4x the deployed one, so the
 *        similarity term saturated at ~0.22 and stayed dominated.
 *   v3 — band bounds corrected to the DERIVED deployed values and the linear
 *        map replaced by empirical-quantile interpolation (Sprint 82). A
 *        median-strength hit now normalizes to ~0.5 instead of ~0.04, which is
 *        what v2's weight rebalance was trying to achieve and could not.
 */
export const NORMALIZE_VERSION = 3;
