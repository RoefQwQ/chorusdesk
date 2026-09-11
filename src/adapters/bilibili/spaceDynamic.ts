import type { Channel, Post } from '../../types';
import { asRecord } from '../../utils/json';
import { toSecureMediaUrl } from '../../utils/media';
import { buildPost } from '../buildPost';

/**
 * The `space-dynamic` item → `Post` mapping, extracted from `bilibili.ts`.
 *
 * It existed **twice**, verbatim, in `fetchLatest` and `fetchHistory` — 18 of the
 * ~49 lines were byte-identical, and the pair had no test coverage at all. That is
 * the shape of duplication that drifts silently: a media fix applied to one copy
 * leaves the other wrong, and the dig (the path only history uses) is the one that
 * gets forgotten.
 *
 * Pure on purpose: no `chrome.*`, no db, no clock. The two things the original
 * copies did differently are therefore **parameters**, not branches:
 *
 *   - `fallbackToNow` — `fetchLatest` uses `Date.now()` when a post has no
 *     `pub_ts`; `fetchHistory` does too, but only after its own defaulting, and the
 *     history cursor is what actually orders that path. Kept explicit so the
 *     difference is visible rather than buried.
 *   - `sinceTs` (the watermark) is NOT here: whether a page stops early is a
 *     property of the caller's loop, not of one item.
 */
export interface MappedItem {
  post: Post;
  /** Author fields the caller folds into the result's `authorMeta`. */
  authorName?: string;
  authorAvatar?: string;
  /** True when this `bvid` was already produced in this batch — the item is dropped. */
  duplicate: boolean;
  /** True when `onlyOriginal` applies and this is a forward — the item is dropped. */
  filteredAsForward: boolean;
  /** True when the item carries neither a bvid nor an id — the item is dropped. */
  skippedForIdentity: boolean;
}

/**
 * Map one element of `data.items` to a `Post`.
 *
 * `seenBvids` is caller-owned and mutated here, exactly as before: the dedup is per
 * page, not per item, so it cannot live inside a pure function. Returning the flags
 * instead of `continue`ing keeps the caller's control flow its own.
 */
export function mapSpaceDynamicItem(
  rawItem: unknown,
  channel: Channel,
  seenBvids: Set<string>,
  options: { onlyOriginal?: boolean; fallbackToNow?: boolean } = {},
): MappedItem {
  const item = asRecord(rawItem);
  const modules = asRecord(item.modules);
  const moduleAuthor = asRecord(modules.module_author);
  const moduleDynamic = asRecord(modules.module_dynamic);

  const authorName = moduleAuthor.name ? String(moduleAuthor.name) : undefined;
  const authorAvatar = moduleAuthor.face ? toSecureMediaUrl(String(moduleAuthor.face)) : undefined;

  const isForward = item.type === 'DYNAMIC_TYPE_FORWARD' || Boolean(item.orig);
  if (options.onlyOriginal && isForward) {
    return { post: null as unknown as Post, duplicate: false, filteredAsForward: true, skippedForIdentity: false };
  }

  const major = asRecord(moduleDynamic.major);
  const archive = asRecord(major.archive);
  const archiveBvid = typeof archive.bvid === 'string' ? archive.bvid : undefined;
  if (archiveBvid) {
    if (seenBvids.has(archiveBvid)) {
      return { post: null as unknown as Post, duplicate: true, filteredAsForward: false, skippedForIdentity: false };
    }
    seenBvids.add(archiveBvid);
  }

  const idStr =
    (typeof item.id_str === 'string' && item.id_str) ||
    String(asRecord(item.basic).comment_id_str ?? item.id ?? '');
  if (!archiveBvid && !idStr) {
    // No stable identity — skip rather than fabricate one (fix queue #6).
    return { post: null as unknown as Post, duplicate: false, filteredAsForward: false, skippedForIdentity: true };
  }

  const pubTime = moduleAuthor.pub_ts ? Number(moduleAuthor.pub_ts) * 1000 : (options.fallbackToNow ? Date.now() : 0);
  const text =
    (typeof asRecord(moduleDynamic.desc).text === 'string' && asRecord(moduleDynamic.desc).text) ||
    (typeof archive.desc === 'string' && archive.desc) ||
    '';
  const title = typeof archive.title === 'string' ? archive.title : '';

  const mediaList: Post['mediaList'] = [];
  if (major.archive) {
    mediaList.push({
      type: 'video',
      previewUrl: String(archive.cover ?? ''),
      originalUrl: `https://www.bilibili.com/video/${archiveBvid}`,
    });
  }
  const draw = asRecord(major.draw);
  if (Array.isArray(draw.items)) {
    for (const rawImg of draw.items) {
      const img = asRecord(rawImg);
      const src = typeof img.src === 'string' ? img.src : '';
      if (src) mediaList.push({ type: 'image', previewUrl: src, originalUrl: src });
    }
  }
  // Forward posts: archive/draw media live on the original item, not the wrapper.
  if (isForward && item.orig) {
    const origMajor = asRecord(asRecord(asRecord(asRecord(item.orig).modules).module_dynamic).major);
    const origArchive = asRecord(origMajor.archive);
    const origBvid = typeof origArchive.bvid === 'string' ? origArchive.bvid : '';
    if (origMajor.archive && origBvid && !mediaList.some((m) => m.type === 'video' && m.originalUrl.endsWith(origBvid))) {
      mediaList.push({
        type: 'video',
        previewUrl: String(origArchive.cover ?? ''),
        originalUrl: `https://www.bilibili.com/video/${origBvid}`,
      });
    }
    const origDraw = asRecord(origMajor.draw);
    if (Array.isArray(origDraw.items)) {
      for (const rawImg of origDraw.items) {
        const img = asRecord(rawImg);
        const src = typeof img.src === 'string' ? img.src : '';
        if (src && !mediaList.some((m) => m.type === 'image' && m.previewUrl === src)) {
          mediaList.push({ type: 'image', previewUrl: src, originalUrl: src });
        }
      }
    }
  }

  const post = buildPost(channel, {
    id: archiveBvid ? `bilibili_video_${archiveBvid}` : `bilibili_${idStr}`,
    title,
    content: typeof text === 'string' ? (text || title || '（分享动态）') : (title || '（分享动态）'),
    mediaList,
    originalUrl: archiveBvid
      ? `https://www.bilibili.com/video/${archiveBvid}`
      : `https://t.bilibili.com/${idStr}`,
    publishedAt: pubTime,
    isRepost: isForward,
  });

  return { post, authorName, authorAvatar, duplicate: false, filteredAsForward: false, skippedForIdentity: false };
}
