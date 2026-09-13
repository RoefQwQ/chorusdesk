import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';
import type { FetchResult } from '../src/adapters/types';

/**
 * The 45-second deadline must not outlive the run it belongs to.
 *
 * `updateChannel` races the adapter's fetch against a 45s timer. The timer exists
 * to CANCEL the work (AUDIT P1-2), and that part was already correct — but the
 * handle was constructed inline and never cleared, so the ordinary path (the
 * fetch wins, which is almost every call) still left a live 45-second timer
 * behind. One per channel per sync.
 *
 * This is not an unhandled rejection: `Promise.race` attaches a handler to the
 * loser, so the timer's `reject` is always consumed. The cost is a pending timer
 * that keeps the process (and the closure) alive after the sync has finished —
 * 19 test files drive `updateChannel`, so the suite carried one armed timer per
 * call, and a long-lived page carried them until each fired.
 *
 * Asserted by COUNTING pending timers, not by waiting: a test that slept 45s
 * would be both slow and a guess about the machine's clock.
 */

let fetchLatestMock: () => Promise<FetchResult> = async () => ({ posts: [] });

vi.mock('../src/platform/registry', () => ({
  getAdapter: (platform: string) => ({
    platform,
    fetchLatest: () => fetchLatestMock(),
  }),
}));

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    posts: {
      where: () => ({
        between: () => ({ last: async () => null }),
        equals: () => ({ primaryKeys: async () => [] }),
      }),
      bulkGet: async () => [],
      bulkPut: vi.fn(),
      bulkDelete: vi.fn(),
    },
    channels: {
      get: vi.fn().mockResolvedValue({ status: 'success' }),
      update: vi.fn().mockResolvedValue(undefined),
    },
    creators: { get: vi.fn().mockResolvedValue(null), update: vi.fn() },
    postSuppressions: { bulkGet: async () => [], bulkDelete: vi.fn() },
  },
}));

vi.mock('../src/utils/devLog', () => ({
  devLog: {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  },
}));

import { updateChannel } from '../src/sync/channelSync';

const channel: Channel = {
  id: 'bilibili:deadline',
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: '1',
  displayName: '示例',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/1',
};

beforeEach(() => {
  fetchLatestMock = async () => ({ posts: [], hasMore: false });
});

describe('the sync deadline timer', () => {
  it('is cancelled once the fetch wins, instead of firing 45s later', async () => {
    // Count only timers scheduled for the deadline's own delay, so unrelated
    // timers in the environment cannot make this pass or fail by accident.
    const realSetTimeout = globalThis.setTimeout;
    const pending = new Map<unknown, number>();

    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      const handle = realSetTimeout(fn, ms as number, ...rest);
      if (ms === 45_000) pending.set(handle, ms as number);
      return handle;
    }) as unknown as typeof setTimeout);

    const realClearTimeout = globalThis.clearTimeout;
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: unknown) => {
      pending.delete(handle);
      return realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout);

    try {
      const res = await updateChannel(channel, 10, true, {});
      expect(res.error).toBeUndefined();

      // The fetch resolved immediately, so its deadline is moot and must be gone.
      expect([...pending.values()]).toEqual([]);
    } finally {
      spy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('arms exactly one deadline per call, and clears it every time', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let armed = 0;
    let cleared = 0;

    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 45_000) armed++;
      return realSetTimeout(fn, ms as number, ...rest);
    }) as unknown as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((h?: unknown) => {
      cleared++;
      return realClearTimeout(h as Parameters<typeof clearTimeout>[0]);
    }) as typeof clearTimeout);

    try {
      await updateChannel(channel, 10, true, {});
      await updateChannel(channel, 10, true, {});

      expect(armed).toBe(2);
      // One clear per call, on the success path — the one that used to leak.
      expect(cleared).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
