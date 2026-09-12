import type { Post, RecycleSnapshot } from '../../types';
import { toSecureMediaUrl } from '../../utils/media';
import { db } from './database';

/**
 * Deletion lifecycle (DELETION_MODEL.md).
 *
 * Three concepts with three lifecycles:
 *
 *   postSuppressions   「这条内容不许通过同步再出现」 — cleared ONLY by an
 *                       explicit restore. `permanentlyDelete` and
 *                       `emptyRecycleBin` must never touch it.
 *   recycleSnapshots   「这条内容还能不能找回」 — cleared by 彻底删除 / 清空回收站
 *                       / 恢复.
 *   posts              「现在可见的内容」 — the feed itself.
 *
 * The earlier single-table design put suppression and snapshot in one row, so
 * dropping a snapshot also dropped the blacklist and deleted posts came back on
 * the next sync. Every mutation here that touches both halves is a single
 * transaction, so a failure can never leave `posts` and `postSuppressions`
 * disagreeing (I5/I6).
 */

/**
 * Clean up old unbookmarked posts to prevent storage explosion.
 *
 * Deliberately does NOT create suppressions: this is storage maintenance the
 * user triggers by hand, not 「我不要这条内容」 (DELETION_MODEL §6 问题 6).
 */
export async function cleanupOldPosts(days: number = 60): Promise<number> {
  const cutoffTime = days > 0 ? Date.now() - days * 86400 * 1000 : Infinity;
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
 * Delete a post: remove it from the feed, record the suppression (permanent
 * until explicitly restored) and keep a full snapshot in the recycle bin.
 *
 * One transaction: a failure leaves the post in the feed rather than in a state
 * where it is gone but not suppressed (I6).
 */
export async function deletePostAndTombstone(post: Post): Promise<void> {
  await db.transaction('rw', [db.posts, db.postSuppressions, db.recycleSnapshots], async () => {
    await db.posts.delete(post.id);
    await db.postSuppressions.put({
      postId: post.id,
      platform: post.platform,
      suppressedAt: Date.now(),
      channelId: post.channelId,
      creatorId: post.creatorId,
    });
    await db.recycleSnapshots.put({
      id: post.id,
      channelId: post.channelId,
      creatorId: post.creatorId,
      platform: post.platform,
      title: post.title || (post.content ? post.content.slice(0, 50) : post.id),
      deletedAt: Date.now(),
      postData: JSON.parse(JSON.stringify(post)),
    });
  });
}

/**
 * The one restore policy, shared by the single and bulk paths.
 *
 * I11: a snapshot whose parent channel is gone cannot be restored into a working
 * feed — writing it back would produce a row pointing at a channel that does not
 * exist, which the old code did while telling the user 「动态已定向找回」. Such an
 * orphan can never become restorable again, so it is dropped.
 *
 * This is a shared predicate because the two paths used to DISAGREE: the single
 * path checked the channel and the bulk path did not, so the same operation
 * rejected a row one at a time and accepted it in bulk. That asymmetry is the
 * one that matters — a v6 migration can carry orphan tombstones from the old
 * `deletedPostIds` shape, and the bulk path would have written them back.
 */
async function isOrphanSnapshot(record: RecycleSnapshot): Promise<boolean> {
  if (!record.channelId) return false;
  return !(await db.channels.get(record.channelId));
}

/**
 * Restore a post from the recycle bin: write it back and CLEAR its suppression.
 *
 * Both halves in one transaction. Returns the restored post, or null when no
 * snapshot existed (the caller then re-fetches instead) or when the snapshot was
 * an orphan (I11, see `isOrphanSnapshot`).
 */
export async function restoreDeletedPost(id: string): Promise<Post | null> {
  return db.transaction('rw', [db.posts, db.channels, db.postSuppressions, db.recycleSnapshots], async () => {
    const record = await db.recycleSnapshots.get(id);
    if (!record) return null;
    if (await isOrphanSnapshot(record)) {
      await db.recycleSnapshots.delete(id);
      return null;
    }
    if (record.postData) {
      await db.posts.put(record.postData);
    }
    await db.postSuppressions.delete(id);
    await db.recycleSnapshots.delete(id);
    return record.postData || null;
  });
}

/** What 「恢复回收站全部动态」 actually did. */
export interface RecycleRestoreSummary {
  /** Snapshots written back into the feed. */
  restored: number;
  /** Orphans dropped instead of restored, because their channel is gone (I11). */
  dropped: number;
}

/**
 * 「恢复回收站全部动态」 — restore what is IN the recycle bin, and nothing else.
 *
 * Touches only snapshots. A post that was 彻底删除 has a suppression and no
 * snapshot, so its suppression SURVIVES this call and the promise 「今后同步也不会
 * 再出现」 holds.
 *
 * That restriction is the whole point. This used to end in an unconditional
 * `postSuppressions.clear()`, which made a button sitting inside the recycle bin
 * silently revoke a permanent deletion made outside it — 彻底删除 was permanent
 * only until someone pressed a different button. Releasing those suppressions is
 * now the explicitly named `releaseAllSuppressions`, so the user has to mean it.
 */
export async function restoreAllDeletedPostIds(): Promise<RecycleRestoreSummary> {
  return db.transaction(
    'rw',
    [db.posts, db.channels, db.postSuppressions, db.recycleSnapshots],
    async () => {
      const records = await db.recycleSnapshots.toArray();
      const restored: Post[] = [];
      const liftSuppressionFor: string[] = [];
      let dropped = 0;
      for (const record of records) {
        if (await isOrphanSnapshot(record)) {
          dropped++;
          continue;
        }
        if (record.postData) restored.push(record.postData);
        // The snapshot is going away, so its suppression has nothing left to
        // hide: this is a restore for exactly the ids in the bin.
        liftSuppressionFor.push(record.id);
      }
      if (restored.length > 0) await db.posts.bulkPut(restored);
      if (liftSuppressionFor.length > 0) await db.postSuppressions.bulkDelete(liftSuppressionFor);
      await db.recycleSnapshots.clear();
      return { restored: restored.length, dropped };
    },
  );
}

/**
 * 「解除所有删除状态」 — lift every suppression, including 彻底删除's.
 *
 * This is the ONLY action that can undo a 彻底删除, and after it previously
 * deleted content may reappear on the next sync. Deliberately separate from
 * restoring the bin, and the UI must state the consequence: it is the one thing
 * the user cannot see afterwards, and the reason the two were split.
 *
 * Returns how many suppressions were lifted.
 */
export async function releaseAllSuppressions(): Promise<number> {
  return db.transaction('rw', db.postSuppressions, async () => {
    const lifted = await db.postSuppressions.count();
    await db.postSuppressions.clear();
    return lifted;
  });
}

/**
 * Deletions that no longer have a snapshot — the residue of 彻底删除.
 *
 * Every delete writes a suppression AND a snapshot; 彻底删除 removes only the
 * snapshot. So the difference is exactly the set of rows that 「恢复回收站全部动态」
 * will leave alone, which is what the 「解除所有删除状态」 confirmation must name.
 */
export async function countPermanentlyDeleted(): Promise<number> {
  const [suppressions, snapshots] = await Promise.all([
    db.postSuppressions.count(),
    db.recycleSnapshots.count(),
  ]);
  return Math.max(0, suppressions - snapshots);
}

/**
 * 彻底删除: drop the snapshot for good. The post stays gone because the
 * SUPPRESSION stays — this is the whole point of the split, and the reason
 * the old comment ("the post stays gone") was false before it.
 */
export async function permanentlyDeletePost(id: string): Promise<void> {
  await db.recycleSnapshots.delete(id);
}

/** Get count of recycle-bin snapshots. */
export async function getDeletedPostCount(): Promise<number> {
  try {
    return await db.recycleSnapshots.count();
  } catch {
    return 0;
  }
}

/** Get all recycle-bin records, sorted newest first. */
export async function getDeletedPostRecords(): Promise<RecycleSnapshot[]> {
  try {
    return await db.recycleSnapshots.orderBy('deletedAt').reverse().toArray();
  } catch {
    return [];
  }
}

/**
 * 清空回收站: drop every snapshot, keep every suppression (I3).
 */
export async function clearDeletedPostRecords(): Promise<void> {
  await db.recycleSnapshots.clear();
}

/**
 * Is this post currently suppressed? The sync layer's filter (I7/I10).
 * Read failures propagate: the caller must fail closed, never write the post.
 */
export async function getSuppressedPostIds(postIds: readonly string[]): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();
  const rows = await db.postSuppressions.bulkGet([...postIds]);
  const suppressed = new Set<string>();
  for (const row of rows) {
    if (row) suppressed.add(row.postId);
  }
  return suppressed;
}

