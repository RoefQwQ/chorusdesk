import type { Channel, MediaItem, Post } from '../types';
import type { FetchOptions, FetchResult, PlatformAdapter } from './types';
import { fetchError } from './types';
import { buildPost } from './buildPost';
import { IS_SERVICE_WORKER } from '../utils/runtime';
import type { DouyinItem, DouyinSnapshot } from './douyin/contract';
import { normalizeSnapshot } from './douyin/contract';

/**
 * Douyin adapter — public creator works (short video + image gallery) only.
 *
 * Acquisition is page-driven: a background fetch of a creator page yields an
 * anti-bot JS shell with no post data (see `douyin/contract.ts` for the spike
 * findings), so the snapshot comes from a real douyin.com tab through the
 * FETCH_DOUYIN_SNAPSHOT message. This adapter never talks to douyin.com itself;
 * it validates the snapshot and maps it onto Post.
 *
 * Out of scope for V1 (deliberately, not accidentally): live rooms, comments,
 * follower stats, recommendation/search feeds, video downloads, and any storage
 * of Douyin credentials.
 */

/** Response shape of the FETCH_DOUYIN_SNAPSHOT message. */
interface SnapshotResponse {
  success?: boolean;
  snapshot?: unknown;
  error?: string;
  code?: 'auth' | 'network' | 'parse' | 'unsupported' | 'rate_limit';
}

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',

  async fetchLatest(channel: Channel, limit: number = 20, options?: FetchOptions): Promise<FetchResult> {
    const secUid = channel.accountId.trim();
    if (!secUid) {
      return { posts: [], error: fetchError('unsupported', '抖音频道缺少创作者标识 (sec_uid)') };
    }

    // The snapshot arrives through the background message router, which is not
    // reachable from inside the service worker itself (AGENTS rule 6). Auto-sync
    // therefore reports plainly instead of pretending it synced nothing.
    if (IS_SERVICE_WORKER) {
      return {
        posts: [],
        error: fetchError(
          'unsupported',
          '抖音需要在打开的抖音页面中采集，后台自动同步无法执行。请在仪表盘手动同步。',
        ),
      };
    }

    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      return { posts: [], error: fetchError('unsupported', '当前环境不支持抖音页面采集') };
    }

    let response: SnapshotResponse;
    try {
      response = await new Promise<SnapshotResponse>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_DOUYIN_SNAPSHOT', secUid, limit },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ success: false, code: 'network', error: chrome.runtime.lastError.message });
            } else {
              resolve((res as SnapshotResponse) || { success: false });
            }
          },
        );
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { posts: [], error: fetchError('network', `抖音采集通信异常: ${message}`, true) };
    }

    if (!response?.success) {
      const code = response?.code ?? 'network';
      const message = response?.error || '抖音作品采集失败';
      return {
        posts: [],
        error: fetchError(code, message, code === 'network' || code === 'rate_limit'),
      };
    }

    // Everything from the page is untrusted until it clears the normalizer.
    const snapshot = normalizeSnapshot(response.snapshot);
    if (!snapshot) {
      return {
        posts: [],
        error: fetchError('parse', '抖音页面数据结构无法解析（可能是页面改版）。'),
      };
    }

    const posts = buildDouyinPosts(channel, snapshot, limit, options);

    return {
      posts,
      authorMeta: {
        name: snapshot.authorName || undefined,
        avatar: snapshot.authorAvatar || undefined,
      },
      // History digging is NOT supported: the spike found no reliable, bounded
      // pagination for the DOM grid, and faking it would silently skip works.
      // `hasMore: false` is the contract's end-of-history signal, so
      // `channelSync` parks the cursor at `__END__` and the dashboard's deep-sync
      // stops after one round instead of looping against a source that cannot
      // page. (A `fetchHistory` override would be dead code: `fetchChannelHistory`
      // routes every dig back through `fetchLatest`.)
      hasMore: false,
      totalFetched: snapshot.items.length,
    };
  },
};

/** Map validated works onto Posts, applying the incremental watermark. */
export function buildDouyinPosts(
  channel: Channel,
  snapshot: DouyinSnapshot,
  limit: number,
  options?: FetchOptions,
): Post[] {
  const since = options?.forceRefresh ? 0 : options?.sinceTimestamp ?? 0;
  const posts: Post[] = [];

  for (const item of snapshot.items) {
    // The grid is not strictly reverse-chronological (pinned works, waterfall
    // layout), so filter every item instead of stopping at the first old one.
    if (since > 0 && item.publishedAt <= since) continue;
    posts.push(toPost(channel, item));
    if (posts.length >= Math.max(limit, 1)) break;
  }

  return posts;
}

function toPost(channel: Channel, item: DouyinItem): Post {
  const title = item.description
    ? item.description.split('\n')[0].slice(0, 120)
    : item.type === 'image'
      ? '抖音图文'
      : '抖音视频';

  return buildPost(channel, {
    // Stable identity: the aweme_id alone. Never the description, cover, or a
    // signed CDN URL — all three change without the work changing.
    id: `douyin_${item.awemeId}`,
    title,
    content: item.description,
    mediaList: toMediaList(item),
    originalUrl: item.pageUrl,
    publishedAt: item.publishedAt,
    isRepost: false,
  });
}

function toMediaList(item: DouyinItem): MediaItem[] {
  const media: MediaItem[] = [];

  if (item.type === 'image' && item.imageUrls.length > 0) {
    for (const url of item.imageUrls) {
      media.push({ type: 'image', previewUrl: url, originalUrl: url });
    }
    return media;
  }

  if (item.coverUrl) {
    media.push({
      type: item.type === 'video' ? 'video' : 'image',
      previewUrl: item.coverUrl,
      // A video's "original" is its work page, not a short-lived playback URL:
      // Douyin play URLs are signed, expiring and session-bound, so persisting
      // one would produce a dead link the next day.
      originalUrl: item.type === 'video' ? item.pageUrl : item.coverUrl,
    });
  }

  return media;
}
