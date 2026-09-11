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

  /**
   * Far above the generic floor: a Douyin request is a real page load in a tab
   * (scripts, images, a client-rendered grid), so it is a much louder automation
   * signal than an API call. Issuing three of them back to back is what produced
   * a verification redirect and a mid-scrape `Frame with ID 0 was removed`.
   */
  minRequestIntervalMs: 15_000,

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

    // Did the grid stop short of the creator's stated work count? The stated
    // total counts works the author has hidden (see below), so a shortfall is the
    // normal state of such a profile and proves nothing on its own. What the
    // shortfall does forbid is claiming "已到底": a dig that cannot see more works
    // is surfaced as an auth error instead, so the sync layer shows the message
    // and does NOT park the cursor at __END__.
    //
    // The original reading of this branch — "anonymous browsing hits a login wall
    // partway down (measured: 18 of a stated 29)" — is withdrawn: that
    // measurement is equally explained by 11 hidden works and a complete grid
    // (AGENTS.md rule 10, and the longer note in collector.ts). The branch below
    // is kept because it is the safe direction, not because the wall is proven.
    const isDeep = isDeepRequest(options);

    // Completeness is NOT provable from the stated work count.
    //
    // `statedTotal` counts works the author has hidden, so a creator who hid
    // anything loads fewer works than it states and `items.length < statedTotal`
    // is permanently true. That makes the count useless as a *positive* test for
    // "we are done": it can only ever say "you have not yet loaded as many as are
    // claimed", which is expected and not evidence of anything unseen.
    //
    // It stays the test anyway, deliberately, and only in the safe direction.
    // The two ways to be wrong are not symmetric:
    //   - claiming complete when works remain writes `__END__`, and the user can
    //     never dig those works again — unrecoverable without editing the DB;
    //   - leaving a dig resumable when it was already complete costs one needless
    //     re-scroll, and loses nothing.
    // So incompleteness is only ever *allowed* to be concluded from evidence that
    // the grid reached the end of what this visitor can see
    // (`snapshotCompleteAtLoginWall`), never inferable from the count.
    //
    // What the count must NOT do is blame the user: the message below no longer
    // reads as "you should be seeing all N", because for a creator with hidden
    // works that sends the user to log in for a shortfall logging in cannot fix.
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
          snapshot.statedTotal > 0 && snapshot.items.length < snapshot.statedTotal
            ? `抖音页面加载出 ${snapshot.items.length} 篇作品后停止增长（主页标注 ${snapshot.statedTotal} 篇，该数字包含作者隐藏的作品，故少于标注属正常）。若确有更早的作品，请在该创作者的抖音标签页中登录后向下滚动加载再重试。`
            : `抖音页面加载了 ${snapshot.items.length} 篇作品后停止增长，且未能读取作品总数，无法确认已到历史底部。请在抖音标签页中登录后向下滚动加载，再重新回溯。`,
        ),
        totalFetched: snapshot.items.length,
      };
    }

    // An empty grid is not evidence that the creator has no works.
    //
    // This runs after navigating a tab and waiting for load; if the
    // client-rendered grid had not painted yet, the snapshot is empty while the
    // creator clearly does have works. Claiming `hasMore: false` here writes
    // `__END__` and permanently blocks that channel from ever digging its
    // history — the same "insufficient evidence declared as an end" failure
    // AGENTS rule 10 records. Report it instead: the cursor stays resumable and
    // the user can retry.
    if (snapshot.items.length === 0) {
      return {
        posts: [],
        authorMeta: {
          name: snapshot.authorName || undefined,
          avatar: snapshot.authorAvatar || undefined,
        },
        error: fetchError(
          'parse',
          snapshot.statedTotal > 0
            // Does not promise the stated count is visible: it includes hidden
            // works, so citing it as an expectation sent the user looking for
            // works that were never going to appear.
            ? `抖音作品列表未加载出来（主页标注 ${snapshot.statedTotal} 篇，含作者隐藏的作品）。请在抖音标签页中确认该主页能正常显示作品后再同步。`
            : '抖音页面未加载出任何作品。若该创作者确有作品，通常是页面网格尚未渲染完成——请在抖音标签页中打开该主页、确认能看到作品后再同步。',
        ),
        totalFetched: 0,
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
