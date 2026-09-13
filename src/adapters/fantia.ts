import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError, HttpStatusError, toFetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';

interface FantiaThumb {
  main?: string;
  original?: string;
}

interface FantiaPost {
  id: number | string;
  title?: string;
  comment?: string;
  posted_at?: string;
  thumb?: FantiaThumb;
  /**
   * The list's own single-image fallback. Measured on the live club endpoint
   * (2026-09-14): `thumb` is `null` for 4 of the 6 newest posts while
   * `thumb_micro` carries a real `https://c.fantia.jp/.../micro_*.jpg` for every
   * one of them. Reading only `thumb.main` therefore dropped the one image the
   * feed already had, so those cards rendered with no media at all.
   */
  thumb_micro?: string;
  uri?: { show?: string };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Read a string field from an object-like value without assuming its whole shape. */
function readStringField(obj: unknown, field: string): string | undefined {
  if (typeof obj !== 'object' || obj === null || !(field in obj)) return undefined;
  // `field in obj` is already verified above; the cast only bridges TS's inability
  // to index an arbitrary-keyed object with a dynamic string.
  return asString((obj as Record<string, unknown>)[field]);
}

function parseThumb(value: unknown): FantiaThumb {
  return {
    main: readStringField(value, 'main'),
    original: readStringField(value, 'original'),
  };
}

function parsePost(value: unknown): FantiaPost | undefined {
  if (typeof value !== 'object' || value === null || !('id' in value)) return undefined;
  const id = value.id;
  if (typeof id !== 'number' && typeof id !== 'string') return undefined;

  const uriShow = readStringField('uri' in value ? value.uri : undefined, 'show');

  return {
    id,
    title: readStringField(value, 'title'),
    comment: readStringField(value, 'comment'),
    posted_at: readStringField(value, 'posted_at'),
    thumb: parseThumb('thumb' in value ? value.thumb : undefined),
    thumb_micro: readStringField(value, 'thumb_micro'),
    uri: uriShow ? { show: uriShow } : undefined,
  };
}

export const fantiaAdapter: PlatformAdapter = {
  platform: 'fantia',

  // `recent_posts` is a fixed preview and the endpoint has no cursor, so
  // `hasMore` is always false. That value is honest about the page, but the
  // platform never stated "no more exist" — see `paginates` in `types.ts`.
  paginates: false,

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const clubId = channel.accountId;
      const signal = options?.signal;

      // Fetch fanclub detail (embeds recent_posts) via Background fetch to bypass CORS
      const apiUrl = `https://fantia.jp/api/v1/fanclubs/${encodeURIComponent(clubId)}`;
      const res = await bgFetch(apiUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal,
      });

      if (!res.ok) {
        throw new HttpStatusError(res.status, `Fantia API 响应异常: HTTP ${res.status}`);
      }

      let json: unknown;
      try {
        json = JSON.parse(res.data);
      } catch {
        throw new Error('Fantia API 返回了无法解析的 JSON');
      }

      const fanclub = typeof json === 'object' && json !== null && 'fanclub' in json ? json.fanclub : undefined;
      if (typeof fanclub !== 'object' || fanclub === null) {
        throw new Error('Fantia API 响应缺少 fanclub 字段');
      }

      // Author meta from the fanclub object
      const authorName =
        readStringField(fanclub, 'creator_name') ||
        readStringField(fanclub, 'fanclub_name_or_creator_name') ||
        channel.displayName;
      const icon = parseThumb('icon' in fanclub ? fanclub.icon : undefined);
      const authorAvatar = icon.main || channel.avatarUrl;

      if (!('recent_posts' in fanclub) || !Array.isArray(fanclub.recent_posts)) {
        throw new Error('Fantia API 响应缺少 recent_posts 字段');
      }

      const parsedPosts = fanclub.recent_posts
        .map(parsePost)
        .filter((p): p is FantiaPost => Boolean(p));

