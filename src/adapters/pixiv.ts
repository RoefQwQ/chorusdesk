import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { errorMessage } from '../utils/errorMessage';

export const pixivAdapter: PlatformAdapter = {
  platform: 'pixiv',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const uid = channel.accountId;

      // 1. Fetch user illust list via Background Fetch (bypasses CORS & uses session cookie)
      const profileUrl = `https://www.pixiv.net/ajax/user/${uid}/profile/all`;
      const signal = options?.signal;
      const [res, userRes] = await Promise.all([
        bgFetch(profileUrl, {
          headers: {
            'Accept': 'application/json',
            'Referer': `https://www.pixiv.net/users/${uid}`,
          },
          signal,
        }),
        bgFetch(`https://www.pixiv.net/ajax/user/${uid}?full=1`, {
          headers: {
            'Accept': 'application/json',
            'Referer': `https://www.pixiv.net/users/${uid}`,
          },
          signal,
        }).catch(() => null),
      ]);

      if (!res.ok) {
        throw new Error(`Pixiv 接口响应异常: HTTP ${res.status}`);
      }

      let authorName = channel.displayName;
      let authorAvatar = channel.avatarUrl;

      if (userRes && userRes.ok && userRes.data) {
        try {
          const uJson = JSON.parse(userRes.data);
          const uBody = uJson?.body;
          if (uBody?.name) authorName = uBody.name;
          const rawAvatar = uBody?.imageBig || uBody?.image;
          if (rawAvatar && typeof rawAvatar === 'string' && !rawAvatar.includes('no_profile')) {
            authorAvatar = rawAvatar;
          }
        } catch {
          // Author-meta fetch is supplementary; the profile parse below still runs.
        }
      }

      const json = JSON.parse(res.data);
      if (json.error) {
        throw new Error(json.message || 'Pixiv 返回错误');
      }

      const illustsObj = json.body?.illusts || {};
      const mangaObj = json.body?.manga || {};
      const allIds = [...Object.keys(illustsObj), ...Object.keys(mangaObj)]
        .map(Number)
        .sort((a, b) => b - a);

      const isHistoryDig = Boolean(options?.cursor);
      const offset = isHistoryDig ? Math.max(Number(options?.cursor) || 0, 0) : 0;
      const targetIds = allIds.slice(offset, offset + limit);

      const posts: Post[] = [];

      // Filled below from each work's ajax endpoint — the profile/all API
      // only returns ids, so the loop starts with the public embed badge.
      const enrichTargets: Post[] = [];

      // Construct posts for the target items with stable estimated timestamps based on monotonic ID
      for (const id of targetIds) {
        // Linear approximation anchor: ID 120,000,000 ~ 2024-07-01 (1719792000000 ms), rate ~3150ms per ID
        const estimatedPubTime = Math.min(
          Date.now(),
          Math.max(1400000000000, 1719792000000 + (id - 120000000) * 3150)
        );

        const post = buildPost(channel, {
          id: `pixiv_${id}`,
          title: `Pixiv 插画/作品 #${id}`,
          content: `作品 ID: ${id} (点击卡片直达原图查看)`,
          mediaList: [
            {
              type: 'image',
              // Pixiv embed preview proxy
              previewUrl: `https://embed.pixiv.net/decorate.php?illust_id=${id}`,
              originalUrl: `https://www.pixiv.net/artworks/${id}`,
            },
          ],
          originalUrl: `https://www.pixiv.net/artworks/${id}`,
          publishedAt: estimatedPubTime,
        });
        enrichTargets.push(post);
        posts.push(post);
      }

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);
      // Fill real previews and all pages of multi-page works from the ajax
      // endpoint — the profile/all API only returns ids, and the embed badge
      // preview is not the work itself.
      await enrichPixivWorkMedia(enrichTargets, signal);

      const nextOffset = offset + targetIds.length;
      const hasMore = nextOffset < allIds.length;

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: hasMore ? String(nextOffset) : undefined,
        hasMore,
      };
    } catch (err: unknown) {
      const message = errorMessage(err);
      return {
        posts: [],
        error: fetchError('network', message || 'Pixiv 抓取失败 (请确认当前浏览器是否登录 Pixiv)'),
      };
    }
  },
};

