import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, Post } from '../src/types';
import type { FetchResult } from '../src/adapters/types';

/**
 * Sync coordination: one channel, one fetch.
 *
 * Six entry points can call `updateChannel` — the dashboard's refresh-all,
 * refresh-creator, refresh-channel and deep-sync, the popup's `SYNC_CHANNEL`,
 * and the auto-sync alarm — and nothing coordinated them. `status: 'updating'`
 * is a field written before the fetch, not a mutex, so the same channel could be
 * acquired twice: each run holding a Channel snapshot from a different moment,
 * whichever finished LAST winning. The user could not see it happen, and the
 * damage is in `nextCursor` — a history dig silently rewinding or skipping.
 *
 * These assert the property that matters (how many times the platform was
 * actually asked) rather than that a helper was invoked.
 */

/** Every `channels.update` payload this run produced. */
const channelUpdates: Array<Record<string, unknown>> = [];

let fetchCalls = 0;
/** Resolved by the test to control when a fetch completes. */
let releaseFetch: (() => void) | undefined;

let fetchLatestImpl: (options?: { signal?: AbortSignal }) => Promise<FetchResult>;

vi.mock('../src/platform/registry', () => ({
  getAdapter: () => ({
    platform: 'bilibili',
    // `options` is forwarded: the cancellation contract is about the signal the
    // ADAPTER receives, so a mock that swallows it cannot test that contract.
    fetchLatest: async (_channel: unknown, _limit: unknown, options?: { signal?: AbortSignal }) => {
      fetchCalls++;
      if (releaseFetch) await new Promise<void>((r) => { releaseFetch = r; });
      return fetchLatestImpl(options);
    },
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
      // Recorded, not swallowed: several contracts are about WHAT gets written
      // (the resolved id, the terminal cursor), and a mock that discards the
      // payload cannot test any of them.
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

import { updateChannel } from '../src/sync/channelSync';import { resetSyncCoordinator, waitForPlatformTurn, notePlatformFinished } from '../src/sync/syncCoordinator';

const channel: Channel = {
  id: 'bilibili:coord',
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: 'coord',
  displayName: '并发样例',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/coord',
};

const post: Post = {
  id: 'bilibili_c1',
  creatorId: 'c1',
  channelId: channel.id,
  platform: 'bilibili',
  title: 't',
  content: 'c',
  mediaList: [],
  originalUrl: 'https://www.bilibili.com/video/c1',
  publishedAt: 1_700_000_000_000,
  fetchedAt: 1_700_000_000_000,
  isRead: 0,
};

beforeEach(() => {
  resetSyncCoordinator();
  channelUpdates.length = 0;
  fetchCalls = 0;
  releaseFetch = undefined;
  fetchLatestImpl = async () => ({ posts: [post], totalFetched: 1, hasMore: false });
});

describe('single-flight per channel', () => {
  it('runs one fetch when two callers ask for the same channel at once', async () => {
    // The defect this exists for: the alarm and a manual refresh both entering.
    // The fetch is held open until both callers have arrived, so they genuinely
    // overlap rather than happening to serialise.
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    let started = 0;
    const { promise: bothStarted, resolve: onBoth } = Promise.withResolvers<void>();
    fetchLatestImpl = async () => {
      started++;
      if (started === 1) onBoth();
      await gate;
      return { posts: [post], totalFetched: 1, hasMore: false };
    };

    const first = updateChannel(channel, 10, true);
    // Wait until the first fetch is actually inside the adapter, so the second
    // call is guaranteed to meet it in flight.
    await bothStarted;
    const second = updateChannel(channel, 10, true);
    open();
    const [a, b] = await Promise.all([first, second]);

    expect(fetchCalls).toBe(1);
    // The joiner sees the same result rather than a second, possibly different one.
    expect(a.posts).toHaveLength(1);
    expect(b.posts).toHaveLength(1);
  });

  it('does not join across DIFFERENT channels', async () => {
    // Over-locking would serialise the whole refresh; only the same channel
    // may share a run.
    const other = { ...channel, id: 'bilibili:other' };

    await Promise.all([updateChannel(channel, 10, true), updateChannel(other, 10, true)]);

    expect(fetchCalls).toBe(2);
  });

  it('allows a later run once the first has settled', async () => {
    // The lock must be released, or a channel syncs exactly once per session.
    await updateChannel(channel, 10, true);
    await updateChannel(channel, 10, true);

    expect(fetchCalls).toBe(2);
  });

  it('releases the slot even when the run fails', async () => {
    fetchLatestImpl = async () => {
      throw new Error('boom');
    };
    await updateChannel(channel, 10, true);

    fetchLatestImpl = async () => ({ posts: [post], totalFetched: 1, hasMore: false });
    await updateChannel(channel, 10, true);

    expect(fetchCalls).toBe(2);
  });
});

describe('platform pacing shared across entry points', () => {
  it('waits when the platform was just contacted', async () => {
    // `batchSync` kept this timestamp per CALL, so two concurrent batches each
    // believed the platform had never been contacted and both fired at once.
    notePlatformFinished('douyin', Date.now());

    const waited = await waitForPlatformTurn('douyin', 300);

    expect(waited).toBeGreaterThan(0);
  });

  it('does not wait once the interval has elapsed', async () => {
    notePlatformFinished('douyin', Date.now() - 5000);

    expect(await waitForPlatformTurn('douyin', 300)).toBe(0);
  });

  it('does not wait for a platform that was never contacted', async () => {
    expect(await waitForPlatformTurn('pixiv', 300)).toBe(0);
  });

  it('records the finish time for a FAILED request too', async () => {
    // A failed request still hit the platform, so the spacing after it must
    // account for it (rule 19).
    fetchLatestImpl = async () => {
      throw new Error('network down');
    };
    await updateChannel(channel, 10, true);

    expect(await waitForPlatformTurn(channel.platform, 300)).toBeGreaterThan(0);
  });
});

/**
 * Cancellation composition.
 *
 * `signal: options?.signal ?? abortController.signal` was a CHOICE, not a
 * combination: with a caller signal present the 45s deadline lost its only
 * lever, so the timeout rejected while the fetch kept running — the exact
 * "resolved while the request continued" failure the abort controller was added
 * to fix. No caller passes a signal today, which is why it stayed latent.
 */
describe('cancellation composes caller signal with the deadline', () => {
  it('keeps the DEADLINE able to cancel when a caller supplied its own signal', async () => {
    // The broken direction, and the only one `??` got wrong: with a caller signal
    // present, `options.signal ?? deadline` handed the adapter the CALLER's
    // signal and the 45s deadline lost its only lever — the timeout would reject
    // while the fetch kept running (AUDIT P1-2). A caller abort still worked,
    // which is why asserting on that direction proved nothing.
    const caller = new AbortController();
    const { promise: gotSignal, resolve: onSignal } = Promise.withResolvers<AbortSignal | undefined>();
    let observed: AbortSignal | undefined;
    fetchLatestImpl = async (opts?: { signal?: AbortSignal }) => {
      observed = opts?.signal;
      onSignal(opts?.signal);
      return { posts: [post], totalFetched: 1, hasMore: false };
    };

    const run = updateChannel(channel, 10, true, { signal: caller.signal });
    const signal = await gotSignal;

    // The signal the adapter holds must NOT be the caller's own object: if it is,
    // nothing else can ever cancel the request.
    expect(signal).toBeDefined();
    expect(signal).not.toBe(caller.signal);
    expect(observed?.aborted).toBe(false);

    caller.abort();
    // …and it still follows the caller.
    expect(observed?.aborted).toBe(true);
    await run.catch(() => undefined);
  });

  it('aborts the adapter when the deadline fires, even with a caller signal', async () => {
    // The direction that was broken: the deadline must still work when the
    // caller supplied something.
    const { composeAbortSignals } = await import('../src/sync/channelSync');
    const caller = new AbortController();
    const deadline = new AbortController();
    const seen = composeAbortSignals(caller.signal, deadline.signal);

    deadline.abort();

    expect(seen.aborted).toBe(true);
  });

  it('passes a lone deadline through unchanged when there is no caller signal', async () => {
    const { composeAbortSignals } = await import('../src/sync/channelSync');
    const deadline = new AbortController();

    expect(composeAbortSignals(undefined, deadline.signal)).toBe(deadline.signal);
  });
});


/**
 * Persisting a resolved platform id.
 *
 * The adapter reports it once; this layer must STORE it, or the next sync pays
 * for the same discovery again. YouTube's case: a 1.16 MB profile page to find
 * an id that never changes.
 */
describe('channelSync stores a resolved platform id', () => {
  it('writes resolvedAccountId onto the channel', async () => {
    fetchLatestImpl = async () => ({
      posts: [post],
      totalFetched: 1,
      hasMore: false,
      authorMeta: { name: 'x', resolvedAccountId: 'UCOI806s3tcLz6S9Xh4kBWow' },
    });

    await updateChannel(channel, 10, true);

    const persisted = channelUpdates.find((u) => u.resolvedAccountId !== undefined);
    expect(persisted?.resolvedAccountId).toBe('UCOI806s3tcLz6S9Xh4kBWow');
  });

  it('does not write the field when the adapter resolved nothing', async () => {
    // Idempotence: the fast path must not rewrite the same value on every sync.
    fetchLatestImpl = async () => ({
      posts: [post],
      totalFetched: 1,
      hasMore: false,
      authorMeta: { name: 'x' },
    });

    await updateChannel(channel, 10, true);

    expect(channelUpdates.some((u) => 'resolvedAccountId' in u)).toBe(false);
  });
});
