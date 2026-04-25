/**
 * Map a raw Rumen confidence score onto a normalized 0..1 value that is
 * comparable across runs and context sizes.
 *
 * The intuition: a small relate-cluster (few citations) caps at lower
 * confidence even with a high raw score, because we have less evidence.
 * A large cluster can reach the full range. Below a minimum context
 * size we treat the score as untrustworthy and clamp aggressively.
 *
 * Curve (first-pass values — calibration can iterate; bump
 * NORMALIZE_VERSION when this changes):
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

/** Bump when the normalize curve changes; written into insight metadata. */
export const NORMALIZE_VERSION = 1;
