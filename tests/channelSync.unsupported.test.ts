import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * A channel whose platform has no adapter.
 *
 * This state became real on 2026-09-12 when Withny was removed outright: anyone
 * who had bound a Withny account still has that row in IndexedDB, and the
 * registry no longer answers for it. Read `platform: 'withny'` below as a
 * stand-in for "any platform key we do not ship an adapter for".
 *
 * Three properties have to hold, and each of them has a plausible way to be
 * broken by an innocuous edit:
 *
 *  - **Report it as unsupported, naming the platform.** `channelSync` writes the
 *    message onto the row, so it is the user's only explanation for the red
 *    badge. A silent skip would leave the row looking idle-but-never-syncing.
 *  - **Do not fall back to another adapter.** `getAdapter`'s own comment forbids
 *    a silent RSS fallback: fetching an arbitrary stored URL as a feed is how a
 *    broken platform turns into unexplained third-party requests.
 *  - **Do not leave the row in `updating`.** The status write happens after the
 *    adapter lookup precisely so an unsupported platform never gets stuck
 *    claiming to sync forever. Moving one line breaks that, and the symptom
 *    (a permanent 同步中 badge) reads like a hung network call.
 *
 * It must also not fetch: an unsupported platform is not a network error, and
 * counting it against a rate limit or a cool-down would be wrong.
 */

const channel: Channel = {
  id: 'withny:ghost',
  creatorId: 'c1',
  platform: 'withny',
  accountId: 'ghost',
  displayName: 'Withny_ghost',
  status: 'idle',
  profileUrl: 'https://withny.fun/users/ghost',
};

/** Every `update()` the sync layer wrote, in order. */
const updates: Array<Record<string, unknown>> = [];

vi.mock('../src/platform/registry', () => ({
  // No adapter for any platform — the state after a platform is removed.
  getAdapter: () => undefined,
}));

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    channels: {
      get: async () => channel,
      update: async (_id: string, changes: Record<string, unknown>) => {
        updates.push(changes);
      },
    },
    creators: { get: async () => null, update: async () => {} },
    posts: {
      where: () => ({
        between: () => ({ last: async () => null }),
        equals: () => ({ primaryKeys: async () => [] }),
      }),
      bulkGet: async () => [],
      bulkPut: async () => {},
    },
    deletedPostIds: { where: () => ({ equals: () => ({ primaryKeys: async () => [] }) }) },
  },
}));

import { updateChannel } from '../src/sync/channelSync';

beforeEach(() => {
  updates.length = 0;
});

describe('a channel on a platform with no adapter', () => {
  it('is reported as unsupported, naming the platform', async () => {
    const res = await updateChannel(channel, 10);

    expect(res.error?.code).toBe('unsupported');
    expect(res.error?.message).toContain('withny');
    expect(res.posts).toEqual([]);
  });

  it('never writes `updating`, so the row cannot get stuck mid-sync', async () => {
    await updateChannel(channel, 10);

    const statuses = updates.map((u) => u.status);
    expect(statuses).not.toContain('updating');
    // Nothing at all is written: there is nothing to say about this row yet —
    // the caller records the error, this function just declines to fetch.
    expect(updates).toEqual([]);
  });

  it('is not classified as a rate limit, so it cannot start a cool-down', async () => {
    // `batchSync` keys its platform cool-down on `code === 'rate_limit'`, and a
    // cool-down is persisted across worker restarts. An unsupported platform is
    // not a limit signal: it was never fetched at all, and parking it would skip
    // a platform the user may still be able to fix by deleting the channel.
    const res = await updateChannel(channel, 10);

    expect(res.error?.code).not.toBe('rate_limit');
    expect(res.error?.code).toBe('unsupported');
  });
});
