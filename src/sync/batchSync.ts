import type { Channel } from '../types';
import type { FetchOptions, FetchResult } from '../adapters/types';
import { fetchError } from '../adapters/types';
import { db } from '../infrastructure/db/database';
import { updateChannel } from './channelSync';
import {
  clearRateLimit,
  formatCooldown,
  noteRateLimit,
  platformMinInterval,
  readCooldowns,
  remainingCooldown,
} from './rateLimit';
import { errorMessage } from '../utils/errorMessage';

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
  const overrideInterval = options?.minPlatformIntervalMs;
  // Read the cool-downs once for the whole batch: it is a tight loop and a
  // per-channel read would query IndexedDB on every iteration.
  const cooldowns = await readCooldowns();

  /**
   * When the previous request on this platform *finished*.
   *
   * Deliberately not when it started: the interval is meant to be a gap between
   * requests, and a platform whose request takes longer than the interval
   * consumed its own spacing, so the next one followed with no delay at all.
   * That is what let three Douyin page loads fire back to back.
   */
  const platformLastFinished: Record<string, number> = {};

  let successful = 0;
  let newPostsCount = 0;

  for (let i = 0; i < interleaved.length; i++) {
    if (options?.shouldStop?.()) break;

    const ch = interleaved[i];

    // Cool-down first: a platform that just pushed back must not be contacted at
    // all, however much spacing has accumulated.
    const cooling = remainingCooldown(cooldowns, ch.platform);
    if (cooling > 0) {
      options?.onProgress?.(i + 1, total, ch, {
        posts: [],
        error: fetchError(
          'rate_limit',
          `${ch.platform} 已触发平台风控，冷却中（剩余约 ${formatCooldown(cooling)}）。期间不再请求该平台，冷却结束后自动恢复。`,
        ),
      });
      continue;
    }

    // Space requests from the *end* of the previous one on this platform.
    //
    // `Math.max`, not `??`: callers pass the user's configured delay as an
    // override, and using it directly would let a setting of 800ms lower Douyin's
    // floor — defeating the per-platform value exactly where it matters most. The
    // platform floor is a minimum, so a caller can only raise it.
    const gap = Math.max(overrideInterval ?? 0, platformMinInterval(ch.platform));
    const elapsed = Date.now() - (platformLastFinished[ch.platform] || 0);
    if (elapsed < gap) {
      await new Promise((r) => setTimeout(r, gap - elapsed));
    }

    try {
      const res = await updateChannel(ch, limit, true, options);

      // A clean request clears the cool-down for that platform; a rate-limit
      // signal starts or escalates one.
      if (res.error?.code === 'rate_limit') {
        const entry = await noteRateLimit(ch.platform);
        cooldowns[ch.platform] = entry;
      } else if (!res.error) {
        delete cooldowns[ch.platform];
        await clearRateLimit(ch.platform);
      }

      if (!res.error || (res.posts && res.posts.length > 0)) {
        successful++;
        newPostsCount += res.posts?.length || 0;
      }
      options?.onProgress?.(i + 1, total, ch, res);
    } catch (e: unknown) {
      console.warn(`[BatchUpdate] Error on ${ch.id}:`, e);
      options?.onProgress?.(i + 1, total, ch, {
        posts: [],
        error: fetchError('network', errorMessage(e)),
      });
    } finally {
      // Recorded on every path, including failure: a failed request still hit the
      // platform, and the spacing that follows must account for it.
      platformLastFinished[ch.platform] = Date.now();
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
  const cooldowns = await readCooldowns();
  const platformLastFinished: Record<string, number> = {};

  for (const ch of interleaved) {
    // Same two guards as the batch path: a cool-down is absolute, and the
    // spacing floor is measured from the end of the previous request. This
    // per-creator path hits the same platforms and was pacing them at a fixed
    // 600ms — below the floor for every platform, Douyin most of all.
    const cooling = remainingCooldown(cooldowns, ch.platform);
    if (cooling > 0) {
      results.push({
        posts: [],
        error: fetchError(
          'rate_limit',
          `${ch.platform} 已触发平台风控，冷却中（剩余约 ${formatCooldown(cooling)}）。期间不再请求该平台。`,
        ),
      });
      continue;
    }

    const gap = platformMinInterval(ch.platform);
    const elapsed = Date.now() - (platformLastFinished[ch.platform] || 0);
    if (elapsed < gap) {
      await new Promise((r) => setTimeout(r, gap - elapsed));
    }

    try {
      const res = await updateChannel(ch, limit, true, options);
      if (res.error?.code === 'rate_limit') {
        cooldowns[ch.platform] = await noteRateLimit(ch.platform);
      } else if (!res.error) {
        delete cooldowns[ch.platform];
        await clearRateLimit(ch.platform);
      }
      results.push(res);
    } finally {
      platformLastFinished[ch.platform] = Date.now();
    }
  }
  return results;
}
