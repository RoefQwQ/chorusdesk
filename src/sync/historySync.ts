import type { Channel } from '../types';
import type { FetchError, FetchResult } from '../adapters/types';
import { fetchError } from '../adapters/types';
import { db } from '../infrastructure/db/database';
import { updateChannel } from './channelSync';

/**
 * Fetches older historical posts for a channel using its saved pagination cursor
 */
export async function fetchChannelHistory(
  channel: Channel,
  limit: number = 10,
  onlyOriginal: boolean = false
): Promise<FetchResult> {
  if (channel.nextCursor === '__END__') {
    // Page-driven platforms (Douyin) have no real pagination cursor — their
    // "__END__" is a completeness GUESS recorded by an earlier dig, not a fact
    // the platform itself stated. When the guess was wrong (grid was actually
    // login-truncated), it permanently blocked works the page can serve today.
    // The fix commit (ea6e539) stopped recording new wrong guesses; this path
    // recovers channels already parked there: clear the stale marker and let
    // the dig run. A genuine end gets re-recorded on this very round if the
    // page truly has nothing more (adapter returns hasMore:false again), so
    // the loop still terminates.
    if (channel.platform === 'douyin') {
      await db.channels.update(channel.id, { nextCursor: undefined });
      channel = { ...channel, nextCursor: undefined };
    } else {
      return {
        posts: [],
        error: fetchError('not_found', '已到达该账号历史作品最底部，暂无更多更早内容。'),
        hasMore: false,
      };
    }
  }

  return await updateChannel(channel, limit, true, {
    cursor: channel.nextCursor,
    isHistory: true,
    onlyOriginal,
  });
}

export interface DeepSyncOptions {
  maxPosts?: number; // 0: unconstrained / dig to the end
  untilTimestamp?: number; // 0: no date limit
  onlyOriginal?: boolean;
  forceResetCursor?: boolean;
  onProgress?: (info: {
    channelId: string;
    displayName: string;
    platform: string;
    round: number;
    fetchedThisRound: number;
    totalNewPosts: number;
    reachEnd: boolean;
    status: 'fetching' | 'done' | 'error';
    error?: FetchError;
  }) => void;
  shouldStop?: () => boolean;
}

/**
 * Iteratively deep-syncs past history for a channel until target count/date or the end is reached
 */
export async function deepSyncChannel(
  channel: Channel,
  options: DeepSyncOptions = {}
): Promise<{ totalNew: number; reachEnd: boolean; rounds: number; error?: FetchError }> {
  let totalNew = 0;
  let rounds = 0;
  let consecutiveEmptyRounds = 0;
  const maxPosts = options.maxPosts || 0;
  const untilTimestamp = options.untilTimestamp || 0;

  if (options.forceResetCursor) {
    await db.channels.update(channel.id, { nextCursor: undefined });
  }

  while (true) {
    if (options.shouldStop?.()) {
      options.onProgress?.({
        channelId: channel.id,
        displayName: channel.displayName || channel.accountId,
        platform: channel.platform,
        round: rounds,
        fetchedThisRound: 0,
        totalNewPosts: totalNew,
        reachEnd: false,
        status: 'done',
      });
      break;
    }

    const currentCh = await db.channels.get(channel.id);
    if (!currentCh || currentCh.nextCursor === '__END__') {
      options.onProgress?.({
        channelId: channel.id,
        displayName: channel.displayName || channel.accountId,
        platform: channel.platform,
        round: rounds,
        fetchedThisRound: 0,
        totalNewPosts: totalNew,
        reachEnd: true,
        status: 'done',
      });
      return { totalNew, reachEnd: true, rounds };
    }

    rounds++;
    options.onProgress?.({
      channelId: channel.id,
      displayName: channel.displayName || channel.accountId,
      platform: channel.platform,
      round: rounds,
      fetchedThisRound: 0,
      totalNewPosts: totalNew,
      reachEnd: false,
      status: 'fetching',
    });

    const res = await fetchChannelHistory(currentCh, 20, options.onlyOriginal);
    const newCount = res.posts?.length || 0;
    const rawFetched = res.totalFetched ?? newCount;
    totalNew += newCount;

    if (newCount === 0) {
      consecutiveEmptyRounds++;
    } else {
      consecutiveEmptyRounds = 0;
    }

    // Finished only on an explicit end-of-history signal. An empty round with
    // no error used to count as "finished" here, silently ending the dig even
    // when the adapter simply had nothing new for this page.
    const isFinished = res.hasMore === false;

    options.onProgress?.({
      channelId: channel.id,
      displayName: channel.displayName || channel.accountId,
      platform: channel.platform,
      round: rounds,
      fetchedThisRound: newCount,
      totalNewPosts: totalNew,
      reachEnd: isFinished,
      status: res.error ? 'error' : 'fetching',
      error: res.error,
    });

    if (res.error || isFinished || consecutiveEmptyRounds >= 4) {
      break;
    }

    // A page-driven dig (Douyin) returns its whole scrolled grid in ONE round
    // and has no pagination cursor: every additional round re-fetches the same
    // window and can never produce anything new. Without this, a login-gated
    // grid burned three more no-op rounds before the empty-round counter ended
    // the loop, reporting "0 条更早作品" with no explanation. Real paginated
    // platforms (bilibili/twitter) always carry a cursor or hasMore:false, so
    // this is scoped to the single-shot acquisition model.
    if (currentCh.platform === 'douyin' && !res.nextCursor && rawFetched > 0) {
      break;
    }

    // Check if reached untilTimestamp
    if (untilTimestamp > 0 && res.posts && res.posts.length > 0) {
      const oldestInBatch = Math.min(...res.posts.map((p) => p.publishedAt || Date.now()));
      if (oldestInBatch <= untilTimestamp) {
        break;
      }
    }

    // Check if reached maxPosts
    if (maxPosts > 0 && totalNew >= maxPosts) {
      break;
    }

    // Safe paced delay between pagination calls (at least 900ms)
    await new Promise((r) => setTimeout(r, 900));
  }

  return { totalNew, reachEnd: false, rounds };
}
