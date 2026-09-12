/**
 * Timestamp normalization.
 *
 * `Post.publishedAt` is documented as Epoch **milliseconds** (`types/index.ts`),
 * but several adapters emit seconds for some platforms, so four call sites grew
 * their own `timestamp < 1e12 ? timestamp * 1000 : timestamp` guess and the
 * contract became "ms, maybe seconds" (audit P2-4). A heuristic repeated at the
 * point of display is a contract that does not exist: each new consumer has to
 * remember it, and each new adapter can break it without anything failing.
 *
 * This module holds the one implementation. Values at or above the threshold are
 * assumed to be ms; below it, seconds. The threshold is `1e12` — a millisecond
 * timestamp for 2001-09-09, so every plausible *second* timestamp (which stays
 * under 1e11 until the year 5138) falls below it and every real millisecond one
 * is well above.
 */

/** A second-resolution timestamp is < 1e12 ms (i.e. before 2001-09-09 in ms terms). */
const MS_THRESHOLD = 1e12;

/**
 * Convert a seconds-or-milliseconds timestamp to Epoch milliseconds.
 *
 * Returns `null` for a missing or non-finite value rather than `NaN`: callers
 * render "未知时间" for an absent date, and a `NaN` Date silently renders
 * "Invalid Date". Use `EpochMs` at boundaries that require a number.
 */
export function toEpochMs(timestamp: number | undefined | null): number | null {
  if (timestamp === undefined || timestamp === null) return null;
  if (!Number.isFinite(timestamp)) return null;
  // Negative/zero is not a real publish time; treat as absent rather than
  // fabricating 1970, which reads as a plausible-but-wrong date.
  if (timestamp <= 0) return null;
  return timestamp < MS_THRESHOLD ? Math.round(timestamp * 1000) : timestamp;
}

/**
 * `toEpochMs` with a caller-supplied fallback for the absent case — the shape
 * most display code wants (`formatX(post.publishedAt, Date.now())`).
 */
export function toEpochMsOr(timestamp: number | undefined | null, fallback: number): number {
  return toEpochMs(timestamp) ?? fallback;
}
