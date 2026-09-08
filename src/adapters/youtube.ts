import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult } from './types';
import { bgFetch } from '../utils/http';

export const youtubeAdapter: PlatformAdapter = {
  platform: 'youtube',

  async fetchLatest(channel: Channel, limit: number = 10): Promise<FetchResult> {
    try {
      let channelId = channel.accountId;
      let pageAuthorTitle = '';
      let pageAuthorAvatar = '';

      // Handle @handles by fetching page to extract channel ID if not yet resolved
      if (channelId.startsWith('@') || !channelId.startsWith('UC')) {
        try {
          const resp = await bgFetch(`https://www.youtube.com/${channelId}`, {
            headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
          });
          if (resp.ok && resp.data) {
            const html = resp.data;
            // 1. Extract canonical channelId or rss channelId
            const rssMatch = html.match(/href=["']https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=(UC[a-zA-Z0-9_-]{22})["']/i);
            const canonicalMatch = html.match(/<link\s+rel=["']canonical["']\s+href=["']https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})["']/i);
            const jsonMatch = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);

            const resolvedId = rssMatch?.[1] || canonicalMatch?.[1] || jsonMatch?.[1];
            if (resolvedId) {
              channelId = resolvedId;
            }

            // 2. Extract real channel title (avoid pure handle)
            const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
            const titleTagMatch = html.match(/<title>([^<]+)<\/title>/i);
            if (ogTitleMatch && ogTitleMatch[1]) {
              pageAuthorTitle = ogTitleMatch[1].trim();
            } else if (titleTagMatch && titleTagMatch[1]) {
              pageAuthorTitle = titleTagMatch[1].replace(/\s*-\s*YouTube$/i, '').trim();
            }

            // 3. Extract real avatar
            const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
            if (ogImageMatch && ogImageMatch[1]) {
              pageAuthorAvatar = ogImageMatch[1].trim();
            }
          }
        } catch (e) {
          console.warn('Failed to resolve YouTube handle to channelId', e);
        }
      }

      // Fetch official channel RSS
      const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
      const res = await bgFetch(rssUrl);
      if (!res.ok) {
        throw new Error(`YouTube RSS 接口响应状态: HTTP ${res.status}`);
      }

      const xmlText = res.data;
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(xmlText, 'text/xml');

      const authorName = pageAuthorTitle || xmlDoc.querySelector('author > name')?.textContent || channel.displayName;
      const entries = Array.from(xmlDoc.querySelectorAll('entry')).slice(0, limit);

      const posts: Post[] = entries.map((entry) => {
        const videoId = entry.querySelector('yt\\:videoId, videoId')?.textContent || '';
        const title = entry.querySelector('title')?.textContent || '';
        const published = entry.querySelector('published')?.textContent || '';
        const desc = entry.querySelector('media\\:description, description')?.textContent || '';
        const originalUrl = entry.querySelector('link')?.getAttribute('href') || `https://www.youtube.com/watch?v=${videoId}`;
        const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        return {
          id: `youtube_${videoId || Math.random().toString(36).slice(2)}`,
          creatorId: channel.creatorId,
          channelId: channel.id,
          platform: 'youtube',
          title,
          content: desc.slice(0, 300) + (desc.length > 300 ? '...' : ''),
          mediaList: videoId ? [
            {
              type: 'video',
              previewUrl: thumbnail,
              originalUrl,
            },
          ] : [],
          originalUrl,
          publishedAt: published ? new Date(published).getTime() : Date.now(),
          fetchedAt: Date.now(),
          isRead: 0,
        };
      });

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: pageAuthorAvatar || undefined,
        },
      };
    } catch (err: any) {
      return {
        posts: [],
        error: err?.message || 'YouTube 更新抓取失败',
      };
    }
  },
};
