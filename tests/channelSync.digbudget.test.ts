import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Channel, Post } from '../src/types';
import type { FetchResult, PlatformAdapter } from '../src/adapters/types';

/**
 * The persist half of the deep-dig budget: channelSync.updateChannel must
 * slice genuinely-new rows to FetchOptions.maxNewPosts before bulkPut. This
 * is what stops a douyin windowed snapshot (whole scrolled grid in one
 * round, up to 200 items) from blowing past a "dig 50" request — the
 * measured failure was 366+ posts persisted for a 50-post budget.
 *
 * Duplicates are upserted for healing WITHOUT consuming budget, so a re-run
 * dig over an already-fetched window persists nothing new.
 */

const channel: Channel = {
  id: 'douyin:persist',
  creatorId: 'c1',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAApersist',
  displayName: '落库测试',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAApersist',
};

function makePosts(n: number, offset = 0): Post[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `douyin_aweme_${offset + i}`,
    creatorId: channel.creatorId,
    channelId: channel.id,
    platform: 'douyin' as const,
    title: `t${offset + i}`,
    content: `c${offset + i}`,
    mediaList: [],
    originalUrl: `https://www.douyin.com/video/${offset + i}`,
    publishedAt: Date.now() - (offset + i) * 1000,
    fetchedAt: Date.now(),
    isRead: 0,
  }));
}

/** Shared in-memory stores, hoisted so vi.mock factories can close over them. */
const state = vi.hoisted(() => {
  const rows = new Map<string, Post>();
  const channels = new Map<string, Channel>();
  const adapters: Record<string, PlatformAdapter> = {};
  return { rows, channels, adapters };
});

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    posts: {
      where: (index: string) => ({
        equals: (key: string) => ({
          primaryKeys: async () => {
            expect(index).toBe('channelId');
            return [...state.rows.values()].filter((p) => p.channelId === key).map((p) => p.id);
          },
        }),
        between: () => ({
          last: async () =>
            [...state.rows.values()].sort((a, b) => a.publishedAt - b.publishedAt).at(-1),
        }),
      }),
      bulkPut: async (posts: Post[]) => {
        for (const p of posts) state.rows.set(p.id, p);
      },
      bulkGet: async (ids: string[]) => ids.map((id) => state.rows.get(id)),
      each: async (cb: (p: Post) => void) => {
        for (const p of state.rows.values()) cb(p);
      },
      bulkDelete: async (ids: string[]) => {
        for (const id of ids) state.rows.delete(id);
      },
    },
    channels: {
      update: vi.fn(async (id: string, changes: Partial<Channel>) => {
        const existing = state.channels.get(id);
        if (existing) Object.assign(existing, changes);
      }),
      get: vi.fn(async (id: string) => state.channels.get(id)),
    },
    creators: {
      get: vi.fn(async () => undefined),
      update: vi.fn(async () => {}),
    },
    postSuppressions: {
      bulkGet: async (ids: string[]) => ids.map(() => undefined),
      bulkDelete: async () => {},
    },
  },
}));

vi.mock('../src/platform/registry', () => ({
  getAdapter: (platform: string) => state.adapters[platform],
  __setAdapter: (a: PlatformAdapter) => {
    state.adapters[a.platform] = a;
  },
}));

import { updateChannel } from '../src/sync/channelSync';

/** Adapter that returns a fixed page, like a douyin windowed snapshot. */
function setAdapterPage(page: Post[], extra: Partial<FetchResult> = {}) {
  state.adapters.douyin = {
    platform: 'douyin',
    fetchLatest: vi.fn(async () => ({ posts: page, ...extra })),
  };
}

describe('updateChannel maxNewPosts slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.clear();
    state.channels.clear();
    state.channels.set(channel.id, { ...channel });
  });

  it('slices new rows to the budget before persisting (douyin 366→50)', async () => {
    setAdapterPage(makePosts(366), { hasMore: false, totalFetched: 366 });
    const res = await updateChannel(channel, 200, true, {
      isHistory: true,
      cursor: undefined,
      maxNewPosts: 50,
    });
    // Exactly the budget was persisted and reported as new.
    expect(state.rows.size).toBe(50);
    expect(res.posts.length).toBe(50);
  });

  it('upserts duplicates without consuming budget', async () => {
    // 20 already in DB (an earlier partial dig), adapter returns all 366.
    const existing = makePosts(20);
    for (const p of existing) state.rows.set(p.id, p);
    const page = [...existing, ...makePosts(346, 20)];
    setAdapterPage(page, { totalFetched: 366 });

    const res = await updateChannel(channel, 200, true, {
      isHistory: true,
      cursor: undefined,
      maxNewPosts: 50,
    });
    // 20 duplicates healed + 50 new persisted = 70 rows, but only 50 count as new.
    expect(state.rows.size).toBe(70);
    expect(res.posts.length).toBe(50);
    expect(res.posts.every((p) => !existing.some((e) => e.id === p.id))).toBe(true);
  });

  it('persists everything when no budget is given', async () => {
    setAdapterPage(makePosts(366), { totalFetched: 366 });
    const res = await updateChannel(channel, 200, true, {
      isHistory: true,
      cursor: undefined,
    });
    expect(state.rows.size).toBe(366);
    expect(res.posts.length).toBe(366);
  });

  it('budget larger than the page persists the whole page', async () => {
    setAdapterPage(makePosts(30), { totalFetched: 30 });
    const res = await updateChannel(channel, 200, true, {
      isHistory: true,
      cursor: undefined,
      maxNewPosts: 50,
    });
    expect(state.rows.size).toBe(30);
    expect(res.posts.length).toBe(30);
  });

  it('never regresses an enriched media list on duplicate upsert', async () => {
    // An earlier round enriched this post with 5 detail images; the adapter
    // now returns only the profile cover for it. The richer DB row must win.
    const enriched = makePosts(1);
    enriched[0].mediaList = Array.from({ length: 5 }, (_, i) => ({
      type: 'image' as const,
      previewUrl: `https://cdn.example/img${i}.jpg`,
      originalUrl: `https://cdn.example/img${i}.jpg`,
    }));
    state.rows.set(enriched[0].id, enriched[0]);

    const coverOnly = { ...enriched[0], mediaList: enriched[0].mediaList.slice(0, 1) };
    setAdapterPage([coverOnly, ...makePosts(5, 1)], { totalFetched: 6 });

    await updateChannel(channel, 20, true, { isHistory: true, cursor: undefined });
    const upserted = state.rows.get(enriched[0].id);
    expect(upserted?.mediaList.length).toBe(5);
  });
});
