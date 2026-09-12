import type { Channel, Post, MediaItem } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { hasArticleMarkup, sanitizeArticleHtml } from '../utils/sanitizeHtml';
import { errorMessage } from '../utils/errorMessage';
import { devLog } from '../utils/devLog';

/**
 * Storage ceiling for one RSS body.
 *
 * Sized from real articles: the measured plain-text length of a full post in a
 * representative newsletter feed is 3.7k-14.9k characters, so this covers all of
 * them while still bounding a pathological feed (a whole book in one field).
 * A cap that truncates would defeat the point of storing the article at all.
 */
export const RSS_MAX_CONTENT_CHARS = 20000;

/**
 * Storage ceiling for one article's *HTML*.
 *
 * Sized from the same measurement as the plain-text ceiling: the markup of a
 * full newsletter article ran 31144 characters for 12798 characters of text
 * (≈2.4×), so the largest measured article needs ≈36k. This leaves room for
 * heavier markup while still bounding a hostile feed.
 */
export const RSS_MAX_HTML_CHARS = 60000;

/**
 * Normalize a feed item's body for storage.
 *
 * Exported so the ceiling and its trim behaviour are testable without standing
 * up a DOM: everything above this line in `fetchLatest` needs `document`, this
 * does not.
 */
export function normalizeRssContent(rawText: string): string {
  const text = rawText.trim();
  if (text.length <= RSS_MAX_CONTENT_CHARS) return text;
  return `${text.slice(0, RSS_MAX_CONTENT_CHARS).trimEnd()}…`;
}


/**
 * Deterministic short hash for feed item guids. `btoa` threw on non-ASCII
 * guids (CJK feed titles are common), so encode UTF-8 bytes via TextEncoder
 * and fold to a base36 string instead.
 */
function stableHash(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const b of bytes) {
    h1 = (h1 ^ b) * 0x01000193 >>> 0;
    h2 = (h2 + b + (h2 << 6) + (h2 << 16)) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 32);
}

/**
 * The feed URL a page advertises about itself, if any.
 *
 * `<link rel="alternate" type="application/rss+xml|atom+xml" href="…">` is the
 * standard autodiscovery mechanism, and it is the only reason subscribing to a
 * site root works anywhere. Measured 2026-09-13 on the failing source: the root
 * serves `text/html` containing
 * `<link rel="alternate" type="application/rss+xml" href="…/rss.xml">`, while
 * `/rss.xml` serves `application/rss+xml`.
 *
 * The href comes from a page we do not control, so it is resolved against the
 * page's own URL and restricted to http(s) — a `javascript:` or `file:` href
 * must not become a fetch. `bgFetch` would reject those too (its URL policy is
 * the authority), but the check belongs here so the log cannot claim we tried.
 *
 * Hand-rolled rather than `DOMParser` because the input is `text/html` fed to a
 * `text/xml` parser above, which yields a `parsererror` document and may still
 * expose the markup as text.
 */
function findAdvertisedFeed(html: string, baseUrl: string): string | null {
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of linkTags) {
    if (!/rel\s*=\s*["']?alternate["']?/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml["']?/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const resolved = new URL(href, baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.toString();
    } catch {
      // Unparseable href: keep looking rather than failing the whole fetch.
    }
  }
  return null;
}

/**
 * Fetch one URL and classify what came back.
 *
 * A discriminated union rather than throwing, because the three outcomes lead to
 * three different `FetchError` codes and the caller must not conflate them:
 * `http-error` is network/not_found, `not-a-feed` is parse, `ok` proceeds.
 * `bgFetch` already logged the body's shape (media type + kind), so the adapter
 * never has to guess why the XML parse failed.
 */
type FeedDocument =
  | { kind: 'ok'; document: Document }
  | { kind: 'not-a-feed'; body: string }
  | { kind: 'http-error'; status: number };

