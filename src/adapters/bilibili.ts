import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions, FetchError } from './types';
import { buildPost } from './buildPost';
import { devLog } from '../utils/devLog';
import { errorMessage } from '../utils/errorMessage';
import { mapSpaceDynamicItem } from './bilibili/spaceDynamic';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { toSecureMediaUrl } from '../utils/media';
import type { JsonRecord } from '../utils/json';
import { asRecord } from '../utils/json';

// Mirror the real site's UA. Bilibili risk-control rejects the default fetch UA.
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * The business code out of an HTTP failure body, when there is one.
 *
 * Bilibili answers a rejected request with an HTTP status AND a JSON body carrying the
 * real code — measured 2026-09-12: `HTTP 412`, body `{"code":-412,"message":"request was
 * banned"}`. Without this, a rejected request never reaches `biliCodeError` at all: the
 * status check skips the whole parse, and the run ends up reporting 「账号可能无投稿或
 * 已注销」 for what is actually a refusal.
 */
function businessCodeFromBody(data: string | undefined): number | undefined {
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data) as unknown;
    const code = asRecord(parsed).code;
    return typeof code === 'number' ? code : undefined;
  } catch {
    // Some refusals come back as HTML rather than JSON (measured: a bare request with no
    // Referer). No code then — the caller falls back to the HTTP status.
    return undefined;
  }
}

/** Map Bilibili business error codes to a structured, user-facing error. */
function biliCodeError(code: number): FetchError {
  switch (code) {
    case -101:
      return fetchError('auth', 'B站未登录或登录已过期，请检查登录状态');
    case -352:
      return fetchError('rate_limit', 'B站风控校验失败，请稍后重试或完成人机验证');
    case -403:
      return fetchError('auth', 'B站接口拒绝访问（权限不足或签名失效），请确认登录状态后重试');
    case -412:
      // MEASURED 2026-09-12, and it changed this mapping's class:
      //     no session, adapter headers -> HTTP 412, {"code":-412,"message":"request was banned"}
      //     the same request from a signed-in browser -> HTTP 200, code 0
      // So -412 is what the endpoint returns when the request carries no usable
      // session. It is NOT the risk-control code — that is -352, which stays
      // `rate_limit` on the next line.
      //
      // Why the class matters twice over: `rate_limit` makes channelSync DISCARD the
      // adapter's message in favour of a hardcoded 「请等待 2~3 分钟」, and batchSync
      // starts a PERSISTED cool-down for the platform. So a signed-out user was told to
      // wait, given no reason to log in, and then had the platform skipped even after
      // logging in. `auth` surfaces this message verbatim instead.
      return fetchError('auth', 'B站拒绝了本次请求，通常是浏览器未登录或登录已过期。请在浏览器中登录 bilibili 后重试。');
    default:
      return fetchError('parse', `B站接口异常 (code ${code})`);
  }
}