      if (parsedPosts.length === 0) {
        // Explicitly observable empty result, not a silent success
        return {
          posts: [],
          authorMeta: {
            name: authorName,
            avatar: authorAvatar,
          },
          nextCursor: undefined,
          hasMore: false,
          error: fetchError('not_found', 'Fantia 该俱乐部暂无可见投稿 (recent_posts 为空)'),
        };
      }

      // `recent_posts` is a fixed preview (this endpoint has no cursor pagination),
      // so a historical dig has nothing older to return.
      if (options?.cursor) {
        return {
          posts: [],
          authorMeta: {
            name: authorName,
            avatar: authorAvatar,
          },
          nextCursor: undefined,
          hasMore: false,
        };
      }

      // Image posts whose media will be filled from their detail pages below.
      const enrichTargets: Post[] = [];
      /** Posts whose list entry carried no `comment` — the detail fetch owns their body. */
      const needsBody = new Set<string>();

      const posts: Post[] = parsedPosts.slice(0, limit).map((p) => {
        const mediaList: MediaItem[] = [];
        // The list offers a full `thumb` object on some posts and only
        // `thumb_micro` on others (measured: 4 of the 6 newest). Either is a
        // real image; reading neither left the card empty.
        const thumbUrl = p.thumb?.main || p.thumb_micro;
        if (thumbUrl) {
          mediaList.push({
            type: 'image',
            previewUrl: thumbUrl,
            originalUrl: p.thumb?.original || thumbUrl,
          });
        }

        const parsedTime = p.posted_at ? new Date(p.posted_at).getTime() : Date.now();
        const pubDate = Number.isFinite(parsedTime) ? parsedTime : Date.now();
        const postUrl = p.uri?.show ? `https://fantia.jp${p.uri.show}` : `https://fantia.jp/posts/${p.id}`;

        const post = buildPost(channel, {
          id: `fantia_${p.id}`,
          title: p.title || 'Fantia 投稿',
          // `comment` is USUALLY plain text, but a post written with Fantia's
          // rich-text editor carries a **Quill delta** there instead
          // (`{"ops":[{"insert":"…"}]}`) — measured on a real post
          // (id 4228374). Rendering that verbatim, which is what the user saw, puts
          // raw JSON in the feed. `fantiaCommentText` decodes it and leaves plain
          // text untouched.
          content: fantiaCommentText(p.comment, p.title),
          mediaList,
          originalUrl: postUrl,
          publishedAt: pubDate,
        });
        // **The list's `comment` is not the post's body.** Measured on the live
        // club endpoint: it is `null` for 4 of the 6 newest posts — including the
        // one in the user's screenshot — while the detail response for those same
        // ids carries real text. Absence in the list is therefore a *missing*
        // value, not an empty post, and the body has to be taken from the detail
        // fetch below. The marker is set here, rather than re-derived there, so
        // the decision lives in one place; `''` never occurs, because
        // `fantiaCommentText` falls back to the title.
        //
        // Every post stays a candidate: a body-only need does not excuse skipping
        // the gallery, and a gallery-only need does not excuse skipping the body.
        if (!p.comment) needsBody.add(post.id);
        enrichTargets.push(post);
        return post;
      });
      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      // Fill posts' media and body from their detail pages (the fanclub API
      // carries a single thumb and no body for most posts).
      const enrich = await enrichFantiaPostMedia(enrichTargets, needsBody, signal);

      // No cursor pagination available on this endpoint
      const hasMore = false;

