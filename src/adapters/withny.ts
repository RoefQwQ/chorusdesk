import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { asRecord } from '../utils/json';
import type { JsonValue } from '../utils/json';
import { errorMessage } from '../utils/errorMessage';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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

      const data = asRecord(JSON.parse(res.data));
      const rawList = data.posts || data.data;
      const list: JsonValue[] = Array.isArray(rawList) ? rawList : [];

      const posts: Post[] = list
        .map((raw) => asRecord(raw))
        .filter((item) => item.id)
        .map((item) => buildPost(channel, {
          id: `withny_${String(item.id)}`,
          title: str(item.title) || 'Withny 动态',
          content: str(item.body) || str(item.text),
          mediaList: Array.isArray(item.mediaUrls)
            ? item.mediaUrls
                .map((u) => str(u))
                .filter(Boolean)
                .map((u) => ({ type: 'image' as const, previewUrl: u, originalUrl: u }))
            : [],
          originalUrl: `https://withny.fun/posts/${String(item.id)}`,
          publishedAt: Number.isFinite(new Date(str(item.publishedAt)).getTime())
            ? new Date(str(item.publishedAt)).getTime()
            : Date.now(),
        }));

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      let authorName = channel.displayName;
      let authorAvatar = channel.avatarUrl;

      // Extract author meta from returned user object or items
      const apiUser = asRecord(data.user);
      if (data.user) {
        authorName = str(apiUser.name) || str(apiUser.nickname) || str(apiUser.displayName) || authorName;
        authorAvatar = str(apiUser.avatarUrl) || str(apiUser.avatar) || str(apiUser.iconUrl) || authorAvatar;
      } else if (list.length > 0) {
        const firstUser = asRecord(asRecord(list[0]).user);
        authorName = str(firstUser.name) || str(firstUser.nickname) || authorName;
        authorAvatar = str(firstUser.avatarUrl) || str(firstUser.avatar) || authorAvatar;
      }

      const lastItem = list.length > 0 ? asRecord(list[list.length - 1]) : {};
      const nextCursor =
        str(data.nextCursor) ||
        str(data.cursor) ||
        (list.length >= limit && lastItem.id ? String(lastItem.id) : undefined);
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
      const message = errorMessage(err);
      return {
        posts: [],
        error: fetchError('network', message || 'Withny 抓取失败 (请确认当前浏览器是否登录 Withny)', true),
      };
    }
  },
};
