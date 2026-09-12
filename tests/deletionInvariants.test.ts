import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Channel, Creator, Post } from '../src/types';

/**
 * The adapter: returns the same post on every fetch, as a real feed would after
 * the user deleted it. This is what makes the suppression observable — if the
 * suppression is honoured the post is filtered out; if it was silently lifted
 * the post is written back.
 *
 * Only the registry is mocked. The database is the REAL Dexie instance over
 * fake-indexeddb, because the property under test is what ends up stored.
 */
vi.mock('../src/platform/registry', () => ({
  getAdapter: () => ({
    platform: 'bilibili',
    fetchLatest: async (channel: Channel) => ({
      posts: [{
        id: 'bilibili_dyn_1',
        creatorId: channel.creatorId,
        channelId: channel.id,
        platform: 'bilibili',
        title: '一条会被删除的动态',
        content: '正文',
        mediaList: [],
        originalUrl: 'https://www.bilibili.com/opus/1',
        publishedAt: 1_750_000_000_000,
        fetchedAt: 1_750_000_000_000,
        isRead: 0,
      } as Post],
      totalFetched: 1,
      hasMore: false,
    }),
  }),
}));

import { db } from '../src/infrastructure/db/database';
import { postService, creatorService, channelService, backupService } from '../src/application';
import { updateChannel } from '../src/sync/channelSync';

/**
 * Deletion-domain invariants (DELETION_MODEL.md §4).
 *
 * Three concepts with three lifecycles share one table today:
 *
 *   suppression      「这条内容不许通过同步再出现」   — long-lived, only an
 *                      explicit restore may clear it
 *   recycleSnapshot  「这条内容还能不能找回」        — short-lived
 *   post             「现在可见的内容」
 *
 * `deletedPostIds` holds suppression and snapshot in one row, so
 * `permanentlyDeletePost` (drop one tombstone) and `clearDeletedPostRecords`
 * (empty the recycle bin) BOTH silently lift the sync blacklist: the deleted
 * post comes back on the next sync, on a force refresh, or after a backup
 * round-trip. `postService`'s own comment — "Drop one tombstone for good (the
 * post stays gone)" — is false today.
 *
 * This file was the §7 step ② runway: it was written BEFORE the v6 schema work,
 * observed red, and then went green when the split landed. It observes through
 * public entry points (`postService` / `creatorService` / `channelService` /
 * `channelSync` / `backupService`) only, so a further refactor of the storage
 * layer does not invalidate it (rule 22's lesson, applied to invariants).
 *
 * Each assertion was confirmed to fail against the pre-v6 implementation before
 * the split — a test that has never been red is not evidence.
 *
 * --- fixture helpers -------------------------------------------------------
 */

const CHANNEL: Channel = {
  id: 'bilibili:invariants',
  creatorId: 'creator_inv',
  platform: 'bilibili',
  accountId: 'invariants',
  displayName: '不变量样例',
  label: '主账号',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/invariants',
};

const CREATOR: Creator = {
  id: 'creator_inv',
  name: '不变量样例创作者',
  avatar: '',
  tags: [],
  createdAt: 1,
  updatedAt: 1,
};

function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 'bilibili_dyn_1',
    creatorId: CREATOR.id,
    channelId: CHANNEL.id,
    platform: 'bilibili',
    title: '一条会被删除的动态',
    content: '正文',
    mediaList: [],
    originalUrl: 'https://www.bilibili.com/opus/1',
    publishedAt: 1_750_000_000_000,
    fetchedAt: 1_750_000_000_000,
    isRead: 0,
    ...overrides,
  };
}

async function seed(): Promise<void> {
  await db.creators.put(CREATOR);
  await db.channels.put(CHANNEL);
  await db.posts.put(post());
}

/** Everything the public surface can say about suppression/snapshot state. */
async function snapshotState() {
  return {
    recycleRecords: await postService.recycleBinRecords(),
    recycleCount: await postService.recycleBinCount(),
    postExists: (await db.posts.get('bilibili_dyn_1')) !== undefined,
  };
}

beforeAll(async () => {
  await db.open();
});

beforeEach(async () => {
  await Promise.all([
    db.creators.clear(),
    db.channels.clear(),
    db.posts.clear(),
    db.postSuppressions.clear(),
    db.recycleSnapshots.clear(),
    db.settings.clear(),
  ]);
});

// ---------------------------------------------------------------------------
// Green pins — hold today, must hold after the v6 split
// ---------------------------------------------------------------------------

