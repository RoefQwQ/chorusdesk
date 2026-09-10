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
  resolvePostDirSegments,
  resolveFileExtension,
} from './pathResolver';
import { proxyImage, toSecureMediaUrl } from '../../utils/media';

// In-memory cache of object URLs created from local files to avoid redundant disk reads
const objectUrlMemoryCache = new Map<string, string>();

// Track pending downloads to avoid duplicate concurrent disk writes
const inFlightCacheJobs = new Set<string>();

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

    const root = await getSavedRootDirectoryHandle();
    if (!root) return null;

    try {
      const dirSegments = resolvePostDirSegments({
        creatorName: params.creatorName,
        platform: params.platform,
        postId: params.postId,
        publishedAt: params.publishedAt,
      });

      const postDir = await getExistingNestedDirectory(root, dirSegments);
      if (!postDir) return null;

      // Try common extensions
      const ext = resolveFileExtension(params.mediaUrl);
      const possibleExtensions = [ext, 'jpg', 'webp', 'png', 'gif', 'avif'];

      for (const curExt of possibleExtensions) {
        const fileName = `${params.mediaIndex}.${curExt}`;
        const blob = await readFileAsBlob(postDir, fileName);
        if (blob && blob.size > 0) {
          const objUrl = URL.createObjectURL(blob);
          objectUrlMemoryCache.set(cacheKey, objUrl);
          return objUrl;
        }
      }
    } catch {
      // Disk read error or permission revoked
    }

    return null;
  },

  /**
   * Check whether every media item of a post is already on disk.
   * Batch-archive uses this to skip fully-cached posts without any download.
   */
  async isPostFullyCached(post: Post): Promise<boolean> {
    if (!post.mediaList || post.mediaList.length === 0) return false;
    const root = await getSavedRootDirectoryHandle();
    if (!root) return false;

    const dirSegments = resolvePostDirSegments({
      platform: post.platform,
      postId: post.id,
      publishedAt: post.publishedAt,
    });
    const postDir = await getExistingNestedDirectory(root, dirSegments);
    if (!postDir) return false;

    for (let i = 0; i < post.mediaList.length; i++) {
      const media = post.mediaList[i];
      if (media.type !== 'image' && !media.previewUrl) continue;
      // Probe by every known extension: the file was written with the
      // extension resolved from the download's mime type at save time.
      let found = false;
      for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']) {
        const blob = await readFileAsBlob(postDir, `${i}.${ext}`).catch(() => null);
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

      const postDir = await getOrCreateNestedDirectory(root, dirSegments);
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
