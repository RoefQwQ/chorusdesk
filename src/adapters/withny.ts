import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../utils/http';

export const withnyAdapter: PlatformAdapter = {
  platform: 'withny',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const username = channel.accountId;
      const cursorParam = options?.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : '';
      // Withny user posts API via bgFetch
      const apiUrl = `https://withny.fun/api/users/${username}/posts?limit=${limit}${cursorParam}`;

      const res = await bgFetch(apiUrl, {
        headers: {
          'Accept': 'application/json',
          'Referer': `https://withny.fun/users/${username}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Withny HTTP ${res.status}`);
      }

      const data = JSON.parse(res.data);
      const list = data?.posts || data?.data || [];

      const posts: Post[] = list
        .filter((item: { id?: unknown }) => item.id)
        .map((item: any) => buildPost(channel, {
          id: `withny_${item.id}`,
          title: item.title || 'Withny 动态',
          content: item.body || item.text || '',
          mediaList: item.mediaUrls ? item.mediaUrls.map((u: string) => ({
            type: 'image',
            previewUrl: u,
            originalUrl: u,
          })) : [],
          originalUrl: `https://withny.fun/posts/${item.id}`,
          publishedAt: Number.isFinite(new Date(item.publishedAt).getTime())
            ? new Date(item.publishedAt).getTime()
            : Date.now(),
        }));

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      let authorName = channel.displayName;
      let authorAvatar = channel.avatarUrl;

      // Extract author meta from returned user object or items
      if (data?.user) {
        authorName = data.user.name || data.user.nickname || data.user.displayName || authorName;
        authorAvatar = data.user.avatarUrl || data.user.avatar || data.user.iconUrl || authorAvatar;
      } else if (list[0]?.user) {
        authorName = list[0].user.name || list[0].user.nickname || authorName;
        authorAvatar = list[0].user.avatarUrl || list[0].user.avatar || authorAvatar;
      }

      const nextCursor = data?.nextCursor || data?.cursor || (list.length >= limit && list[list.length - 1]?.id ? String(list[list.length - 1].id) : undefined);
      const hasMore = Boolean(nextCursor);

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor,
        hasMore,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        posts: [],
        error: fetchError('network', message || 'Withny 抓取失败 (请确认当前浏览器是否登录 Withny)', true),
      };
    }
  },
};
