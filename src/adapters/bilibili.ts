import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions, FetchError } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../utils/http';
import { toSecureMediaUrl } from '../utils/media';
import type { JsonRecord } from '../utils/json';
import { asRecord } from '../utils/json';

// Mirror the real site's UA. Bilibili risk-control rejects the default fetch UA.
const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Map Bilibili business error codes to a structured, user-facing error. */
function biliCodeError(code: number): FetchError {
  switch (code) {
    case -101:
      return fetchError('auth', 'B站未登录或登录已过期，请检查登录状态');
    case -352:
      return fetchError('rate_limit', 'B站风控校验失败，请稍后重试或完成人机验证', true);
    case -403:
      return fetchError('auth', 'B站接口拒绝访问（权限不足或签名失效），请确认登录状态后重试');
    case -412:
      return fetchError('rate_limit', 'B站请求被拦截（风控），请稍后重试', true);
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

      if (res.ok && res.data) {
        const json = JSON.parse(res.data) as JsonRecord;
        if (json.code !== 0) {
          lastDynamicCode = json.code as number;
          console.warn('[Bilibili] dynamic feed returned code', json.code, json.message);
        } else if (json.data) {
          const data = asRecord(json.data);
          const items = Array.isArray(data.items) ? data.items : [];
          if (data.has_more) hasMore = true;
          if (data.offset) nextCursor = String(data.offset);

          for (const rawItem of items) {
            const item = asRecord(rawItem);
            const modules = asRecord(item.modules);
            const moduleAuthor = asRecord(modules.module_author);
            const moduleDynamic = asRecord(modules.module_dynamic);

            if (moduleAuthor.name) authorName = String(moduleAuthor.name);
            if (moduleAuthor.face) authorAvatar = toSecureMediaUrl(String(moduleAuthor.face));

            const pubTime = moduleAuthor.pub_ts ? Number(moduleAuthor.pub_ts) * 1000 : 0;

            // WATERMARK CHECK: dynamic feed is newest-first, stop as soon as we hit old content
            if (sinceTs > 0 && pubTime > 0 && pubTime <= sinceTs) {
              hasMore = false;
              nextCursor = undefined;
              break;
            }

            const isForward = item.type === 'DYNAMIC_TYPE_FORWARD' || Boolean(item.orig);
            if (options?.onlyOriginal && isForward) continue;

            const major = asRecord(moduleDynamic.major);
            const archive = asRecord(major.archive);
            const archiveBvid = typeof archive.bvid === 'string' ? archive.bvid : undefined;
            if (archiveBvid && seenBvids.has(archiveBvid)) continue;
            if (archiveBvid) seenBvids.add(archiveBvid);

            const idStr =
              (typeof item.id_str === 'string' && item.id_str) ||
              String(asRecord(item.basic).comment_id_str ?? item.id ?? '');
            if (!archiveBvid && !idStr) continue; // no stable identity — skip rather than fabricate
            const postId = archiveBvid
              ? `bilibili_video_${archiveBvid}`
              : `bilibili_${idStr}`;

            const text =
              (typeof asRecord(moduleDynamic.desc).text === 'string' && asRecord(moduleDynamic.desc).text) ||
              (typeof archive.desc === 'string' && archive.desc) ||
              '';
            const title = typeof archive.title === 'string' ? archive.title : '';

            const mediaList: Post['mediaList'] = [];
            if (major.archive) {
              mediaList.push({
                type: 'video',
                previewUrl: String(archive.cover ?? ''),
                originalUrl: `https://www.bilibili.com/video/${archiveBvid}`,
              });
            }
            const draw = asRecord(major.draw);
            if (Array.isArray(draw.items)) {
              for (const rawImg of draw.items) {
                const img = asRecord(rawImg);
                const src = typeof img.src === 'string' ? img.src : '';
                if (src) mediaList.push({ type: 'image', previewUrl: src, originalUrl: src });
              }
            }
            // Forward posts: archive/draw media live on the original item, not the forward wrapper.
            if (isForward && item.orig) {
              const origMajor = asRecord(asRecord(asRecord(asRecord(item.orig).modules).module_dynamic).major);
              const origArchive = asRecord(origMajor.archive);
              const origBvid = typeof origArchive.bvid === 'string' ? origArchive.bvid : '';
              if (origMajor.archive && origBvid && !mediaList.some((m) => m.type === 'video' && m.originalUrl.endsWith(origBvid))) {
                mediaList.push({
                  type: 'video',
                  previewUrl: String(origArchive.cover ?? ''),
                  originalUrl: `https://www.bilibili.com/video/${origBvid}`,
                });
              }
              const origDraw = asRecord(origMajor.draw);
              if (Array.isArray(origDraw.items)) {
                for (const rawImg of origDraw.items) {
                  const img = asRecord(rawImg);
                  const src = typeof img.src === 'string' ? img.src : '';
                  if (src && !mediaList.some((m) => m.type === 'image' && m.previewUrl === src)) {
                    mediaList.push({ type: 'image', previewUrl: src, originalUrl: src });
                  }
                }
              }
            }

            allPosts.push(buildPost(channel, {
              id: postId,
              title,
              content: typeof text === 'string' ? (text || title || '（分享动态）') : (title || '（分享动态）'),
              mediaList,
              originalUrl: archiveBvid
                ? `https://www.bilibili.com/video/${archiveBvid}`
                : `https://t.bilibili.com/${idStr}`,
              publishedAt: pubTime || Date.now(),
              isRepost: isForward,
            }));

            if (allPosts.length >= limit) break;
          }
        }
      }
    } catch (e) {
      console.warn('[Bilibili] dynamic feed fetch failed:', e);
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

        if (res.ok && res.data) {
          const json = JSON.parse(res.data);
          if (json.code !== 0) {
            lastMediaCode = json.code;
            console.warn('[Bilibili] medialist returned code', json.code, json.message);
          } else {
            // code 0 is authoritative, even when media_list is null/empty
            // ("account has no videos") — do not surface a dynamic-feed error then.
            mediaSucceeded = true;
            const mediaList = Array.isArray(json.data?.media_list) ? json.data.media_list : [];
            for (const item of mediaList) {
              const bvid = item.bv_id;
              if (!bvid || seenBvids.has(bvid)) continue;

              const pubTime = item.pubtime ? item.pubtime * 1000 : 0;
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
        console.warn('[Bilibili] medialist supplement failed:', e);
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
            const item = asRecord(rawItem);
            const modules = asRecord(item.modules);
            const moduleAuthor = asRecord(modules.module_author);
            const moduleDynamic = asRecord(modules.module_dynamic);

            if (moduleAuthor.name) authorName = String(moduleAuthor.name);
            if (moduleAuthor.face) authorAvatar = toSecureMediaUrl(String(moduleAuthor.face));

            const isForward = item.type === 'DYNAMIC_TYPE_FORWARD' || Boolean(item.orig);
            if (options.onlyOriginal && isForward) continue;

            const major = asRecord(moduleDynamic.major);
            const archive = asRecord(major.archive);
            const archiveBvid = typeof archive.bvid === 'string' ? archive.bvid : undefined;
            if (archiveBvid && seenBvids.has(archiveBvid)) continue;
            if (archiveBvid) seenBvids.add(archiveBvid);
            const idStr =
              (typeof item.id_str === 'string' && item.id_str) ||
              String(asRecord(item.basic).comment_id_str ?? item.id ?? '');
            if (!archiveBvid && !idStr) continue; // no stable identity — skip rather than fabricate
            const postId = archiveBvid
              ? `bilibili_video_${archiveBvid}`
              : `bilibili_${idStr}`;
            const pubTime = moduleAuthor.pub_ts ? Number(moduleAuthor.pub_ts) * 1000 : Date.now();
            const text =
              (typeof asRecord(moduleDynamic.desc).text === 'string' && asRecord(moduleDynamic.desc).text) ||
              (typeof archive.desc === 'string' && archive.desc) ||
              '';
            const title = typeof archive.title === 'string' ? archive.title : '';

            const mediaList: Post['mediaList'] = [];
            if (major.archive) {
              mediaList.push({
                type: 'video',
                previewUrl: String(archive.cover ?? ''),
                originalUrl: `https://www.bilibili.com/video/${archiveBvid}`,
              });
            }
            const draw = asRecord(major.draw);
            if (Array.isArray(draw.items)) {
              for (const rawImg of draw.items) {
                const img = asRecord(rawImg);
                const src = typeof img.src === 'string' ? img.src : '';
                if (src) mediaList.push({ type: 'image', previewUrl: src, originalUrl: src });
              }
            }
            // Forward posts: archive/draw media live on the original item, not the forward wrapper.
            if (isForward && item.orig) {
              const origMajor = asRecord(asRecord(asRecord(asRecord(item.orig).modules).module_dynamic).major);
              const origArchive = asRecord(origMajor.archive);
              const origBvid = typeof origArchive.bvid === 'string' ? origArchive.bvid : '';
              if (origMajor.archive && origBvid && !mediaList.some((m) => m.type === 'video' && m.originalUrl.endsWith(origBvid))) {
                mediaList.push({
                  type: 'video',
                  previewUrl: String(origArchive.cover ?? ''),
                  originalUrl: `https://www.bilibili.com/video/${origBvid}`,
                });
              }
              const origDraw = asRecord(origMajor.draw);
              if (Array.isArray(origDraw.items)) {
                for (const rawImg of origDraw.items) {
                  const img = asRecord(rawImg);
                  const src = typeof img.src === 'string' ? img.src : '';
                  if (src && !mediaList.some((m) => m.type === 'image' && m.previewUrl === src)) {
                    mediaList.push({ type: 'image', previewUrl: src, originalUrl: src });
                  }
                }
              }
            }

            allPosts.push(buildPost(channel, {
              id: postId,
              title,
              content: typeof text === 'string' ? (text || title || '（分享动态）') : (title || '（分享动态）'),
              mediaList,
              originalUrl: archiveBvid
                ? `https://www.bilibili.com/video/${archiveBvid}`
                : `https://t.bilibili.com/${idStr}`,
              publishedAt: pubTime,
              isRepost: isForward,
            }));

            if (allPosts.length >= limit) break;
          }
        }
      }
    } catch (e) {
      console.warn('[Bilibili] historical dynamic fetch failed:', e);
    }

    return {
      posts: allPosts,
      authorMeta: { name: authorName, avatar: authorAvatar },
      nextCursor,
      hasMore,
    };
  },

  async checkAuthStatus(): Promise<{ loggedIn: boolean; username?: string }> {
    if (typeof chrome === 'undefined' || !chrome.cookies?.get) return { loggedIn: false };
    try {
      const sessdata = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'SESSDATA' });
      const dedeUserId = await chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'DedeUserID' });
      return { loggedIn: Boolean(sessdata?.value || dedeUserId?.value) };
    } catch {
      return { loggedIn: false };
    }
  },
};
