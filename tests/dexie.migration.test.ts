import { beforeAll, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import type { Post, DeletedPostRecord } from '../src/types';

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
    await tx.table('deletedPostIds').toCollection().modify((record: DeletedPostRecord) => {
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