      // A rejected detail request degrades the page without falsifying it: the
      // posts are real and their list data is correct, but bodies and galleries
      // stay at whatever the list carried. Saying so is the difference between
      // "the platform refused" and "this platform just looks poor" — measured on
      // the user's session, where every detail request returned HTTP 403 while the
      // sync still reported a clean 0-new-posts result.
      const warnings =
        enrich.failed > 0
          ? [
              `${enrich.failed}/${enrich.attempted} 个投稿详情请求被拒绝（HTTP 403），正文与图集沿用列表数据`,
            ]
          : undefined;

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: undefined,
        hasMore,
        ...(warnings ? { degraded: true, warnings } : {}),
      };
    } catch (err: unknown) {
      // Same as pixiv: an HTTP status keeps its class, anything else is `parse`
      // (a missing/renamed field is a schema change, not a network fault).
      return {
        posts: [],
        error: toFetchError(err, 'Fantia', 'Fantia 更新抓取失败 (请确认是否在浏览器中登录过 Fantia)'),
      };
    }
  },
};

/**
 * A Fantia post's body text from its `comment` field.
 *
 * `comment` is normally plain text (measured: most posts), but a post composed in
 * Fantia's rich-text editor stores a **Quill delta** there instead —
 * `{"ops":[{"insert":"…"},{"attributes":…},{"insert":"\n"}]}` — because the field
 * doubles as the editor's document. Measured on a real post (id 4228374): the
 * entire body arrived as one JSON string, which the adapter wrote straight into
 * `Post.content`, so the feed showed `{"ops":[{"insert":"本編→"},…` verbatim.
 *
 * Only `insert` values are text; `attributes` and any other keys are formatting
 * and are dropped. An `insert` that is not a string is an embedded object (an
 * image or a link card) and contributes nothing here — the post's images come
 * from `post_contents` instead.
 *
 * Anything that does not parse as a delta is returned as-is: a plain-text body
 * that merely looks like JSON must not be eaten.
 */
export function fantiaCommentText(comment: string | undefined, title?: string): string {
  const raw = (comment || '').trim();
  if (!raw) return (title || '').slice(0, 300);
  if (!raw.startsWith('{')) return raw.slice(0, 300);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON after all: a plain body that starts with `{`. Keep it.
    return raw.slice(0, 300);
  }

  const ops = (parsed as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops)) return raw.slice(0, 300);

  const text = ops
    .map((op) => {
      const insert = (op as { insert?: unknown } | null)?.insert;
      return typeof insert === 'string' ? insert : '';
    })
    .join('')
    .trim();

  // A delta with no readable text (an image-only post): fall back to the title
  // rather than storing an empty body.
  return (text || title || '').slice(0, 300);
}

/**
 * Detail fetch pacing and per-round cap.
 *
 * The cap was 3, inherited by analogy with the XHS adapter — whose number is
 * justified by that platform's account risk control. Fantia has no such measured
 * constraint, and the cap was leaving the page *incorrect* rather than merely
 * unenriched: the club list is a fixed 6-item preview whose `comment` is `null`
 * on most posts, so at 3 fetches per round the 4th–6th posts kept the title as
 * their body — the same defect this function exists to fix, just for fewer rows.
 *
 * Measured 2026-09-14: 6 sequential detail GETs at 300 ms spacing returned 200 for
 * all 6, in 3.9 s total. The page size bounds the work (at most 6 requests per
 * round, whatever `limit` is), so the cost is fixed and small; the interval keeps
 * the pacing. Set to the preview size so one sync corrects the whole page.
 */
const FANTIA_ENRICH_MAX_PER_ROUND = 6;
const FANTIA_ENRICH_INTERVAL_MS = 1200;

