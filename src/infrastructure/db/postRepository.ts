import type { Post, DeletedPostRecord } from '../../types';
import { toSecureMediaUrl } from '../../utils/media';
import { db } from './database';

/**
 * Clean up old unbookmarked posts to prevent storage explosion.
 * @param days Keep posts newer than this many days (e.g. 30, 60, 90). If 0, delete all unbookmarked posts.
 * @returns Number of posts deleted
 */
export async function cleanupOldPosts(days: number = 60): Promise<number> {
  const cutoffTime = days > 0 ? Date.now() - days * 86400 * 1000 : Infinity;

  // Find posts to delete: published before cutoff and NOT bookmarked
  const postsToDelete = await db.posts
    .filter(p => {
      const isOld = days === 0 || p.publishedAt < cutoffTime;
      const isProtected = Boolean(p.isBookmarked);
      return isOld && !isProtected;
    })
    .primaryKeys();

  if (postsToDelete.length > 0) {
    await db.posts.bulkDelete(postsToDelete);
  }

  return postsToDelete.length;
}

/**
 * Mark a post as deleted by removing it from `posts` and storing in `deletedPostIds` (Recycle Bin)
 * with a full post snapshot so it can be restored directly at any time.
 */
export async function deletePostAndTombstone(post: Post): Promise<void> {
  await db.posts.delete(post.id);
  await db.deletedPostIds.put({
    id: post.id,
    channelId: post.channelId,
    creatorId: post.creatorId,
    platform: post.platform,
    title: post.title || (post.content ? post.content.slice(0, 50) : post.id),
    deletedAt: Date.now(),
    postData: JSON.parse(JSON.stringify(post)),
  });
}

/**
 * Restore a single deleted post directly back to `posts` table from Recycle Bin.
 * Returns the restored Post if it was restored, or null if no postData existed.
 */
export async function restoreDeletedPost(id: string): Promise<Post | null> {
  const record = await db.deletedPostIds.get(id);
  if (!record) return null;
  if (record.postData) {
    await db.posts.put(record.postData);
  }
  await db.deletedPostIds.delete(id);
  return record.postData || null;
}

/**
 * Restore a single deleted post id so it can be re-fetched via network sync.
 */
export async function restoreDeletedPostId(id: string): Promise<void> {
  await restoreDeletedPost(id);
}

/**
 * Restore multiple deleted posts directly back into `posts` table.
 */
export async function restoreDeletedPostIds(ids: string[]): Promise<Post[]> {
  const records = await db.deletedPostIds.where('id').anyOf(ids).toArray();
  const restored: Post[] = [];
  for (const r of records) {
    if (r.postData) {
      restored.push(r.postData);
    }
  }
  if (restored.length > 0) {
    await db.posts.bulkPut(restored);
  }
  await db.deletedPostIds.bulkDelete(ids);
  return restored;
}

/**
 * Clear all deleted post tombstone records and restore all snapshot posts back to feed.
 */
export async function restoreAllDeletedPostIds(): Promise<number> {
  const records = await db.deletedPostIds.toArray();
  const restored: Post[] = [];
  for (const r of records) {
    if (r.postData) {
      restored.push(r.postData);
    }
  }
  if (restored.length > 0) {
    await db.posts.bulkPut(restored);
  }
  await db.deletedPostIds.clear();
  return records.length;
}

/**
 * Permanently purge a deleted post record from Recycle Bin without restoring it.
 */
export async function permanentlyDeletePost(id: string): Promise<void> {
  await db.deletedPostIds.delete(id);
}

/**
 * Get count of tombstoned deleted posts in Recycle Bin.
 */
export async function getDeletedPostCount(): Promise<number> {
  try {
    return await db.deletedPostIds.count();
  } catch {
    return 0;
  }
}

/**
 * Get all tombstoned deleted post records in Recycle Bin, sorted newest first.
 */
export async function getDeletedPostRecords(): Promise<DeletedPostRecord[]> {
  try {
    return await db.deletedPostIds.orderBy('deletedAt').reverse().toArray();
  } catch {
    return [];
  }
}

/**
 * Persist the post's bookmark flag. Mirrors the dashboard's inline
 * `db.posts.update(post.id, { isBookmarked })` write exactly.
 */
export async function setPostBookmarked(id: string, isBookmarked: boolean): Promise<void> {
  await db.posts.update(id, { isBookmarked });
}

/**
 * Mark a single post as read (`isRead: true`). The caller keeps its own
 * already-read guard; this only persists the flag like the legacy write.
 */
export async function setPostRead(id: string): Promise<void> {
  await db.posts.update(id, { isRead: true });
}

/**
 * Permanently clear every tombstone in the recycle bin without restoring any
 * snapshot (dashboard "清空回收站" action — `db.deletedPostIds.clear()`).
 */
export async function clearDeletedPostRecords(): Promise<void> {
  await db.deletedPostIds.clear();
}

/**
 * Heal broken or stale image URLs in local IndexedDB posts (e.g. Xiaohongshu strict CDN domains).
 * Returns the count of healed posts.
 */
export async function healBrokenPostMedia(): Promise<number> {
  let healedCount = 0;
  const xhsPosts = await db.posts.where('platform').equals('xiaohongshu').toArray();

  for (const post of xhsPosts) {
    let modified = false;
    if (post.mediaList && post.mediaList.length > 0) {
      for (const media of post.mediaList) {
        if (media.previewUrl) {
          const healed = toSecureMediaUrl(media.previewUrl);
          if (healed && healed !== media.previewUrl) {
            media.previewUrl = healed;
            modified = true;
          }
        }
        if (media.originalUrl) {
          const healed = toSecureMediaUrl(media.originalUrl);
          if (healed && healed !== media.originalUrl) {
            media.originalUrl = healed;
            modified = true;
          }
        }
      }
    }

    if (post.authorMeta?.avatar) {
      const healedAvatar = toSecureMediaUrl(post.authorMeta.avatar);
      if (healedAvatar && healedAvatar !== post.authorMeta.avatar) {
        post.authorMeta.avatar = healedAvatar;
        modified = true;
      }
    }

    if (modified) {
      await db.posts.put(post);
      healedCount++;
    }
  }

  // Also check channels avatarUrl
  const xhsChannels = await db.channels.where('platform').equals('xiaohongshu').toArray();
  for (const ch of xhsChannels) {
    if (ch.avatarUrl) {
      const fixed = toSecureMediaUrl(ch.avatarUrl);
      if (fixed && fixed !== ch.avatarUrl) {
        await db.channels.update(ch.id, { avatarUrl: fixed });
      }
    }
  }

  return healedCount;
}
