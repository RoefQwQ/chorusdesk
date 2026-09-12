import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { Post } from '../src/types';
import { db } from '../src/infrastructure/db/database';
import { postService } from '../src/application';
import { cleanupOldPosts, healBrokenPostMedia } from '../src/infrastructure/db/postRepository';

/**
 * The non-deletion half of `postRepository`.
 *
 * The deletion lifecycle has its own invariant suite (`deletionInvariants.test.ts`);
 * these are the other exported mutations — bookmark / read flags, the storage
 * cleanup, and media healing — which had NO test at all until the coverage
 * baseline (audit P2-14) exposed `postRepository.ts` at 26% branch while
 * `channelSync` sat at 78%.
 *
 * Each assertion here is on stored state, because that is what the rest of the
 * app reads back: the flags are `0 | 1` for the index reason, cleanup must not
 * invent suppressions, and healing must rewrite the URL a card will render.
 */

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 'xiaohongshu_heal_1',
    creatorId: 'c1',
    channelId: 'xiaohongshu:u1',
    platform: 'xiaohongshu',
    title: 't',
    content: 'c',
    mediaList: [],
    originalUrl: 'https://www.xiaohongshu.com/explore/heal_1',
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    isRead: 0,
    ...overrides,
  };
}

beforeEach(async () => {
  await db.open();
  await Promise.all([
    db.creators.clear(),
    db.channels.clear(),
    db.posts.clear(),
    db.settings.clear(),
    db.postSuppressions.clear(),
    db.recycleSnapshots.clear(),
  ]);
});

describe('post flag writes', () => {
  it('persists bookmark / read as 0|1 so the indexes stay queryable', async () => {
    await db.posts.put(post());

    await postService.setBookmarked('xiaohongshu_heal_1', true);
    await postService.markRead('xiaohongshu_heal_1');

    const row = await db.posts.get('xiaohongshu_heal_1');
    expect(row?.isBookmarked).toBe(1);
    expect(row?.isRead).toBe(1);

    // The index is what the badge and the bookmark view query; a boolean here
    // would silently drop the row from it (AGENTS rule 5).
    expect(await db.posts.where('isBookmarked').equals(1).primaryKeys()).toEqual(['xiaohongshu_heal_1']);
    expect(await db.posts.where('isRead').equals(1).primaryKeys()).toEqual(['xiaohongshu_heal_1']);

    await postService.setBookmarked('xiaohongshu_heal_1', false);
    expect((await db.posts.get('xiaohongshu_heal_1'))?.isBookmarked).toBe(0);
  });
});

describe('cleanupOldPosts', () => {
  it('deletes old unbookmarked posts and keeps bookmarked ones', async () => {
    const now = Date.now();
    await db.posts.bulkPut([
      post({ id: 'xiaohongshu_old', publishedAt: now - 90 * 86400_000 }),
      post({ id: 'xiaohongshu_old_saved', publishedAt: now - 90 * 86400_000, isBookmarked: 1 }),
      post({ id: 'xiaohongshu_new', publishedAt: now - 1 * 86400_000 }),
    ]);

    const deleted = await cleanupOldPosts(60);

    expect(deleted).toBe(1);
    const remaining = (await db.posts.toArray()).map((p) => p.id).sort();
    expect(remaining).toEqual(['xiaohongshu_new', 'xiaohongshu_old_saved']);
  });

  it('days = 0 clears every unbookmarked post regardless of age', async () => {
    const now = Date.now();
    await db.posts.bulkPut([
      post({ id: 'xiaohongshu_a', publishedAt: now }),
      post({ id: 'xiaohongshu_b', isBookmarked: 1, publishedAt: now }),
    ]);

    expect(await cleanupOldPosts(0)).toBe(1);
    expect((await db.posts.toArray()).map((p) => p.id)).toEqual(['xiaohongshu_b']);
  });

  it('does NOT create a suppression — storage cleanup is not a deletion intent', async () => {
    // DELETION_MODEL §6 问题 6: what the cleanup removes must be able to come
    // back. A suppression here would blacklist content the user never deleted.
    await db.posts.put(post({ id: 'xiaohongshu_old', publishedAt: Date.now() - 90 * 86400_000 }));

    await cleanupOldPosts(60);

    expect(await db.postSuppressions.count()).toBe(0);
    expect(await postService.recycleBinCount()).toBe(0);
  });
});

describe('healBrokenPostMedia', () => {
  it('rewrites media and avatar URLs through toSecureMediaUrl and re-saves the row', async () => {
    // Xiaohongshu's strict CDN form: `http://`/bare host must become the
    // https, secure form the card renders.
    await db.posts.put(post({
      mediaList: [{ type: 'image', previewUrl: 'http://sns-img.example/a.jpg', originalUrl: 'http://sns-img.example/a.jpg' }],
      authorMeta: { name: 'n', avatar: 'http://sns-avatar.example/b.jpg' },
    }));

    const healed = await healBrokenPostMedia();

    expect(healed).toBe(1);
    const row = await db.posts.get('xiaohongshu_heal_1');
    expect(row?.mediaList[0].previewUrl.startsWith('https://')).toBe(true);
    expect(row?.authorMeta?.avatar?.startsWith('https://')).toBe(true);
  });

  it('leaves already-secure rows untouched and reports zero healed', async () => {
    await db.posts.put(post({
      mediaList: [{ type: 'image', previewUrl: 'https://sns-img.example/a.jpg', originalUrl: 'https://sns-img.example/a.jpg' }],
    }));

    expect(await healBrokenPostMedia()).toBe(0);
  });

  it('handles rows with no media and no avatar without touching them', async () => {
    await db.posts.put(post({ mediaList: [] }));

    expect(await healBrokenPostMedia()).toBe(0);
    expect(await db.posts.count()).toBe(1);
  });
});
