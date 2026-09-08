import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../utils/http';

export const weiboAdapter: PlatformAdapter = {
  platform: 'weibo',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const uid = channel.accountId.trim();
      const page = options?.cursor ? Math.max(Number(options.cursor) || 1, 1) : 1;

      // 1. Fetch user container info via mobile API
      const indexUrl = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}`;
      const indexRes = await bgFetch(indexUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `https://m.weibo.cn/u/${uid}`,
          'MWeibo-Pwa': '1',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!indexRes.ok) {
        return await this.fetchAjaxFallback!(channel, limit, page, options);
      }

      let indexJson: any;
      try {
        indexJson = JSON.parse(indexRes.data);
      } catch {
        return await this.fetchAjaxFallback!(channel, limit, page, options);
      }

      const userInfo = indexJson.data?.userInfo || {};
      const authorName = userInfo.screen_name || channel.displayName;
      const authorAvatar = userInfo.avatar_hd || userInfo.profile_image_url || channel.avatarUrl;

      // Find the container ID for 'weibo' tab
      let containerId = `107603${userInfo.id || uid}`;
      const tabs = indexJson.data?.tabsInfo?.tabs;
      if (Array.isArray(tabs)) {
        const weiboTab = tabs.find((t: any) => t.tab_type === 'weibo');
        if (weiboTab?.containerid) {
          containerId = weiboTab.containerid;
        }
      }

      // 2. Fetch timeline cards
      const timelineUrl = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}&containerid=${encodeURIComponent(containerId)}&page=${page}`;
      const timelineRes = await bgFetch(timelineUrl, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: `https://m.weibo.cn/u/${uid}`,
          'MWeibo-Pwa': '1',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!timelineRes.ok) {
        return await this.fetchAjaxFallback!(channel, limit, page, options);
      }

      let timelineJson: any;
      try {
        timelineJson = JSON.parse(timelineRes.data);
      } catch {
        return await this.fetchAjaxFallback!(channel, limit, page, options);
      }

      const cards = timelineJson.data?.cards || [];
      const posts: Post[] = [];

      for (const card of cards) {
        if (posts.length >= limit) break;
        if (card.card_type !== 9 || !card.mblog) continue;

        const mblog = card.mblog;
        const isRetweet = Boolean(mblog.retweeted_status);

        // If caller requested only original posts, skip retweets from consuming quota
        if (options?.onlyOriginal && isRetweet) {
          continue;
        }

        const id = mblog.id || mblog.mid || String(card.id);
        if (!id) continue; // skip rather than collide all items on weibo_undefined
        const rawText = cleanWeiboHtml(mblog.text || '');
        let fullText = rawText;

        if (isRetweet) {
          const origUser = mblog.retweeted_status.user?.screen_name || '原博主';
          const origText = cleanWeiboHtml(mblog.retweeted_status.text || '');
          fullText = `${rawText}\n\n[转发自 @${origUser}]:\n${origText}`;
        }

        const mediaList: any[] = [];

        // Photos / 9-Grid Images
        const pics = mblog.pics || mblog.retweeted_status?.pics || [];
        for (const p of pics) {
          const origImg = toHttps(p.large?.url || p.url);
          const previewImg = toHttps(p.url || origImg);
          if (origImg) {
            mediaList.push({
              type: 'image',
              previewUrl: previewImg,
              originalUrl: origImg,
            });
          }
        }

        // Video
        if (mblog.page_info?.type === 'video' || mblog.page_info?.media_info) {
          const videoPic = toHttps(mblog.page_info.page_pic?.url || mblog.page_info.page_pic);
          const videoUrl = mblog.page_info.media_info?.stream_url || `https://weibo.com/${uid}/${mblog.bid || id}`;
          if (videoPic) {
            mediaList.push({
              type: 'video',
              previewUrl: videoPic,
              originalUrl: videoUrl,
            });
          }
        }

        const pubDate = parseWeiboTime(mblog.created_at);
        const firstLine = rawText.split('\n')[0].trim();
        const title = firstLine.length > 0 && firstLine.length < 50
          ? firstLine
          : (isRetweet ? `转发微博: ${rawText.slice(0, 30)}` : `@${authorName} 的微博`);

        posts.push(buildPost(channel, {
          id: `weibo_${id}`,
          title,
          content: fullText || title,
          mediaList,
          originalUrl: `https://weibo.com/${userInfo.id || uid}/${mblog.bid || id}`,
          publishedAt: pubDate,
          isRepost: isRetweet,
        }));
      }

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      const hasMore = cards.length > 0 && Boolean(timelineJson.data?.cardlistInfo?.total);

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: hasMore ? String(page + 1) : undefined,
        hasMore,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        posts: [],
        error: fetchError('network', `获取微博动态异常: ${message}`, true),
      };
    }
  },

  async fetchAjaxFallback(channel: Channel, limit: number, page: number, options?: FetchOptions): Promise<FetchResult> {
    try {
      const uid = channel.accountId.trim();
      const ajaxUrl = `https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(uid)}&page=${page}&feature=0`;
      const res = await bgFetch(ajaxUrl, {
        headers: {
          Referer: `https://weibo.com/u/${uid}`,
          Accept: 'application/json, text/plain, */*',
        },
      });

      if (!res.ok) {
        if (res.status === 403) {
          return { posts: [], error: fetchError('auth', '微博接口访问受限 (HTTP 403)。请在浏览器中打开 weibo.com 并完成登录，随后重试同步。') };
        }
        return { posts: [], error: fetchError('network', `微博接口响应异常 HTTP ${res.status}`, true) };
      }

      if (typeof res.data === 'string' && (res.data.includes('Sina Visitor System') || res.data.includes('passport.weibo.com') || res.data.trim().startsWith('<'))) {
        return { posts: [], error: fetchError('auth', '微博访客系统拦截。请在浏览器中打开 weibo.com 并完成登录，随后重试同步。') };
      }

      const json = JSON.parse(res.data);
      const list = json.data?.list || [];
      const posts: Post[] = [];
      let authorName = channel.displayName;
      let authorAvatar = channel.avatarUrl;

      for (const item of list) {
        if (posts.length >= limit) break;

        const isRetweet = Boolean(item.retweeted_status);
        if (options?.onlyOriginal && isRetweet) continue;

        if (item.user?.screen_name) authorName = item.user.screen_name;
        if (item.user?.avatar_hd) authorAvatar = item.user.avatar_hd;

        const text = cleanWeiboHtml(item.text_raw || item.text || '');
        const id = item.id || item.mid;
        if (!id) continue; // skip rather than collide all items on weibo_undefined
        const parsedTime = item.created_at ? new Date(item.created_at).getTime() : Date.now();
        const pubDate = Number.isFinite(parsedTime) ? parsedTime : Date.now();

        const mediaList: any[] = [];
        if (item.pic_infos) {
          for (const key of Object.keys(item.pic_infos)) {
            const p = item.pic_infos[key];
            const origImg = toHttps(p.large?.url || p.original?.url);
            const previewImg = toHttps(p.bmiddle?.url || p.thumbnail?.url || origImg);
            if (origImg) {
              mediaList.push({
                type: 'image',
                previewUrl: previewImg,
                originalUrl: origImg,
              });
            }
          }
        }

        posts.push(buildPost(channel, {
          id: `weibo_${id}`,
          title: text.slice(0, 40),
          content: text,
          mediaList,
          originalUrl: `https://weibo.com/${uid}/${item.mblogid || id}`,
          publishedAt: pubDate,
          isRepost: isRetweet,
        }));
      }

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      return {
        posts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: list.length > 0 ? String(page + 1) : undefined,
        hasMore: list.length > 0,
      };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { posts: [], error: fetchError('network', message || '微博网络连接异常', true) };
    }
  },

  async checkAuthStatus(): Promise<{ loggedIn: boolean; username?: string }> {
    if (typeof chrome === 'undefined' || !chrome.cookies?.get) {
      return { loggedIn: false };
    }
    try {
      const sub = await chrome.cookies.get({ url: 'https://weibo.com', name: 'SUB' });
      const subp = await chrome.cookies.get({ url: 'https://weibo.com', name: 'SUBP' });
      const isLogged = Boolean(sub?.value || subp?.value);
      return { loggedIn: isLogged };
    } catch {
      return { loggedIn: false };
    }
  },
};

function cleanWeiboHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<img[^>]*alt="([^"]+)"[^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseWeiboTime(timeStr: string): number {
  if (!timeStr) return Date.now();
  const d = new Date(timeStr);
  if (!isNaN(d.getTime())) return d.getTime();
  if (timeStr.includes('刚刚')) return Date.now();

  const minMatch = timeStr.match(/(\d+)\s*分钟前/);
  if (minMatch) return Date.now() - Number(minMatch[1]) * 60 * 1000;

  const hourMatch = timeStr.match(/(\d+)\s*小时前/);
  if (hourMatch) return Date.now() - Number(hourMatch[1]) * 3600 * 1000;

  const dayMatch = timeStr.match(/(\d+)\s*天前/);
  if (dayMatch) return Date.now() - Number(dayMatch[1]) * 86400 * 1000;

  const mdMatch = timeStr.match(/^(\d{1,2})-(\d{1,2})/);
  if (mdMatch) {
    const now = new Date();
    return new Date(now.getFullYear(), Number(mdMatch[1]) - 1, Number(mdMatch[2])).getTime();
  }

  return Date.now();
}

function toHttps(url?: string): string {
  if (!url) return '';
  return url.replace(/^http:\/\//i, 'https://');
}
