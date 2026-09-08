import type { Channel, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { bgFetch } from '../utils/http';

export const rplayAdapter: PlatformAdapter = {
  platform: 'rplay',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const rawId = channel.accountId.trim();

      // Step 1: Resolve creator details from accountId (supports nickname, customUrl, or 24-char hex OID)
      let creatorUser: any = null;
      let creatorOid = rawId;

      const isHexOid = /^[a-f0-9]{24}$/i.test(rawId);

      if (isHexOid) {
        const res = await bgFetch(`https://api.rplay.live/account/getuser?userOid=${rawId}&creator=true`);
        if (res.ok && res.data) {
          try {
            creatorUser = JSON.parse(res.data);
          } catch {}
        }
      }

      if (!creatorUser || !creatorUser._id) {
        // Try resolving by customUrl
        const customUrlRes = await bgFetch(
          `https://api.rplay.live/account/getuser?customUrl=${encodeURIComponent(rawId)}&creator=true`
        );
        if (customUrlRes.ok && customUrlRes.data) {
          try {
            const data = JSON.parse(customUrlRes.data);
            if (data._id) {
              creatorUser = data;
              creatorOid = data._id;
            }
          } catch {}
        }
      }

      if (!creatorUser || !creatorUser._id) {
        // Fallback to searching by nickname
        const nickRes = await bgFetch(
          `https://api.rplay.live/account/creatorfromnickname?nickname=${encodeURIComponent(rawId)}`
        );
        if (nickRes.ok && nickRes.data) {
          try {
            const list = JSON.parse(nickRes.data);
            if (Array.isArray(list) && list.length > 0) {
              const matched = list.find((item: any) => item.nickname?.toLowerCase() === rawId.toLowerCase()) || list[0];
              creatorOid = matched._id;
              // Now fetch full user data with oid
              const fullUserRes = await bgFetch(
                `https://api.rplay.live/account/getuser?userOid=${creatorOid}&creator=true`
              );
              if (fullUserRes.ok && fullUserRes.data) {
                creatorUser = JSON.parse(fullUserRes.data);
              }
            }
          } catch {}
        }
      }

      if (!creatorUser || !creatorUser._id) {
        throw new Error(`未能在 Rplay 找到该创作者 (${rawId})，请确认输入的昵称或主页链接正确`);
      }

      // Author metadata
      const authorName =
        creatorUser.nickname ||
        creatorUser.multiLangNick?.zh ||
        creatorUser.multiLangNick?.['zh-Hant'] ||
        creatorUser.multiLangNick?.en ||
        creatorUser.multiLangNick?.jp ||
        channel.displayName;
      const authorAvatar = creatorUser.channelImage || channel.avatarUrl;

      // Step 2: Extract content list
      // Published scenario items / audio-video works
      const publishedOids: string[] = [
        ...(Array.isArray(creatorUser.published) ? creatorUser.published : []),
        ...(Array.isArray(creatorUser.publishedClips) ? creatorUser.publishedClips : []),
        ...(Array.isArray(creatorUser.publishedReplays) ? creatorUser.publishedReplays : []),
        ...(Array.isArray(creatorUser.fileContentPosts) ? creatorUser.fileContentPosts : []),
      ];

      // Reverse so newest items are first, then slice based on offset cursor for history digging
      const allOids = Array.from(new Set(publishedOids)).reverse();
      const isHistoryDig = Boolean(options?.cursor);
      const offset = isHistoryDig ? Math.max(Number(options?.cursor) || 0, 0) : 0;
      const targetOids = allOids.slice(offset, offset + limit);

      if (targetOids.length === 0) {
        return {
          posts: [],
          authorMeta: {
            name: authorName,
            avatar: authorAvatar,
          },
          hasMore: false,
        };
      }

      // Step 3: Fetch detail metadata for each content item with rate-limiting pacing
      const posts: Post[] = [];

      for (let i = 0; i < targetOids.length; i++) {
        const oid = targetOids[i];
        if (i > 0) {
          // 250ms polite pause between items to prevent Cloudflare/API 429 Too Many Requests
          await new Promise((r) => setTimeout(r, 250));
        }

        try {
          const detailRes = await bgFetch(
            `https://api.rplay.live/content?contentOid=${oid}&status=published`
          );

          if (detailRes.status === 429) {
            console.warn(`[Rplay] Hit 429 rate limit on item ${oid}, stopping further batch fetch.`);
            break;
          }

          if (!detailRes.ok || !detailRes.data) continue;

          const item = JSON.parse(detailRes.data);
          const title =
            item.title ||
            item.multiLangTitle?.zh ||
            item.multiLangTitle?.['zh-Hant'] ||
            item.multiLangTitle?.en ||
            'Rplay 投稿作品';

          const content =
            item.introText ||
            item.multiLangIntroText?.zh ||
            item.multiLangIntroText?.['zh-Hant'] ||
            item.multiLangIntroText?.en ||
            '';

          const publishedTime = item.publishedAt
            ? new Date(item.publishedAt).getTime()
            : item.createdAt
            ? new Date(item.createdAt).getTime()
            : Date.now();

          // Build thumbnail preview URL from s3key
          const mediaList: any[] = [];
          const s3key = item.thumbnailAsset?.s3key || item.playerImageAsset?.s3key;
          if (s3key) {
            mediaList.push({
              type: 'image',
              previewUrl: `https://rplay.live/api/cdn/${s3key}`,
              originalUrl: `https://rplay.live/api/cdn/${s3key}`,
            });
          }

          posts.push({
            id: `rplay_${oid}`,
            creatorId: channel.creatorId,
            channelId: channel.id,
            platform: 'rplay',
            title,
            content,
            mediaList,
            originalUrl: `https://rplay.live/c/${encodeURIComponent(creatorUser.nickname || rawId)}?content=${oid}`,
            publishedAt: publishedTime,
            fetchedAt: Date.now(),
            isRead: 0,
          });
        } catch (itemErr) {
          console.warn(`[Rplay] Error fetching item ${oid}:`, itemErr);
        }
      }

      // Sort strictly newest first
      posts.sort((a, b) => b.publishedAt - a.publishedAt);

      const nextOffset = offset + targetOids.length;
      const hasMore = nextOffset < allOids.length;

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
        error: err?.message || 'Rplay 抓取失败 (请确认当前浏览器是否登录 Rplay)',
      };
    }
  },
};
