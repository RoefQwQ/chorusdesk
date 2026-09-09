import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deepSyncChannel } from '../src/sync/historySync';
import type { Channel, Post } from '../src/types';
import type { FetchOptions } from '../src/adapters/types';

/**
 * Regression: the deep-dig budget (maxPosts) was only checked AFTER a round
 * had already persisted its posts. A douyin deep dig returns the whole
 * scrolled grid in one round (up to 200 items) — a user asking for 50 got
 * 366+. The fix has two halves:
 *
 *  1. deepSyncChannel never asks a round for more than the remaining budget
 *     (per-round limit min(20, remaining), min 1);
 *  2. the remaining budget is passed down as FetchOptions.maxNewPosts so the
 *     persist path slices genuinely-new rows to the quota (duplicates upsert
 *     without consuming it — that is the douyin windowed-snapshot case).
 *
 * These tests mock updateChannel's persist path is exercised via
 * fetchChannelHistory → updateChannel with the exact options; the persist
 * slice itself is covered in dig-budget.slice.test.ts.
 */

vi.mock('../src/infrastructure/db/database', () => {
  const state: { channels: Record<string, Channel> } = { channels: {} };
  return {
    db: {
      channels: {
        get: vi.fn(async (id: string) => state.channels[id] ?? undefined),
        update: vi.fn(async (id: string, changes: Partial<Channel>) => {
          if (state.channels[id]) Object.assign(state.channels[id], changes);
        }),
        __setState: (ch: Channel) => { state.channels[ch.id] = { ...ch }; },
        __reset: () => { state.channels = {}; },
      },
    },
  };
});

const updateChannel = vi.fn();

vi.mock('../src/sync/channelSync', () => ({
  updateChannel: (...args: unknown[]) => updateChannel(...args),
}));

import { db } from '../src/infrastructure/db/database';

/** The vi.mock factory attaches these test hooks to the mocked table. */
type MockChannelTable = typeof db.channels & {
  __setState: (ch: Channel) => void;
  __reset: () => void;
};
const channelTable = db.channels as MockChannelTable;

const channel: Channel = {
  id: 'douyin:budget',
  creatorId: 'c1',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAbudget',
  displayName: '预算测试',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAbudget',
};

function makePosts(n: number, startTs = Date.now()): Post[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `douyin_aweme_${i}`,
    creatorId: channel.creatorId,
    channelId: channel.id,
    platform: 'douyin' as const,
    title: `t${i}`,
    content: `c${i}`,
    mediaList: [],
    originalUrl: 'https://www.douyin.com/video/1',
    publishedAt: startTs - i * 1000,
    fetchedAt: Date.now(),
    isRead: 0,
  }));
}

/** Drive updateChannel as the persist-path would: return per-round posts. */
function makePersistedRound(postsPerRound: number) {
  let round = 0;
  updateChannel.mockImplementation(async (_ch: Channel, limit: number, _force: boolean, opts?: FetchOptions) => {
    round++;
    // The adapter-level page must honor the requested round limit; the
    // channelSync slice then caps genuinely-new rows at maxNewPosts.
    const page = makePosts(Math.min(postsPerRound, limit));
    return {
      posts: opts?.maxNewPosts ? page.slice(0, opts.maxNewPosts) : page,
      hasMore: round < 100,
      nextCursor: String(round),
    };
  });
}

describe('deepSyncChannel budget enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateChannel.mockReset();
    channelTable.__reset();
    channelTable.__setState(channel);
  });

  it('passes the remaining budget down as maxNewPosts on every round', async () => {
    makePersistedRound(20);
    await deepSyncChannel(channel, { maxPosts: 50 });
    const seenBudgets = updateChannel.mock.calls.map(
      (c) => (c[3] as FetchOptions | undefined)?.maxNewPosts,
    );
    // Round 1: 50 headroom; after 20 new posts round 2 sees 30; after 40, round 3 sees 10.
    expect(seenBudgets).toEqual([50, 30, 10]);
  });

  it('never asks for more than the remaining budget in a round', async () => {
    makePersistedRound(20);
    await deepSyncChannel(channel, { maxPosts: 50 });
    const roundLimits = updateChannel.mock.calls.map((c) => c[1] as number);
    expect(roundLimits).toEqual([20, 20, 10]);
  });

  it('stops digging once the budget is met', async () => {
    makePersistedRound(20);
    const res = await deepSyncChannel(channel, { maxPosts: 50 });
    expect(res.totalNew).toBe(50);
    expect(updateChannel).toHaveBeenCalledTimes(3);
  });

  it('keeps a final partial round request at least 1 item', async () => {
    makePersistedRound(20);
    await deepSyncChannel(channel, { maxPosts: 41 });
    const roundLimits = updateChannel.mock.calls.map((c) => c[1] as number);
    // 41 = 20 + 20 + 1: the last round asks for exactly the 1 remaining.
    expect(roundLimits).toEqual([20, 20, 1]);
    expect(updateChannel).toHaveBeenCalledTimes(3);
  });

  it('does not slice when no budget is set (unconstrained dig)', async () => {
    makePersistedRound(20);
    updateChannel.mockClear();
    // Re-stub: an unconstrained dig keeps running rounds until hasMore:false
    // or the empty-round counter; here cap it at 2 rounds for the test.
    let round = 0;
    updateChannel.mockImplementation(async () => {
      round++;
      return {
        posts: makePosts(20),
        hasMore: round < 2,
        nextCursor: String(round),
      };
    });
    await deepSyncChannel(channel, {});
    const budgets = updateChannel.mock.calls.map(
      (c) => (c[3] as FetchOptions | undefined)?.maxNewPosts,
    );
    expect(budgets).toEqual([undefined, undefined]);
  });

  it('a douyin windowed snapshot round cannot exceed the budget', async () => {
    // The real bug: douyin returns the whole scrolled grid (366 items) in one
    // round regardless of limit. fetchChannelHistory passes remaining budget
    // as maxNewPosts; channelSync slices new rows to it. Simulate the adapter
    // returning everything and the persist path slicing.
    updateChannel.mockImplementation(async (_ch: Channel, _limit: number, _force: boolean, opts?: FetchOptions) => {
      const budget = opts?.maxNewPosts;
      const page = makePosts(366);
      return {
        // In real code updateChannel returns the sliced posts; mirror it.
        posts: budget ? page.slice(0, budget) : page,
        hasMore: false,
        totalFetched: 366,
      };
    });
    const res = await deepSyncChannel(channel, { maxPosts: 50 });
    expect(res.totalNew).toBe(50);
    expect(updateChannel).toHaveBeenCalledTimes(1);
    const opts = updateChannel.mock.calls[0][3] as FetchOptions;
    expect(opts.maxNewPosts).toBe(50);
    expect(opts.isHistory).toBe(true);
  });
});
