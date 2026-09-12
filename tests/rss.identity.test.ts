// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Channel, Post } from '../src/types';

/**
 * RSS post identity is scoped to its feed.
 *
 * `<guid>` is unique *within one feed* and nothing more — RSS 2.0 leaves its
 * syntax entirely to the publisher. This project hashed it into a GLOBAL primary
 * key (`Post.id`, and `PostSuppression.postId`), so two unrelated feeds both
 * emitting `<guid>1</guid>` produced the same row, and 彻底删除 on one item
 * suppressed the other's.
 *
 * Measured shapes that make this real rather than theoretical: the feeds in
 * `tests/fixtures/rss/` use bare dates, opaque ids and bare numbers as guids.
 */

const FEED = (guid: string, title: string) => `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>示例源</title>
<link>https://example.com/</link>
<item>
  <title>${title}</title>
  <link>https://example.com/${encodeURIComponent(guid)}</link>
  <guid>${guid}</guid>
  <pubDate>Wed, 10 Sep 2026 10:00:00 GMT</pubDate>
  <description>正文</description>
</item>
</channel></rss>`;

const channel = (id: string): Channel => ({
  id,
  creatorId: 'c1',
  platform: 'rss',
  accountId: `https://example.com/${id}.xml`,
  profileUrl: `https://example.com/${id}.xml`,
  displayName: id,
  status: 'idle',
});

/** Fetch one feed through a fresh module registry, as the other RSS tests do. */
async function idsFrom(feed: string, ch: Channel): Promise<string[]> {
  vi.resetModules();
  vi.doMock('../src/infrastructure/chrome/http', () => ({
    bgFetch: async () => ({ ok: true, status: 200, data: feed, truncated: false }),
    MAX_RESPONSE_CHARS: 1_000_000,
  }));
  const { rssAdapter } = await import('../src/adapters/rss');
  const res = await rssAdapter.fetchLatest(ch, 10);
  return res.posts.map((p) => p.id);
}

