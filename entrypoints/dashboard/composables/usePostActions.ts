import type { Ref } from 'vue';
import type { Post } from '../../../src/types';
import { postService } from '../../../src/application';
import type { DashboardStats } from './useDashboardData';

export interface PostActionsDependencies {
  /** Live dashboard stats — bookmark count is adjusted reactively on toggle. */
  dbStats: Ref<DashboardStats>;
}

/**
 * Post state actions (bookmark / read) for the Dashboard feed & bookmarks
 * surfaces. Persistence goes through `postService` — the calling layer never
 * touches Dexie. Optimistic-mutation semantics are preserved from the former
 * App.vue handlers.
 */
export function usePostActions(deps: PostActionsDependencies) {
  async function toggleBookmarkPost(post: Post) {
    const nextState = !post.isBookmarked;
    post.isBookmarked = nextState;
    try {
      await postService.setBookmarked(post.id, nextState);
      // Update dbStats count reactively
      if (deps.dbStats.value) {
        deps.dbStats.value.bookmarkedPostsCount = (deps.dbStats.value.bookmarkedPostsCount || 0) + (nextState ? 1 : -1);
      }
    } catch (err: unknown) {
      console.error('Failed to toggle post bookmark', err);
      post.isBookmarked = !nextState; // rollback on failure
    }
  }

  async function markPostRead(post: Post) {
    if (post.isRead) return;
    post.isRead = true;
    await postService.markRead(post.id);
  }

  return { toggleBookmarkPost, markPostRead };
}
