import { describe, expect, it, vi, beforeEach } from 'vitest';
import { deepSyncChannel } from '../src/sync/historySync';
import type { Channel } from '../src/types';

/**
 * Regression: deepSyncChannel's OWN loop head had a second __END__ gate that
 * ran BEFORE fetchChannelHistory, so the fetchChannelHistory recovery (which
 * clears a douyin channel's stale __END__ and re-digs) was never reached.
 * The user's screenshot showed exactly this: the dig modal reported
 * "已到达历史作品最底部" while the logged-in page served all 31 works.
 *
 * The loop head must only short-circuit for platforms whose __END__ is
 * platform-stated fact (a real pagination cursor). Douyin's __END__ is a
 * recorded guess and must fall through to the dig.
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

vi.mock('../src/sync/channelSync', () => ({
  updateChannel: vi.fn(async () => ({ posts: [], hasMore: true })),
}));

import { db } from '../src/infrastructure/db/database';
import { updateChannel } from '../src/sync/channelSync';

const douyinAtEnd: Channel = {
  id: 'douyin:loop',
  creatorId: 'c1',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAloop',
  displayName: '主循环被挡',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAloop',
  nextCursor: '__END__',
};

describe('deepSyncChannel loop head vs __END__', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.channels as any).__reset();
    (db.channels as any).__setState(douyinAtEnd);
  });

  it('falls through to a dig for a douyin channel parked at __END__', async () => {
    const res = await deepSyncChannel(douyinAtEnd, { maxPosts: 5 });
    // The dig actually ran at least one round instead of reporting reachEnd.
    expect(res.rounds).toBeGreaterThanOrEqual(1);
    expect(updateChannel).toHaveBeenCalled();
    expect(res.reachEnd).toBe(false);
  });

  it('still short-circuits for a cursor-paginated platform at __END__', async () => {
    (db.channels as any).__setState({ ...douyinAtEnd, id: 'bilibili:loop', platform: 'bilibili' });
    const res = await deepSyncChannel(
      { ...douyinAtEnd, id: 'bilibili:loop', platform: 'bilibili' },
      { maxPosts: 5 },
    );
    expect(res.reachEnd).toBe(true);
    expect(res.rounds).toBe(0);
    expect(updateChannel).not.toHaveBeenCalled();
  });
});
