import {
  clearDeletedPostRecords,
  deletePostAndTombstone,
  getDeletedPostCount,
  getDeletedPostRecords,
  permanentlyDeletePost,
  restoreAllDeletedPostIds,
  restoreDeletedPost,
  setPostBookmarked,
  setPostRead,
} from '../infrastructure/db/postRepository';
import type { DeletedPostRecord, Post } from '../types';

/**
 * Post state mutation service — the application entry point the UI should call for
 * bookmark / read / delete / recycle-bin actions. All persistence lives in the
 * repository layer; nothing here touches Dexie directly.
 *
 * The recycle-bin lifecycle is here for a reason rather than for symmetry:
 * `useDeletedPosts` used to import seven functions straight from `postRepository`,
 * which is the shape AGENTS rule 8 forbids ("prefer adding a service method over a
 * new direct repository import") while sitting outside the four areas that rule
 * enumerates. Routing it through the service is what makes the rule's ledger true
 * again — and it is why `deleteToRecycleBin` below has a caller at last.
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
   * Remove a post from the feed and store its full snapshot in the recycle bin
   * (tombstone), so it can be restored later.
   */
  async deleteToRecycleBin(post: Post): Promise<void> {
    await deletePostAndTombstone(post);
  },

  /** How many tombstoned posts the recycle bin holds (the settings badge). */
  async recycleBinCount(): Promise<number> {
    return getDeletedPostCount();
  },

  /** The recycle-bin records themselves, for the modal's list. */
  async recycleBinRecords(): Promise<DeletedPostRecord[]> {
    return getDeletedPostRecords();
  },

  /**
   * Restore one tombstoned post straight back into the feed.
   *
   * Returns the restored post, or null when the tombstone carried no snapshot —
   * in which case the caller re-fetches instead, which is why the null case is
   * part of the contract rather than swallowed here.
   */
  async restoreFromRecycleBin(id: string): Promise<Post | null> {
    return restoreDeletedPost(id);
  },

  /** Restore every tombstoned post back into the feed. Returns how many were restored. */
  async restoreAllFromRecycleBin(): Promise<number> {
    return restoreAllDeletedPostIds();
  },

  /** Drop one tombstone for good (the post stays gone). */
  async permanentlyDelete(id: string): Promise<void> {
    await permanentlyDeletePost(id);
  },

  /** Drop every tombstone for good. */
  async emptyRecycleBin(): Promise<void> {
    await clearDeletedPostRecords();
  },
};