describe('deletion invariants that hold today (and must survive v6)', () => {
  it('I1 — after a delete the post is gone, and both a suppression and a snapshot exist', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());

    expect(await db.posts.get('bilibili_dyn_1')).toBeUndefined();
    const records = await postService.recycleBinRecords();
    expect(records.map((r) => r.id)).toContain('bilibili_dyn_1');
    expect(records[0].postData).toBeDefined();
  });

  it('I4 — an explicit restore brings the post back and clears both records', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    const restored = await postService.restoreFromRecycleBin('bilibili_dyn_1');

    expect(restored?.id).toBe('bilibili_dyn_1');
    expect(await db.posts.get('bilibili_dyn_1')).toBeDefined();
    const after = await snapshotState();
    expect(after.recycleRecords).toHaveLength(0);
    expect(after.recycleCount).toBe(0);
  });

  it('I7 — a normal sync never writes a post whose suppression still stands', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());

    // The adapter returns the same post, as a real feed would.
    await updateChannel(CHANNEL, 20, false);

    expect(await db.posts.get('bilibili_dyn_1')).toBeUndefined();
  });

  it('I9 — deleting a creator does not clear the suppressions under it', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    await creatorService.deleteCascade(CREATOR.id);

    // The creator/channel/posts (and the snapshot) are gone; the suppression
    // outlives them by design — a re-follow must not resurrect a deletion.
    expect(await db.postSuppressions.get('bilibili_dyn_1')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The invariants DELETION_MODEL §4.2 records as violated before v6
// ---------------------------------------------------------------------------

describe('deletion invariants restored by the v6 split (DELETION_MODEL §4.2)', () => {
  it('I2 — 彻底删除 clears the snapshot but MUST keep the suppression', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    await postService.permanentlyDelete('bilibili_dyn_1');

    // Snapshot gone (the recycle row disappears) …
    expect((await postService.recycleBinRecords()).map((r) => r.id)).not.toContain('bilibili_dyn_1');
    // … but the sync blacklist must still hold it.
    await updateChannel(CHANNEL, 20, false);
    expect(await db.posts.get('bilibili_dyn_1')).toBeUndefined();
  });

  it('I3 — 清空回收站 clears every snapshot but MUST keep every suppression', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    await postService.emptyRecycleBin();

    expect(await postService.recycleBinCount()).toBe(0);
    await updateChannel(CHANNEL, 20, false);
    expect(await db.posts.get('bilibili_dyn_1')).toBeUndefined();
  });

  it('I5 — post and suppression must never coexist (restore must be atomic)', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());

    // A write failure midway through the restore. Both halves live in one
    // transaction (DELETION_MODEL §4.2 I6), so the rollback must undo the
    // `posts.put` that already happened.
    const suppressionTable = db.postSuppressions as unknown as { delete: (id: string) => Promise<void> };
    const realDelete = suppressionTable.delete.bind(suppressionTable);
    let failNext = true;
    suppressionTable.delete = (id: string) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('injected: suppression delete failed')); }
      return realDelete(id);
    };
    try {
      await postService.restoreFromRecycleBin('bilibili_dyn_1').catch(() => undefined);
    } finally {
      suppressionTable.delete = realDelete;
    }

    // I5: a visible post and a standing suppression must not both hold.
    const coexist = (await db.posts.get('bilibili_dyn_1')) !== undefined
      && (await db.postSuppressions.get('bilibili_dyn_1')) !== undefined;
    expect(coexist).toBe(false);
  });

  it('I6 — a failed delete must not leave a half state (post gone, no suppression)', async () => {
    await seed();

    // The suppress-and-snapshot write fails after `posts.delete` was applied.
    // One transaction means the delete rolls back with it (I6).
    const suppressionTable = db.postSuppressions as unknown as { put: (row: unknown) => Promise<string> };
    const realPut = suppressionTable.put.bind(suppressionTable);
    suppressionTable.put = () => Promise.reject(new Error('injected: suppression write failed'));
    try {
      await postService.deleteToRecycleBin(post()).catch(() => undefined);
    } finally {
      suppressionTable.put = realPut;
    }

    const postGone = (await db.posts.get('bilibili_dyn_1')) === undefined;
    const suppressed = (await db.postSuppressions.get('bilibili_dyn_1')) !== undefined;
    // Neither half alone is a valid end state: the post must have survived the
    // failed delete, or the suppression must have.
    expect(postGone && !suppressed).toBe(false);
  });

  it('I8 — suppression survives 导出 → 清库 → 导入 (backup format 1.1, 方案 A)', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());

    const backup = await backupService.export() as unknown as Record<string, unknown>;
    expect(Array.isArray(backup.suppressions)).toBe(true);

    await Promise.all([
      db.creators.clear(),
      db.channels.clear(),
      db.posts.clear(),
      db.postSuppressions.clear(),
      db.recycleSnapshots.clear(),
    ]);
    await backupService.restore(backup as never);

    // After 迁移/重装 the user's deletions must still hold.
    await updateChannel(CHANNEL, 20, false);
    expect(await db.posts.get('bilibili_dyn_1')).toBeUndefined();
  });

  it('I10 — a failed suppression read MUST fail closed, not write the post', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());

    // channelSync's suppression read is where the fail-closed decision lives:
    // a read failure must abort the write, not proceed with the unfiltered
    // batch. Before v6 a `catch {}` here resurrected every deletion silently.
    const suppressionTable = db.postSuppressions as unknown as { bulkGet: (ids: string[]) => Promise<unknown[]> };
    const realBulkGet = suppressionTable.bulkGet.bind(suppressionTable);
    suppressionTable.bulkGet = () => Promise.reject(new Error('injected: suppression read failed'));
    try {
      await updateChannel(CHANNEL, 20, false).catch(() => undefined);
    } finally {
      suppressionTable.bulkGet = realBulkGet;
    }

    expect(await db.posts.get('bilibili_dyn_1')).toBeUndefined();
  });

  it('I11 — restoring a post whose creator was cascade-deleted must not dangle', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    await creatorService.deleteCascade(CREATOR.id);

    // The cascade cleared the snapshot, so there is nothing to write back —
    // and crucially the old path would have written a post whose channelId
    // points at a channel that no longer exists, while telling the user
    // 「动态已定向找回」. Refusing is the contract.
    const restored = await postService.restoreFromRecycleBin('bilibili_dyn_1');
    expect(restored).toBeNull();
    expect(await db.posts.get('bilibili_dyn_1')).toBeUndefined();
  });

  it('I12 — a cascade delete gives every orphan snapshot a defined fate', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    await creatorService.deleteCascade(CREATOR.id);

    // No recycle record may outlive its parent channel: restoring one would
    // write a row pointing at a channel that no longer exists.
    const orphans = (await postService.recycleBinRecords()).filter((r) => r.channelId === CHANNEL.id);
    expect(orphans).toHaveLength(0);
  });

  it('a channel cascade cleans the snapshots of its own posts', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    await channelService.deleteCascade(CHANNEL.id);

    const orphans = (await postService.recycleBinRecords()).filter((r) => r.channelId === CHANNEL.id);
    expect(orphans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P0-5 / Q5 — the two behaviours the redesign had to make explicit
// ---------------------------------------------------------------------------

describe('restore mode and the unfollow prompt (P0-5 / Q5)', () => {
  it('replace wipes what the file does not contain; merge keeps it', async () => {
    await seed();
    await db.posts.put({ ...post({ id: 'bilibili_dyn_2' }), title: '只在当前库里' });
    const file = await backupService.export();
    await db.posts.delete('bilibili_dyn_2');
    const smallFile = await backupService.export();
    expect(await db.posts.get('bilibili_dyn_2')).toBeUndefined();

    // Put the extra post back, then import the smaller file both ways.
    await db.posts.put({ ...post({ id: 'bilibili_dyn_2' }), title: '只在当前库里' });

    await backupService.restore(smallFile as never, 'merge');
    expect(await db.posts.get('bilibili_dyn_2')).toBeDefined();

    await backupService.restore(smallFile as never, 'replace');
    expect(await db.posts.get('bilibili_dyn_2')).toBeUndefined();
    expect(await db.posts.get('bilibili_dyn_1')).toBeDefined();
    expect(file.creators).toHaveLength(1);
  });

  it('replace clears suppressions the file does not carry (the snapshot is the state)', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    const withSuppression = await backupService.export();
    expect(withSuppression.suppressions).toHaveLength(1);

    // An older 1.0 file: no suppressions. Restoring it as a snapshot means the
    // library becomes that file — including its empty deletion blacklist.
    const { suppressions: _drop, ...legacy } = withSuppression as unknown as Record<string, unknown>;
    await backupService.restore(legacy as never, 'replace');
    expect(await db.postSuppressions.count()).toBe(0);
  });

  it('counts the deletions that survive an unfollow, per creator and per channel', async () => {
    await seed();
    await postService.deleteToRecycleBin(post());
    await postService.deleteToRecycleBin(post({ id: 'bilibili_dyn_2' }));

    expect(await postService.suppressionsUnderCreator(CREATOR.id)).toBe(2);
    expect(await postService.suppressionsUnderChannels([CHANNEL.id])).toBe(2);
    // 彻底删除 drops the snapshot but the deletion still stands — a count that
    // read the recycle list instead would report 0 here and tell the user
    // nothing is being kept deleted.
    await postService.permanentlyDelete('bilibili_dyn_1');
    expect(await postService.suppressionsUnderCreator(CREATOR.id)).toBe(2);
    expect(await postService.recycleBinCount()).toBe(1);
  });
});
