/**
 * Image Cache Service.
 * High-level coordinator for saving, retrieving, and batch-caching
 * creator media to user's local directory using File System Access API.
 */

import type { Post } from '../../types';
import {
  getSavedRootDirectoryHandle,
  clearRootDirectoryHandle,
  promptSelectDirectory,
  verifyDirectoryPermission,
  getOrCreateNestedDirectory,
  getExistingNestedDirectory,
  saveBlobToFile,
  readFileAsBlob,
} from './fsManager';
import {
  CACHED_IMAGE_EXTENSIONS,
  resolvePostDirSegments,
  resolveFileExtension,
} from './pathResolver';
import { proxyImage, toSecureMediaUrl } from '../../utils/media';

// In-memory cache of object URLs created from local files to avoid redundant disk reads
const objectUrlMemoryCache = new Map<string, string>();

// Track pending downloads to avoid duplicate concurrent disk writes
const inFlightCacheJobs = new Set<string>();

/**
 * Media keys already probed on disk and found absent, for this session.
 *
 * Without it every card mount re-walks the directory tree and retries the whole
 * extension ladder for media that is simply not cached — and on a first screen
 * that is dozens of redundant filesystem round trips competing with the images
 * that are actually loading. Cleared whenever the directory binding changes,
 * and never consulted for a key known to be present (those live in
 * `objectUrlMemoryCache`).
 */
const knownMissingMedia = new Set<string>();

/**
 * Resolved post directories, keyed by the resolved segment path.
 *
 * A 9-image post asked for the same directory nine times, and each walk is up to
 * three `getDirectoryHandle` round trips to the browser process. The value is
 * `null` for "walked and absent", recorded so a miss is not paid again.
 * Invalidated whenever the root binding changes.
 */
const postDirCache = new Map<string, FileSystemDirectoryHandle | null>();

/**
 * Convert a data URL or fetch a web URL to a Blob
 */
async function fetchImageBlob(url: string): Promise<{ blob: Blob; mimeType: string } | null> {
  const secureUrl = toSecureMediaUrl(url);

  // 1. If it's already a data URL
  if (secureUrl.startsWith('data:')) {
    const res = await fetch(secureUrl);
    const blob = await res.blob();
    return { blob, mimeType: blob.type || 'image/jpeg' };
  }

  // 2. Try direct fetch first
  try {
    const res = await fetch(secureUrl, { referrerPolicy: 'no-referrer' });
    if (res.ok) {
      const blob = await res.blob();
      return { blob, mimeType: blob.type || 'image/jpeg' };
    }
  } catch {
    // Direct fetch failed (CORS/hotlink): fall through to the background proxy.
  }

  // 3. Try background proxy if direct fetch fails (e.g. cross-origin/Referer hotlink protection)
  try {
    const dataUrl = await proxyImage(secureUrl);
    if (dataUrl) {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      return { blob, mimeType: blob.type || 'image/jpeg' };
    }
  } catch {
    // Proxy also failed: no local copy possible for this media.
  }

  return null;
}

/**
 * Resolve a post's directory, walking the tree at most once per session.
 *
 * Every media item of a post resolves the same three segments, so without this
 * a 9-image post paid 27 `getDirectoryHandle` round trips instead of 3. A miss
 * is cached as `null` so the walk is not repeated for media that was never
 * archived; `cacheMediaItem` replaces the entry when it creates the directory.
 */
async function resolvePostDir(
  root: FileSystemDirectoryHandle,
  dirSegments: string[],
): Promise<FileSystemDirectoryHandle | null> {
  const key = dirSegments.join('\u0000');
  const cached = postDirCache.get(key);
  if (cached !== undefined) return cached;
  const dir = await getExistingNestedDirectory(root, dirSegments);
  postDirCache.set(key, dir);
  return dir;
}

/**
 * Image Cache Service API
 */
