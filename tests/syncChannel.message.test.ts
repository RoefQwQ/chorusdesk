import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * `SYNC_CHANNEL` — the popup asks the service worker to fetch a channel it has
 * just followed.
 *
 * Two properties matter and neither is visible from the popup's side:
 *
 *  - **The channel is read from the database by id, never taken from the
 *    message.** A message body is caller-supplied. The router decides *who* may
 *    ask (AGENTS rule 4); this handler has to decide *what* may be asked for, and
 *    "sync whatever record you hand me" would let a page reach any URL the
 *    extension can fetch.
 *  - **The limit is bounded and coerced.** An unbounded or non-numeric `limit`
 *    becomes a fetch of arbitrary size — the same reason adapters bound the counts
 *    they accept from a page.
 *
 * It also has to answer on every path: a handler that returns without calling
 * `sendResponse` leaves the popup's promise pending forever.
 */

const channels = new Map<string, Channel>();
const synced: Array<{ id: string; limit: number }> = [];
/** Set to a FetchResult-shaped value to simulate a failed sync. */
let failWith: Error | null = null;
let returnError: { code: string; message: string } | null = null;

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    channels: {
      get: async (id: string) => channels.get(id),
    },
  },
}));

vi.mock('../src/sync/channelSync', () => ({
  updateChannel: async (channel: Channel, limit: number) => {
    if (failWith) throw failWith;
    synced.push({ id: channel.id, limit });
    // A real sync resolves with a FetchResult; a failure is carried in `error`,
    // it is not thrown.
    return returnError ? { posts: [], error: returnError } : { posts: [] };
  },
}));

import { handleSyncChannel } from '../src/infrastructure/chrome/messages/syncChannel';

const channel = (id: string): Channel => ({
  id,
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: 'a',
  displayName: '昵称',
  status: 'idle',
  profileUrl: 'https://example.com/' + id,
});

/** Runs the handler and resolves with whatever it eventually sends. */
async function run(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  let answer: Record<string, unknown> | undefined;
  const returned = handleSyncChannel(message, (r) => {
    answer = r as Record<string, unknown>;
  });
  // `true` keeps the message channel open for the async reply; a handler that
  // returned false would have its reply dropped silently.
  expect(returned).toBe(true);
  for (let i = 0; i < 50 && answer === undefined; i++) await new Promise((r) => setTimeout(r, 0));
  if (answer === undefined) throw new Error('the handler never called sendResponse');
  return answer;
}

beforeEach(() => {
  channels.clear();
  synced.length = 0;
  failWith = null;
  returnError = null;
});

describe('SYNC_CHANNEL', () => {
  it('syncs the stored channel named by the id', async () => {
    channels.set('bilibili:a', channel('bilibili:a'));

    const res = await run({ channelId: 'bilibili:a', limit: 5 });

    expect(res).toEqual({ success: true });
    expect(synced).toEqual([{ id: 'bilibili:a', limit: 5 }]);
  });

  it('syncs what the id names, not what the message describes', async () => {
    // The message claims a different channel entirely; only the id is honoured.
    channels.set('bilibili:a', channel('bilibili:a'));

    await run({ channelId: 'bilibili:a', limit: 5, channel: channel('twitter:evil') });

    expect(synced).toEqual([{ id: 'bilibili:a', limit: 5 }]);
  });

  it('refuses an unknown id instead of syncing anything', async () => {
    const res = await run({ channelId: 'bilibili:missing' });

    expect(res.success).toBe(false);
    expect(synced).toEqual([]);
  });

  it('refuses a missing or non-string id', async () => {
    for (const channelId of [undefined, null, 42, '', { id: 'bilibili:a' }]) {
      const res = await run({ channelId });
      expect(res.success, `accepted ${JSON.stringify(channelId)}`).toBe(false);
    }
    expect(synced).toEqual([]);
  });

  it('bounds the limit and falls back for junk values', async () => {
    channels.set('bilibili:a', channel('bilibili:a'));

    await run({ channelId: 'bilibili:a', limit: 2.7 });
    await run({ channelId: 'bilibili:a', limit: 10_000 });
    await run({ channelId: 'bilibili:a', limit: -1 });
    await run({ channelId: 'bilibili:a', limit: Number.NaN });
    await run({ channelId: 'bilibili:a', limit: '20' });
    await run({ channelId: 'bilibili:a' });

    expect(synced.map((s) => s.limit)).toEqual([2, 50, 5, 5, 5, 5]);
  });

  it('reports a failed sync rather than answering success', async () => {
    channels.set('bilibili:a', channel('bilibili:a'));
    failWith = new Error('触发平台防刷频率限制。');

    const res = await run({ channelId: 'bilibili:a', limit: 5 });

    expect(res.success).toBe(false);
    expect(String(res.error)).toContain('频率限制');
  });

  it('reports a sync that RESOLVED with an error, not only one that threw', async () => {
    // `updateChannel` reports a failed sync by resolving with `error` — a rate
    // limit, an auth wall, an unsupported platform — and never throws for any of
    // them. A handler that only catches would call every one of those a success.
    channels.set('bilibili:a', channel('bilibili:a'));
    returnError = { code: 'unsupported', message: '不支持的平台: nope' };

    const res = await run({ channelId: 'bilibili:a', limit: 5 });

    expect(res.success).toBe(false);
    expect(res.error).toBe('不支持的平台: nope');
  });
});
