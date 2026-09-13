import type { Channel, Platform } from '../types';
import type { FetchResult } from '../adapters/types';
import { hasPlatformStatedEnd } from '../adapters/types';
import { getAdapter } from '../platform/registry';

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

/** True for the sentinel value. */
export function isEndOfHistoryCursor(cursor: unknown): boolean {
  return cursor === END_OF_HISTORY_CURSOR;
}

/**
 * True when this platform's end-of-history marker is platform-stated (trustworthy).
 *
 * The fact is DECLARED BY THE ADAPTER (`PlatformAdapter.paginates`), not held here.
 * It was held here before, in a `SINGLE_SHOT_ACQUISITION` array listing douyin
 * alone — which meant the array and the adapters were two sources of truth for
 * one fact (rule 35), and they had already diverged: `youtube` and `rss` return
 * neither `nextCursor` nor `hasMore`, i.e. they cannot state an end either, yet
 * they were absent from the array and so their recorded `__END__` was trusted.
 *
 * An unknown platform has no adapter and therefore no declaration; it answers
 * `true`, keeping the old behaviour for records written by an older build (a
 * platform later removed from the registry). That is the safe direction here:
 * `false` would make every such channel's dig clear its marker and re-run.
 */
export function terminalCursorIsStated(platform: Platform): boolean {
  return hasPlatformStatedEnd(getAdapter(platform));
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