/**
 * Fill posts' media and body from the Fantia post-detail API.
 *
 * The fanclub endpoint exposes a single thumb and a `comment` that is `null` for
 * most posts. The post API carries the full gallery in `post_contents` blocks
 * **and the real body text in `comment`** — one request answers both, so
 * discarding the second was pure loss.
 *
 * Two field names here were wrong in a way nothing could see, because both made
 * the loop a no-op:
 *
 *   - the body key is **`post_contents`** (plural); the code read `post_content`,
 *     which the payload does not contain;
 *   - a gallery block's category is **`photo_gallery`**, not `photo`.
 *
 * Measured against the real endpoint: `record.photos` does not exist either — the
 * URLs are a flat array of strings in **`post_content_photos_micro`**. The `micro_`
 * variant is a real, displayable JPEG (verified by downloading one: `ffd8ffe0…JFIF`),
 * and `original_`/`main_` answers 403, so the micro URL is what we keep.
 *
 * A post's gallery can be several blocks; every block is walked.
 *
 * `needsBody` holds the posts whose list entry carried no `comment` at all — the
 * detail response is the only source of a body for them (see the marker set in
 * `fetchLatest`).
 *
 * Note what is **not** here: a second "is a body needed" test in the candidate
 * filter. It would be redundant rather than protective — the list carries at most
 * one image per post (`thumb` *or* `thumb_micro`), so `mediaList.length` is 0 or 1
 * for every post this adapter builds and the media test already admits them all.
 * A body that only the detail has is therefore never skipped; if the list ever
 * grows multi-image posts, the marker still decides the body and the media test
 * still decides the gallery, and the two consumers below stay independent.
 */
async function enrichFantiaPostMedia(
  posts: Post[],
  needsBody: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<{ attempted: number; failed: number }> {
  const candidates = posts.filter(
    (p) =>
      /^fantia_\d+$/.test(p.id) &&
      p.mediaList.length <= 1 &&
      p.mediaList.every((m) => m.type === 'image'),
  );
  let fetched = 0;
  let failed = 0;

  for (const post of candidates) {
    if (fetched >= FANTIA_ENRICH_MAX_PER_ROUND) break;
    if (fetched > 0) {
      await new Promise((r) => setTimeout(r, FANTIA_ENRICH_INTERVAL_MS));
    }
    fetched++;

    const postId = post.id.slice('fantia_'.length);
    try {
      const res = await bgFetch(`https://fantia.jp/api/v1/posts/${postId}`, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal,
      });
      // A rejected detail request is counted, not swallowed: it means the body and
      // the gallery for this post could not be improved, and the caller has to be
      // able to say so. Measured on the user's session (2026-09-14): all three
      // detail requests returned HTTP 403 while the club list returned 200, so
      // every post kept its one-image list thumb and the body it already had.
      if (!res.ok) {
        failed++;
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(res.data);
      } catch {
        continue;
      }
      const postBody =
        typeof json === 'object' && json !== null && 'post' in json
          ? (json as Record<string, unknown>).post
          : undefined;
      if (typeof postBody !== 'object' || postBody === null) continue;

      // The body first: it is the field the list genuinely does not have, and it
      // arrives in the same response the gallery does.
      if (needsBody.has(post.id)) {
        const body = fantiaCommentText(readStringField(postBody, 'comment'), post.title);
        // Only ever fill in — an empty decode leaves the title fallback in place.
        if (body) post.content = body;
      }

      const contents = (postBody as Record<string, unknown>).post_contents;
      if (!Array.isArray(contents)) continue;

      const mediaList: MediaItem[] = [];
      const seen = new Set<string>();
      for (const block of contents) {
        if (typeof block !== 'object' || block === null) continue;
        const record = block as Record<string, unknown>;
        // `photo_gallery` is the only block category carrying images.
        if (record.category !== 'photo_gallery') continue;
        const micro = record.post_content_photos_micro;
        if (!Array.isArray(micro)) continue;
        for (const url of micro) {
          if (typeof url !== 'string' || !url || seen.has(url)) continue;
          // Only http(s): a page-supplied `javascript:` must never reach `<img src>`.
          if (!/^https?:\/\//i.test(url)) continue;
          seen.add(url);
          mediaList.push({ type: 'image', previewUrl: url, originalUrl: url });
        }
      }
      if (mediaList.length > post.mediaList.length) {
        post.mediaList = mediaList;
      }
    } catch {
      // Network/parse failure: the thumb and body stay as they are, and the
      // failure is counted so the caller can report it rather than presenting a
      // silently-degraded sync as a clean one.
      failed++;
    }
  }
  return { attempted: fetched, failed };
}