export const bilibiliAdapter: PlatformAdapter = {
  platform: 'bilibili',

  async fetchLatest(channel: Channel, limit: number = 15, options?: FetchOptions): Promise<FetchResult> {
    const uid = channel.accountId;
    let authorName = channel.displayName;
    let authorAvatar = toSecureMediaUrl(channel.avatarUrl);

    // sinceTimestamp: the watermark. Normal sync skips anything older or equal to this.
    // Historical dig (options.cursor is set) ignores the watermark and fetches older content.
    const sinceTs = options?.cursor ? 0 : (options?.sinceTimestamp ?? 0);

    if (options?.cursor) {
      const fetchHistory = this.fetchHistory;
      if (!fetchHistory) {
        return { posts: [], error: fetchError('unsupported', 'Bilibili historical fetch is unavailable') };
      }
      return fetchHistory.call(this, channel, uid, limit, options, authorName, authorAvatar);
    }

    const allPosts: Post[] = [];
    const seenBvids = new Set<string>();
    let nextCursor: string | undefined;
    let hasMore = false;
    // Remember non-zero business codes so a total-empty result reports the real cause.
    let lastDynamicCode: number | undefined;
    let lastMediaCode: number | undefined;
    /** Items the platform returned, counted before any adapter-side filtering. */
    let rawFetched = 0;
    // Whether medialist responded with a successful business code (code 0). When it
    // does, it is the authoritative source: an empty list means "no videos", which
    // must not be re-reported as a permission error from the risk-controlled dynamic feed.
    let mediaSucceeded = false;

    // PRIMARY: Space dynamic feed (sorted newest-first, covers all dynamic types)
    try {
      const dynamicUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${encodeURIComponent(uid)}`;
      const res = await bgFetch(dynamicUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `https://space.bilibili.com/${uid}/dynamic`,
          Origin: 'https://space.bilibili.com',
          'User-Agent': BILI_UA,
        },
      });

      if (!res.ok) {
        // A refusal is not an absence. Without this the run reports "no content" for a
        // channel the platform declined to serve (measured: HTTP 412 with
        // `{"code":-412}` when the session is missing or rejected).
        lastDynamicCode = businessCodeFromBody(res.data) ?? (res.status === 412 ? -412 : undefined);
      }
      if (res.ok && res.data) {
        const json = JSON.parse(res.data) as JsonRecord;
        if (json.code !== 0) {
          lastDynamicCode = json.code as number;
          // The Developer Log panel does not capture `console`, and this code is the
          // ONLY explanation for a bilibili channel that reports nothing: -412 is
          // risk control, -404 a deleted account, and so on. Logging it to the console
          // alone made the reason invisible in the one surface users can send us.
          devLog.warn(
            'bilibili',
            `动态接口返回业务码 ${String(json.code)}`,
            `${String(json.message ?? '')}（频道 ${channel.displayName || channel.accountId}）`,
          );
        } else if (json.data) {
          const data = asRecord(json.data);
          const items = Array.isArray(data.items) ? data.items : [];
          if (data.has_more) hasMore = true;
          if (data.offset) nextCursor = String(data.offset);

          for (const rawItem of items) {
            const mapped = mapSpaceDynamicItem(rawItem, channel, seenBvids, {
              onlyOriginal: options?.onlyOriginal,
              fallbackToNow: true,
            });
            const moduleAuthor = asRecord(asRecord(asRecord(rawItem).modules).module_author);
            const pubTime = moduleAuthor.pub_ts ? Number(moduleAuthor.pub_ts) * 1000 : 0;

            if (mapped.authorName) authorName = mapped.authorName;
            if (mapped.authorAvatar) authorAvatar = mapped.authorAvatar;

            // Counted before the watermark / onlyOriginal filters below: the
            // difference between this and `posts.length` is what tells the sync
            // log "the platform had content, we filtered it" apart from "the
            // platform returned nothing".
            rawFetched++;

            // WATERMARK CHECK: the feed is newest-first, so stop as soon as we hit
            // old content. This is the caller's loop, not the mapping's business.
            if (sinceTs > 0 && pubTime > 0 && pubTime <= sinceTs) {
              hasMore = false;
              nextCursor = undefined;
              break;
            }

            if (mapped.filteredAsForward || mapped.duplicate || mapped.skippedForIdentity) continue;

            allPosts.push(mapped.post);

            if (allPosts.length >= limit) break;
          }
        }
      }
    } catch (e) {
      devLog.warn('bilibili', '动态接口请求失败', errorMessage(e));
    }

    // SUPPLEMENT: medialist API for pure video uploads that may have no dynamic post entry
    if (allPosts.length < limit) {
      try {
        const videoListUrl = `https://api.bilibili.com/x/v2/medialist/resource/list?type=1&biz_id=${uid}&ps=${limit}`;
        const res = await bgFetch(videoListUrl, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Referer': `https://space.bilibili.com/${uid}/video`,
            'User-Agent': BILI_UA,
          },
        });

        if (!res.ok) {
          lastMediaCode = businessCodeFromBody(res.data) ?? (res.status === 412 ? -412 : undefined);
        }
        if (res.ok && res.data) {
          const json = JSON.parse(res.data);
          if (json.code !== 0) {
            lastMediaCode = json.code;
            devLog.warn(
              'bilibili',
              `投稿列表接口返回业务码 ${String(json.code)}`,
              `${String(json.message ?? '')}（频道 ${channel.displayName || channel.accountId}）`,
            );
          } else {
            // code 0 is authoritative, even when media_list is null/empty
            // ("account has no videos") — do not surface a dynamic-feed error then.
            mediaSucceeded = true;
            const mediaList = Array.isArray(json.data?.media_list) ? json.data.media_list : [];
            for (const item of mediaList) {
              const bvid = item.bv_id;
              if (!bvid || seenBvids.has(bvid)) continue;

              const pubTime = item.pubtime ? item.pubtime * 1000 : 0;
              rawFetched++;
              // Skip if it falls within already-covered time range
              if (sinceTs > 0 && pubTime > 0 && pubTime <= sinceTs) continue;

              if (item.upper?.name) authorName = item.upper.name;
              if (item.upper?.face) authorAvatar = toSecureMediaUrl(item.upper.face);

              seenBvids.add(bvid);
              const cover = item.cover || '';
              const title = item.title || '无标题视频';
              const desc = item.intro && item.intro !== '-' ? item.intro : title;

              allPosts.push(buildPost(channel, {
                id: `bilibili_video_${bvid}`,
                title,
                content: desc,
                mediaList: cover ? [{ type: 'video', previewUrl: cover, originalUrl: `https://www.bilibili.com/video/${bvid}` }] : [],
                originalUrl: `https://www.bilibili.com/video/${bvid}`,
                publishedAt: pubTime || Date.now(),
                isRepost: false,
              }));

              if (allPosts.length >= limit) break;
            }
          }
        }
      } catch (e) {
        devLog.warn('bilibili', '投稿列表补充请求失败', errorMessage(e));
      }
    }

    // The medialist supplement above already ran whenever allPosts.length < limit
    // (which includes the empty case). Here we only decide the final error:
    //  - medialist code 0 (authoritative): empty list = "no content", never a
    //    permission error, even if the risk-controlled dynamic feed also failed;
    //  - medialist business code: report that as the real cause;
    //  - dynamic-feed hard failure only matters when medialist itself failed/errored.
    if (allPosts.length === 0) {
      if (mediaSucceeded) {
        // Medialist is authoritative and returned nothing (or only watermark-skipped items).
        return {
          posts: [],
          authorMeta: { name: authorName, avatar: authorAvatar },
          totalFetched: rawFetched,
        };
      }

      const hardCode = lastMediaCode ?? lastDynamicCode;
      if (hardCode !== undefined) {
        return {
          posts: [],
          error: biliCodeError(hardCode),
        };
      }
      return {
        posts: [],
        error: fetchError('not_found', '未获取到B站内容（账号可能无投稿或已注销）'),
      };
    }

    return {
      posts: allPosts.slice(0, limit),
      authorMeta: { name: authorName, avatar: authorAvatar },
      nextCursor,
      hasMore,
      // Raw items before the watermark / onlyOriginal / limit filters: lets the
      // sync log separate "the adapter filtered everything away" from "the
      // platform returned nothing".
      totalFetched: rawFetched,
    };
  },

  // Historical dig: paginate backwards through dynamic feed using offset cursor
  async fetchHistory(
    channel: Channel,
    uid: string,
    limit: number,
    options: FetchOptions,
    authorName?: string,
    authorAvatar?: string,
  ): Promise<FetchResult> {
    const allPosts: Post[] = [];
    const seenBvids = new Set<string>();
    let nextCursor: string | undefined;
    let hasMore = false;

    try {
      const offset = options.cursor || '';
      const dynamicUrl = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=${uid}${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`;
      const res = await bgFetch(dynamicUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Referer': `https://space.bilibili.com/${uid}/dynamic`,
          'User-Agent': BILI_UA,
        },
      });

      if (res.ok && res.data) {
        const json = JSON.parse(res.data) as JsonRecord;
        const data = asRecord(json.data);
        const items = Array.isArray(data.items) ? data.items : [];
        if (json.code === 0 && items.length > 0) {
          hasMore = Boolean(data.has_more);
          if (data.offset) nextCursor = String(data.offset);

          for (const rawItem of items) {
            const mapped = mapSpaceDynamicItem(rawItem, channel, seenBvids, {
              onlyOriginal: options.onlyOriginal,
              // The history path never used `Date.now()` as a per-item fallback in
              // the same way; its ordering comes from the cursor.
              fallbackToNow: false,
            });

            if (mapped.authorName) authorName = mapped.authorName;
            if (mapped.authorAvatar) authorAvatar = mapped.authorAvatar;
            if (mapped.filteredAsForward || mapped.duplicate || mapped.skippedForIdentity) continue;

            allPosts.push(mapped.post);

            if (allPosts.length >= limit) break;
          }
        }
      }
    } catch (e) {
      devLog.warn('bilibili', '回溯动态接口请求失败', errorMessage(e));
    }

    return {
      posts: allPosts,
      authorMeta: { name: authorName, avatar: authorAvatar },
      nextCursor,
      hasMore,
    };
  },
};
