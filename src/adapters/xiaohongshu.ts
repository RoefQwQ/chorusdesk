import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions, FetchErrorCode } from './types';
import { fetchError, httpStatusError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { MAX_RESPONSE_CHARS } from '../infrastructure/chrome/messages/bgFetch';
import { toSecureMediaUrl } from '../utils/media';
import { errorMessage } from '../utils/errorMessage';
import { asRecord } from '../utils/json';
import { devLog } from '../utils/devLog';
import { IS_SERVICE_WORKER } from '../utils/runtime';
import { buildPost } from './buildPost';
import { normalizeXhsSnapshot } from './xiaohongshu/contract';
import type { RawXhsNote } from './xiaohongshu/collector';
import {
  collectRawNotes,
  extractInitialState,
  firstInfoListUrl,
  hasInitialStateMarker,
  mapProfileNote,
  resolveAuthorMeta,
} from './xiaohongshu/profileState';


export const xiaohongshuAdapter: PlatformAdapter = {
  platform: 'xiaohongshu',
  /**
   * The profile page cannot state "there is nothing older": its SSR payload
   * carries one screen of notes plus `noteQueries[].hasMore`, and reaching older
   * ones needs the page's signed `user_posted` call, which this adapter cannot
   * make from the service worker.
   *
   * Declaring this is what lets an already-poisoned channel recover. `__END__`
   * written by an earlier build was trusted — `hasStaleTerminalCursor` clears a
   * terminal cursor only for platforms that do NOT claim to paginate — so a
   * channel dug to the end of its first screen stayed permanently blocked
   * (AGENTS rule 10). This declaration is also what the `restricted_only` archive
   * strategy and the honesty fix above depend on being accurate.
   */
  paginates: false,
  /**
   * A dig scrolls the user's own logged-in profile page, which is what the
   * platform's anti-bot heuristics watch for. The warning in `useDeepSync` is
   * driven by this flag rather than by a platform name at the call site.
   *
   * Deliberately NOT paired with a raised `minRequestIntervalMs`: that floor is
   * per PLATFORM, and the risk here is specific to the dig, which opens one page
   * and then paces itself from inside (the collector sleeps between scroll steps
   * and `deepSyncChannel` waits 900 ms between rounds). Raising the floor would
   * slow the ordinary SSR sync — a single cheap fetch — for no safety gain.
   */
  digScrollsUserPage: true,

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    // A history dig cannot be served from the service worker: paging past the
    // first screen needs the page's own signed `user_posted` call, so this runs
    // in a page through the FETCH_XHS_NOTES handler (the Douyin shape, rule 9).
    //
    // It stays a deep-only path. Scrolling is what trips the platform's
    // automation heuristics — the reference implementation ships it off by default
    // with a risk warning — so an ordinary sync keeps using the plain SSR fetch
    // below, which touches nothing the user's own browsing would not.
    if (isDeepRequest(options)) {
      return fetchDeepFromPage(channel, limit, options);
    }

    try {
      const signal = options?.signal;
      const userId = channel.accountId.trim();
      const profileUrl = `https://www.xiaohongshu.com/user/profile/${userId}`;

      const res = await bgFetch(profileUrl, {
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://www.xiaohongshu.com/',
        },
      });

      if (!res.ok) {
        // Every status used to be reported as `network`, so a 429 (the platform
        // asking us to stop) never entered a cool-down and a 404 read as a
        // connection problem. The shared classifier separates them.
        return {
          posts: [],
          error: httpStatusError(res.status, '小红书'),
        };
      }

      const html = res.data;
      // Two very different conditions used to share one message. A body that
      // never arrived is a fetch problem; a body that arrived but carries no SSR
      // payload means the page this session was served is not the profile we
      // think it is (login wall, verification page, or a shape change). Saying
      // 「请确认已登录」 for both sent the user to check a login that was fine.
      if (!html || html.length === 0) {
        devLog.warn('xiaohongshu', '主页响应为空', 'HTTP 200 但响应体为空');
        return {
          posts: [],
          error: fetchError('network', '小红书主页返回了空响应，请稍后重试。'),
        };
      }

      const state = extractInitialState(html);

      if (!state) {
        // Where the failure actually is: the payload marker is absent from the
        // HTML. `extractInitialState` returns null both when nothing matches and
        // when the JSON is malformed (that case logs its own warning), so this
        // reports what it can see and names the two real causes.
        const hasMarker = hasInitialStateMarker(html);
        // A truncated body explains a malformed payload without any problem on
        // the page's side, and must be said first — measured on this very
        // profile: 250 000 characters received (the old ceiling, exactly) while
        // the marker was present and the JSON was cut. The generic 「页面结构可能
        // 已调整」 would have sent the user hunting a change that never happened.
        if (res.truncated) {
          devLog.warn(
            'xiaohongshu',
            '响应被传输上限截断，初始状态因此不完整',
            `已收到 ${html.length} 字符（上限 ${MAX_RESPONSE_CHARS}）。这不是页面结构的问题。`,
          );
          return {
            posts: [],
            error: fetchError(
              'parse',
              `小红书主页内容过大，超过单次请求上限（${MAX_RESPONSE_CHARS} 字符）而被截断，`
              + '因此无法解析其中的笔记数据。',
            ),
          };
        }
        devLog.warn(
          'xiaohongshu',
          '主页未包含初始状态数据',
          hasMarker
            ? '响应中出现标记但 JSON 解析失败（详见上一条）'
            : `响应中找不到初始状态标记（${html.length} 字符）`,
        );
        return {
          posts: [],
          error: fetchError(
            'parse',
            hasMarker
              ? '小红书主页的初始状态数据无法解析（页面结构可能已调整）。'
              : '小红书主页未返回笔记数据（页面未携带初始状态）。若该主页在浏览器中可正常显示，可能是登录态或页面结构问题。',
          ),
        };
      }

      const rawNotes = collectRawNotes(state);
      const { name: authorName, avatar: authorAvatar } = resolveAuthorMeta(state, rawNotes, channel);
      const allPosts: Post[] = [];
      const seenIds = new Set<string>();

      for (const rawItem of rawNotes) {
        const post = mapProfileNote(rawItem, channel, seenIds);
        if (post) allPosts.push(post);
      }
      // CRITICAL: Sort strictly descending by publication time (newest first)
      // This fixes the random-order bug caused by multiple columns in waterfall layout
      allPosts.sort((a, b) => b.publishedAt - a.publishedAt);

      // The profile page always embeds the creator's notes in its initial
      // state. Zero parsed notes therefore means the page did not carry what
      // this adapter reads — logged out, login-walled, or the state shape
      // changed — and must not be reported as a successful empty sync.
      if (rawNotes.length === 0) {
        return {
          posts: [],
          error: fetchError(
            'parse',
            '小红书博主页面未包含任何笔记数据。请确认浏览器已在 xiaohongshu.com 登录，'
            + '且该主页在浏览器中能正常显示笔记；若页面显示正常仍报此错，可能是页面结构已调整。',
          ),
        };
      }

      // This path serves only an ORDINARY sync now. A dig, a cursor page and a
      // force-refresh all want notes older than the SSR first screen and are
      // handled by the page-driven path above, so the local offset machinery that
      // used to live here is gone rather than left unreachable.
      //
      // What it used to do, and why it is not missed: it reported
      // `hasMore: false` when the offset ran past the ~30 parsed notes, which
      // `statesEndOfHistory` reads as the platform declaring the end. The page
      // contradicts that outright — measured 2026-09-13, the SSR state's
      // `user.noteQueries[0]` says `{ num: 30, hasMore: true, cursor: … }` on the
      // same response (rule 10: wrongly claiming complete is unrecoverable).
      const targetPosts = allPosts.slice(0, limit);

      // Image notes: the profile SSR cards carry only a single cover. Fetch
      // each note's detail page (SSR embeds the full imageList) so picture
      // posts show all their images, not just the first.
      await enrichImageNoteMedia(channel, targetPosts, signal);

      return {
        posts: targetPosts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        // Never an end-of-history claim: the SSR document carries one screen, so
        // "I ran out of parsed notes" is a statement about this fetch, not about
        // the account. Leaving `hasMore` unset (`undefined`) says exactly that.
        totalFetched: allPosts.length,
      };
    } catch (err: unknown) {
      const message = errorMessage(err);
      return {
        posts: [],
        error: fetchError('network', `获取小红书动态异常: ${message}`),
      };
    }
  },
};


