import {
  clearDeletedPostRecords,
  clearSuppressions,
  countPermanentlyDeleted,
  countSuppressionsForChannels,
  countSuppressionsForCreator,
  deletePostAndTombstone,
  getDeletedPostCount,
  getDeletedPostRecords,
  permanentlyDeletePost,
  releaseAllSuppressions,
  restoreAllDeletedPostIds,
  restoreDeletedPost,
  setPostBookmarked,
  setPostRead,
  type RecycleRestoreSummary,
} from '../infrastructure/db/postRepository';
import type { Post, RecycleSnapshot } from '../types';

/**
 * Post state mutation service — the application entry point the UI should call for
 * bookmark / read / delete / recycle-bin actions. All persistence lives in the
 * repository layer; nothing here touches Dexie directly.
 *
 * The deletion semantics it exposes are `DELETION_MODEL.md`'s, and the two
 * destructive actions are deliberately asymmetric with `restore`:
 *
 *   permanentlyDelete / emptyRecycleBin  → drop snapshots only, KEEP suppressions
 *   restoreFromRecycleBin / restoreAll   → restore the post AND lift suppression
 *
 * The old single-table design made the first pair lift the blacklist too, so
 * 「彻底删除」 promised "the post stays gone" and delivered the opposite.
 */
export const postService = {
  /**
   * Toggle the bookmark flag of a single post (optimistic caller pattern:
   * the UI flips `post.isBookmarked` first and rolls back on throw).
   */
  async setBookmarked(id: string, isBookmarked: boolean): Promise<void> {
    await setPostBookmarked(id, isBookmarked);
  },

  /** Mark a single post as read. No-op semantics are the caller's guard. */
  async markRead(id: string): Promise<void> {
    await setPostRead(id);
  },

  /**
   * Remove a post from the feed, suppress it from future syncs, and store its
   * full snapshot in the recycle bin, so it can be restored later.
   */
  async deleteToRecycleBin(post: Post): Promise<void> {
    await deletePostAndTombstone(post);
  },

  /** How many snapshots the recycle bin holds (the settings badge). */
  async recycleBinCount(): Promise<number> {
    return getDeletedPostCount();
  },

  /** The recycle-bin records themselves, for the modal's list. */
  async recycleBinRecords(): Promise<RecycleSnapshot[]> {
    return getDeletedPostRecords();
  },

  /**
   * Restore one post straight back into the feed, clearing its suppression.
   *
   * Returns the restored post, or null when nothing was restored — no snapshot,
   * or an orphan whose channel is gone (I11). The caller then re-fetches, which
   * is why the null case is part of the contract rather than swallowed here.
   */
  async restoreFromRecycleBin(id: string): Promise<Post | null> {
    return restoreDeletedPost(id);
  },

  /**
   * 「恢复回收站全部动态」: restore every snapshot, and only those. Returns what
   * happened, including how many orphan snapshots were dropped (I11).
   *
   * This does NOT lift 彻底删除's suppressions — see `releaseAllSuppressions`.
   */
  async restoreAllFromRecycleBin(): Promise<RecycleRestoreSummary> {
    return restoreAllDeletedPostIds();
  },

  /**
   * 「解除所有删除状态」: lift every suppression, INCLUDING 彻底删除's, so
   * previously deleted content may reappear on the next sync. The only way to
   * undo a permanent deletion; the UI must state that consequence.
   */
  async releaseAllSuppressions(): Promise<number> {
    return releaseAllSuppressions();
  },

  /** How many deletions a bin restore will leave alone (彻底删除's residue). */
  async countPermanentlyDeleted(): Promise<number> {
    return countPermanentlyDeleted();
  },

  /**
   * 彻底删除: drop one snapshot for good. The post stays gone because the
   * suppression remains — that is the difference from `restoreFromRecycleBin`.
   */
  async permanentlyDelete(id: string): Promise<void> {
    await permanentlyDeletePost(id);
  },

  /** 清空回收站: drop every snapshot, keep every suppression. */
  async emptyRecycleBin(): Promise<void> {
    await clearDeletedPostRecords();
  },

  /**
   * Lift suppression for explicit ids. Used by the UI only for ids the user
   * named; the sync layer's `restoreDeleted` path does its own clearing.
   */
  async clearSuppressed(ids: string[]): Promise<void> {
    await clearSuppressions(ids);
  },

  /** How many deletions still stand under these channels (unfollow prompt). */
  async suppressionsUnderChannels(channelIds: string[]): Promise<number> {
    return countSuppressionsForChannels(channelIds);
  },

  /** How many deletions still stand under this creator (batch unfollow prompt). */
  async suppressionsUnderCreator(creatorId: string): Promise<number> {
    return countSuppressionsForCreator(creatorId);
  },
};
