import type { Channel } from '../types';
import type { FetchOptions, FetchResult } from '../adapters/types';
import { fetchError } from '../adapters/types';
import { db } from '../infrastructure/db/database';
import { updateChannel } from './channelSync';

/**
 * Groups channels by platform and interleaves them round-robin across platforms.
 * Example: [B1, B2, B3, T1, T2, Y1] -> [B1, T1, Y1, B2, T2, B3]
 * Ensures consecutive requests rarely hit the same domain, maximizing natural cooldown.
 */
export function interleaveChannelsByPlatform(channels: Channel[]): Channel[] {
  const buckets: Record<string, Channel[]> = {};
  for (const ch of channels) {
    if (!buckets[ch.platform]) {
      buckets[ch.platform] = [];
    }
    buckets[ch.platform].push(ch);
  }

  const platforms = Object.keys(buckets);
  const result: Channel[] = [];
  let round = 0;
  let hasMore = true;

  while (hasMore) {
    hasMore = false;
    for (const p of platforms) {
      const list = buckets[p];
      if (round < list.length) {
        result.push(list[round]);
        if (round + 1 < list.length) {
          hasMore = true;
        }
      }
    }
    round++;
  }

  return result;
}

/**
 * Executes interleaved round-robin multi-round synchronization for a list of channels.
 * Tracks per-platform last request timestamp to guarantee a minimum pacing delay
 * on the SAME platform while letting different platforms progress without artificial stall.
 */
export async function batchUpdateChannelsInterleaved(
  channelList: Channel[],
  limit: number = 10,
  options?: FetchOptions & {
    minPlatformIntervalMs?: number;
    onProgress?: (current: number, total: number, channel: Channel, result: FetchResult) => void;
    shouldStop?: () => boolean;
  }
): Promise<{ totalChannels: number; successful: number; newPostsCount: number }> {
  const total = channelList.length;
  if (total === 0) return { totalChannels: 0, successful: 0, newPostsCount: 0 };

  const interleaved = interleaveChannelsByPlatform(channelList);
  const minInterval = options?.minPlatformIntervalMs ?? 800;
  const platformLastCall: Record<string, number> = {};

  let successful = 0;
  let newPostsCount = 0;

  for (let i = 0; i < interleaved.length; i++) {
    if (options?.shouldStop?.()) break;

    const ch = interleaved[i];
    const now = Date.now();
    const lastTime = platformLastCall[ch.platform] || 0;
    const elapsed = now - lastTime;

    // If same platform was hit recently, wait until the safe cooldown has passed
    if (elapsed < minInterval) {
      await new Promise((r) => setTimeout(r, minInterval - elapsed));
    }

    platformLastCall[ch.platform] = Date.now();

    try {
      const res = await updateChannel(ch, limit, true, options);
      if (!res.error || (res.posts && res.posts.length > 0)) {
        successful++;
        newPostsCount += res.posts?.length || 0;
      }
      options?.onProgress?.(i + 1, total, ch, res);
    } catch (e: unknown) {
      console.warn(`[BatchUpdate] Error on ${ch.id}:`, e);
      options?.onProgress?.(i + 1, total, ch, {
        posts: [],
        error: fetchError('network', e instanceof Error ? e.message : String(e), true),
      });
    }
  }

  return { totalChannels: total, successful, newPostsCount };
}

/**
 * Updates all channels belonging to a specific Creator using round-robin platform pacing
 */
export async function updateCreator(
  creatorId: string,
  limit: number = 10,
  options?: FetchOptions
): Promise<FetchResult[]> {
  const channels = await db.channels.where('creatorId').equals(creatorId).toArray();
  const results: FetchResult[] = [];
  const interleaved = interleaveChannelsByPlatform(channels);
  for (const ch of interleaved) {
    const res = await updateChannel(ch, limit, true, options);
    results.push(res);
    await new Promise((r) => setTimeout(r, 600));
  }
  return results;
}