/** Detail fetch pacing and per-round cap — same rationale as the XHS adapter. */
const PIXIV_ENRICH_MAX_PER_ROUND = 3;
const PIXIV_ENRICH_INTERVAL_MS = 1200;

/**
 * Fill each work's mediaList from the Pixiv ajax illust endpoint.
 *
 * `/ajax/user/{uid}/profile/all` only lists ids. `/ajax/illust/{id}` carries
 * the real preview urls (`illustType` 0/1: `urls.original/regular`; 2=ugoira)
 * and `pageCount` — a multi-page manga's remaining pages come from
 * `/ajax/illust/{id}/pages`. i.pximg.net hotlink-protects images, so display
 * goes through the extension's PROXY_IMAGE (Referer: pixiv.net) exactly like
 * every other pximg URL in the app; failures are silent (the embed badge
 * stays, a later round retries).
 */
async function enrichPixivWorkMedia(posts: Post[], signal?: AbortSignal): Promise<void> {
  let fetched = 0;

  for (const post of posts) {
    if (fetched >= PIXIV_ENRICH_MAX_PER_ROUND) break;
    if (fetched > 0) {
      await new Promise((r) => setTimeout(r, PIXIV_ENRICH_INTERVAL_MS));
    }
    fetched++;

    const id = post.id.slice('pixiv_'.length);
    try {
      const res = await bgFetch(`https://www.pixiv.net/ajax/illust/${id}`, {
        headers: {
          Accept: 'application/json',
          Referer: `https://www.pixiv.net/artworks/${id}`,
        },
        signal,
      });
      if (!res.ok) continue;

      let json: unknown;
      try {
        json = JSON.parse(res.data);
      } catch {
        continue;
      }
      const body =
        typeof json === 'object' && json !== null && 'body' in json
          ? (json as Record<string, unknown>).body
          : undefined;
      if (typeof body !== 'object' || body === null) continue;
      const record = body as Record<string, unknown>;

      const urls = record.urls as { original?: string; regular?: string } | undefined;
      const pageCount = typeof record.pageCount === 'number' ? record.pageCount : 1;
      const illustType = typeof record.illustType === 'number' ? record.illustType : 0;
      const original = urls?.original || urls?.regular;
      const regular = urls?.regular || urls?.original;
      if (typeof original !== 'string' || !original) continue;

      // Ugoira and single-page works: one image (ugoira has no still pages).
      if (illustType !== 0 && illustType !== 1) {
        post.mediaList = [
          {
            type: 'image',
            previewUrl: typeof regular === 'string' ? regular : original,
            originalUrl: `https://www.pixiv.net/artworks/${id}`,
          },
        ];
        continue;
      }

      if (pageCount <= 1) {
        post.mediaList = [
          {
            type: 'image',
            previewUrl: typeof regular === 'string' ? regular : original,
            originalUrl: original,
          },
        ];
        continue;
      }

      // Multi-page work: fetch the page list.
      await new Promise((r) => setTimeout(r, PIXIV_ENRICH_INTERVAL_MS));
      const pagesRes = await bgFetch(`https://www.pixiv.net/ajax/illust/${id}/pages`, {
        headers: { Accept: 'application/json', Referer: `https://www.pixiv.net/artworks/${id}` },
        signal,
      });
      if (!pagesRes.ok) continue;
      let pagesJson: unknown;
      try {
        pagesJson = JSON.parse(pagesRes.data);
      } catch {
        continue;
      }
      const pagesBody =
        typeof pagesJson === 'object' && pagesJson !== null && 'body' in pagesJson
          ? (pagesJson as Record<string, unknown>).body
          : undefined;
      if (!Array.isArray(pagesBody)) continue;

      const mediaList: MediaItem[] = [];
      for (const page of pagesBody) {
        if (typeof page !== 'object' || page === null) continue;
        const pr = page as Record<string, unknown>;
        const pageUrls = pr.urls as { original?: string; regular?: string } | undefined;
        const pageOriginal = pageUrls?.original || pageUrls?.regular;
        if (typeof pageOriginal === 'string' && pageOriginal) {
          mediaList.push({
            type: 'image',
            previewUrl: pageUrls?.regular || pageOriginal,
            originalUrl: pageOriginal,
          });
        }
      }
      if (mediaList.length > 0) {
        post.mediaList = mediaList;
      }
    } catch {
      // Silent: embed badge stays; retry on a later round.
    }
  }
}
