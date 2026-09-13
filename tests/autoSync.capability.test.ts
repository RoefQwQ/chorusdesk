import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * Auto-sync must FILTER worker-incapable platforms out of its batch, not attempt
 * them and report the failure.
 *
 * This ran every 30 minutes over every channel. The adapter already answered
 * `unsupported` (so nothing was silently mis-synced), but each douyin/twitter
 * channel produced a red row and a warn line — for a condition that cannot change
 * between runs, on a schedule the user set up to keep things current. The honest
 * answer, that those two platforms only work from the dashboard, was never stated
 * anywhere they could see.
 *
 * Two properties, and the second is the one a future edit would drop:
 *  - the batch receives only runnable channels;
 *  - the skipped platforms are NAMED in the log. Silence would be the same defect
 *    class as the discarded batch result this file already fixed — nothing left
 *    to distinguish "not applicable" from "we forgot to try".
 */

const batchedChannels: Channel[] = [];
const logged: string[] = [];

const douyinChannel: Channel = {
  id: 'douyin:a',
  creatorId: 'c1',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAx',
  displayName: '抖音号',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAx',
};

const bilibiliChannel: Channel = {
  id: 'bilibili:1',
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: '1',
  displayName: 'B站号',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/1',
};

vi.mock('../src/platform/registry', async () => {
  const { douyinAdapter } = await import('../src/adapters/douyin');
  const { bilibiliAdapter } = await import('../src/adapters/bilibili');
  return {
    getAdapter: (platform: string) =>
      platform === 'douyin' ? douyinAdapter : platform === 'bilibili' ? bilibiliAdapter : undefined,
  };
});

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    channels: { toArray: async () => [douyinChannel, bilibiliChannel] },
    posts: { where: () => ({ equals: () => ({ count: async () => 0 }) }) },
  },
}));

vi.mock('../src/infrastructure/db/settingsRepository', () => ({
  getSettings: async () => ({ enableAutoSync: true, itemsPerFetch: 10, hideReposts: false, requestDelayMs: 0 }),
}));

vi.mock('../src/sync/batchSync', () => ({
  batchUpdateChannelsInterleaved: async (channels: Channel[]) => {
    batchedChannels.push(...channels);
    return { totalChannels: channels.length, successful: channels.length, newPostsCount: 0 };
  },
}));

vi.mock('../src/utils/devLog', () => ({
  devLog: {
    info: (_scope: string, message: string) => {
      logged.push(message);
    },
    warn: (_scope: string, message: string) => {
      logged.push(message);
    },
    error: (_scope: string, message: string) => {
      logged.push(message);
    },
    debug: () => {},
    record: () => {},
    flush: async () => {},
  },
}));

vi.mock('../src/utils/badge', () => ({ notifyBadgeRefresh: async () => {} }));

import { handleAutoSyncAlarm } from '../src/infrastructure/chrome/autoSync';

/** `handleAutoSyncAlarm` reads `chrome.alarms` first; give it one to inspect. */
(globalThis as { chrome?: unknown }).chrome = {
  alarms: { get: async () => undefined, create: async () => {}, clear: async () => {} },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
};

beforeEach(() => {
  batchedChannels.length = 0;
  logged.length = 0;
});

describe('auto-sync filters platforms that cannot run in the worker', () => {
  it('hands the batch only runnable channels', async () => {
    await handleAutoSyncAlarm({ name: 'creator-feed-auto-sync' });

    expect(batchedChannels.map((c) => c.platform)).toEqual(['bilibili']);
  });

  it('names the skipped platform instead of dropping it silently', async () => {
    await handleAutoSyncAlarm({ name: 'creator-feed-auto-sync' });

    const skipLine = logged.find((l) => l.includes('跳过'));
    expect(skipLine, `no skip line among: ${JSON.stringify(logged)}`).toBeDefined();
    // The user-visible name, not the internal key.
    expect(skipLine).toContain('抖音');
    expect(skipLine).not.toContain('bilibili');
  });
});
