import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Post } from '../src/types';

/**
 * Failure-domain split (AUDIT P1-1).
 *
 * `code` is not wording. It drives policy: `batchSync` starts a platform
 * cool-down on `rate_limit` and clears it on success, `cursorState` reads
 * `not_found` as end-of-history, and the UI wording is chosen from the code.
 *
 * The old catch classified every thrown Error as `network`, so a local
 * IndexedDB write failure was reported as「平台网络错误」 — it cooled down a
 * platform that had never been contacted and hid a local storage problem
 * behind a platform-shaped message.
 *
 * This test pins the classification at the boundary that makes the decision:
 * a Dexie rejection is `storage`, and a storage failure must not produce a
 * rate-limit signal.
 */

const channelUpdates: Array<Record<string, unknown>> = [];
const bulkPut = vi.fn();

vi.mock('../src/platform/registry', () => ({
  getAdapter: () => ({
    platform: 'bilibili',
    fetchLatest: async (channel: Channel) => ({
      posts: [{
        id: 'bilibili_e1',
        creatorId: channel.creatorId,
        channelId: channel.id,
        platform: 'bilibili',
        title: 't',
        content: 'c',
        mediaList: [],
        originalUrl: 'https://example.com/e1',
        publishedAt: 1_700_000_000_000,
        fetchedAt: 1_700_000_000_000,
        isRead: 0,
      } as Post],
      totalFetched: 1,
      hasMore: false,
    }),
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
      bulkPut: (...args: unknown[]) => bulkPut(...args),
      bulkDelete: vi.fn(),
      each: async () => {},
      get: vi.fn(),
    },
    channels: {
      get: vi.fn(async () => ({ status: 'updating' })),
      update: vi.fn(async (_id: string, changes: Record<string, unknown>) => {
        channelUpdates.push(changes);
      }),
    },
    creators: { get: vi.fn(async () => undefined), update: vi.fn() },
    postSuppressions: {
      bulkGet: async (ids: string[]) => ids.map(() => undefined),
      bulkDelete: vi.fn(),
    },
  },
}));

import { updateChannel, isStorageFailure } from '../src/sync/channelSync';

const channel: Channel = {
  id: 'bilibili:errdomain',
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: 'errdomain',
  displayName: '失败域样例',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/errdomain',
};

/** A Dexie rejection as it reaches the catch: an Error carrying the DOMException. */
function quotaError(): Error {
  const err = new Error('QuotaExceededError: the quota has been exceeded');
  err.name = 'QuotaExceededError';
  return err;
}

beforeEach(() => {
  channelUpdates.length = 0;
  bulkPut.mockReset();
});

describe('isStorageFailure', () => {
  it('recognises Dexie/IndexedDB failures and rejects ordinary errors', () => {
    expect(isStorageFailure(quotaError())).toBe(true);
    const tx = new Error('The transaction was aborted');
    expect(isStorageFailure(tx)).toBe(true);
    expect(isStorageFailure(new Error('Failed to fetch'))).toBe(false);
    expect(isStorageFailure('nope')).toBe(false);
  });
});

describe('channelSync failure classification', () => {
  it('reports a local write failure as storage, not network', async () => {
    bulkPut.mockRejectedValueOnce(quotaError());

    const result = await updateChannel(channel, 10, false);

    expect(result.error?.code).toBe('storage');
    // The wording must not blame the platform.
    expect(result.error?.message).toContain('本地');
  });

  it('does not write a platform error onto the channel for a storage failure', async () => {
    bulkPut.mockRejectedValueOnce(quotaError());

    await updateChannel(channel, 10, false);

    // The channel row is what the user reads as 「同步失败」 with the platform's
    // message. A local failure must not claim the platform failed.
    const platformError = channelUpdates.find(
      (u) => u.status === 'error' && typeof u.errorMessage === 'string',
    );
    expect(platformError).toBeUndefined();
  });

  it('still reports a genuine network error as network', async () => {
    bulkPut.mockRejectedValueOnce(new Error('Failed to fetch'));

    const result = await updateChannel(channel, 10, false);

    expect(result.error?.code).toBe('network');
  });

  it('leaves the channel out of 同步中 after a storage failure', async () => {
    bulkPut.mockRejectedValueOnce(quotaError());

    await updateChannel(channel, 10, false);

    // The finally block must still run: a storage failure cannot park the row
    // in `updating` forever.
    expect(channelUpdates.some((u) => u.status === 'idle')).toBe(true);
  });
});