/**
 * True when this fetch wants older notes, which only a page can reach.
 *
 * A dig, a cursor-driven page and a force-refresh all ask for history; all three
 * take the injected path.
 */
function isDeepRequest(options?: FetchOptions): boolean {
  return Boolean(options?.isHistory || options?.cursor !== undefined || options?.forceRefresh);
}

/** Response shape of the FETCH_XHS_NOTES message. */
interface XhsNotesResponse {
  success?: boolean;
  code?: FetchErrorCode;
  error?: string;
  snapshot?: unknown;
}

/**
 * Acquire a creator's notes by driving an open xiaohongshu profile page.
 *
 * The page is the only place this can run: the SSR document carries one screen,
 * and the endpoint that pages it needs a signature only the page's JS produces.
 * The handler owns the tab lifecycle; this function owns turning the (untrusted)
 * snapshot into Posts.
 */
async function fetchDeepFromPage(
  channel: Channel,
  limit: number,
  options?: FetchOptions,
): Promise<FetchResult> {
  const userId = channel.accountId.trim();
  if (!userId) {
    return { posts: [], error: fetchError('unsupported', '小红书频道缺少创作者标识') };
  }

  // Same reasoning as the Douyin adapter: the SW cannot message its own router,
  // so a background dig says so rather than reporting a successful empty sync.
  if (IS_SERVICE_WORKER) {
    return {
      posts: [],
      error: fetchError(
        'unsupported',
        '小红书历史回溯需要在打开的页面中采集，后台自动同步无法执行。请在仪表盘手动回溯。',
      ),
    };
  }

  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return { posts: [], error: fetchError('unsupported', '当前环境不支持小红书页面采集') };
  }

  if (options?.signal?.aborted) {
    return { posts: [], error: fetchError('timeout', '同步已取消（调用方已中止）') };
  }

  let response: XhsNotesResponse;
  try {
    response = await new Promise<XhsNotesResponse>((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'FETCH_XHS_NOTES', userId, limit, deep: true },
        (res) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, code: 'network', error: chrome.runtime.lastError.message });
          } else {
            resolve((res as XhsNotesResponse) || { success: false });
          }
        },
      );
    });
  } catch (err: unknown) {
    return { posts: [], error: fetchError('network', `小红书采集通信异常: ${errorMessage(err)}`) };
  }

  if (!response?.success) {
    return {
      posts: [],
      error: fetchError(response?.code ?? 'network', response?.error || '小红书笔记采集失败'),
    };
  }

  // Everything from the page is untrusted; the contract is the single place that
  // knows the page's shape and drops what it cannot vouch for.
  const snapshot = normalizeXhsSnapshot(response.snapshot);
  if (!snapshot) {
    return { posts: [], error: fetchError('parse', '小红书页面数据结构无法解析（可能是页面改版）。') };
  }

  if (snapshot.requiresLogin) {
    return {
      posts: [],
      error: fetchError('auth', '小红书要求登录，未登录的会话看不到创作者主页。请先在浏览器中登录小红书。'),
    };
  }

  const authorMeta = {
    name: snapshot.authorName || undefined,
    avatar: snapshot.authorAvatar || undefined,
  };

  // Zero notes is not "this creator posted nothing" — the collector drove a real
  // page and found no cards at all, which is a login wall, an empty grid that has
  // not painted, or a changed state shape. Reporting it as a successful empty sync
  // would also let a `hasMore: false` park the cursor at `__END__` forever
  // (rules 10 and 13).
  if (snapshot.notes.length === 0) {
    return {
      posts: [],
      authorMeta,
      error: fetchError(
        'parse',
        snapshot.statedTotal
          ? `小红书主页未加载出任何笔记（主页标注 ${snapshot.statedTotal} 篇，该数字包含作者隐藏的作品）。请在浏览器中确认该主页能正常显示笔记后再回溯。`
          : '小红书页面未加载出任何笔记。若该创作者确有笔记，通常是页面尚未渲染完成——请在浏览器中打开该主页、确认能看到笔记后再回溯。',
      ),
      totalFetched: 0,
    };
  }

  const posts: Post[] = [];
  const seenIds = new Set<string>();
  const since = options?.forceRefresh ? 0 : options?.sinceTimestamp ?? 0;
  for (const note of snapshot.notes) {
    const post = toPostFromNote(channel, note);
    if (!post || seenIds.has(post.id)) continue;
    seenIds.add(post.id);
    // The grid is not strictly reverse-chronological, so filter every note rather
    // than stopping at the first old one.
    if (since > 0 && post.publishedAt <= since) continue;
    posts.push(post);
  }
  posts.sort((a, b) => b.publishedAt - a.publishedAt);

  // Enrich image notes with their detail page's full `imageList`, exactly as the
  // SSR path does — the profile card carries only a cover.
  await enrichImageNoteMedia(channel, posts, options?.signal);

  // `hasMore: false` is the end-of-history signal, and parking the cursor at
  // `__END__` is unrecoverable — so it is claimed only on POSITIVE evidence that the
  // page served everything: the grid reached at least the total the header states.
  //
  // Saturation is NOT that evidence. A grid that stopped growing may have finished
  // or may have been cut off, and the stated total counts works the author has
  // hidden, so a shortfall is permanently true for such a profile and proves nothing
  // (rule 10). The asymmetry is deliberate: staying resumable costs one re-scroll,
  // claiming complete loses the history permanently.
  const matchedStated = snapshot.statedTotal !== null && snapshot.notes.length >= snapshot.statedTotal;
  const shortOfStated = snapshot.statedTotal !== null && snapshot.notes.length < snapshot.statedTotal;

  if (snapshot.saturated && shortOfStated && posts.length === 0) {
    // A dig that returns nothing must say why rather than reporting a successful
    // empty sync (rule 13) — and it must not blame the user for a shortfall that
    // hidden works explain.
    return {
      posts: [],
      authorMeta,
      error: fetchError(
        'unsupported',
        `页面滚动到 ${snapshot.notes.length} 篇笔记后停止增长（主页标注 ${snapshot.statedTotal} 篇，`
        + '该数字包含作者隐藏的作品，故少于标注属正常）。若确有更早的笔记，请在该创作者的页面中'
        + '登录后向下滚动加载再重试。',
      ),
      totalFetched: snapshot.notes.length,
    };
  }

  return {
    posts: posts.slice(0, Math.max(limit, 1)),
    authorMeta,
    hasMore: !matchedStated,
    totalFetched: snapshot.notes.length,
  };
}

