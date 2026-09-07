import {
  deletePostAndTombstone,
  setPostBookmarked,
  setPostRead,
} from '../infrastructure/db/postRepository';
import type { Post } from '../types';

/**
 * Post state mutation service — the application entry point the UI should
 * call for bookmark / read / delete-to-recycle-bin actions. All persistence
 * lives in the repository layer; nothing here touches Dexie directly.
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
   * Remove a post from the feed and store its full snapshot in the recycle
   * bin (tombstone), so it can be restored later.
   */
  async deleteToRecycleBin(post: Post): Promise<void> {
    await deletePostAndTombstone(post);
  },
};
