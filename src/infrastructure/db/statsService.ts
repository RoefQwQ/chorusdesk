import { db } from './database';

/**
 * Get comprehensive database statistics (record counts and estimated storage)
 */
export async function getDatabaseStats() {
  const creatorsCount = await db.creators.count();
  const channelsCount = await db.channels.count();
  const totalPostsCount = await db.posts.count();
  // isBookmarked is stored as 0|1 (IndexedDB refuses booleans as index keys),
  // so this now matches real rows and needs no `as any`.
  const bookmarkedPostsCount = await db.posts.where('isBookmarked').equals(1).count();

  let quotaUsage = { usage: 0, quota: 0 };
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quotaUsage = {
        usage: est.usage || 0,
        quota: est.quota || 0,
      };
    } catch {}
  }

  return {
    creatorsCount,
    channelsCount,
    totalPostsCount,
    bookmarkedPostsCount,
    storageUsageBytes: quotaUsage.usage,
    storageQuotaBytes: quotaUsage.quota,
  };
}
