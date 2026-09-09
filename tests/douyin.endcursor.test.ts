import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fetchChannelHistory } from '../src/sync/historySync';
import type { Channel } from '../src/types';

/**
 * Regression: a douyin channel parked at __END__ by an older build must be
 * recoverable WITHOUT the user manually ticking "reset history progress".
 *
 * Root cause (verified against the user's real LevelDB on 2026-09-10): an
 * earlier adapter version treated an unreadable statedTotal as "complete",
 * returned hasMore:false and got __END__ written. Every later dig then hit
 * fetchChannelHistory's early return and refused to even open the page —
 * while the logged-in page actually served all 31 of 31 works.
 *
 * Douyin has no real pagination cursor: its __END__ is always a recorded
 * guess, so the dig must clear it and re-run. A genuine end is re-recorded
 * the same round (adapter returns hasMore:false again), so this cannot loop.
 */

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    channels: {
      update: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../src/sync/channelSync', () => ({
  updateChannel: vi.fn().mockResolvedValue({ posts: [], hasMore: false }),
}));

import { db } from '../src/infrastructure/db/database';
import { updateChannel } from '../src/sync/channelSync';

const douyinChannel: Channel = {
  id: 'douyin:end',
  creatorId: 'c1',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAend',
  displayName: '被封死的频道',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAend',
  nextCursor: '__END__',
};

const bilibiliChannel: Channel = {
  ...douyinChannel,
  id: 'bilibili:end',
  platform: 'bilibili',
  nextCursor: '__END__',
};

describe('fetchChannelHistory vs __END__', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears __END__ for a douyin channel and runs the dig', async () => {
    const res = await fetchChannelHistory(douyinChannel, 20);
    // The stale marker was deleted (undefined deletes the Dexie field).
    expect(db.channels.update).toHaveBeenCalledWith('douyin:end', { nextCursor: undefined });
    // And the dig actually ran instead of short-circuiting.
    expect(updateChannel).toHaveBeenCalled();
    expect(res.hasMore).toBe(false); // from the mocked adapter result
  });

  it('still honors __END__ for cursor-paginated platforms (bilibili)', async () => {
    const res = await fetchChannelHistory(bilibiliChannel, 20);
    expect(db.channels.update).not.toHaveBeenCalled();
    expect(updateChannel).not.toHaveBeenCalled();
    expect(res.error?.code).toBe('not_found');
    expect(res.hasMore).toBe(false);
  });
});
