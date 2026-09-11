import type { Channel, MediaItem, Post } from '../types';
import type { PlatformAdapter, FetchResult, FetchOptions } from './types';
import { buildPost } from './buildPost';
import { fetchError } from './types';
import { bgFetch } from '../infrastructure/chrome/http';
import { toSecureMediaUrl } from '../utils/media';
import type { JsonRecord, JsonValue } from '../utils/json';
import { asRecord, firstFilled } from '../utils/json';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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
      const rawNotes: JsonValue[] = [];
      const stateUser = asRecord(state.user);
      const stateNote = asRecord(state.note);
      const notesContainer =
        stateUser.notes || asRecord(stateUser.userPageData).notes || stateNote.notes;

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
      if (rawNotes.length === 0 && stateNote.noteDetailMap) {
        const noteDetailMap = asRecord(stateNote.noteDetailMap);
        for (const [nid, detail] of Object.entries(noteDetailMap)) {
          const detailRecord = asRecord(detail);
          if (detail && typeof detail === 'object') {
            rawNotes.push({ id: nid, ...asRecord(detailRecord.note) } as JsonRecord);
          }
        }
      }

      // Extract author meta with fallback to note items
      const basicInfo =
        asRecord(asRecord(stateUser.userPageData).basicInfo) ||
        asRecord(asRecord(stateUser.userProfile).basicInfo);
      const noteRecords = rawNotes.map((n) => asRecord(n));
      const sampleUserRaw = noteRecords.find((n) => str(asRecord(asRecord(n.noteCard).user).nickname) || str(asRecord(n.user).nickname));
      const sampleUser = asRecord(asRecord(sampleUserRaw?.noteCard).user) || asRecord(sampleUserRaw?.user);
      const authorName = str(basicInfo.nickname) || str(basicInfo.name) || str(sampleUser.nickname) || channel.displayName || `小红书用户_${userId.slice(0, 6)}`;
      const rawAvatar = str(basicInfo.imageb) || str(basicInfo.images) || str(sampleUser.avatar) || str(sampleUser.avatarUrl) || channel.avatarUrl;
      const authorAvatar = toSecureMediaUrl(rawAvatar);

      const allPosts: Post[] = [];
      const seenIds = new Set<string>();

      for (const rawItem of rawNotes) {
        const item = asRecord(rawItem);
        const noteCard = asRecord(item.noteCard);
        const noteId = str(item.id) || str(item.noteId) || str(noteCard.noteId);
        if (!noteId || seenIds.has(noteId)) continue;
        seenIds.add(noteId);

        // `asRecord(item.noteCard) || item` was dead: an empty record is truthy.
        const card = firstFilled(asRecord(item.noteCard), item);
        const displayTitle = str(card.displayTitle) || str(card.title) || '小红书精选笔记';
        const isVideo = card.type === 'video';

        // Media Cover & Images
        const mediaList: MediaItem[] = [];
        const cover = asRecord(card.cover);
        const coverInfoList = Array.isArray(cover.infoList) ? cover.infoList : [];
        const coverUrl =
          str(cover.urlDefault) ||
          str(cover.urlPre) ||
          str(asRecord(coverInfoList[0]).url) ||
          str(asRecord(card.image).url);
        const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

        // Support multiple images if present in card (e.g. imageList, imagesList)
        const imageListSource = card.imageList || card.imagesList || item.imageList || item.imagesList;
        const imageList = Array.isArray(imageListSource) ? imageListSource : [];
        if (imageList.length > 0) {
          for (const rawImg of imageList) {
            const img = asRecord(rawImg);
            const imgInfoList = Array.isArray(img.infoList) ? img.infoList : [];
            const imgUrl = str(img.urlDefault) || str(img.urlPre) || str(img.url) || str(asRecord(imgInfoList[0]).url);
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

        const likedCount = str(asRecord(card.interactInfo).likedCount);
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
          } catch {
            // Malformed ObjectId prefix: fall through to Date.now().
          }
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

function firstInfoListUrl(infoList: unknown): string | undefined {
  if (!Array.isArray(infoList) || infoList.length === 0) return undefined;
  const first = infoList[0];
  if (typeof first === 'object' && first !== null) {
    const url = (first as Record<string, unknown>).url;
    if (typeof url === 'string') return url;
  }
  return undefined;
}