describe('RSS post identity is scoped to the feed', () => {
  it('gives two feeds with the SAME guid different ids', async () => {
    // The collision case: `<guid>1</guid>` in both, which is conformant RSS.
    const a = await idsFrom(FEED('1', '来自 A'), channel('rss:a'));
    const b = await idsFrom(FEED('1', '来自 B'), channel('rss:b'));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]);
  });

  it('is stable across syncs of the same feed', async () => {
    // Identity must not change per call, or every sync would re-import.
    const first = await idsFrom(FEED('1', 'A'), channel('rss:a'));
    const second = await idsFrom(FEED('1', 'A'), channel('rss:a'));

    expect(first).toEqual(second);
  });

  it('keeps distinct items of one feed distinct', async () => {
    const two = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>t</title><link>https://example.com/</link>
<item><title>one</title><guid>1</guid><link>https://example.com/1</link><pubDate>Wed, 10 Sep 2026 10:00:00 GMT</pubDate><description>a</description></item>
<item><title>two</title><guid>2</guid><link>https://example.com/2</link><pubDate>Tue, 09 Sep 2026 10:00:00 GMT</pubDate><description>b</description></item>
</channel></rss>`;

    const ids = await idsFrom(two, channel('rss:a'));

    expect(new Set(ids).size).toBe(2);
  });

  it('reports the id each item had under the old scheme', async () => {
    // The adapter is the only place that knows both ids, so `channelSync` can
    // move stored rows without reimplementing the guid fallback chain.
    vi.resetModules();
    vi.doMock('../src/infrastructure/chrome/http', () => ({
      bgFetch: async () => ({ ok: true, status: 200, data: FEED('1', 'A'), truncated: false }),
      MAX_RESPONSE_CHARS: 1_000_000,
    }));
    const { rssAdapter } = await import('../src/adapters/rss');
    const res = await rssAdapter.fetchLatest(channel('rss:a'), 10);

    expect(res.legacyIds).toHaveLength(1);
    expect(res.legacyIds![0]).toMatch(/^rss_/);
    expect(res.legacyIds![0]).not.toBe(res.posts[0].id);
  });
});

/**
 * The stored-row half.
 *
 * Fixing the adapter alone leaves every existing RSS row under the old id: a
 * normal sync only returns the newest page, so an older row can never acquire a
 * counterpart (rule 16) — the feed would double, and the user's read/bookmark
 * state would stay with the orphan.
 */
import { adoptRenamedPostIds } from '../src/infrastructure/db/postRepository';
import { db } from '../src/infrastructure/db/database';

function post(id: string, over: Partial<Post> = {}): Post {
  return {
    id,
    creatorId: 'c1',
    channelId: 'rss:a',
    platform: 'rss',
    title: 't',
    content: 'c',
    mediaList: [],
    originalUrl: 'https://example.com/1',
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    isRead: 0,
    ...over,
  };
}

describe('adoptRenamedPostIds', () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all([db.posts.clear(), db.postSuppressions.clear(), db.recycleSnapshots.clear()]);
  });

  it('moves the row and carries the user read/bookmark state', async () => {
    await db.posts.put(post('rss_old', { isRead: 1, isBookmarked: 1 }));

    const moved = await adoptRenamedPostIds([{ from: 'rss_old', to: 'rss_new' }]);

    expect(moved).toBe(1);
    expect(await db.posts.get('rss_old')).toBeUndefined();
    const next = await db.posts.get('rss_new');
    expect(next?.isRead).toBe(1);
    expect(next?.isBookmarked).toBe(1);
  });

  it('moves the suppression, so a 彻底删除 keeps applying', async () => {
    // The failure this prevents is silent: a suppression left on the old id
    // means the deleted post comes back on the next sync (I2).
    await db.posts.put(post('rss_old'));
    await db.postSuppressions.put({
      postId: 'rss_old',
      platform: 'rss',
      suppressedAt: 1,
      channelId: 'rss:a',
    });

    await adoptRenamedPostIds([{ from: 'rss_old', to: 'rss_new' }]);

    expect(await db.postSuppressions.get('rss_old')).toBeUndefined();
    expect(await db.postSuppressions.get('rss_new')).toBeDefined();
  });

  it('moves the recycle snapshot, including the copy inside it', async () => {
    await db.posts.put(post('rss_old'));
    await db.recycleSnapshots.put({
      id: 'rss_old',
      channelId: 'rss:a',
      platform: 'rss',
      deletedAt: 1,
      postData: post('rss_old'),
    });

    await adoptRenamedPostIds([{ from: 'rss_old', to: 'rss_new' }]);

    const snapshot = await db.recycleSnapshots.get('rss_new');
    expect(snapshot).toBeDefined();
    // Restoring this snapshot must write back the CURRENT id, not the old one.
    expect(snapshot?.postData?.id).toBe('rss_new');
  });

  it('merges into a row that already exists, keeping either read flag', async () => {
    // Both present means the new row came from the sync that is running; the
    // user state from the old one must not be lost.
    await db.posts.put(post('rss_old', { isRead: 1 }));
    await db.posts.put(post('rss_new', { isRead: 0, isBookmarked: 1 }));

    await adoptRenamedPostIds([{ from: 'rss_old', to: 'rss_new' }]);

    expect(await db.posts.get('rss_old')).toBeUndefined();
    const merged = await db.posts.get('rss_new');
    expect(merged?.isRead).toBe(1);
    expect(merged?.isBookmarked).toBe(1);
  });

  it('does nothing when the old id is not stored', async () => {
    // A fresh install syncing for the first time: there is nothing to adopt,
    // and inventing a row would be worse than doing nothing.
    const moved = await adoptRenamedPostIds([{ from: 'rss_never', to: 'rss_new' }]);

    expect(moved).toBe(0);
    expect(await db.posts.get('rss_new')).toBeUndefined();
  });

  it('is a no-op for an unchanged id', async () => {
    await db.posts.put(post('rss_same', { isRead: 1 }));

    const moved = await adoptRenamedPostIds([{ from: 'rss_same', to: 'rss_same' }]);

    expect(moved).toBe(0);
    expect((await db.posts.get('rss_same'))?.isRead).toBe(1);
  });
});

/**
 * The wiring in `channelSync`.
 *
 * The adapter reports the id each item had under the old scheme; the sync layer
 * must MOVE the stored row onto the new one. Without it the feed doubles — the
 * old row orphaned with the user's read state, the new one written fresh — and a
 * 彻底删除 recorded against the old id stops applying.
 *
 * Uses the REAL Dexie instance over fake-indexeddb, like the deletion-invariant
 * suite: the property under test is what ends up stored.
 */

describe('channelSync adopts renamed ids reported by the adapter', () => {
  beforeEach(async () => {
    await db.channels.put({
      id: 'rss:a',
      creatorId: 'c1',
      platform: 'rss',
      accountId: 'https://example.com/a.xml',
      displayName: 'A',
      status: 'idle',
      profileUrl: 'https://example.com/a.xml',
    });
  });

  it('moves the stored row, keeping the user read state', async () => {
    await db.posts.put(post('rss_legacy_1', { isRead: 1, isBookmarked: 1 }));
    vi.resetModules();
    vi.doMock('../src/platform/registry', () => ({
      getAdapter: () => ({
        platform: 'rss',
        fetchLatest: async () => ({
          posts: [post('rss_scoped_1')],
          totalFetched: 1,
          hasMore: false,
          legacyIds: ['rss_legacy_1'],
        }),
      }),
    }));
    const { updateChannel } = await import('../src/sync/channelSync');

    await updateChannel(channel('rss:a'), 10, true, { sinceTimestamp: 1 });

    expect(await db.posts.get('rss_legacy_1')).toBeUndefined();
    const moved = await db.posts.get('rss_scoped_1');
    expect(moved?.isRead).toBe(1);
    expect(moved?.isBookmarked).toBe(1);
  });

  it('leaves rows alone when the adapter reports no rename', async () => {
    await db.posts.put(post('rss_stable'));
    vi.resetModules();
    vi.doMock('../src/platform/registry', () => ({
      getAdapter: () => ({
        platform: 'rss',
        fetchLatest: async () => ({
          posts: [post('rss_stable')],
          totalFetched: 1,
          hasMore: false,
        }),
      }),
    }));
    const { updateChannel } = await import('../src/sync/channelSync');

    await updateChannel(channel('rss:a'), 10, true, { sinceTimestamp: 1 });

    expect(await db.posts.get('rss_stable')).toBeDefined();
  });
});

describe('channelSync state preservation on the write path', () => {
  beforeEach(async () => {
    await db.channels.put({
      id: 'rss:a',
      creatorId: 'c1',
      platform: 'rss',
      accountId: 'https://example.com/a.xml',
      displayName: 'A',
      status: 'idle',
      profileUrl: 'https://example.com/a.xml',
    });
  });

  it('a brand-new post is written with the adapter state, not forced to read', async () => {
    // The arm that must NOT carry anything: nothing stored, so the fresh row is
    // written as-is. Forcing `isRead: 1` here would mark a new post read.
    vi.resetModules();
    vi.doMock('../src/platform/registry', () => ({
      getAdapter: () => ({
        platform: 'rss',
        fetchLatest: async () => ({
          posts: [post('rss_fresh', { isRead: 0 })],
          totalFetched: 1,
          hasMore: false,
          legacyIds: ['rss_never_existed'],
        }),
      }),
    }));
    const { updateChannel } = await import('../src/sync/channelSync');

    await updateChannel(channel('rss:a'), 10, true, { sinceTimestamp: 1 });

    expect((await db.posts.get('rss_fresh'))?.isRead).toBe(0);
  });

  it('carries an unread stored row forward without inventing a read flag', async () => {
    // The complement of the migration case: a stored row with isRead 0 stays 0.
    await db.posts.put(post('rss_old2', { isRead: 0, isBookmarked: 0 }));
    vi.resetModules();
    vi.doMock('../src/platform/registry', () => ({
      getAdapter: () => ({
        platform: 'rss',
        fetchLatest: async () => ({
          posts: [post('rss_new2', { isRead: 0 })],
          totalFetched: 1,
          hasMore: false,
          legacyIds: ['rss_old2'],
        }),
      }),
    }));
    const { updateChannel } = await import('../src/sync/channelSync');

    await updateChannel(channel('rss:a'), 10, true, { sinceTimestamp: 1 });

    expect((await db.posts.get('rss_new2'))?.isRead).toBe(0);
  });
});
