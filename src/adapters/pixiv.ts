import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { bgFetch } from '../utils/http';

export const pixivAdapter: PlatformAdapter = {
  platform: 'pixiv',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const uid = channel.accountId;

      // 1. Fetch user illust list via Background Fetch (bypasses CORS & uses session cookie)
      const profileUrl = `https://www.pixiv.net/ajax/user/${uid}/profile/all`;
      const [res, userRes] = await Promise.all([
        bgFetch(profileUrl, {
          headers: {
            'Accept': 'application/json',
            'Referer': `https://www.pixiv.net/users/${uid}`,
          },
        }),
        bgFetch(`https://www.pixiv.net/ajax/user/${uid}?full=1`, {
          headers: {
            'Accept': 'application/json',
            'Referer': `https://www.pixiv.net/users/${uid}`,
          },
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
        } catch {}
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

      // Construct posts for the target items with stable estimated timestamps based on monotonic ID
      for (const id of targetIds) {
        // Linear approximation anchor: ID 120,000,000 ~ 2024-07-01 (1719792000000 ms), rate ~3150ms per ID
        const estimatedPubTime = Math.min(
          Date.now(),
          Math.max(1400000000000, 1719792000000 + (id - 120000000) * 3150)
        );

        posts.push({
          id: `pixiv_${id}`,
          creatorId: channel.creatorId,
          channelId: channel.id,
          platform: 'pixiv',
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
          fetchedAt: Date.now(),
          isRead: 0,
        });
      }

      // Sort strictly newest first
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
    } catch (err: any) {
      return {
        posts: [],
        error: err?.message || 'Pixiv 抓取失败 (请确认当前浏览器是否登录 Pixiv)',
      };
    }
  },
};