export const imageCacheService = {
  /**
   * Check whether local file system cache is available and permission is granted.
   */
  async isReady(): Promise<{ ready: boolean; dirName?: string }> {
    const root = await getSavedRootDirectoryHandle();
    if (!root) return { ready: false };

    const hasPermission = await verifyDirectoryPermission(root, true);
    return {
      ready: hasPermission,
      dirName: root.name,
    };
  },

  /**
   * Prompt the user to bind a new local folder.
   */
  async bindDirectory(): Promise<{ success: boolean; dirName?: string; error?: string }> {
    try {
      const handle = await promptSelectDirectory();
      if (!handle) return { success: false, error: '已取消选择目录' };
      // A different directory invalidates every negative probe: media absent
      // under the old root may well be present under the new one.
      knownMissingMedia.clear();
      postDirCache.clear();
      objectUrlMemoryCache.clear();
      return { success: true, dirName: handle.name };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : '选择本地目录失败' };
    }
  },

  /**
   * Unbind the current directory.
   */
  async unbindDirectory(): Promise<void> {
    await clearRootDirectoryHandle();
    objectUrlMemoryCache.clear();
    knownMissingMedia.clear();
    postDirCache.clear();
  },

  /**
   * Check if a post's media item is cached locally, and return an Object URL if present.
   */
  async getLocalCachedMediaUrl(params: {
    creatorName?: string;
    platform: string;
    postId: string;
    publishedAt?: number;
    mediaIndex: number;
    mediaUrl: string;
  }): Promise<string | null> {
    const cacheKey = `${params.postId}_${params.mediaIndex}`;
    if (objectUrlMemoryCache.has(cacheKey)) {
      return objectUrlMemoryCache.get(cacheKey)!;
    }
    if (knownMissingMedia.has(cacheKey)) return null;

    const root = await getSavedRootDirectoryHandle();
    if (!root) return null;

    try {
      const dirSegments = resolvePostDirSegments({
        creatorName: params.creatorName,
        platform: params.platform,
        postId: params.postId,
        publishedAt: params.publishedAt,
      });

      const postDir = await resolvePostDir(root, dirSegments);
      if (!postDir) {
        knownMissingMedia.add(cacheKey);
        return null;
      }

      // Try the URL-derived extension first, then every other extension the
      // writer can produce (same list as the batch probe).
      const canonical: readonly string[] = CACHED_IMAGE_EXTENSIONS;
      const ext = resolveFileExtension(params.mediaUrl);
      const possibleExtensions = canonical.includes(ext)
        ? [ext, ...canonical.filter((e) => e !== ext)]
        : [ext, ...canonical];

      for (const curExt of possibleExtensions) {
        const fileName = `${params.mediaIndex}.${curExt}`;
        const blob = await readFileAsBlob(postDir, fileName);
        if (blob && blob.size > 0) {
          const objUrl = URL.createObjectURL(blob);
          objectUrlMemoryCache.set(cacheKey, objUrl);
          return objUrl;
        }
      }
      knownMissingMedia.add(cacheKey);
    } catch {
      // Disk read error or permission revoked. Not memoized: a transient failure
      // must not permanently hide a file that is really there.
    }

    return null;
  },

  /**
   * Check whether every media item of a post is already on disk.
   * Batch-archive uses this to skip fully-cached posts without any download.
   *
   * `creatorName` must be the same value the writer used: the post directory's
   * first segment is the creator name, so probing without it resolves
   * `默认创作者/…` and can never hit a file that was written under the real
   * name — the probe then reports "not cached" for every post and the batch
   * re-downloads everything.
   */
  async isPostFullyCached(post: Post, creatorName?: string): Promise<boolean> {
    if (!post.mediaList || post.mediaList.length === 0) return false;
    const root = await getSavedRootDirectoryHandle();
    if (!root) return false;

    const dirSegments = resolvePostDirSegments({
      creatorName,
      platform: post.platform,
      postId: post.id,
      publishedAt: post.publishedAt,
    });
    const postDir = await resolvePostDir(root, dirSegments);
    if (!postDir) return false;

    for (let i = 0; i < post.mediaList.length; i++) {
      const media = post.mediaList[i];
      if (media.type !== 'image' && !media.previewUrl) continue;
      // Probe by every extension the writer can produce: the file name is
      // `${index}.${ext}` with the extension resolved from the download's mime
      // type at save time.
      let found = false;
      for (const ext of CACHED_IMAGE_EXTENSIONS) {
        const blob = await readFileAsBlob(postDir, `${i}.${ext}`);
        if (blob && blob.size > 0) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  },

  /**
   * Cache a single media item for a post to the local disk.
   */
  async cacheMediaItem(params: {
    creatorName?: string;
    platform: string;
    postId: string;
    publishedAt?: number;
    mediaIndex: number;
    mediaUrl: string;
  }): Promise<string | null> {
    const jobKey = `${params.postId}_${params.mediaIndex}`;
    if (inFlightCacheJobs.has(jobKey)) return null;
    inFlightCacheJobs.add(jobKey);

    try {
      const root = await getSavedRootDirectoryHandle();
      if (!root) return null;

      // Check if already on disk
      const existing = await this.getLocalCachedMediaUrl(params);
      if (existing) return existing;

      // Download blob
      const fetched = await fetchImageBlob(params.mediaUrl);
      if (!fetched || fetched.blob.size === 0) return null;

      const dirSegments = resolvePostDirSegments({
        creatorName: params.creatorName,
        platform: params.platform,
        postId: params.postId,
        publishedAt: params.publishedAt,
      });

      // The walk above recorded this post as absent; the writes below create it,
      // so the memo must be corrected or the next read would still miss.
      const dirKey = dirSegments.join('\u0000');
      const postDir = postDirCache.get(dirKey) ?? await getOrCreateNestedDirectory(root, dirSegments);
      postDirCache.set(dirKey, postDir);
      const ext = resolveFileExtension(params.mediaUrl, fetched.mimeType);
      const fileName = `${params.mediaIndex}.${ext}`;

      await saveBlobToFile(postDir, fileName, fetched.blob);

      const objUrl = URL.createObjectURL(fetched.blob);
      objectUrlMemoryCache.set(jobKey, objUrl);
      return objUrl;
    } catch (err) {
      console.warn('[ImageCache] Save failed for', params.mediaUrl, err);
      return null;
    } finally {
      inFlightCacheJobs.delete(jobKey);
    }
  },

  /**
   * Cache all images in a post in the background.
   */
  async cachePost(post: Post, creatorName?: string): Promise<number> {
    if (!post.mediaList || post.mediaList.length === 0) return 0;
    const root = await getSavedRootDirectoryHandle();
    if (!root) return 0;

    let successCount = 0;
    for (let i = 0; i < post.mediaList.length; i++) {
      const media = post.mediaList[i];
      if (media.type !== 'image' && !media.previewUrl) continue;
      const url = media.originalUrl || media.previewUrl;
      const res = await this.cacheMediaItem({
        creatorName,
        platform: post.platform,
        postId: post.id,
        publishedAt: post.publishedAt,
        mediaIndex: i,
        mediaUrl: url,
      });
      if (res) successCount++;
    }
    return successCount;
  },
};
