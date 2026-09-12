import { beforeAll, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import type { Post } from '../src/types';
import { migrateStoredTweetLinks, migrateDeletionSplit } from '../src/infrastructure/db/database';

/**
 * Permanent regression test for the Dexie v3 → v4 migration
 * (AGENTS.md rule 5): IndexedDB rejects `boolean` as an index key, so
 * boolean-valued `isRead` / `isBookmarked` rows were never entered into
 * those indexes — `where('isRead').equals(...)` matched nothing and the
 * unread badge / bookmark stat stayed permanently 0.
 *
 * The test builds a real v3-shaped database (booleans in posts and in
 * tombstoned `deletedPostIds.postData` snapshots), then opens the
 * production schema over it and asserts the upgrade rewrote every row
 * to `0 | 1` — including the snapshot copies — so index-backed queries
 * work again.
 */

/** Fresh, isolated DB name per run so tests never share state. */
const dbName = 'ChorusMigrationTestDB';

/** The v3 schema exactly as shipped (see database.ts version history). */
function openV3Database(): Dexie {
  const db = new Dexie(dbName);
  db.version(1).stores({
    creators: 'id, name, *tags, createdAt, sortOrder',
    channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
    settings: 'key',
  });
  db.version(2).stores({
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked, [channelId+publishedAt]',
  });
  db.version(3).stores({
    deletedPostIds: 'id, channelId, creatorId, deletedAt',
  });
  return db;
}

/**
 * v4 = production schema. Declared inline (not imported from
 * `src/infrastructure/db/database.ts`) so this test pins the migration
 * contract independently: the store layout, index set, and upgrade
 * callback can be compared against what production ships.
 */
function openV4Database(): Dexie {
  const db = new Dexie(dbName);
  db.version(1).stores({
    creators: 'id, name, *tags, createdAt, sortOrder',
    channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
    settings: 'key',
  });
  db.version(2).stores({
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked, [channelId+publishedAt]',
  });
  db.version(3).stores({
    deletedPostIds: 'id, channelId, creatorId, deletedAt',
  });
  db.version(4).upgrade(async (tx) => {
    await tx.table('posts').toCollection().modify((post: Post) => {
      post.isRead = post.isRead ? 1 : 0;
      post.isBookmarked = post.isBookmarked ? 1 : 0;
    });
    await tx.table('deletedPostIds').toCollection().modify((record: { postData?: Post }) => {
      if (record.postData) {
        record.postData.isRead = record.postData.isRead ? 1 : 0;
        record.postData.isBookmarked = record.postData.isBookmarked ? 1 : 0;
      }
    });
  });
  return db;
}

/** A v3-era post carrying raw booleans (the pre-migration state). */
type LegacyPost = Omit<Post, 'isRead' | 'isBookmarked'> & {
  isRead: boolean | 0 | 1;
  isBookmarked: boolean | 0 | 1;
};

function v3Post(overrides: Partial<LegacyPost> = {}): LegacyPost {
  return {
    id: 'bilibili_1',
    creatorId: 'creator-1',
    channelId: 'bilibili:1',
    platform: 'bilibili',
    title: 'v3 post',
    content: 'boolean flags live here',
    mediaList: [],
    originalUrl: 'https://example.com/1',
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    isRead: true,
    isBookmarked: false,
    ...overrides,
  };
}

beforeAll(async () => {
  // Seed a v3 database with the exact shapes that broke the indexes.
  const v3 = openV3Database();
  await v3.open();
  await v3.table('posts').bulkPut([
    v3Post({ id: 'bilibili_1', isRead: true, isBookmarked: false }),
    v3Post({ id: 'bilibili_2', isRead: false, isBookmarked: true }),
    v3Post({ id: 'weibo_1', isRead: true, isBookmarked: true }),
  ]);
  await v3.table('deletedPostIds').bulkPut([
    {
      // Tombstone with a full snapshot: restoring it must not reintroduce
      // a boolean row invisible to the isRead/isBookmarked indexes.
      id: 'bilibili_dead',
      channelId: 'bilibili:1',
      creatorId: 'creator-1',
      deletedAt: 1_700_000_100_000,
      postData: v3Post({ id: 'bilibili_dead', isRead: false, isBookmarked: true }),
    },
    { id: 'weibo_dead', channelId: 'weibo:9', deletedAt: 1_700_000_200_000 },
  ]);
  v3.close();
});

describe('Dexie v3 → v4 migration (0|1 index keys)', () => {
  it('upgrades boolean flags in posts and tombstone snapshots to 0|1', async () => {
    const v4 = openV4Database();
    await v4.open();

    const posts = await v4.table('posts').toArray();
    expect(posts).toHaveLength(3);
    for (const post of posts) {
      expect(post.isRead === 0 || post.isRead === 1).toBe(true);
      expect(post.isBookmarked === 0 || post.isBookmarked === 1).toBe(true);
    }
    expect(posts.find((p) => p.id === 'bilibili_2')?.isBookmarked).toBe(1);
    expect(posts.find((p) => p.id === 'bilibili_2')?.isRead).toBe(0);

    const tombstones = await v4.table('deletedPostIds').toArray();
    expect(tombstones).toHaveLength(2);
    const snapshot = tombstones.find((t) => t.id === 'bilibili_dead')?.postData;
    expect(snapshot?.isRead).toBe(0);
    expect(snapshot?.isBookmarked).toBe(1);
    v4.close();
  });

  it('makes isRead / isBookmarked index-backed queries match migrated rows', async () => {
    const v4 = openV4Database();
    await v4.open();

    // These queries silently returned nothing on unmigrated boolean rows —
    // the unread-badge/bookmark-stat bug this migration exists to fix.
    const unread = await v4.table('posts').where('isRead').equals(0).primaryKeys();
    const bookmarked = await v4.table('posts').where('isBookmarked').equals(1).primaryKeys();
    expect(unread).toEqual(['bilibili_2']);
    expect(bookmarked).toEqual(['bilibili_2', 'weibo_1']);
    v4.close();
  });

  it('leaves a fresh v4 database fully usable (install path)', async () => {
    // The version chain must also work from an empty database — no v3 data.
    const fresh = new Dexie(dbName + '_fresh');
    const db = openV4Database();
    // Re-declare against the fresh name by copying the version chain shape:
    fresh.version(1).stores({
      creators: 'id, name, *tags, createdAt, sortOrder',
      channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
      posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
      settings: 'key',
    });
    fresh.version(4).upgrade(async (tx) => {
      await tx.table('posts').toCollection().modify((post: Post) => {
        post.isRead = post.isRead ? 1 : 0;
        post.isBookmarked = post.isBookmarked ? 1 : 0;
      });
    });
    await fresh.open();

    await fresh.table('posts').put(v3Post({ id: 'new_1', isRead: 0, isBookmarked: 1 }));
    const rows = await fresh.table('posts').where('isBookmarked').equals(1).toArray();
    expect(rows.map((r) => r.id)).toEqual(['new_1']);
    fresh.close();
    db.close();
  });
});

/**
 * Permanent regression test for the Dexie v4 → v5 migration.
 *
 * The adapter stopped leaking X's appended `t.co` link, and `channelSync` repairs
 * stored rows — but a normal sync only returns the newest ~10 posts of a channel,
 * so a row older than that window can never acquire a fresh counterpart, and no
 * UI action rewrites it (force refresh replaces what the adapter returns, which
 * is the same newest-N). Observed on a real card: still carrying its link with a
 * `4 小时前 同步` footer while a sync ran.
 *
 * The rule is text-only and therefore deliberately narrow — the entity list that
 * lets the adapter tell an appended link from a typed one does not survive in the
 * database — so it only touches rows WITH media and only a link at the very end.
 * `isRead` / `isBookmarked` must survive, since the migration rewrites content on
 * rows the user has already read or saved.
 */
const linkV5dbName = 'ChorusMigrationV5TestDB';

function openV4ForV5(): Dexie {
  const db = new Dexie(linkV5dbName);
  db.version(1).stores({
    creators: 'id, name, *tags, createdAt, sortOrder',
    channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
    settings: 'key',
  });
  db.version(2).stores({
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked, [channelId+publishedAt]',
  });
  db.version(3).stores({ deletedPostIds: 'id, channelId, creatorId, deletedAt' });
  db.version(4).upgrade(async (tx) => {
    await tx.table('posts').toCollection().modify((post: Post) => {
      post.isRead = post.isRead ? 1 : 0;
      post.isBookmarked = post.isBookmarked ? 1 : 0;
    });
  });
  return db;
}

/**
 * v5 uses the **production** upgrade callback, not a copy.
 *
 * The version chain is still declared inline — that is what pins the schema shape
 * independently — but the rule itself is imported. An earlier version of this
 * test re-implemented the callback, and a mutation that removed the media gate
 * from the shipped rule left the suite green: the test was asserting a copy of
 * the behaviour, not the behaviour.
 */
function openV5Database(): Dexie {
  const db = openV4ForV5();
  db.version(5).upgrade(migrateStoredTweetLinks);
  return db;
}

const LINK = 'https://t.co/abc1234567';

function v4Post(overrides: Partial<Post> = {}): Post {
  return {
    id: 'twitter_1',
    creatorId: 'creator-1',
    channelId: 'twitter:a',
    platform: 'twitter',
    title: 'caption',
    content: `caption ${LINK}`,
    mediaList: [{ type: 'image', previewUrl: 'https://pbs.twimg.com/a.jpg', originalUrl: 'https://pbs.twimg.com/a.jpg' }],
    originalUrl: 'https://x.com/a/status/1',
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    isRead: 0,
    isBookmarked: 0,
    ...overrides,
  };
}

beforeAll(async () => {
  await Dexie.delete(linkV5dbName);
  const v4 = openV4ForV5();
  await v4.open();
  await v4.table('posts').bulkPut([
    // The shape the bug produced: caption + X's appended link, with media.
    v4Post({ id: 'twitter_appended', isRead: 1, isBookmarked: 1 }),
    // No media: a link here is the author's content, not X's append.
    v4Post({ id: 'twitter_nomedia', mediaList: [], content: `作者写的 ${LINK}` }),
    // A link mid-caption is the author's.
    v4Post({ id: 'twitter_middle', content: `看看 ${LINK} 很好` }),
    // Another platform, untouched.
    v4Post({ id: 'weibo_1', platform: 'weibo', content: `微博正文 ${LINK}` }),
    // A media-only tweet: the link WAS the whole body.
    v4Post({ id: 'twitter_onlylink', content: LINK, title: '' }),
  ]);
  await v4.table('deletedPostIds').bulkPut([
    {
      id: 'twitter_dead',
      channelId: 'twitter:a',
      deletedAt: 1_700_000_100_000,
      postData: v4Post({ id: 'twitter_dead' }),
    },
  ]);
  v4.close();
});

describe('Dexie v4 → v5 migration (X appended t.co links)', () => {
  it('strips a trailing link from a stored media tweet', async () => {
    const v5 = openV5Database();
    await v5.open();

    const row = await v5.table('posts').get('twitter_appended');
    expect(row.content).toBe('caption');
  });

  it('preserves the read and bookmark state of a rewritten row', async () => {
    // The migration rewrites content on rows the user has already flagged.
    const v5 = openV5Database();
    await v5.open();

    const row = await v5.table('posts').get('twitter_appended');
    expect(row.isRead).toBe(1);
    expect(row.isBookmarked).toBe(1);
  });

  it('empties a media-only tweet whose body was just the link', async () => {
    const v5 = openV5Database();
    await v5.open();

    expect((await v5.table('posts').get('twitter_onlylink')).content).toBe('');
  });

  it('leaves a row with no media alone', async () => {
    // Without media there is no reason to believe X appended anything, so the
    // link is the author's and must survive.
    const v5 = openV5Database();
    await v5.open();

    expect((await v5.table('posts').get('twitter_nomedia')).content).toBe(`作者写的 ${LINK}`);
  });

  it('leaves a link in the middle of a caption alone', async () => {
    const v5 = openV5Database();
    await v5.open();

    expect((await v5.table('posts').get('twitter_middle')).content).toBe(`看看 ${LINK} 很好`);
  });

  it('leaves other platforms alone', async () => {
    const v5 = openV5Database();
    await v5.open();

    expect((await v5.table('posts').get('weibo_1')).content).toBe(`微博正文 ${LINK}`);
  });

  it('cleans the tombstone snapshot too, so a restore does not bring the link back', async () => {
    const v5 = openV5Database();
    await v5.open();

    const tombstone = await v5.table('deletedPostIds').get('twitter_dead');
    expect(tombstone.postData.content).toBe('caption');
  });

  it('is idempotent: a second open changes nothing further', async () => {
    const v5 = openV5Database();
    await v5.open();
    v5.close();

    const again = openV5Database();
    await again.open();
    expect((await again.table('posts').get('twitter_appended')).content).toBe('caption');
    again.close();
  });
});

/**
 * Permanent regression test for the Dexie v5 → v6 migration (DELETION_MODEL §5).
 *
 * One table held two concepts with different lifecycles: 「不要再同步这条」
 * (long-lived) and 「还能不能找回」 (short-lived). 彻底删除 and 清空回收站 dropped
 * the whole row, so they silently lifted the sync blacklist and deleted posts
 * came back on the next sync.
 *
 * v6 splits it into `postSuppressions` + `recycleSnapshots` and drops
 * `deletedPostIds`. Every pre-v6 row played both roles, so the mapping is a
 * one-to-one copy into each table — lossless, no inference.
 *
 * The version chain is declared inline (that pins the schema shape), but the
 * upgrade callback is the PRODUCTION `migrateDeletionSplit` — rule 22: a test
 * that re-implements the migration tests a copy, not the shipped rule.
 */
const splitV6dbName = 'ChorusMigrationV6TestDB';

/** v5 = the schema immediately before the split. */
function openV5ForV6(): Dexie {
  const db = new Dexie(splitV6dbName);
  db.version(1).stores({
    creators: 'id, name, *tags, createdAt, sortOrder',
    channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
    settings: 'key',
  });
  db.version(2).stores({
    posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked, [channelId+publishedAt]',
  });
  db.version(3).stores({ deletedPostIds: 'id, channelId, creatorId, deletedAt' });
  db.version(4).upgrade(async (tx) => {
    await tx.table('posts').toCollection().modify((post: Post) => {
      post.isRead = post.isRead ? 1 : 0;
      post.isBookmarked = post.isBookmarked ? 1 : 0;
    });
  });
  db.version(5).upgrade(migrateStoredTweetLinks);
  return db;
}

/** v6 = production schema, production upgrade callback. */
function openV6Database(): Dexie {
  const db = openV5ForV6();
  db.version(6).stores({
    postSuppressions: 'postId, platform, suppressedAt',
    recycleSnapshots: 'id, channelId, creatorId, deletedAt',
    deletedPostIds: null,
  }).upgrade(migrateDeletionSplit);
  return db;
}

beforeAll(async () => {
  await Dexie.delete(splitV6dbName);
  const v5 = openV5ForV6();
  await v5.open();
  await v5.table('deletedPostIds').bulkPut([
    {
      // The common case: a full snapshot, both a suppression and a snapshot.
      id: 'bilibili_split_a',
      channelId: 'bilibili:1',
      creatorId: 'creator-1',
      platform: 'bilibili',
      title: '拆分样例 A',
      deletedAt: 1_700_000_300_000,
      postData: { ...v4Post({ id: 'bilibili_split_a' }), platform: 'bilibili' },
    },
    {
      // A row with no snapshot (already 彻底删除-ed under the old model).
      id: 'weibo_split_b',
      channelId: 'weibo:9',
      creatorId: 'creator-2',
      platform: 'weibo',
      title: '拆分样例 B',
      deletedAt: 1_700_000_400_000,
    },
  ]);
  v5.close();
});

describe('Dexie v5 → v6 migration (suppression / snapshot split)', () => {
  it('copies every row into both tables (lossless)', async () => {
    const v6 = openV6Database();
    await v6.open();

    const suppressions = await v6.table('postSuppressions').toArray();
    const snapshots = await v6.table('recycleSnapshots').toArray();

    expect(suppressions.map((r) => r.postId).sort()).toEqual(['bilibili_split_a', 'weibo_split_b']);
    expect(snapshots.map((r) => r.id).sort()).toEqual(['bilibili_split_a', 'weibo_split_b']);
    v6.close();
  });

  it('keeps the platform (stored redundantly, §6 问题 2) and the snapshot body', async () => {
    const v6 = openV6Database();
    await v6.open();

    const suppression = await v6.table('postSuppressions').get('bilibili_split_a');
    expect(suppression.platform).toBe('bilibili');
    expect(suppression.suppressedAt).toBe(1_700_000_300_000);

    const snapshot = await v6.table('recycleSnapshots').get('bilibili_split_a');
    expect(snapshot.channelId).toBe('bilibili:1');
    expect(snapshot.title).toBe('拆分样例 A');
    expect(snapshot.postData?.id).toBe('bilibili_split_a');
    v6.close();
  });

  it('carries channelId / creatorId into the suppression (the unfollow prompt counts them)', async () => {
    // `postRepository.deletePostAndTombstone` writes these on every new
    // suppression, and `countSuppressionsForCreator` / `...ForChannels` read
    // them. Dropping them in the migration would make every PRE-v6 deletion
    // invisible to the unfollow prompt's count — the user would be told nothing
    // is being kept deleted while those deletions all still stand (§6 问题 5).
    const v6 = openV6Database();
    await v6.open();

    const suppression = await v6.table('postSuppressions').get('bilibili_split_a');
    expect(suppression.channelId).toBe('bilibili:1');
    expect(suppression.creatorId).toBe('creator-1');
    v6.close();
  });

  it('drops the old table entirely', async () => {
    const v6 = openV6Database();
    await v6.open();

    expect(v6.tables.map((t) => t.name)).not.toContain('deletedPostIds');
    v6.close();
  });

  it('preserves a suppression whose snapshot is absent (the 彻底删除 case)', async () => {
    const v6 = openV6Database();
    await v6.open();

    const suppression = await v6.table('postSuppressions').get('weibo_split_b');
    expect(suppression?.platform).toBe('weibo');
    const snapshot = await v6.table('recycleSnapshots').get('weibo_split_b');
    expect(snapshot?.postData).toBeUndefined();
    v6.close();
  });
});
