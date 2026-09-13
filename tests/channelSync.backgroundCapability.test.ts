import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * The consumers of the capability model (queue #6).
 *
 * A declaration nothing reads is a comment, and the declarations themselves are
 * covered in `tests/platformCapabilities.test.ts`. These cover the two places
 * that ACT on them — the pair that mutations proved was untested:
 *   - `channelSync` refuses a worker-incapable platform BEFORE dispatching;
 *   - `autoSync` filters such channels out of the batch, and says so.
 *
 * Both were user-visible defects before this:
 *   - the popup's `SYNC_CHANNEL` runs in the worker ON PURPOSE (so the fetch
 *     survives the popup closing), so following a douyin/twitter creator from the
 *     popup stored the channel and never fetched its posts;
 *   - auto-sync attempted every channel every 30 minutes, so each douyin/twitter
 *     channel produced a red row and a warn line for a condition that cannot
 *     change between runs.
 */

const updates: Array<{ id: string; changes: Record<string, unknown> }> = [];
let fetchedPlatforms: string[] = [];

const workerOnlyChannel: Channel = {
  id: 'douyin:abc',
  creatorId: 'c1',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAx',
  displayName: '抖音号',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAx',
};

const apiChannel: Channel = {
  ...workerOnlyChannel,
  id: 'bilibili:1',
  platform: 'bilibili',
  accountId: '1',
  displayName: 'B站号',
};

/** The real adapters, so the capability declarations under test are the shipped ones. */
vi.mock('../src/platform/registry', async () => {
  const { douyinAdapter } = await import('../src/adapters/douyin');
  const { bilibiliAdapter } = await import('../src/adapters/bilibili');
  return {
    getAdapter: (platform: string) => {
      if (platform === 'douyin') return douyinAdapter;
      if (platform === 'bilibili') return bilibiliAdapter;
      return undefined;
    },
  };
});

/** Force the service-worker branch: node has neither `window` nor `self`. */
vi.mock('../src/utils/runtime', () => ({ IS_SERVICE_WORKER: true }));

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    channels: {
      get: async (id: string) => (id === workerOnlyChannel.id ? workerOnlyChannel : apiChannel),
      update: async (id: string, changes: Record<string, unknown>) => {
        updates.push({ id, changes });
      },
      toArray: async () => [workerOnlyChannel, apiChannel],
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
    postSuppressions: {
      bulkGet: async (ids: string[]) => ids.map(() => undefined),
      bulkDelete: vi.fn(),
    },
  },
}));

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async () => ({ ok: true, status: 200, data: '', truncated: false }),
  MAX_RESPONSE_CHARS: 1_000_000,
}));

import { updateChannel } from '../src/sync/channelSync';

beforeEach(() => {
  updates.length = 0;
  fetchedPlatforms = [];
});

describe('channelSync refuses a worker-incapable platform before dispatching', () => {
  it('reports unsupported with a message that names where it DOES work', async () => {
    const res = await updateChannel(workerOnlyChannel, 10);

    expect(res.error?.code).toBe('unsupported');
    // "not supported" alone leaves the user with no next step; the message has to
    // say the dashboard is where it runs.
    expect(res.error?.message).toMatch(/仪表盘|扩展页面/);
    expect(res.error?.message).toContain('抖音');
  });

  it('never writes `updating`, so the row cannot get stuck mid-sync', async () => {
    await updateChannel(workerOnlyChannel, 10);

    expect(updates.map((u) => u.changes.status)).not.toContain('updating');
  });

  it('does not attempt the acquisition at all', async () => {
    // The point of declaring it: the refusal happens from the declaration, not
    // after a doomed message round-trip to a page.
    const res = await updateChannel(workerOnlyChannel, 10);
    expect(res.posts).toEqual([]);
    expect(fetchedPlatforms).toEqual([]);
  });

  it('leaves a worker-capable platform alone', async () => {
    // The control: bilibili declares nothing, so the gate must not touch it. A
    // gate that refuses everything would pass the tests above.
    const res = await updateChannel(apiChannel, 10);
    expect(res.error?.code).not.toBe('unsupported');
  });
});
