import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * A single-shot dig must stop after ONE round — for every platform whose
 * acquisition model is single-shot, not just the one that happened to be named.
 *
 * The break was `currentCh.platform === 'douyin'`, while its own comment said the
 * scope was "the single-shot acquisition model". `xiaohongshu` joined that set the
 * moment its dig became page-driven (`FETCH_XHS_NOTES`), and with a hardcoded name
 * it would re-scroll the same page four times per dig — four times the automation
 * signal on the platform whose heuristics watch for exactly that, for zero new
 * notes. The fact is precisely `paginates: false`, so it is read from the
 * adapter's own declaration (rule 2's shape).
 *
 * `tests/douyin.digbudget.test.ts` covers the round/limit arithmetic and
 * `tests/douyin.loophead.test.ts` the `__END__` gate; this pins the MODEL-based
 * scoping that replaced the name.
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

import { deepSyncChannel } from '../src/sync/historySync';
import { db } from '../src/infrastructure/db/database';

const channelOf = (platform: string): Channel => ({
  id: `${platform}:oneshot`,
  creatorId: 'c1',
  platform: platform as Channel['platform'],
  accountId: platform === 'xiaohongshu' ? '63799a52000000001f01ca92' : 'MS4wLjABAAAAtest',
  displayName: '单发模型',
  status: 'idle',
  profileUrl: 'https://example.com/',
});

describe('a single-shot dig stops after one round', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.channels as unknown as { __reset: () => void }).__reset();
    // Every round yields content and no cursor — the single-shot shape (a whole
    // scrolled page in one message). `hasMore: true` keeps the loop from ending
    // on an end-of-history signal, so ONLY the single-shot break can stop it.
    updateChannel.mockImplementation(async () => ({
      posts: [{ id: 'p1' }],
      hasMore: true,
      totalFetched: 30,
    }));
  });

  it('does not re-scroll a paginates:false platform', async () => {
    for (const platform of ['xiaohongshu', 'douyin']) {
      updateChannel.mockClear();
      (db.channels as unknown as { __reset: () => void }).__reset();
      const ch = channelOf(platform);
      (db.channels as unknown as { __setState: (s: unknown) => void }).__setState(ch);

      await deepSyncChannel(ch, { maxPosts: 5 });

      // One round, not the four the empty-round counter would have allowed.
      expect(updateChannel, platform).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps paging a platform that walks a real cursor', async () => {
    // bilibili paginates: it must NOT stop after one round when it still reports
    // more work, or a dig would silently fetch only its first page.
    let round = 0;
    updateChannel.mockImplementation(async () => {
      round++;
      return { posts: [{ id: `p${round}` }], hasMore: round < 3, nextCursor: String(round) };
    });
    const ch = channelOf('bilibili');
    (db.channels as unknown as { __setState: (s: unknown) => void }).__setState(ch);

    await deepSyncChannel(ch, {});

    expect(updateChannel.mock.calls.length).toBeGreaterThan(1);
  });
});
