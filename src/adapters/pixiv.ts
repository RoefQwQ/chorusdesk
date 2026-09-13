import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { HttpStatusError, toFetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';

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
        throw new HttpStatusError(res.status, `Pixiv 接口响应异常: HTTP ${res.status}`);
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

      // Construct posts for the target items. The timestamp here is a PLACEHOLDER:
      // `/profile/all` returns ids only, so the real publication time is not
      // available at this point and is filled from each work's ajax endpoint
      // below. The id-to-time estimate is deliberately crude and only has to be
      // monotonic (newer works have larger ids) so an un-enriched post still
      // sorts sensibly; it is never presented as the publication time once the
      // real one arrives. It must NOT be clamped to `Date.now()` — that made an
      // older work look brand new — so it is allowed into the future and the list
      // is re-sorted after enrichment.
      for (const id of targetIds) {
        const estimatedPubTime = Math.max(1400000000000, 1719792000000 + (id - 120000000) * 3150);

        const post = buildPost(channel, {
          id: `pixiv_${id}`,
          title: `Pixiv 插画/作品 #${id}`,
          content: `作品 ID: ${id} (点击卡片直达原图查看)`,
          mediaList: [
            {
              type: 'image',
              // Pixiv's own preview endpoint for a work. It IS a real image
              // (`Content-Type: image/png`, 640 588 bytes, verified with curl),
              // so it renders — but it is a *decorative frame around* the work
              // (title, artist, a small thumbnail), not the work itself, and it
              // is a fixed-size PNG regardless of the artwork's aspect ratio.
              // The real `urls.regular`/`urls.original` are filled in below.
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

      // Fill real previews, real times and all pages of multi-page works from the
      // ajax endpoints. This runs BEFORE the sort: it rewrites `publishedAt`, so
      // sorting first would leave the feed ordered by the estimate.
      await enrichPixivWorkMedia(enrichTargets, signal);

      // Sort strictly newest first, on the times we now believe.
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

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
      // The status decides the class (429 → a real cool-down, 401/403 → auth);
      // a plain throw means the response did not parse, which is `parse`.
      return {
        posts: [],
        error: toFetchError(err, 'Pixiv', 'Pixiv 抓取失败 (请确认当前浏览器是否登录 Pixiv)'),
      };
    }
  },
};

/** Detail fetch pacing. Same rationale as the XHS adapter. */
const PIXIV_ENRICH_INTERVAL_MS = 1200;

/**
 * Fill each work's real publication time and mediaList from the Pixiv ajax
 * illust endpoint.
 *
 * `/ajax/user/{uid}/profile/all` returns **ids only** — it carries no timestamp
 * and no image URLs. The first version of this adapter therefore *invented* a
 * time from the id (`1719792000000 + (id - 120000000) * 3150`) and showed an
 * `embed.pixiv.net/decorate.php` badge as the preview. Measured against the real
 * endpoint, both were wrong in the same direction:
 *
 *   - **The time.** Work 147520202 was published **2026-07-22**; the formula put
 *     it at 2026-09-13 and, because that is in the future, `Math.min(Date.now(),
 *     …)` clamped it to *now* — so every card read 「刚刚」 and the feed's
 *     ordering was meaningless. `createDate`/`uploadDate` were in the response the
 *     whole time.
 *   - **The image.** `decorate.php` is a PNG, but a *fixed-size decorative
 *     frame* around the work rather than the work itself — measured 640 588
 *     bytes, `Content-Type: image/png`, for a 900x1200 original, so it can
 *     never show the artwork at its own ratio. (An earlier version of this
 *     comment claimed it was an HTML page; that was wrong, and it matters:
 *     it means the old badge *rendered*, which is why the defect presented as
 *     "wrong image" and not as "broken image".)
 *
 * Both are fixed from the payload rather than estimated. The cap that made this
 * worse is gone too: it bounded *works enriched*, which is not the scarce
 * resource — a work already fetched from cache costs nothing, and the limit left
 * 7 of 10 cards permanently imageless and misfiled in time. Pacing is per
 * *request* now (see `PIXIV_ENRICH_INTERVAL_MS`), which is the resource the
 * platform actually meters.
 */
async function enrichPixivWorkMedia(posts: Post[], signal?: AbortSignal): Promise<void> {
  let requests = 0;

  for (const post of posts) {
    const id = post.id.slice('pixiv_'.length);
    try {
      if (requests > 0) {
        await new Promise((r) => setTimeout(r, PIXIV_ENRICH_INTERVAL_MS));
      }
      requests++;
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

      // The real publication time. `createDate` is the work's own; `uploadDate`
      // is its fallback (they are equal for an original work, and `uploadDate`
      // is what a re-upload reports). A work whose time is still unreadable keeps
      // the estimate rather than becoming "now".
      const publishedAt = parsePixivDate(record.createDate) ?? parsePixivDate(record.uploadDate);
      if (publishedAt !== undefined) {
        post.publishedAt = publishedAt;
      }

      const urls = record.urls as { original?: string; regular?: string } | undefined;
      const pageCount = typeof record.pageCount === 'number' ? record.pageCount : 1;
      const illustType = typeof record.illustType === 'number' ? record.illustType : 0;
      const original = urls?.original || urls?.regular;
      const regular = urls?.regular || urls?.original;
      if (typeof original !== 'string' || !original) continue;

      // Ugoira (2) has no still pages, and a single-page work has nothing to
      // enumerate: one image either way, with the work page as the click target.
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

      // Multi-page work: the page list is one more request, paced like the rest.
      await new Promise((r) => setTimeout(r, PIXIV_ENRICH_INTERVAL_MS));
      requests++;
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
      // Silent: the estimate and the embed badge stay; a later round retries.
    }
  }
}

/**
 * A Pixiv date string (`2026-07-22T16:14:00+00:00`) as epoch ms.
 *
 * Returns `undefined` for anything unparseable, so a caller can distinguish
 * "no usable date" from a real timestamp — an invalid `Date` would otherwise
 * become `NaN` and sort unpredictably.
 */
function parsePixivDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}