/** Map one validated page note onto a Post. */
function toPostFromNote(channel: Channel, note: RawXhsNote): Post | null {
  const title = note.title || '小红书笔记';
  const isVideo = note.type === 'video';
  const likedCount = note.likedCount;

  const mediaList: MediaItem[] = [];
  if (note.coverUrl) {
    const secureCover = toSecureMediaUrl(note.coverUrl);
    mediaList.push({
      type: isVideo ? 'video' : 'image',
      previewUrl: secureCover,
      // A video's page is its canonical target; its cover is not playable.
      originalUrl: isVideo ? note.noteUrl : secureCover,
    });
  }

  return buildPost(channel, {
    id: `xiaohongshu_${note.id}`,
    title,
    content: likedCount ? `${title}\n\n❤️ ${likedCount} 次赞同` : title,
    mediaList,
    originalUrl: note.noteUrl,
    publishedAt: note.time,
    isRepost: false,
  });
}

/**
 * Cap on detail-page fetches per sync round. XHS risk control is strict;
 * hammering dozens of /explore/ pages in one go is how accounts get
 * challenged. The remaining notes fall back to their profile-card cover and
 * are enriched on a later round.
 */
const DETAIL_ENRICH_MAX_PER_ROUND = 3;
/** Pacing between detail fetches (ms), mirroring the sync layer's pacing. */
const DETAIL_ENRICH_INTERVAL_MS = 1200;

