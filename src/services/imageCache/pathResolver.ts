/**
 * Path and file naming utilities for the File System Image Cache.
 * Sanitizes folder and file names across Windows and POSIX operating systems.
 */

// Reserved characters in Windows file systems: \ / : * ? " < > |
const ILLEGAL_CHARACTERS = /[\\/:*?"<>|\r\n\t]/g;

/**
 * Sanitize a string so it can safely be used as a directory or file name on Windows & POSIX.
 */
export function sanitizePathSegment(name: string, fallback: string = 'unknown'): string {
  if (!name) return fallback;
  const cleaned = name
    .replace(ILLEGAL_CHARACTERS, '_')
    .trim()
    .replace(/^\.+/, '') // remove leading dots
    .replace(/\.+$/, ''); // remove trailing dots
  return cleaned || fallback;
}

/**
 * Platform display names for hierarchical directory grouping
 */
export const PLATFORM_DIR_NAMES: Record<string, string> = {
  xiaohongshu: '小红书',
  bilibili: '哔哩哔哩',
  weibo: '微博',
  douyin: '抖音',
  twitter: 'Twitter',
  pixiv: 'Pixiv',
  fantia: 'Fantia',
  youtube: 'YouTube',
  rss: 'RSS',
};

/**
 * Format timestamp into YYYYMMDD
 */
export function formatDateSegment(timestamp?: number): string {
  if (!timestamp) return 'nodate';
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  if (isNaN(date.getTime())) return 'nodate';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * Resolve standard directory segments for a post
 * Structure: [creatorName, platformName, `${date}_${postId}`]
 */
export function resolvePostDirSegments(params: {
  creatorName?: string;
  platform: string;
  channelName?: string;
  postId: string;
  publishedAt?: number;
}): [string, string, string] {
  const creatorDir = sanitizePathSegment(params.creatorName || '默认创作者');
  const platformDir = PLATFORM_DIR_NAMES[params.platform] || sanitizePathSegment(params.platform);
  
  // Clean post ID (strip platform prefix like xiaohongshu_)
  const rawId = params.postId.replace(/^[a-z0-9]+_/i, '');
  const shortId = rawId.slice(0, 16);
  const dateStr = formatDateSegment(params.publishedAt);
  const postFolder = sanitizePathSegment(`${dateStr}_${shortId}`);

  return [creatorDir, platformDir, postFolder];
}

/**
 * Canonical extensions a cached media file may have been written with.
 * `resolveFileExtension` normalizes `jpeg` to `jpg` and falls back to `jpg`, so
 * this is exactly the set of names on disk — probing must use the same list or
 * a cached file is reported missing.
 */
export const CACHED_IMAGE_EXTENSIONS = ['jpg', 'webp', 'png', 'gif', 'avif'] as const;

/**
 * Guess appropriate file extension from mime type or URL
 */
export function resolveFileExtension(url: string, mimeType?: string): string {
  if (mimeType) {
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('png')) return 'png';
    if (mimeType.includes('gif')) return 'gif';
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('avif')) return 'avif';
  }
  const cleanUrl = url.split('?')[0].split('!')[0];
  const m = cleanUrl.match(/\.([a-zA-Z0-9]{3,4})$/);
  if (m) {
    const ext = m[1].toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext)) {
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  }
  return 'jpg';
}
