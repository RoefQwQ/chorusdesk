import { triggerRef, type Ref, type ShallowRef } from 'vue';
import type { Post } from '../../../src/types';
import { postService } from '../../../src/application';
import type { DashboardStats } from './useDashboardData';

export interface PostActionsDependencies {
  /** Live dashboard stats — bookmark count is adjusted reactively on toggle. */
  dbStats: Ref<DashboardStats>;
  /** Live posts shallowRef — triggerRef notifies BookmarksView and other computeds immediately. */
  posts?: ShallowRef<Post[]>;
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
    post.isBookmarked = nextState ? 1 : 0;
    if (deps.posts) {
      triggerRef(deps.posts);
    }
    try {
      await postService.setBookmarked(post.id, nextState);
      // Update dbStats count reactively
      if (deps.dbStats.value) {
        deps.dbStats.value.bookmarkedPostsCount = Math.max(0, (deps.dbStats.value.bookmarkedPostsCount || 0) + (nextState ? 1 : -1));
      }
    } catch (err: unknown) {
      console.error('Failed to toggle post bookmark', err);
      post.isBookmarked = nextState ? 0 : 1; // rollback on failure
      if (deps.posts) {
        triggerRef(deps.posts);
      }
    }
  }

  async function markPostRead(post: Post) {
    if (post.isRead) return;
    post.isRead = 1;
    if (deps.posts) {
      triggerRef(deps.posts);
    }
    await postService.markRead(post.id);
  }

  return { toggleBookmarkPost, markPostRead };
}
