import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Post } from '../src/types';
import type { FetchResult } from '../src/adapters/types';

/**
 * Degraded results (audit P1-3).
 *
 * The most dangerous failure shape is not an error — it is a valid but SHORTER
 * page. Platforms here are multi-source (bilibili dynamic + medialist, XHS list
 * + enrichment, Twitter tab + direct), so when one source is down the adapter
 * still returns content, `hasMore` is honest about the page, and nothing reports
 * a problem: the user reads "this creator did not post" and the log says
 * 同步完成.
 *
 * `FetchResult.degraded` + `warnings` make that state nameable, and `channelSync`
 * must actually emit it — a flag nobody reads is the write-only-field defect
 * this repo already removed once (`FetchError.retryable`). So the assertion
 * below is on the LOG, which is the surface a user can paste back.
 */

const channelUpdates: Array<Record<string, unknown>> = [];
const rows = new Map<string, Post>();
let adapterResult: FetchResult;

vi.mock('../src/platform/registry', () => ({
  getAdapter: () => ({
    platform: 'bilibili',
    fetchLatest: async () => adapterResult,
  }),
}));

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    posts: {
      where: () => ({
        between: () => ({ last: async () => null }),
        equals: () => ({ primaryKeys: async () => [], each: async () => {} }),
      }),
      bulkGet: async () => [],
      bulkPut: async (posts: Post[]) => {
        for (const p of posts) rows.set(p.id, p);
      },
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

import { updateChannel } from '../src/sync/channelSync';
import { devLog } from '../src/utils/devLog';

const channel: Channel = {
  id: 'bilibili:degraded',
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: 'degraded',
  displayName: '降级样例',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/degraded',
};

function makePost(id: string): Post {
  return {
    id,
    creatorId: 'c1',
    channelId: channel.id,
    platform: 'bilibili',
    title: 't',
    content: 'c',
    mediaList: [],
    originalUrl: `https://www.bilibili.com/video/${id}`,
    publishedAt: 1_700_000_000_000,
    fetchedAt: 1_700_000_000_000,
    isRead: 0,
  };
}

beforeEach(() => {
  channelUpdates.length = 0;
  rows.clear();
  devLog.clear();
});

describe('degraded fetch results', () => {
  it('logs a warning naming the partial result, and still writes the posts it got', async () => {
    adapterResult = {
      posts: [makePost('bilibili_video_1')],
      totalFetched: 1,
      hasMore: false,
      degraded: true,
      warnings: ['动态接口未返回可用数据（业务码 -412），本次仅有投稿列表可用，可能缺少图文动态。'],
    };

    await updateChannel(channel, 10, false);

    // Partial data still lands: the alternative (writing nothing) loses what
    // the working source did return.
    expect(rows.has('bilibili_video_1')).toBe(true);

    // `record` is fire-and-forget by design (AGENTS rule 11) — the entry is
    // queued on the module's write chain, so the read must wait for it.
    await devLog.flush();
    const entries = await devLog.read();
    const warning = entries.find((e) => e.level === 'warn' && e.message.includes('不完整'));
    expect(warning, `no degraded warning in: ${JSON.stringify(entries)}`).toBeDefined();
    expect(warning?.detail).toContain('动态接口未返回可用数据');
    // The channel is still a success: a degraded page is not a failed channel.
    expect(channelUpdates.some((u) => u.status === 'success')).toBe(true);
  });

  it('does not log a degraded warning for an intact result', async () => {
    adapterResult = { posts: [makePost('bilibili_video_2')], totalFetched: 1, hasMore: false };

    await updateChannel(channel, 10, false);

    // `record` is fire-and-forget by design (AGENTS rule 11): the write is
    // queued behind the module's write chain, so a read must wait for it.
    await devLog.flush();
    expect((await devLog.read()).some((e) => e.message.includes('不完整'))).toBe(false);
  });
});