/**
 * Fill image notes' mediaList from their detail-page SSR.
 *
 * The profile page's SSR cards only carry a single `cover`; the note detail
 * page (`/explore/{noteId}`) embeds the full `imageList` for the note. Only
 * image-type posts with at most one image are candidates (video notes keep
 * their cover+link; already-multi-image posts came from a detail-shaped
 * source). Failures are silent: the cover stays, enrichment retries next
 * round.
 */
async function enrichImageNoteMedia(channel: Channel, posts: Post[], signal?: AbortSignal): Promise<void> {
  const candidates = posts.filter(
    (p) =>
      p.mediaList.length <= 1 &&
      p.mediaList.every((m) => m.type === 'image') &&
      /^xiaohongshu_[0-9a-f]{24}$/.test(p.id),
  );
  let fetched = 0;

  for (const post of candidates) {
    if (fetched >= DETAIL_ENRICH_MAX_PER_ROUND) break;
    if (fetched > 0) {
      await new Promise((r) => setTimeout(r, DETAIL_ENRICH_INTERVAL_MS));
    }
    fetched++;

    const noteId = post.id.slice('xiaohongshu_'.length);
    try {
      // Reuse the token the profile page gave this note, rather than fetching the
      // bare `/explore/<id>`: without it xiaohongshu answers `error_code=300031`
      // and the detail page carries no `imageList`, so the enrichment silently
      // kept the single cover. `post.originalUrl` already carries it (see
      // `mapProfileNote`), so this is a parse, not a second source of truth.
      let detailUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
      try {
        const withToken = new URL(post.originalUrl);
        const token = withToken.searchParams.get('xsec_token');
        if (token) {
          detailUrl = `${withToken.origin}${withToken.pathname}?xsec_token=${encodeURIComponent(token)}&xsec_source=pc_user`;
        }
      } catch {
        // A malformed stored URL: fall back to the tokenless form.
      }
      const res = await bgFetch(detailUrl, {
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: `https://www.xiaohongshu.com/user/profile/${channel.accountId}`,
        },
      });
      if (!res.ok) continue;

      const state = extractInitialState(res.data);
      const note = asRecord(asRecord(asRecord(asRecord(asRecord(state).note).noteDetailMap)[noteId]).note);
      const imageList: unknown = note.imageList || note.imagesList;
      if (!Array.isArray(imageList) || imageList.length === 0) continue;

      const mediaList: MediaItem[] = [];
      for (const img of imageList) {
        const url =
          (typeof img === 'object' && img !== null
            ? (img as Record<string, unknown>).urlDefault ||
              (img as Record<string, unknown>).urlPre ||
              (img as Record<string, unknown>).url ||
              firstInfoListUrl((img as Record<string, unknown>).infoList)
            : undefined) as string | undefined;
        if (typeof url === 'string' && url) {
          const secureUrl = toSecureMediaUrl(url);
          mediaList.push({ type: 'image', previewUrl: secureUrl, originalUrl: secureUrl });
        }
      }
      // Only replace when the detail page actually provided more images;
      // otherwise keep the cover (a failed parse must not blank the post).
      if (mediaList.length > post.mediaList.length) {
        post.mediaList = mediaList;
      }
    } catch {
      // Silent: cover stays; retry on a later round.
    }
  }
}


