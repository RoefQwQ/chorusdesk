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

/**
 * Ceiling for a history dig's page payload. Bounded because a dig scrolls the
 * grid, and an unbounded scrape of a prolific creator would ship a huge snapshot
 * across the message channel in one go.
 */
const MAX_HISTORY_ITEMS = 200;

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
      // A history dig (or an explicit force-refresh) asks the page to scroll the
      // grid first, which is the only way older works enter the DOM.
      const deep = isDeepRequest(options);
      response = await new Promise<SnapshotResponse>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'FETCH_DOUYIN_SNAPSHOT', secUid, limit: deep ? MAX_HISTORY_ITEMS : limit, deep },
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

    // A dig wants everything the scrolled grid yielded, not just one page's worth.
    const buildLimit = isDeepRequest(options) ? MAX_HISTORY_ITEMS : limit;
    const posts = buildDouyinPosts(channel, snapshot, buildLimit, options);

    // Did the grid stop short of the creator's stated work count? Anonymous
    // browsing hits a login wall partway down (measured: 18 of a stated 29, with
    // no further growth however far it is scrolled), and the works behind it are
    // exactly the older ones a history dig is after. Saying "已到底" there would
    // be a lie, so the truncation is surfaced as an auth error instead — the sync
    // layer shows the message and does NOT park the cursor at __END__.
    const isDeep = isDeepRequest(options);
    // Unknown totals are treated as potentially truncated too: when the header
    // count could not be read as a plain integer, "the grid stopped growing"
    // carries no evidence of completeness, and claiming hasMore:false would park
    // the cursor at __END__ on pure guesswork. Only a stated total that the grid
    // actually reached may end the dig.
    const truncated =
      snapshot.statedTotal > 0
        ? snapshot.items.length < snapshot.statedTotal
        : isDeep && snapshot.saturated && snapshot.items.length > 0 && !snapshotCompleteAtLoginWall(snapshot);

    if (isDeep && truncated && posts.length === 0) {
      return {
        posts: [],
        authorMeta: {
          name: snapshot.authorName || undefined,
          avatar: snapshot.authorAvatar || undefined,
        },
        error: fetchError(
          'auth',
          snapshot.statedTotal > 0
            ? `抖音页面只加载出 ${snapshot.items.length} / ${snapshot.statedTotal} 篇作品便停止。更早的作品需要在抖音标签页中登录后向下滚动加载，请登录后重试。`
            : `抖音页面加载了 ${snapshot.items.length} 篇作品后停止增长，且未能读取作品总数，无法确认已到历史底部。请在抖音标签页中登录后向下滚动加载，再重新回溯。`,
        ),
        totalFetched: snapshot.items.length,
      };
    }

    return {
      posts,
      authorMeta: {
        name: snapshot.authorName || undefined,
        avatar: snapshot.authorAvatar || undefined,
      },
      // `hasMore: false` is the end-of-history signal, so only claim it when the
      // grid actually looks complete. A grid cut short by a login wall must stay
      // resumable: parking the cursor at __END__ would permanently stop the user
      // from digging the rest after they log in.
      hasMore: truncated ? undefined : false,
      totalFetched: snapshot.items.length,
    };
  },
};

/**
 * True when this fetch should scroll the grid before scraping.
 *
 * A dig, a cursor-driven page and a force-refresh all want older works, which
 * only enter the DOM once the grid's own scroll container is driven.
 */
function isDeepRequest(options?: FetchOptions): boolean {
  return Boolean(options?.isHistory || options?.cursor !== undefined || options?.forceRefresh);
}

/**
 * Heuristic: does the page look like the works that ARE loaded reached the
 * login wall's cut rather than the true bottom?
 *
 * Douyin's anonymous grid stops around the most recent ~6 months of a creator's
 * output. A grid whose oldest loaded work is far older than that has very likely
 * loaded everything Douyin is willing to show this visitor, so a saturated dig
 * with an unreadable header count may still legitimately be complete. This is a
 * deliberately conservative check: it only ever ALLOWS hasMore:false to be
 * claimed, and only when the evidence (loaded history reaching well past the
 * typical anonymous window) supports it.
 */
function snapshotCompleteAtLoginWall(snapshot: DouyinSnapshot): boolean {
  if (snapshot.items.length === 0) return false;
  const oldest = snapshot.items[snapshot.items.length - 1].publishedAt;
  const SIX_MONTHS_MS = 183 * 24 * 60 * 60 * 1000;
  // Oldest loaded work predates the typical anonymous window: the grid very
  // likely reached the beginning of the creator's output, not a login wall.
  return Date.now() - oldest > SIX_MONTHS_MS;
}

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
