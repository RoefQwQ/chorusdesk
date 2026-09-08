import type { Channel, Post, MediaItem } from '../types';
import type { PlatformAdapter, FetchResult } from './types';
import { bgFetch } from '../utils/http';

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

        const guid =
          item.querySelector('guid, id')?.textContent ||
          link ||
          Math.random().toString(36).substring(2);

        const desc =
          item.querySelector('description, summary, content')?.textContent || '';

        // Clean HTML tags from content preview
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = desc;
        const cleanText = tempDiv.textContent || tempDiv.innerText || '';

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

        // Also check any <img> tags inside description
        const imgTags = tempDiv.querySelectorAll('img');
        imgTags.forEach((img) => {
          const src = img.getAttribute('src');
          if (src && mediaList.length < 4) {
            mediaList.push({
              type: 'image',
              previewUrl: src,
              originalUrl: src,
            });
          }
        });

        // Date
        const dateStr =
          item.querySelector('pubDate, published, updated')?.textContent || '';
        const publishedAt = dateStr ? new Date(dateStr).getTime() : Date.now();

        posts.push({
          id: `rss_${btoa(guid).replace(/[/+=]/g, '').slice(0, 32)}`,
          creatorId: channel.creatorId,
          channelId: channel.id,
          platform: 'rss',
          channelLabel: channel.label,
          title,
          content: cleanText.slice(0, 350) + (cleanText.length > 350 ? '...' : ''),
          mediaList,
          originalUrl: link,
          publishedAt,
          fetchedAt: Date.now(),
          isRead: 0,
        });
      }

      return {
        posts,
        authorMeta: {
          name: channelTitle,
        },
      };
    } catch (err: any) {
      return {
        posts: [],
        error: err?.message || 'RSS 订阅源抓取失败',
      };
    }
  },
};