async function fetchFeedDocument(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<FeedDocument> {
  const res = await bgFetch(url, { headers, signal });
  if (!res.ok) return { kind: 'http-error', status: res.status };

  const doc = new DOMParser().parseFromString(res.data, 'text/xml');
  if (doc.querySelector('parsererror')) return { kind: 'not-a-feed', body: res.data };
  return { kind: 'ok', document: doc };
}

export const rssAdapter: PlatformAdapter = {
  platform: 'rss',
  // A feed's images are hosted wherever the publisher likes, and a publisher CDN that
  // blocks hotlinking answers 403 to the proxy — the archive then retries every item
  // on every run for no result. See the field's note in `adapters/types.ts`.
  archivesMedia: false,

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const feedUrl = channel.profileUrl || channel.accountId;

      const FEED_HEADERS = {
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      };

      let doc = await fetchFeedDocument(feedUrl, FEED_HEADERS, options?.signal);

      // Not a feed? A site root commonly serves HTML that ADVERTISES its feed
      // with `<link rel="alternate" type="application/rss+xml" href="…">`, which
      // is how every feed reader finds it. Measured 2026-09-13 on the user's
      // failing source: `daily.juya.uk/` always answers `text/html` while the
      // href it advertises (`/rss.xml`) answers `application/rss+xml` — so the
      // subscription worked once and then never again, and the log blamed the
      // network for it.
      //
      // One hop only. Following a chain would let a page we do not control
      // decide how many requests we make (rule 19's concern is exactly this).
      if (doc.kind === 'not-a-feed' || doc.kind === 'http-error') {
        const advertised = doc.kind === 'not-a-feed'
          ? findAdvertisedFeed(doc.body, feedUrl)
          : null;
        if (advertised && advertised !== feedUrl) {
          devLog.info('rss', '源不是 feed，改用页面声明的地址', `${feedUrl} → ${advertised}`);
          const retry = await fetchFeedDocument(advertised, FEED_HEADERS, options?.signal);
          if (retry.kind === 'ok') {
            doc = retry;
          } else {
            devLog.warn('rss', '页面声明的 feed 地址仍不可用', `已尝试 ${advertised}`);
          }
        }
      }

      if (doc.kind === 'http-error') {
        return {
          posts: [],
          error: fetchError(
            doc.status === 404 ? 'not_found' : 'network',
            `RSS 源请求异常: HTTP ${doc.status}`,
          ),
        };
      }

      // `parse`, NOT `network`, and the distinction is load-bearing rather than
      // cosmetic: `code` drives the platform cool-down (rule 19), so reporting a
      // malformed feed as a network failure puts the user in a 2–3 minute wait
      // that cannot possibly help. The body's SHAPE is already in the log, from
      // `bgFetch`.
      if (doc.kind === 'not-a-feed') {
        return {
          posts: [],
          error: fetchError(
            'parse',
            '源返回的内容不是有效 XML（RSS/Atom）。该地址可能返回了 HTML 页面，或该源暂时不稳定。',
          ),
        };
      }

      const parsed = doc.document;

      // Check if RSS 2.0 or Atom
      const isAtom = !!parsed.querySelector('feed');
      const channelTitle =
        parsed.querySelector('channel > title, feed > title')?.textContent || channel.displayName;
      const channelLink =
        parsed.querySelector('channel > link, feed > link')?.textContent ||
        parsed.querySelector('feed > link')?.getAttribute('href') ||
        feedUrl;

      const items = isAtom
        ? Array.from(parsed.querySelectorAll('feed > entry'))
        : Array.from(parsed.querySelectorAll('channel > item'));

      const posts: Post[] = [];

      for (const item of items.slice(0, limit)) {
        const title = item.querySelector('title')?.textContent || '无标题动态';
        const link =
          item.querySelector('link')?.textContent ||
          item.querySelector('link')?.getAttribute('href') ||
          channelLink;

        // Date (parsed before the guid fallback needs it)
        const dateStr =
          item.querySelector('pubDate, published, updated')?.textContent || '';
        const parsedTime = dateStr ? new Date(dateStr).getTime() : Date.now();
        const publishedAt = Number.isFinite(parsedTime) ? parsedTime : Date.now();

        // Stable fallback: derive from content identity, not randomness — a
        // Math.random id made every sync re-import the same item as a "new"
        // post when guid and link are both missing.
        const guid =
          item.querySelector('guid, id')?.textContent ||
          link ||
          `${title}|${publishedAt}`;

        // Prefer the FULL article over the feed's summary.
        //
        // A feed commonly carries a truncated summary in `<description>` /
        // `<summary>` and the complete article in `<content:encoded>` (RSS) or
        // `<content>` (Atom). Reading only the summary is why an RSS post stopped
        // mid-sentence with the feed's own ellipsis: measured on a real
        // newsletter feed, `<description>` was 359 characters ending in "…" while
        // `<content:encoded>` carried 31144 characters of article.
        //
        // `getElementsByTagName` is used for the namespaced name because a CSS
        // selector would need the colon escaped and the qualified name is exact.
        const fullArticle = item.getElementsByTagName('content:encoded')[0]?.textContent;
        const atomContent = item.querySelector('content')?.textContent;
        const summary = item.querySelector('description, summary')?.textContent;
        // A `<description>` may itself be an HTML-escaped document, so it goes
        // through the same tag-stripping pass as the full article below.
        const rawBody = fullArticle || atomContent || summary || '';

        // Strip markup: assign the (entity-decoded) HTML and read the text back.
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = rawBody;
        const cleanText = (tempDiv.textContent || tempDiv.innerText || '').trim();

        // The same parse also carries the article's *structure*, which is what
        // makes an RSS post readable in place: headings, paragraphs and the
        // images sitting where the author put them. Storing only the flattened
        // text is why every image ended up in a gallery under the article.
        //
        // `tempDiv` is left untouched — the media scan below reads its `<img>`
        // tags — and only sanitized output is stored, so nothing downstream has
        // to remember that a feed's markup is untrusted.
        const sanitizedHtml = sanitizeArticleHtml(tempDiv, link, RSS_MAX_HTML_CHARS);
        // Kept only when it really carries structure: a plain-text body has no
        // tags to preserve, and HTML-rendering it would lose the feed's own line
        // breaks (the reader's `whitespace-pre-wrap` path keeps them).
        const contentHtml = hasArticleMarkup(sanitizedHtml) ? sanitizedHtml : '';

        // Media enclosures
        const mediaList: MediaItem[] = [];
        const enclosure = item.querySelector('enclosure');
        if (enclosure) {
          const encUrl = enclosure.getAttribute('url');
          const encType = enclosure.getAttribute('type') || '';
          if (encUrl) {
            mediaList.push({
              type: encType.startsWith('video')
                ? 'video'
                : encType.startsWith('audio')
                ? 'audio'
                : 'image',
              previewUrl: encUrl,
              originalUrl: encUrl,
            });
          }
        }

        // Also check any <img> tags inside description. Feeds decide how many
        // images a post has; a low hard cap silently truncated long photo
        // essays. The 35-image ceiling only guards against a hostile feed
        // stuffing the mediaList (same bound the douyin contract uses).
        const imgTags = tempDiv.querySelectorAll('img');
        imgTags.forEach((img) => {
          const src = img.getAttribute('src');
          if (src && mediaList.length < 35) {
            mediaList.push({
              type: 'image',
              previewUrl: src,
              originalUrl: src,
            });
          }
        });

        posts.push(buildPost(channel, {
          id: `rss_${stableHash(guid)}`,
          channelLabel: channel.label,
          title,
          // RSS is the one platform whose body is prose the user is meant to
          // read in place, so the full text is stored (see `normalizeRssContent`
          // for the cap): the old 350-character teaser cut articles off
          // mid-sentence, and the click-to-read view is gone.
          content: normalizeRssContent(cleanText),
          contentHtml: contentHtml || undefined,
          mediaList,
          originalUrl: link,
          publishedAt,
        }));
      }

      return {
        posts,
        authorMeta: {
          name: channelTitle,
        },
      };
    } catch (err: unknown) {
      const message = errorMessage(err);
      // The catch-all used to say `network` for everything that reached it,
      // which is the remaining half of the classification problem (the HTTP and
      // XML branches above now return their own code). A DOM/parse exception
      // here means the body was not what the parser expected, and a network
      // failure means the request itself did not complete — reporting the first
      // as the second sends the user to check their connection over a malformed
      // feed, and cools down a platform that answered fine.
      //
      // `bgFetch` never throws for an HTTP error (it returns `ok: false`), so by
      // the time control reaches here the throw is local: parsing, sanitizing or
      // mapping.
      devLog.warn('rss', '解析/映射阶段抛出异常', message);
      return {
        posts: [],
        error: fetchError('parse', message || 'RSS 订阅源解析失败'),
      };
    }
  },
};
