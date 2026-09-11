import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { toSecureMediaUrl } from '../utils/media';
import { errorMessage } from '../utils/errorMessage';
import type { JsonRecord } from '../utils/json';
import { asRecord } from '../utils/json';
import {
  collectRawNotes,
  extractInitialState,
  firstInfoListUrl,
  mapProfileNote,
  resolveAuthorMeta,
} from './xiaohongshu/profileState';


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
          error: fetchError('network', `小红书页面访问异常 HTTP ${res.status}`),
        };
      }

      const html = res.data;
      const state = extractInitialState(html);

      if (!state) {
        return {
          posts: [],
          error: fetchError('parse', '未能解析小红书博主页面数据。请确认当前浏览器已在 xiaohongshu.com 登录。'),
        };
      }

      const rawNotes = collectRawNotes(state);
      const { name: authorName, avatar: authorAvatar } = resolveAuthorMeta(state, rawNotes, channel);
      const allPosts: Post[] = [];
      const seenIds = new Set<string>();

      for (const rawItem of rawNotes) {
        const post = mapProfileNote(rawItem, channel, seenIds);
        if (post) allPosts.push(post);
      }
      // CRITICAL: Sort strictly descending by publication time (newest first)
      // This fixes the random-order bug caused by multiple columns in waterfall layout
      allPosts.sort((a, b) => b.publishedAt - a.publishedAt);

      // The profile page always embeds the creator's notes in its initial
      // state. Zero parsed notes therefore means the page did not carry what
      // this adapter reads — logged out, login-walled, or the state shape
      // changed — and must not be reported as a successful empty sync.
      if (rawNotes.length === 0) {
        return {
          posts: [],
          error: fetchError(
            'parse',
            '小红书博主页面未包含任何笔记数据。请确认浏览器已在 xiaohongshu.com 登录，'
            + '且该主页在浏览器中能正常显示笔记；若页面显示正常仍报此错，可能是页面结构已调整。',
          ),
        };
      }

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
        totalFetched: allPosts.length,
      };
    } catch (err: unknown) {
      const message = errorMessage(err);
      return {
        posts: [],
        error: fetchError('network', `获取小红书动态异常: ${message}`),
      };
    }
  },
};

function extractXhsInitialState(html: string): JsonRecord | null {
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
                const inner = JSON.parse(raw.slice(quoteStart, quoteEnd + 1)) as unknown;
                return asRecord(JSON.parse(String(inner)));
              }
            } else if (raw.startsWith('{')) {
              const cleaned = raw.replace(/:\s*undefined\b/g, ': null');
              return asRecord(JSON.parse(cleaned) as unknown);
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
      const note = asRecord(asRecord(asRecord(asRecord(asRecord(state).note).noteDetailMap)[noteId]).note);
      const imageList: unknown = note.imageList || note.imagesList;
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


