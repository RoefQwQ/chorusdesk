import type { Channel, Post, MediaItem } from '../types';
import type { PlatformAdapter, FetchResult } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { hasArticleMarkup, sanitizeArticleHtml } from '../utils/sanitizeHtml';
import { errorMessage } from '../utils/errorMessage';

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

export const rssAdapter: PlatformAdapter = {
  platform: 'rss',

  async fetchLatest(channel: Channel, limit: number = 10): Promise<FetchResult> {
    try {
      const feedUrl = channel.profileUrl || channel.accountId;
      const res = await bgFetch(feedUrl, {
        headers: {
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });

      if (!res.ok) {
        throw new Error(`RSS 源请求异常: HTTP ${res.status}`);
      }

      const xmlText = res.data;
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');

      // Check parse error
      const parseError = doc.querySelector('parsererror');
      if (parseError) {
        throw new Error('无法解析 RSS / XML 数据格式');
      }

      // Check if RSS 2.0 or Atom
      const isAtom = !!doc.querySelector('feed');
      const channelTitle =
        doc.querySelector('channel > title, feed > title')?.textContent || channel.displayName;
      const channelLink =
        doc.querySelector('channel > link, feed > link')?.textContent ||
        doc.querySelector('feed > link')?.getAttribute('href') ||
        feedUrl;

      const items = isAtom
        ? Array.from(doc.querySelectorAll('feed > entry'))
        : Array.from(doc.querySelectorAll('channel > item'));

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
      return {
        posts: [],
        error: fetchError('network', message || 'RSS 订阅源抓取失败'),
      };
    }
  },
};
