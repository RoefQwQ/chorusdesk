import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Post } from '../src/types';
import type { FetchResult } from '../src/adapters/types';
import { fetchError } from '../src/adapters/types';

/**
 * Sync-path visibility in the Developer Log.
 *
 * Motivation, from one real session: the log showed a channel's fetch lines and
 * then, twenty-seven seconds later, its 「同步完成」 line — with nothing in
 * between. The user reasonably asked whether that platform had stopped
 * responding. It had not; the acquisition (page load, injection, contract
 * validation, mapping) simply emitted nothing, and several paths returned
 * without logging at all.
 *
 * So these assert what the user can READ, at the level they read it — the
 * `channelSync` lines — rather than that some helper was called. The three
 * silent returns matter most: a channel that was skipped, ended, or had no
 * adapter looked identical to one that was never reached.
 */

let fetchLatestMock: () => Promise<FetchResult> = async () => ({ posts: [] });

vi.mock('../src/platform/registry', () => ({
  getAdapter: (platform: string) => (platform === 'ghost' ? undefined : {
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
      each: async () => {},
      get: vi.fn(),
    },
    channels: {
      get: vi.fn(async () => ({ status: 'idle' })),
      update: vi.fn(async () => undefined),
    },
    creators: { get: vi.fn(async () => undefined), update: vi.fn() },
    postSuppressions: {
      bulkGet: async (ids: string[]) => ids.map(() => undefined),
      bulkDelete: vi.fn(),
    },
  },
}));

import { updateChannel } from '../src/sync/channelSync';
import { devLog } from '../src/utils/devLog';

const channel: Channel = {
  id: 'bilibili:vis',
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: 'vis',
  displayName: '可见性样例',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/vis',
};

const post: Post = {
  id: 'bilibili_v1',
  creatorId: 'c1',
  channelId: channel.id,
  platform: 'bilibili',
  title: 't',
  content: 'c',
  mediaList: [],
  originalUrl: 'https://www.bilibili.com/video/v1',
  publishedAt: 1_700_000_000_000,
  fetchedAt: 1_700_000_000_000,
  isRead: 0,
};

/** Every line the panel would show, as one searchable string. */
async function logText(): Promise<string> {
  await devLog.flush();
  const entries = await devLog.read();
  return entries.map((e) => `${e.scope}: ${e.message} ${e.detail || ''}`).join('\n');
}

beforeEach(async () => {
  await devLog.clear();
  // `debug` lines are kept only while verbose is on (rule 11), and the start /
  // skip lines are debug by design — they are high-volume on the success path.
  await devLog.setVerbose(true);
  fetchLatestMock = async () => ({ posts: [post], totalFetched: 1, hasMore: false });
});

describe('sync visibility — the interval that used to be blank', () => {
  it('logs a start line naming the mode, limited to the water mark', async () => {
    await updateChannel(channel, 10, true);

    expect(await logText()).toContain('开始同步（常规）');
  });

  it('logs the elapsed time on completion', async () => {
    // Without this the start line and the finish line cannot be related, which
    // is exactly how a 27-second gap read as "the platform stopped responding".
    await updateChannel(channel, 10, true);

    const text = await logText();
    expect(text).toContain('同步完成');
    expect(text).toMatch(/耗时 \d+ms/);
  });

  it('names the mode so a dig is not confused with a normal sync', async () => {
    await updateChannel(channel, 10, true, { cursor: '2' });

    expect(await logText()).toContain('开始同步（历史回溯）');
  });
});

describe('sync visibility — the paths that returned silently', () => {
  it('logs a skip when the platform has no adapter', async () => {
    // A real state since platforms can be removed (Rplay, Withny). The channel
    // simply never appeared in the log, which reads as "the sync stopped".
    const ghost = { ...channel, platform: 'ghost' as never };

    const result = await updateChannel(ghost, 10, true);

    expect(result.error?.code).toBe('unsupported');
    expect(await logText()).toContain('跳过：没有对应适配器');
  });

  it('logs a skip for the 30-second cooldown instead of vanishing', async () => {
    const recent = { ...channel, lastSuccessAt: Date.now() };

    // Not forced, and no cursor: the guard applies.
    const result = await updateChannel(recent, 10, false);

    expect(result.error).toBeUndefined();
    expect(await logText()).toContain('跳过：30 秒内已成功同步');
  });

  it('records reaching the end of history, because that write cannot be undone', async () => {
    // The terminal cursor is the one write in this file the user cannot take
    // back, and it was made without leaving a line.
    //
    // Reached through the ERROR branch by construction: `statesEndOfHistory` is
    // consulted inside `if (result.error && result.posts.length === 0)`, and its
    // predicate accepts `hasMore === false` or a `not_found` — i.e. the platform
    // stated it while returning nothing.
    fetchLatestMock = async () => ({ posts: [], hasMore: false, error: fetchError('not_found', '没有更多了') });

    await updateChannel(channel, 10, true);

    expect(await logText()).toContain('已到历史底部');
  });

  it('includes the failure code and elapsed time when a sync fails', async () => {
    fetchLatestMock = async () => ({ posts: [], error: fetchError('rate_limit', '平台限流') });

    const result = await updateChannel(channel, 10, true);

    expect(result.error?.code).toBe('rate_limit');
    const text = await logText();
    expect(text).toContain('同步失败（rate_limit）');
    // "Failed after 40s" and "failed after 0.2s" are different bugs.
    expect(text).toMatch(/耗时 \d+ms/);
  });
});
