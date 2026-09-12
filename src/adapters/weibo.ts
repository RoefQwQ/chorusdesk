import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { asRecord } from '../utils/json';
import { errorMessage } from '../utils/errorMessage';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const weiboAdapter: PlatformAdapter = {
  platform: 'weibo',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    const signal = options?.signal;
    try {
      const uid = channel.accountId.trim();
      const page = options?.cursor ? Math.max(Number(options.cursor) || 1, 1) : 1;

      // 1. Fetch user container info via mobile API
      const indexUrl = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}`;
      const indexRes = await bgFetch(indexUrl, {
        signal,
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

      let indexJson: Record<string, unknown>;
      try {
        indexJson = JSON.parse(indexRes.data);
      } catch {
        return await this.fetchAjaxFallback!(channel, limit, page, options);
      }

      const userInfo = asRecord(asRecord(indexJson.data).userInfo);
      const authorName = str(userInfo.screen_name) || channel.displayName || '';
      const authorAvatar = str(userInfo.avatar_hd) || str(userInfo.profile_image_url) || toHttps(channel.avatarUrl);

      // Find the container ID for 'weibo' tab
      let containerId = `107603${userInfo.id || uid}`;
      const tabs = asRecord(asRecord(indexJson.data).tabsInfo).tabs;
      if (Array.isArray(tabs)) {
        const weiboTab = asRecord(tabs.find((t) => asRecord(t).tab_type === 'weibo'));
        if (weiboTab.containerid) {
          containerId = String(weiboTab.containerid);
        }
      }

      // 2. Fetch timeline cards
      const timelineUrl = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}&containerid=${encodeURIComponent(containerId)}&page=${page}`;
      const timelineRes = await bgFetch(timelineUrl, {
        signal,
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

      let timelineJson: Record<string, unknown>;
      try {
        timelineJson = JSON.parse(timelineRes.data);
      } catch {
        return await this.fetchAjaxFallback!(channel, limit, page, options);
      }

      const timelineData = asRecord(timelineJson.data);
      const cards = Array.isArray(timelineData.cards) ? timelineData.cards : [];
      const posts: Post[] = [];

      for (const rawCard of cards) {
        if (posts.length >= limit) break;
        const card = asRecord(rawCard);
        const mblog = asRecord(card.mblog);
        if (card.card_type !== 9 || !card.mblog) continue;

        const isRetweet = Boolean(mblog.retweeted_status);

        // If caller requested only original posts, skip retweets from consuming quota
        if (options?.onlyOriginal && isRetweet) {
          continue;
        }

        const id = str(mblog.id) || str(mblog.mid) || String(card.id ?? '');
        if (!id) continue; // skip rather than collide all items on weibo_undefined
        const rawText = cleanWeiboHtml(str(mblog.text));
        let fullText = rawText;

        if (isRetweet) {
          const rt = asRecord(mblog.retweeted_status);
          const origUser = str(asRecord(rt.user).screen_name) || '原博主';
          const origText = cleanWeiboHtml(str(rt.text));
          fullText = `${rawText}\n\n[转发自 @${origUser}]:\n${origText}`;
        }

        const mediaList: Post['mediaList'] = [];

        // Photos / 9-Grid Images
        const picsSource = mblog.pics || asRecord(mblog.retweeted_status).pics;
        const pics = Array.isArray(picsSource) ? picsSource : [];
        for (const rawP of pics) {
          const p = asRecord(rawP);
          const origImg = toHttps(str(asRecord(p.large).url) || str(p.url));
          const previewImg = toHttps(str(p.url) || origImg);
          if (origImg) {
            mediaList.push({
              type: 'image',
              previewUrl: previewImg,
              originalUrl: origImg,
            });
          }
        }

        // Video
        const pageInfo = asRecord(mblog.page_info);
        if (pageInfo.type === 'video' || pageInfo.media_info) {
          const videoPic = toHttps(str(asRecord(pageInfo.page_pic).url) || str(pageInfo.page_pic));
          const videoUrl = str(asRecord(pageInfo.media_info).stream_url) || `https://weibo.com/${uid}/${str(mblog.bid) || id}`;
          if (videoPic) {
            mediaList.push({
              type: 'video',
              previewUrl: videoPic,
              originalUrl: videoUrl,
            });
          }
        }

        const pubDate = parseWeiboTime(str(mblog.created_at));
        const firstLine = rawText.split('\n')[0].trim();
        const title = firstLine.length > 0 && firstLine.length < 50
          ? firstLine
          : (isRetweet ? `转发微博: ${rawText.slice(0, 30)}` : `@${authorName} 的微博`);

        posts.push(buildPost(channel, {
          id: `weibo_${id}`,
          title,
          content: fullText || title,
          mediaList,
          originalUrl: `https://weibo.com/${userInfo.id || uid}/${str(mblog.bid) || id}`,
          publishedAt: pubDate,
          isRepost: isRetweet,
        }));
      }

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      const hasMore = cards.length > 0 && Boolean(asRecord(timelineData.cardlistInfo).total);

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
      const message = errorMessage(err);
      return {
        posts: [],
        error: fetchError('network', `获取微博动态异常: ${message}`),
      };
    }
  },

  async fetchAjaxFallback(channel: Channel, limit: number, page: number, options?: FetchOptions): Promise<FetchResult> {
    try {
      const uid = channel.accountId.trim();
      const ajaxUrl = `https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(uid)}&page=${page}&feature=0`;
      const res = await bgFetch(ajaxUrl, {
        signal: options?.signal,
        headers: {
          Referer: `https://weibo.com/u/${uid}`,
          Accept: 'application/json, text/plain, */*',
        },
      });

      if (!res.ok) {
        if (res.status === 403) {
          return { posts: [], error: fetchError('auth', '微博接口访问受限 (HTTP 403)。请在浏览器中打开 weibo.com 并完成登录，随后重试同步。') };
        }
        return { posts: [], error: fetchError('network', `微博接口响应异常 HTTP ${res.status}`) };
      }

      if (typeof res.data === 'string' && (res.data.includes('Sina Visitor System') || res.data.includes('passport.weibo.com') || res.data.trim().startsWith('<'))) {
        return { posts: [], error: fetchError('auth', '微博访客系统拦截。请在浏览器中打开 weibo.com 并完成登录，随后重试同步。') };
      }

      const json: Record<string, unknown> = JSON.parse(res.data);
      const list = (Array.isArray(asRecord(json.data).list) ? asRecord(json.data).list : []) as unknown[];
      const posts: Post[] = [];
      let authorName = channel.displayName;
      let authorAvatar = channel.avatarUrl;

      for (const rawItem of list) {
        if (posts.length >= limit) break;
        const item = asRecord(rawItem);

        const isRetweet = Boolean(item.retweeted_status);
        if (options?.onlyOriginal && isRetweet) continue;

        const user = asRecord(item.user);
        if (user.screen_name) authorName = str(user.screen_name);
        if (user.avatar_hd) authorAvatar = str(user.avatar_hd);

        const text = cleanWeiboHtml(str(item.text_raw) || str(item.text));
        const id = str(item.id) || str(item.mid);
        if (!id) continue; // skip rather than collide all items on weibo_undefined
        const parsedTime = str(item.created_at) ? new Date(str(item.created_at)).getTime() : Date.now();
        const pubDate = Number.isFinite(parsedTime) ? parsedTime : Date.now();

        const mediaList: Post['mediaList'] = [];
        const picInfos = asRecord(item.pic_infos);
        if (item.pic_infos) {
          for (const key of Object.keys(picInfos)) {
            const p = asRecord(picInfos[key]);
            const origImg = toHttps(str(asRecord(p.large).url) || str(asRecord(p.original).url));
            const previewImg = toHttps(str(asRecord(p.bmiddle).url) || str(asRecord(p.thumbnail).url) || origImg);
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
          originalUrl: `https://weibo.com/${uid}/${str(item.mblogid) || id}`,
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
      const message = errorMessage(e);
      return { posts: [], error: fetchError('network', message || '微博网络连接异常') };
    }
  },
};

function cleanWeiboHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
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