/**
 * Lift suppression for exactly these ids (the user's explicit restore path).
 * Bounded to the ids the adapter just returned — never a table scan.
 */
export async function clearSuppressions(postIds: readonly string[]): Promise<void> {
  if (postIds.length > 0) await db.postSuppressions.bulkDelete([...postIds]);
}

/**
 * How many suppressions still stand under these channels (unfollow prompt,
 * §6 问题 5). Counts suppression rows directly, so it stays correct after
 * 彻底删除 has dropped the snapshot.
 */
export async function countSuppressionsForChannels(channelIds: readonly string[]): Promise<number> {
  if (channelIds.length === 0) return 0;
  const ids = new Set(channelIds);
  const rows = await db.postSuppressions.toArray();
  return rows.filter((r) => r.channelId !== undefined && ids.has(r.channelId)).length;
}

/** How many suppressions still stand under this creator (batch unfollow prompt). */
export async function countSuppressionsForCreator(creatorId: string): Promise<number> {
  // `creatorId` is not an index on postSuppressions (the key is postId), so
  // filter rather than `where` — this is a rare prompt, not a hot path.
  const rows = await db.postSuppressions.toArray();
  return rows.filter((r) => r.creatorId === creatorId).length;
}

/**
 * Persist the post's bookmark flag as 0|1 (IndexedDB refuses booleans as
 * index keys — AGENTS.md rule 5). Callers speak boolean; the boundary
 * converts.
 */
