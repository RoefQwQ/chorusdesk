import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Post } from '../src/types';

/**
 * Repair semantics of the incremental watermark.
 *
 * A user whose stored Twitter posts held a broken `content` field (only the
 * trailing `t.co` link, from a since-fixed parser bug) found that re-syncing did
 * not repair them. That is by design, and the design has two halves worth
 * pinning down:
 *
 *  - a NORMAL sync filters the adapter's results against the newest stored
 *    `publishedAt` and writes only what is newer, so existing rows are never
 *    rewritten — this is what makes incremental sync cheap, and it also means a
 *    normal sync can never repair a bad row;
 *  - a FORCE refresh bypasses that filter and `bulkPut`s everything the adapter
 *    returned, which is the only path that rewrites existing rows.
 *
 * If either half changes, the advice given to users about repairing data goes
 * wrong, so both are asserted here.
 */

const posts = new Map<string, Post>();
const channelUpdates: Array<Record<string, unknown>> = [];

vi.mock('../src/platform/registry', () => ({
  getAdapter: () => ({
    platform: 'twitter',
    // Returns one post that is OLDER than the stored watermark.
    fetchLatest: async (channel: Channel) => ({
      posts: [{
        id: 'twitter_1',
        creatorId: channel.creatorId,
        channelId: channel.id,
        platform: 'twitter',
        title: '重新解析后的标题',
        content: '重新解析后的正文 #标签',
        mediaList: [],
        originalUrl: 'https://x.com/a/status/1',
        publishedAt: 1_700_000_000_000,
        fetchedAt: Date.now(),
        isRead: 0,
      } as Post],
      totalFetched: 1,
      hasMore: false,
    }),
  }),
}));

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    channels: {
      get: vi.fn().mockResolvedValue({ status: 'success' }),
      update: vi.fn(async (_id: string, changes: Record<string, unknown>) => {
        channelUpdates.push(changes);
      }),
    },
    creators: { get: vi.fn().mockResolvedValue(null), update: vi.fn() },
    posts: {
      // Watermark lookup: the newest stored post for this channel.
      where: () => ({
        between: () => ({ last: async () => posts.get('twitter_1') ?? null }),
        equals: () => ({ primaryKeys: async () => [...posts.keys()] }),
      }),
      bulkGet: async (ids: string[]) => ids.map((id) => posts.get(id)),
      bulkPut: vi.fn(async (rows: Post[]) => {
        for (const row of rows) posts.set(row.id, row);
      }),
      bulkDelete: vi.fn(),
      get: vi.fn(),
    },
    postSuppressions: {
      bulkGet: async (ids: string[]) => ids.map(() => undefined),
      bulkDelete: vi.fn(),
    },
  },
}));

import { db } from '../src/infrastructure/db/database';
import { updateChannel } from '../src/sync/channelSync';

const channel: Channel = {
  id: 'twitter:repair',
  creatorId: 'c1',
  platform: 'twitter',
  accountId: 'a',
  displayName: '示例',
  status: 'idle',
  profileUrl: 'https://x.com/a',
};

/** A row whose body is an ordinary stale caption — not auto-repairable. */
function staleRow(): Post {
  return {
    id: 'twitter_1',
    creatorId: 'c1',
    channelId: 'twitter:repair',
    platform: 'twitter',
    title: '旧标题',
    content: '旧正文 #标签',
    mediaList: [],
    originalUrl: 'https://x.com/a/status/1',
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1,
    isRead: 0,
  };
}

/** The shape the adapter bug produced: the media link stored as the body. */
function brokenRow(): Post {
  return { ...staleRow(), title: 'https://t.co/abc', content: 'https://t.co/abc' };
}

beforeEach(() => {
  posts.clear();
  channelUpdates.length = 0;
  vi.clearAllMocks();
});

describe('repairing a stored post', () => {
  it('leaves a stale-but-valid row alone on a normal sync', async () => {
    // A normal sync is incremental by contract: it writes only what is newer
    // than the watermark and never rewrites existing rows.
    posts.set('twitter_1', staleRow());

    const res = await updateChannel(channel, 10, true, {});

    // The post is at the watermark, so it is not "new"…
    expect(res.posts).toEqual([]);
    // …and the row is untouched.
    expect(posts.get('twitter_1')!.content).toBe('旧正文 #标签');
    expect(db.posts.bulkPut).not.toHaveBeenCalled();
  });

  it('auto-repairs a stored body that is only a media link, without a force refresh', async () => {
    // The user-visible bug: a card kept showing `https://t.co/...` after the
    // adapter was fixed, because the sync reported「新增 0 条」— nothing was
    // written and the stored row still held the old text. Rows already in the
    // database therefore need repairing on the ordinary path.
    posts.set('twitter_1', brokenRow());

    await updateChannel(channel, 10, true, {});

    expect(posts.get('twitter_1')!.content).toBe('重新解析后的正文 #标签');
    expect(posts.get('twitter_1')!.title).toBe('重新解析后的标题');
  });

  it('keeps the user\'s read and bookmark state when repairing', async () => {
    posts.set('twitter_1', { ...brokenRow(), isRead: 1, isBookmarked: 1 });

    await updateChannel(channel, 10, true, {});

    // Repairing the text must not reset what the user did with the post.
    expect(posts.get('twitter_1')!.isRead).toBe(1);
    expect(posts.get('twitter_1')!.isBookmarked).toBe(1);
  });

  it('rewrites the stored row on a force refresh', async () => {
    posts.set('twitter_1', staleRow());

    await updateChannel(channel, 10, true, { forceRefresh: true });

    // Force refresh still heals everything, not just the shapes auto-repair knows.
    expect(db.posts.bulkPut).toHaveBeenCalled();
    expect(posts.get('twitter_1')!.content).toBe('重新解析后的正文 #标签');
    expect(posts.get('twitter_1')!.title).toBe('重新解析后的标题');
  });
});
