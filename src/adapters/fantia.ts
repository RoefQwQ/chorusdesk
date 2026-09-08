import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { bgFetch } from '../utils/http';

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
    uri: uriShow ? { show: uriShow } : undefined,
  };
}

export const fantiaAdapter: PlatformAdapter = {
  platform: 'fantia',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const clubId = channel.accountId;

      // Fetch fanclub detail (embeds recent_posts) via Background fetch to bypass CORS
      const apiUrl = `https://fantia.jp/api/v1/fanclubs/${encodeURIComponent(clubId)}`;
      const res = await bgFetch(apiUrl, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!res.ok) {
        throw new Error(`Fantia API 响应异常: HTTP ${res.status}`);
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
          error: 'Fantia 该俱乐部暂无可见投稿 (recent_posts 为空)',
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

      const posts: Post[] = parsedPosts.slice(0, limit).map((p) => {
        const mediaList: MediaItem[] = [];
        if (p.thumb?.main) {
          mediaList.push({
            type: 'image',
            previewUrl: p.thumb.main,
            originalUrl: p.thumb.original || p.thumb.main,
          });
        }

        const pubDate = p.posted_at ? new Date(p.posted_at).getTime() : Date.now();
        const postUrl = p.uri?.show ? `https://fantia.jp${p.uri.show}` : `https://fantia.jp/posts/${p.id}`;

        return {
          id: `fantia_${p.id}`,
          creatorId: channel.creatorId,
          channelId: channel.id,
          platform: 'fantia' as const,
          title: p.title || 'Fantia 投稿',
          content: (p.comment || p.title || '').slice(0, 300),
          mediaList,
          originalUrl: postUrl,
          publishedAt: pubDate,
          fetchedAt: Date.now(),
          isRead: 0,
        };
      });

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      // No cursor pagination available on this endpoint
      const hasMore = false;

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: undefined,
        hasMore,
      };
    } catch (err: unknown) {
      return {
        posts: [],
        error: err instanceof Error ? err.message : 'Fantia 更新抓取失败 (请确认是否在浏览器中登录过 Fantia)',
      };
    }
  },
};
