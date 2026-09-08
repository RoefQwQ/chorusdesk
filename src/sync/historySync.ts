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
    return {
      posts: [],
      error: fetchError('not_found', '已到达该账号历史作品最底部，暂无更多更早内容。'),
      hasMore: false,
    };
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
