import { devLog } from './devLog';

/**
 * Burst-aggregated logging for the per-card image-cache probe.
 *
 * The probe used to log one line per card. Measured on a real session, that made
 * the developer log unusable: **102 of 150 lines (68%) were `磁盘探测`**, in two
 * bursts of 72 and 26 as the feed was scrolled, around 11 lines that actually
 * said what happened. The log is the thing the user reads and pastes when
 * reporting a problem, so noise is not cosmetic — it is the reason a useful
 * window is hard to find.
 *
 * Cards probe in bursts (a feed render or a scroll brings many into the
 * observer's margin at once), so summing over a short quiet period keeps every
 * fact the per-card line carried — how many cards, how many of their images were
 * cached, and the worst case — in one line instead of a hundred.
 *
 * Deliberately not a sampled/rate-limited log: dropping lines would hide the one
 * slow card that matters. Nothing is dropped, it is only summed.
 */

/** Quiet period after the last probe before the summary is emitted. */
const FLUSH_DELAY_MS = 1_000;

/**
 * A card slower than this means the session caches in `fsManager` are not doing
 * their job, and the summary is raised to `warn` so it stands out.
 */
const SLOW_CARD_MS = 1_500;

interface PendingBatch {
  cards: number;
  items: number;
  hits: number;
  slowCards: number;
  slowestMs: number;
  /** Platform of the slowest card, for triage when something is wrong. */
  slowestPlatform: string;
}

function emptyBatch(): PendingBatch {
  return { cards: 0, items: 0, hits: 0, slowCards: 0, slowestMs: 0, slowestPlatform: '' };
}

let pending = emptyBatch();
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Emit the accumulated summary, if any, and start a fresh batch.
 *
 * Safe to call with nothing pending. Exported for tests and for callers that
 * want the line immediately rather than after the quiet period.
 */
export function flushMediaProbeLog(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = pending;
  pending = emptyBatch();
  if (batch.cards === 0) return;

  const summary = `磁盘探测 ${batch.cards} 张卡片（命中 ${batch.hits}/${batch.items}）`;
  if (batch.slowCards > 0) {
    // One line, raised severity: a slow cache is a real problem, but reporting it
    // once per card is how the original warning became part of the noise.
    devLog.warn(
      'media',
      `${summary}，其中 ${batch.slowCards} 张超过 ${SLOW_CARD_MS}ms，最慢 ${batch.slowestMs}ms`,
      batch.slowestPlatform ? `平台 ${batch.slowestPlatform}` : undefined,
    );
    return;
  }
  devLog.debug('media', `${summary}，最慢 ${batch.slowestMs}ms`);
}

/**
 * Record one card's probe. The summary is emitted once probing goes quiet.
 *
 * `items` is the number of media entries probed for that card and `hits` how
 * many were found on disk.
 */
export function recordMediaProbe(items: number, hits: number, elapsedMs: number, platform = ''): void {
  pending.cards += 1;
  pending.items += items;
  pending.hits += hits;
  if (elapsedMs > SLOW_CARD_MS) pending.slowCards += 1;
  if (elapsedMs > pending.slowestMs) {
    pending.slowestMs = elapsedMs;
    pending.slowestPlatform = platform;
  }

  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flushMediaProbeLog();
  }, FLUSH_DELAY_MS);
}

/** Drop anything pending without logging. For tests. */
export function resetMediaProbeLog(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending = emptyBatch();
}
