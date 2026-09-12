import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowRef } from 'vue';
import type { Post } from '../src/types';

/**
 * Hover-prefetch (queue B5).
 *
 * The feature is a pure optimisation, so its contract is about NOT being a
 * problem: it must not stampede (one pass per platform), must not run when the
 * disk cache is unbound (the default), must stop when superseded, and must
 * never throw into a hover handler. Those are the properties worth pinning —
 * "it eventually caches some images" is the part a user would notice anyway.
 */

const cachePost = vi.fn<(post: Post, creatorName?: string) => Promise<number>>(async () => 1);
const isReady = vi.fn(async () => ({ ready: true }));

vi.mock('../src/services/imageCache', () => ({
  imageCacheService: {
    cachePost: (post: Post, creatorName?: string) => cachePost(post, creatorName),
    isReady: () => isReady(),
  },
}));

import { usePlatformPrefetch } from '../entrypoints/dashboard/composables/usePlatformPrefetch';

function post(platform: string, id: string): Post {
  return {
    id,
    creatorId: 'c1',
    channelId: `${platform}:u`,
    platform,
    title: 't',
    content: 'c',
    mediaList: [{ type: 'image', previewUrl: 'https://x/1.jpg', originalUrl: 'https://x/1.jpg' }],
    originalUrl: 'https://x/1',
    publishedAt: 1,
    fetchedAt: 1,
    isRead: 0,
  };
}

beforeEach(() => {
  cachePost.mockClear();
  cachePost.mockImplementation(async () => 1);
  isReady.mockClear();
  isReady.mockImplementation(async () => ({ ready: true }));
});

describe('usePlatformPrefetch', () => {
  it('warms at most one screen of a platform, once', async () => {
    const posts = shallowRef<Post[]>(
      Array.from({ length: 100 }, (_, i) => post('bilibili', `bilibili_${i}`)),
    );
    const { prefetchPlatform } = usePlatformPrefetch(posts);

    await prefetchPlatform('bilibili');
    expect(cachePost).toHaveBeenCalledTimes(36); // PREFETCH_POST_LIMIT

    // A second hover must not re-run: the gesture is not a background archiver.
    await prefetchPlatform('bilibili');
    expect(cachePost).toHaveBeenCalledTimes(36);
  });

  it('does nothing when the disk cache is not bound', async () => {
    isReady.mockImplementation(async () => ({ ready: false }));
    const posts = shallowRef<Post[]>([post('weibo', 'weibo_1')]);
    const { prefetchPlatform } = usePlatformPrefetch(posts);

    await prefetchPlatform('weibo');

    expect(cachePost).not.toHaveBeenCalled();
  });

  it('only touches posts of the hovered platform', async () => {
    const posts = shallowRef<Post[]>([post('bilibili', 'b_1'), post('weibo', 'w_1')]);
    const { prefetchPlatform } = usePlatformPrefetch(posts);

    await prefetchPlatform('weibo');

    expect(cachePost).toHaveBeenCalledTimes(1);
    expect((cachePost.mock.calls[0][0] as Post).id).toBe('w_1');
  });

  it('survives a failing cachePost without throwing into the hover handler', async () => {
    cachePost.mockRejectedValue(new Error('disk full'));
    const posts = shallowRef<Post[]>([post('pixiv', 'p_1'), post('pixiv', 'p_2')]);
    const { prefetchPlatform } = usePlatformPrefetch(posts);

    await expect(prefetchPlatform('pixiv')).resolves.toBeUndefined();
    expect(cachePost).toHaveBeenCalledTimes(2); // the second post still ran
  });

  it('stops an in-flight pass when a newer hover supersedes it', async () => {
    // Every cachePost resolves on a microtask; the first pass checks the
    // generation before each post, so bumping it after the first call must stop
    // the loop early. `await Promise.resolve()` a few times lets the loop run.
    const posts = shallowRef<Post[]>([
      post('bilibili', 'b_1'), post('bilibili', 'b_2'), post('bilibili', 'b_3'),
      post('weibo', 'w_1'),
    ]);
    const { prefetchPlatform } = usePlatformPrefetch(posts);

    const first = prefetchPlatform('bilibili');
    const second = prefetchPlatform('weibo');
    await Promise.all([first, second]);

    const platforms = cachePost.mock.calls.map((c) => c[0].platform);
    // The weibo pass ran; the bilibili pass stopped before its third post.
    expect(platforms).toContain('weibo');
    expect(platforms.filter((p) => p === 'bilibili').length).toBeLessThan(3);
  });
});
