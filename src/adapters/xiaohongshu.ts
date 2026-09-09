import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../utils/http';
import { toSecureMediaUrl } from '../utils/media';

export const xiaohongshuAdapter: PlatformAdapter = {
  platform: 'xiaohongshu',

  async fetchLatest(channel: Channel, limit: number = 10, options?: FetchOptions): Promise<FetchResult> {
    try {
      const userId = channel.accountId.trim();
      const profileUrl = `https://www.xiaohongshu.com/user/profile/${userId}`;

      const res = await bgFetch(profileUrl, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: 'https://www.xiaohongshu.com/',
        },
      });

      if (!res.ok) {
        return {
          posts: [],
          error: fetchError('network', `小红书页面访问异常 HTTP ${res.status}`, true),
        };
      }

      const html = res.data;
      const state = extractXhsInitialState(html);

      if (!state) {
        return {
          posts: [],
          error: fetchError('parse', '未能解析小红书博主页面数据。请确认当前浏览器已在 xiaohongshu.com 登录。'),
        };
      }

      // Extract notes list (can be column array or flat list)
      const rawNotes: any[] = [];
      const notesContainer = state.user?.notes || state.user?.userPageData?.notes || state.note?.notes;

      if (Array.isArray(notesContainer)) {
        for (const item of notesContainer) {
          if (Array.isArray(item)) {
            rawNotes.push(...item);
          } else if (item && typeof item === 'object') {
            rawNotes.push(item);
          }
        }
      }

      // Check noteDetailMap if it's a single note / explore page
      if (rawNotes.length === 0 && state.note?.noteDetailMap) {
        for (const [nid, detail] of Object.entries(state.note.noteDetailMap)) {
          if (detail && typeof detail === 'object') {
            rawNotes.push({ id: nid, ...((detail as any).note || detail) });
          }
        }
      }

      // Extract author meta with fallback to note items
      const basicInfo = state.user?.userPageData?.basicInfo || state.user?.userProfile?.basicInfo || {};
      const sampleUser = rawNotes.find(n => (n.noteCard?.user || n.user)?.nickname)?.noteCard?.user ||
                         rawNotes.find(n => (n.noteCard?.user || n.user)?.nickname)?.user;
      const authorName = basicInfo.nickname || basicInfo.name || sampleUser?.nickname || channel.displayName || `小红书用户_${userId.slice(0, 6)}`;
      const rawAvatar = basicInfo.imageb || basicInfo.images || sampleUser?.avatar || sampleUser?.avatarUrl || channel.avatarUrl;
      const authorAvatar = toSecureMediaUrl(rawAvatar);

      const allPosts: Post[] = [];
      const seenIds = new Set<string>();

      for (const item of rawNotes) {
        const noteId = item.id || item.noteId || item.noteCard?.noteId;
        if (!noteId || seenIds.has(noteId)) continue;
        seenIds.add(noteId);

        const card = item.noteCard || item;
        const displayTitle = card.displayTitle || card.title || '小红书精选笔记';
        const isVideo = card.type === 'video';

        // Media Cover & Images
        const mediaList: any[] = [];
        const cover = card.cover || {};
        const coverUrl = cover.urlDefault || cover.urlPre || cover.infoList?.[0]?.url || card.image?.url;
        const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

        // Support multiple images if present in card (e.g. imageList, imagesList)
        const imageList = card.imageList || card.imagesList || item.imageList || item.imagesList;
        if (Array.isArray(imageList) && imageList.length > 0) {
          for (const img of imageList) {
            const imgUrl = img?.urlDefault || img?.urlPre || img?.url || img?.infoList?.[0]?.url;
            if (imgUrl) {
              const secureUrl = toSecureMediaUrl(imgUrl);
              mediaList.push({
                type: 'image',
                previewUrl: secureUrl,
                originalUrl: secureUrl,
              });
            }
          }
        }

        if (mediaList.length === 0 && coverUrl) {
          const secureCover = toSecureMediaUrl(coverUrl);
          mediaList.push({
            type: isVideo ? 'video' : 'image',
            previewUrl: secureCover,
            originalUrl: isVideo ? noteUrl : secureCover,
          });
        }

        const likedCount = card.interactInfo?.likedCount || '';
        const noteContent = likedCount
          ? `${displayTitle}\n\n❤️ ${likedCount} 次赞同`
          : displayTitle;

        // Calculate accurate publication time
        let pubTime = 0;
        const timeCandidates = [
          card.time,
          card.createTime,
          card.timestamp,
          card.pubTime,
          item.time,
          item.createTime,
          item.timestamp,
        ];
        for (const tc of timeCandidates) {
          if (typeof tc === 'number' && tc > 0) {
            pubTime = tc > 1e11 ? tc : tc * 1000;
            break;
          }
        }

        // Xiaohongshu noteId is a 24-hex ObjectId; first 8 hex characters represent the creation timestamp in seconds
        if (!pubTime && noteId && /^[0-9a-fA-F]{8}/.test(noteId)) {
          try {
            const sec = parseInt(noteId.slice(0, 8), 16);
            if (sec > 1400000000 && sec < 2500000000) {
              pubTime = sec * 1000;
            }
          } catch {}
        }

        if (!pubTime) {
          pubTime = Date.now();
        }

        allPosts.push(buildPost(channel, {
          id: `xiaohongshu_${noteId}`,
          title: displayTitle,
          content: noteContent,
          mediaList,
          originalUrl: noteUrl,
          publishedAt: pubTime,
          isRepost: false,
        }));
      }

      // CRITICAL: Sort strictly descending by publication time (newest first)
      // This fixes the random-order bug caused by multiple columns in waterfall layout
      allPosts.sort((a, b) => b.publishedAt - a.publishedAt);

      // Support cursor-based pagination for history digging (offset)
      const isHistoryDig = Boolean(options?.cursor !== undefined || options?.isHistory);
      const isForce = Boolean(options?.forceRefresh);
      const offset = isHistoryDig ? Math.max(Number(options?.cursor) || 0, 0) : 0;

      // If history digging has already reached or exceeded the end of SSR notes list
      if (isHistoryDig && !isForce && offset >= allPosts.length) {
        return {
          posts: [],
          authorMeta: {
            name: authorName,
            avatar: authorAvatar,
          },
          hasMore: false,
        };
      }

      // When force refreshing, return all parsed posts so old items get updated/healed
      const targetPosts = isForce ? allPosts : allPosts.slice(offset, offset + limit);

      // Image notes: the profile SSR cards carry only a single cover. Fetch
      // each note's detail page (SSR embeds the full imageList) so picture
      // posts show all their images, not just the first.
      await enrichImageNoteMedia(channel, targetPosts);

      const nextOffset = offset + targetPosts.length;
      const hasMore = !isForce && nextOffset < allPosts.length;
      return {
        posts: targetPosts,
        authorMeta: {
          name: authorName,
          avatar: authorAvatar,
        },
        nextCursor: hasMore ? String(nextOffset) : undefined,
        hasMore,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        posts: [],
        error: fetchError('network', `获取小红书动态异常: ${message}`, true),
      };
    }
  },

  async checkAuthStatus(): Promise<{ loggedIn: boolean; username?: string }> {
    if (typeof chrome === 'undefined' || !chrome.cookies?.get) {
      return { loggedIn: false };
    }
    try {
      const session = await chrome.cookies.get({ url: 'https://www.xiaohongshu.com', name: 'web_session' });
      const a1 = await chrome.cookies.get({ url: 'https://www.xiaohongshu.com', name: 'a1' });
      const isLogged = Boolean(session?.value || a1?.value);
      return { loggedIn: isLogged };
    } catch {
      return { loggedIn: false };
    }
  },
};

