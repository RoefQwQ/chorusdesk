import type { Channel, Platform } from '../types';
import type { FetchResult } from '../adapters/types';

/**
 * The end-of-history policy, in one place.
 *
 * A channel's `nextCursor` doubles as a completeness marker: `END_OF_HISTORY_CURSOR`
 * means "a dig reached the bottom". That marker is the most dangerous thing this
 * codebase writes, because the two ways of being wrong are not symmetric:
 *
 *   - claiming complete when works remain writes the sentinel, and the user can
 *     never dig those works again — unrecoverable without editing the database;
 *   - leaving a dig resumable when it was already complete costs one needless
 *     re-scroll, and loses nothing.
 *
 * So the sentinel is only ever *trusted* when the platform itself stated it. A
 * platform that has no pagination cursor cannot state it, and anything recorded
 * for such a platform is a guess made by an older build. Those guesses are
 * recovered rather than honoured — `fetchChannelHistory` and `deepSyncChannel`'s
 * loop head used to carry that test, and the same comment, separately; a fix in
 * one left the other short-circuiting first, so the recovery was unreachable
 * (regression test: `tests/douyin.loophead.test.ts`).
 */

/**
 * The value stored in `Channel.nextCursor` once a dig has reached the end.
 *
 * Named rather than inlined because it is written in one module and compared in
 * another; a typo in either used to be a silent "never matches".
 */
export const END_OF_HISTORY_CURSOR = '__END__';

/** Shown when a dig refuses to continue because the platform stated the end. */
export const END_OF_HISTORY_MESSAGE = '已到达该账号历史作品最底部，暂无更多更早内容。';

/**
 * Platforms that acquire a creator's works as a single page snapshot instead of
 * walking a pagination cursor.
 *
 * Douyin is the only one: its adapter scrapes a rendered grid, so there is no
 * cursor for the platform to hand back and therefore no way for it to state
 * "this is the end". Everything else (bilibili, twitter, weibo, …) receives a
 * real cursor or `hasMore: false` from the API, which is a platform-stated fact.
 *
 * Adding a platform here is a correctness decision, not a tuning knob: it means
 * "never trust a recorded end for this platform".
 */
const SINGLE_SHOT_ACQUISITION: readonly Platform[] = ['douyin'];

/** True for the sentinel value. */
export function isEndOfHistoryCursor(cursor: unknown): boolean {
  return cursor === END_OF_HISTORY_CURSOR;
}

/** True when this platform's end-of-history marker is platform-stated (trustworthy). */
export function terminalCursorIsStated(platform: Platform): boolean {
  return !SINGLE_SHOT_ACQUISITION.includes(platform);
}

/**
 * A channel parked at the sentinel whose platform never stated it.
 *
 * Both the history entry point and the dig loop ask this, and both must act on
 * it the same way: clear the marker and let the dig run. A genuine end is
 * re-recorded on that very round if the platform says so again, so this cannot
 * loop.
 */
export function hasStaleTerminalCursor(channel: Pick<Channel, 'platform' | 'nextCursor'>): boolean {
  return isEndOfHistoryCursor(channel.nextCursor) && !terminalCursorIsStated(channel.platform);
}

/**
 * True when a fetch result is itself the platform stating the end.
 *
 * Used on the error path: a `not_found` is the platform saying "nothing here",
 * which is as final as an explicit `hasMore: false`.
 */
export function statesEndOfHistory(result: Pick<FetchResult, 'hasMore' | 'error'>): boolean {
  return result.hasMore === false || result.error?.code === 'not_found';
}

/**
 * True when a *successful* history page should be recorded as the permanent end.
 *
 * Requires no cursor in the response: a page that still carries one has not
 * finished, whatever `hasMore` claims.
 */
export function shouldRecordHistoryEnd(result: Pick<FetchResult, 'hasMore' | 'nextCursor'>): boolean {
  return !result.nextCursor && result.hasMore === false;
}
