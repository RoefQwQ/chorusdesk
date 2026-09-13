// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Creator, Post } from '../src/types';

/**
 * Post-sync archiving: the feature that saves media at the moment a sync hands it
 * over, rather than when the user happens to scroll a card into view.
 *
 * Why it matters, measured in a real library: a note published 5/21 and synced
 * 9/6 still showed 「原图暂无法直接预览」, because 9/6 was the first time anything
 * asked for its image and xiaohongshu's signed CDN link had already lapsed. Save
 * now or lose it.
 *
 * These assertions are on WHAT GETS SAVED and WHEN — the observable behaviour —
 * not on which helper was called. The two things most likely to go wrong quietly
 * are covered directly: an unbound directory must be a no-op (archiving is opt-in
 * and the common case is unbound), and the strategy setting must actually select.
 */

const isReadyResult = { ready: true as boolean };
const cached: Array<{ postId: string; creatorName?: string }> = [];

vi.mock('../src/services/imageCache', () => ({
  imageCacheService: {
    isReady: async () => isReadyResult,
    cachePost: async (post: Post, creatorName?: string) => {
      cached.push({ postId: post.id, creatorName });
      return 2; // two images saved
    },
  },
}));

// `archivesMedia` is read through the real registry, so rss (archivesMedia:false)
// is exercised rather than mocked away.
import { usePostSyncArchive } from '../entrypoints/dashboard/composables/usePostSyncArchive';

function post(over: Partial<Post>): Post {
  return {
    id: 'p1',
    creatorId: 'c1',
    channelId: 'ch1',
    platform: 'xiaohongshu',
    title: 't',
    content: 'c',
    mediaList: [{ type: 'image', previewUrl: 'https://cdn/a.jpg', originalUrl: 'https://cdn/a.jpg' }],
    originalUrl: 'https://example.invalid/1',
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    isRead: 0,
    ...over,
  } as Post;
}

const creators: Creator[] = [{ id: 'c1', name: '示例画师', avatar: '', tags: [], createdAt: 0, updatedAt: 0 }];

function make(posts: Post[], strategy?: 'all' | 'restricted_only' | 'bookmarks_only') {
  return usePostSyncArchive({
    getPosts: () => posts,
    getCreators: () => creators,
    getChannels: () => [],
    getStrategy: () => strategy,
  });
}

beforeEach(() => {
  cached.length = 0;
  isReadyResult.ready = true;
});

describe('post-sync archiving', () => {
  it('saves the media of the posts the snapshot holds, under the creator folder', async () => {
    const posts = [post({ id: 'a' }), post({ id: 'b' })];
    await make(posts).archiveSyncedPosts();

    expect(cached.map((c) => c.postId)).toEqual(['a', 'b']);
    // The folder must match what the cards write, or one creator's images split
    // across two directories (`默认创作者/` vs their real name).
    expect(cached.every((c) => c.creatorName === '示例画师')).toBe(true);
  });

  it('does nothing when no directory is bound', async () => {
    isReadyResult.ready = false;
    await make([post({})]).archiveSyncedPosts();

    expect(cached).toEqual([]);
  });

  it('stops probing once it has found the directory unbound', async () => {
    isReadyResult.ready = false;
    const archive = make([post({})]);
    await archive.archiveSyncedPosts();
    await archive.archiveSyncedPosts();
    // Still nothing saved; the point is that the second call short-circuits rather
    // than re-asking on every sync for the rest of the session.
    expect(cached).toEqual([]);
  });

  it('skips posts with no media, and platforms that opted out of archiving', async () => {
    await make([
      post({ id: 'nomedia', mediaList: [] }),
      post({ id: 'rss', platform: 'rss' }), // archivesMedia:false
      post({ id: 'xhs' }),
    ]).archiveSyncedPosts();

    expect(cached.map((c) => c.postId)).toEqual(['xhs']);
  });

  describe('the strategy setting selects what is worth saving', () => {
    const items = [
      post({ id: 'xhs' }), // expiring signed URL
      post({ id: 'bili', platform: 'bilibili' }), // permanent URL
      post({ id: 'bm', platform: 'bilibili', isBookmarked: 1 }),
    ];

    it('all (and an absent setting) saves everything', async () => {
      await make(items).archiveSyncedPosts();
      expect(cached.map((c) => c.postId)).toEqual(['xhs', 'bili', 'bm']);
    });

    it('restricted_only saves only platforms whose URLs expire', async () => {
      await make(items, 'restricted_only').archiveSyncedPosts();
      expect(cached.map((c) => c.postId)).toEqual(['xhs']);
    });

    it('bookmarks_only saves only what the user flagged', async () => {
      await make(items, 'bookmarks_only').archiveSyncedPosts();
      expect(cached.map((c) => c.postId)).toEqual(['bm']);
    });
  });

  it('does not stack a second pass while one is running', async () => {
    const posts = [post({ id: 'x' })];
    const archive = make(posts);
    // Two syncs landing together: the second must join, not duplicate the work.
    await Promise.all([archive.archiveSyncedPosts(), archive.archiveSyncedPosts()]);
    expect(cached.map((c) => c.postId)).toEqual(['x']);
  });
});