function extractXhsInitialState(html: string): any {
  if (!html) return null;

  try {
    for (const prefix of ['window.__INITIAL_STATE__', 'window.__INITIAL_SSR_STATE__']) {
      const idx = html.indexOf(prefix);
      if (idx !== -1) {
        const assignIdx = html.indexOf('=', idx);
        if (assignIdx !== -1) {
          const scriptEnd = html.indexOf('</script>', assignIdx);
          if (scriptEnd !== -1) {
            let raw = html.slice(assignIdx + 1, scriptEnd).trim();
            if (raw.endsWith(';')) raw = raw.slice(0, -1).trim();

            if (raw.startsWith('JSON.parse(')) {
              const quoteStart = raw.indexOf('"');
              const quoteEnd = raw.lastIndexOf('"');
              if (quoteStart !== -1 && quoteEnd > quoteStart) {
                return JSON.parse(JSON.parse(raw.slice(quoteStart, quoteEnd + 1)));
              }
            } else if (raw.startsWith('{')) {
              const cleaned = raw.replace(/:\s*undefined\b/g, ': null');
              return JSON.parse(cleaned);
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[Xiaohongshu] Parse INITIAL_STATE error:', e);
  }

  return null;
}

/**
 * Cap on detail-page fetches per sync round. XHS risk control is strict;
 * hammering dozens of /explore/ pages in one go is how accounts get
 * challenged. The remaining notes fall back to their profile-card cover and
 * are enriched on a later round.
 */
const DETAIL_ENRICH_MAX_PER_ROUND = 3;
/** Pacing between detail fetches (ms), mirroring the sync layer's pacing. */
const DETAIL_ENRICH_INTERVAL_MS = 1200;

/**
 * Fill image notes' mediaList from their detail-page SSR.
 *
 * The profile page's SSR cards only carry a single `cover`; the note detail
 * page (`/explore/{noteId}`) embeds the full `imageList` for the note. Only
 * image-type posts with at most one image are candidates (video notes keep
 * their cover+link; already-multi-image posts came from a detail-shaped
 * source). Failures are silent: the cover stays, enrichment retries next
 * round.
 */
async function enrichImageNoteMedia(channel: Channel, posts: Post[]): Promise<void> {
  const candidates = posts.filter(
    (p) =>
      p.mediaList.length <= 1 &&
      p.mediaList.every((m) => m.type === 'image') &&
      /^xiaohongshu_[0-9a-f]{24}$/.test(p.id),
  );
  let fetched = 0;

  for (const post of candidates) {
    if (fetched >= DETAIL_ENRICH_MAX_PER_ROUND) break;
    if (fetched > 0) {
      await new Promise((r) => setTimeout(r, DETAIL_ENRICH_INTERVAL_MS));
    }
    fetched++;

    const noteId = post.id.slice('xiaohongshu_'.length);
    try {
      const res = await bgFetch(`https://www.xiaohongshu.com/explore/${noteId}`, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: `https://www.xiaohongshu.com/user/profile/${channel.accountId}`,
        },
      });
      if (!res.ok) continue;

      const state = extractXhsInitialState(res.data);
      const note = state?.note?.noteDetailMap?.[noteId]?.note;
      const imageList: unknown = note?.imageList || note?.imagesList;
      if (!Array.isArray(imageList) || imageList.length === 0) continue;

      const mediaList: MediaItem[] = [];
      for (const img of imageList) {
        const url =
          (typeof img === 'object' && img !== null
            ? (img as Record<string, unknown>).urlDefault ||
              (img as Record<string, unknown>).urlPre ||
              (img as Record<string, unknown>).url ||
              firstInfoListUrl((img as Record<string, unknown>).infoList)
            : undefined) as string | undefined;
        if (typeof url === 'string' && url) {
          const secureUrl = toSecureMediaUrl(url);
          mediaList.push({ type: 'image', previewUrl: secureUrl, originalUrl: secureUrl });
        }
      }
      // Only replace when the detail page actually provided more images;
      // otherwise keep the cover (a failed parse must not blank the post).
      if (mediaList.length > post.mediaList.length) {
        post.mediaList = mediaList;
      }
    } catch {
      // Silent: cover stays; retry on a later round.
    }
  }
}

function firstInfoListUrl(infoList: unknown): string | undefined {
  if (!Array.isArray(infoList) || infoList.length === 0) return undefined;
  const first = infoList[0];
  if (typeof first === 'object' && first !== null) {
    const url = (first as Record<string, unknown>).url;
    if (typeof url === 'string') return url;
  }
  return undefined;
}
