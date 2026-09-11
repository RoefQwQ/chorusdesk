import type { Channel, MediaItem, Post } from '../../types';
import type { JsonRecord, JsonValue } from '../../utils/json';
import { asRecord, firstFilled } from '../../utils/json';
import { toSecureMediaUrl } from '../../utils/media';
import { buildPost } from '../buildPost';
import { devLog } from '../../utils/devLog';

/**
 * The xiaohongshu profile-page reader, extracted from `xiaohongshu.ts`.
 *
 * Same motivation as `bilibili/spaceDynamic.ts`: this is nested-record reading
 * (`state.user.notes[0][i].noteCard.cover.infoList[0].url` and several fallback
 * chains) that had zero test coverage, and one bug of exactly this shape already
 * shipped — `asRecord(item.noteCard) || item` was dead code, because an empty
 * record is truthy, so the fallback never ran.
 *
 * Pure: no `chrome.*`, no db. The one thing that must stay with the caller is the
 * per-page `seenIds` set, so it is passed in and mutated here, exactly as before.
 *
 * `extractInitialState` was already a standalone function; it moved here so the
 * whole read path lives together, and its `console.warn` became a `devLog.warn` —
 * the Developer Log panel is the surface a user can send us, and a parse failure
 * that only reaches the console is invisible there (rules 11 and 20).
 */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The `window.__INITIAL_STATE__` / `__INITIAL_SSR_STATE__` payload of a page. */
export function extractInitialState(html: string): JsonRecord | null {
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
              // Real SSR HTML contains bare `undefined` tokens, which are not JSON.
              const cleaned = raw.replace(/:\s*undefined\b/g, ': null');
              return asRecord(JSON.parse(cleaned) as unknown);
            }
          }
        }
      }
    }
  } catch (e) {
    devLog.warn('xiaohongshu', '初始化状态解析失败', e instanceof Error ? e.message : String(e));
  }

  return null;
}

/**
 * Every note record on the page, from the three places the state may carry them.
 *
 * The profile page nests them one level (`notes: [[…]]`), so arrays are flattened;
 * a single-note or explore page instead has `note.noteDetailMap`.
 */
export function collectRawNotes(state: JsonRecord): JsonValue[] {
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

  if (rawNotes.length === 0 && stateNote.noteDetailMap) {
    const noteDetailMap = asRecord(stateNote.noteDetailMap);
    for (const [nid, detail] of Object.entries(noteDetailMap)) {
      const detailRecord = asRecord(detail);
      if (detail && typeof detail === 'object') {
        rawNotes.push({ id: nid, ...asRecord(detailRecord.note) } as JsonRecord);
      }
    }
  }

  return rawNotes;
}

/**
 * The author's display name and avatar, with the same fallback chain as before:
 * `basicInfo` first, then whatever the first note's card says about its author,
 * then the channel's own values, then a generated placeholder.
 */
export function resolveAuthorMeta(
  state: JsonRecord,
  rawNotes: JsonValue[],
  channel: Channel,
): { name: string; avatar: string } {
  const stateUser = asRecord(state.user);
  const basicInfo =
    asRecord(asRecord(stateUser.userPageData).basicInfo) ||
    asRecord(asRecord(stateUser.userProfile).basicInfo);
  const noteRecords = rawNotes.map((n) => asRecord(n));
  const sampleUserRaw = noteRecords.find(
    (n) => str(asRecord(asRecord(n.noteCard).user).nickname) || str(asRecord(n.user).nickname),
  );
  const sampleUser = asRecord(asRecord(sampleUserRaw?.noteCard).user) || asRecord(sampleUserRaw?.user);
  const userId = channel.accountId.trim();
  const name =
    str(basicInfo.nickname) ||
    str(basicInfo.name) ||
    str(sampleUser.nickname) ||
    channel.displayName ||
    `小红书用户_${userId.slice(0, 6)}`;
  const rawAvatar =
    str(basicInfo.imageb) ||
    str(basicInfo.images) ||
    str(sampleUser.avatar) ||
    str(sampleUser.avatarUrl) ||
    channel.avatarUrl;
  return { name, avatar: toSecureMediaUrl(rawAvatar) };
}

/**
 * Map one note record to a `Post`, or `null` when it has no usable id or was already
 * produced on this page.
 *
 * `seenIds` is caller-owned and mutated here, because the dedup is per page.
 */
export function mapProfileNote(
  rawItem: JsonValue,
  channel: Channel,
  seenIds: Set<string>,
): Post | null {
  const item = asRecord(rawItem);
  const noteCard = asRecord(item.noteCard);
  const noteId = str(item.id) || str(item.noteId) || str(noteCard.noteId);
  if (!noteId || seenIds.has(noteId)) return null;
  seenIds.add(noteId);

  // `asRecord(item.noteCard) || item` was dead: an empty record is truthy.
  const card = firstFilled(asRecord(item.noteCard), item);
  const displayTitle = str(card.displayTitle) || str(card.title) || '小红书精选笔记';
  const isVideo = card.type === 'video';

  const mediaList: MediaItem[] = [];
  const cover = asRecord(card.cover);
  const coverInfoList = Array.isArray(cover.infoList) ? cover.infoList : [];
  const coverUrl =
    str(cover.urlDefault) ||
    str(cover.urlPre) ||
    str(asRecord(coverInfoList[0]).url) ||
    str(asRecord(card.image).url);
  const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;

  const imageListSource = card.imageList || card.imagesList || item.imageList || item.imagesList;
  const imageList = Array.isArray(imageListSource) ? imageListSource : [];
  if (imageList.length > 0) {
    for (const rawImg of imageList) {
      const img = asRecord(rawImg);
      const imgInfoList = Array.isArray(img.infoList) ? img.infoList : [];
      const imgUrl =
        str(img.urlDefault) || str(img.urlPre) || str(img.url) || str(asRecord(imgInfoList[0]).url);
      if (imgUrl) {
        const secureUrl = toSecureMediaUrl(imgUrl);
        mediaList.push({ type: 'image', previewUrl: secureUrl, originalUrl: secureUrl });
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
  const noteContent = likedCount ? `${displayTitle}\n\n❤️ ${likedCount} 次赞同` : displayTitle;

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

  // The note id is a 24-hex ObjectId whose first 8 hex characters are the creation
  // timestamp in seconds. Note that a card's own `time` (ms) equals that value —
  // measured on a captured payload — so this branch only fires for cards that carry
  // no usable time at all, not as a different answer.
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

  if (!pubTime) pubTime = Date.now();

  return buildPost(channel, {
    id: `xiaohongshu_${noteId}`,
    title: displayTitle,
    content: noteContent,
    mediaList,
    originalUrl: noteUrl,
    publishedAt: pubTime,
    isRepost: false,
  });
}

/** One image entry's URL, from the detail page's `imageList`. */
export function firstInfoListUrl(infoList: unknown): string | undefined {
  if (!Array.isArray(infoList) || infoList.length === 0) return undefined;
  const first = infoList[0];
  if (typeof first === 'object' && first !== null) {
    const url = (first as Record<string, unknown>).url;
    if (typeof url === 'string') return url;
  }
  return undefined;
}
