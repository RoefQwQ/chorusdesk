import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { fetchError, httpStatusError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { MAX_RESPONSE_CHARS } from '../infrastructure/chrome/messages/bgFetch';
import { toSecureMediaUrl } from '../utils/media';
import { errorMessage } from '../utils/errorMessage';
import { asRecord } from '../utils/json';
import { devLog } from '../utils/devLog';
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

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
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

      // A local offset over the notes parsed from THIS page. It is not a platform
      // cursor: it exists so a dig can page through the ~30 notes one response
      // carries instead of returning all of them at once.
      const isHistoryDig = Boolean(options?.cursor !== undefined || options?.isHistory);
      const isForce = Boolean(options?.forceRefresh);
      const offset = isHistoryDig ? Math.max(Number(options?.cursor) || 0, 0) : 0;

      // The profile page carries only its first screen (~30 notes) in the SSR
      // state, and this adapter has no way to ask for the next page from the
      // service worker — the endpoint that would (`user_posted`) requires an `X-S`
      // signature only the page's own JS can produce. So "I ran out of the notes I
      // parsed" is a statement about THIS FETCH, not about the account.
      //
      // It used to return `hasMore: false` here, which `statesEndOfHistory` reads
      // as the platform declaring the end — writing `__END__` and permanently
      // blocking the channel (rule 10: wrongly claiming complete is unrecoverable).
      // The page contradicts it outright: measured 2026-09-13, the SSR state's
      // `user.noteQueries[0]` says `{ num: 30, hasMore: true, cursor: "69fdde80…" }`
      // on the same response. The platform says there IS more; we are the ones who
      // cannot reach it, and we must not put that in the platform's mouth.
      //
      // Reported as an error instead of a silent empty success (rule 13): a dig
      // that returns nothing must say why, and this is a real limit the user can
      // act on (open the note's page in a browser, or wait for in-page acquisition).
      if (isHistoryDig && !isForce && offset >= allPosts.length) {
        return {
          posts: [],
          authorMeta: {
            name: authorName,
            avatar: authorAvatar,
          },
          error: fetchError(
            'unsupported',
            '小红书主页只提供最近的一屏作品（约 30 条），更早的内容需要页面端才能取到，'
            + '当前同步路径无法继续回溯。已获取的内容不会丢失，深挖稍后可重试。',
          ),
        };
      }

      // When force refreshing, return all parsed posts so old items get updated/healed
      const targetPosts = isForce ? allPosts : allPosts.slice(offset, offset + limit);

      // Image notes: the profile SSR cards carry only a single cover. Fetch
      // each note's detail page (SSR embeds the full imageList) so picture
      // posts show all their images, not just the first.
      await enrichImageNoteMedia(channel, targetPosts, signal);

      const nextOffset = offset + targetPosts.length;
      // `hasMore` only while there are still unparsed notes IN THIS PAGE. When the
      // offset reaches the end, the branch above has already answered — so this is
      // `false` only alongside a real cursor, never as an end-of-history claim.
      const hasMore = !isForce && nextOffset < allPosts.length;
      return {
        posts: targetPosts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: hasMore ? String(nextOffset) : undefined,
        hasMore,
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