export async function setPostBookmarked(id: string, isBookmarked: boolean): Promise<void> {
  await db.posts.update(id, { isBookmarked: isBookmarked ? 1 : 0 });
}

/**
 * Mark a single post as read (`isRead: 1`). The caller keeps its own
 * already-read guard; this only persists the flag like the legacy write.
 */
export async function setPostRead(id: string): Promise<void> {
  await db.posts.update(id, { isRead: 1 });
}

/**
 * Heal broken or stale image URLs in local IndexedDB posts (e.g. Xiaohongshu strict CDN domains).
 * Returns the count of healed posts.
 */
export async function healBrokenPostMedia(): Promise<number> {
  const posts = await db.posts.toArray();
  let healedCount = 0;

  for (const post of posts) {
    let changed = false;

    if (post.mediaList && post.mediaList.length > 0) {
      const newMediaList = post.mediaList.map(m => {
        const securedPreview = toSecureMediaUrl(m.previewUrl);
        const securedOriginal = toSecureMediaUrl(m.originalUrl);
        if (securedPreview !== m.previewUrl || securedOriginal !== m.originalUrl) {
          changed = true;
        }
        return { ...m, previewUrl: securedPreview, originalUrl: securedOriginal };
      });
      if (changed) post.mediaList = newMediaList;
    }

    const securedAvatar = post.authorMeta?.avatar ? toSecureMediaUrl(post.authorMeta.avatar) : undefined;
    if (securedAvatar && securedAvatar !== post.authorMeta?.avatar) {
      post.authorMeta = { ...post.authorMeta, avatar: securedAvatar };
      changed = true;
    }

    if (changed) {
      await db.posts.put(post);
      healedCount++;
    }
  }

  return healedCount;
}
