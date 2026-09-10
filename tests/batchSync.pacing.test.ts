import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';
import type { FetchResult } from '../src/adapters/types';

/**
 * Platform pacing in the batch sync loop.
 *
 * The regression these pin: the loop recorded a platform's last request time
 * *before* awaiting the request, so consecutive requests on that platform were
 * separated by `interval - duration` — and zero for any request slower than the
 * interval. Douyin's requests take seconds (a real page load in a tab), so a
 * "sync all" issued them back to back and the platform answered with a
 * verification wall.
 *
 * The observable contract is therefore about *gaps*, not about which variable
 * holds what: the gap between two requests on the same platform must last the
 * configured interval, measured from the end of the first.
 */

const settings = new Map<string, unknown>();

/** Timestamps of each request the loop actually issued. */
let requests: Array<{ platform: string; channelId: string; startedAt: number; finishedAt: number }>;
/** How long the fake adapter takes to answer. */
let requestDurationMs: number;
/** What the fake adapter returns, per channel. */
let results: Map<string, FetchResult>;

vi.mock('../src/platform/registry', () => ({
  // A small floor, so the pacing assertions can measure real gaps without
  // sleeping for the production Douyin interval. The production value is
  // asserted separately, against the real adapter.
  getAdapter: (platform: string) =>
    platform === 'douyin' ? { platform, minRequestIntervalMs: 60 } : { platform },
}));

vi.mock('../src/infrastructure/db/database', () => ({
  db: {
    settings: {
      get: async (key: string) => (settings.has(key) ? { key, value: settings.get(key) } : undefined),
      put: async (row: { key: string; value: unknown }) => {
        settings.set(row.key, row.value);
      },
    },
  },
}));

vi.mock('../src/sync/channelSync', () => ({
  updateChannel: async (channel: Channel): Promise<FetchResult> => {
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, requestDurationMs));
    const finishedAt = Date.now();
    requests.push({ platform: channel.platform, channelId: channel.id, startedAt, finishedAt });
    return results.get(channel.id) ?? { posts: [] };
  },
}));

import { batchUpdateChannelsInterleaved } from '../src/sync/batchSync';
import { fetchError } from '../src/adapters/types';
import { RATE_LIMIT_BASE_MS, platformMinInterval } from '../src/sync/rateLimit';

function channel(id: string, platform: string): Channel {
  return {
    id,
    creatorId: 'c1',
    platform,
    accountId: id,
    displayName: id,
    status: 'idle',
    profileUrl: 'https://example.com/' + id,
  };
}

beforeEach(() => {
  settings.clear();
  requests = [];
  requestDurationMs = 0;
  results = new Map();
});

describe('batch pacing — spacing is measured from the end of the request', () => {
  it('leaves the full interval after a slow request, not zero', async () => {
    // The regression, stated directly: the request takes longer than the floor,
    // so measuring from its *start* yields no gap at all.
    requestDurationMs = 120;
    const interval = 60;

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin'), channel('d2', 'douyin')], 10, {
      minPlatformIntervalMs: interval,
    });

    expect(requests).toHaveLength(2);
    const gap = requests[1].startedAt - requests[0].finishedAt;
    // Timing tolerance only; the point is that the gap is the interval, not nil.
    expect(gap).toBeGreaterThan(interval * 0.7);
  });

  it('leaves the full interval after a fast request too', async () => {
    requestDurationMs = 0;
    const interval = 60;

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin'), channel('d2', 'douyin')], 10, {
      minPlatformIntervalMs: interval,
    });

    const gap = requests[1].startedAt - requests[0].finishedAt;
    expect(gap).toBeGreaterThan(interval * 0.7);
  });

  it('spaces the same platform but does not delay different ones', async () => {
    // The interleave exists so a slow platform does not stall the others; a
    // global sleep would undo it.
    requestDurationMs = 0;

    await batchUpdateChannelsInterleaved(
      [channel('d1', 'douyin'), channel('t1', 'twitter'), channel('d2', 'douyin')],
      10,
      { minPlatformIntervalMs: 60 },
    );

    // The two Douyin requests are still separated…
    const douyin = requests.filter((r) => r.platform === 'douyin');
    expect(douyin[1].startedAt - douyin[0].finishedAt).toBeGreaterThan(40);
    // …while Twitter ran in between without waiting for Douyin's floor.
    const twitter = requests.find((r) => r.platform === 'twitter')!;
    expect(twitter.startedAt).toBeLessThan(douyin[1].startedAt);
  });

  it('counts a failed request as having hit the platform', async () => {
    // A failure still reached the platform, so the spacing that follows has to
    // account for it — otherwise the retry immediately follows the failure.
    requestDurationMs = 60;
    results.set('d1', { posts: [], error: fetchError('network', 'boom', true) });

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin'), channel('d2', 'douyin')], 10, {
      minPlatformIntervalMs: 60,
    });

    const gap = requests[1].startedAt - requests[0].finishedAt;
    expect(gap).toBeGreaterThan(40);
  });
});

  it('does not let a caller-supplied delay lower a platform floor', async () => {
    // Real callers pass the user's configured delay as `minPlatformIntervalMs`.
    // Treating that as a replacement for the per-platform floor would erase the
    // platform's own minimum in the one code path users actually trigger, while
    // every test above still passed — because they pass a small override too.
    requestDurationMs = 0;
    const floor = platformMinInterval('douyin');

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin'), channel('d2', 'douyin')], 10, {
      // Deliberately below the platform floor.
      minPlatformIntervalMs: Math.floor(floor / 4),
    });

    const gap = requests[1].startedAt - requests[0].finishedAt;
    expect(gap).toBeGreaterThan(floor * 0.7);
  });

describe('batch pacing — rate-limit cool-down', () => {
  it('does not contact a platform that is cooling down', async () => {
    settings.set('sync.platformCooldown', {
      douyin: { until: Date.now() + 600_000, strikes: 1 },
    });
    const progress: FetchResult[] = [];

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin')], 10, {
      onProgress: (_c, _t, _ch, res) => progress.push(res),
    });

    expect(requests).toHaveLength(0);
    expect(progress).toHaveLength(1);
    expect(progress[0].error?.code).toBe('rate_limit');
    // The message has to tell the user this is deliberate and temporary, or a
    // skipped channel reads as a bug.
    expect(progress[0].error?.message).toContain('冷却');
  });

  it('still syncs other platforms while one cools down', async () => {
    settings.set('sync.platformCooldown', {
      douyin: { until: Date.now() + 600_000, strikes: 1 },
    });

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin'), channel('t1', 'twitter')], 10, {});

    expect(requests.map((r) => r.platform)).toEqual(['twitter']);
  });

  it('starts a cool-down from a rate-limit result', async () => {
    results.set('d1', { posts: [], error: fetchError('rate_limit', '触发了验证', true) });

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin')], 10, {});

    const stored = settings.get('sync.platformCooldown') as Record<string, { until: number }>;
    expect(stored.douyin.until).toBeGreaterThan(Date.now() + RATE_LIMIT_BASE_MS * 0.9);
  });

  it('skips the rest of that platform in the same run', async () => {
    // Detecting the limit and then continuing to hammer the same platform would
    // be worse than not detecting it.
    results.set('d1', { posts: [], error: fetchError('rate_limit', '触发了验证', true) });

    await batchUpdateChannelsInterleaved([channel('d1', 'douyin'), channel('d2', 'douyin')], 10, {});

    expect(requests.map((r) => r.channelId)).toEqual(['d1']);
  });

  it('clears the cool-down once a request succeeds', async () => {
    settings.set('sync.platformCooldown', {
      twitter: { until: Date.now() - 1, strikes: 3 },
    });

    await batchUpdateChannelsInterleaved([channel('t1', 'twitter')], 10, {});

    expect(settings.get('sync.platformCooldown')).toEqual({});
  });

  it('keeps a cool-down for one platform when another succeeds', async () => {
    await batchUpdateChannelsInterleaved(
      [channel('d1', 'douyin'), channel('t1', 'twitter')],
      10,
      { minPlatformIntervalMs: 0 },
    );
    settings.set('sync.platformCooldown', { douyin: { until: Date.now() + 60_000, strikes: 1 } });

    await batchUpdateChannelsInterleaved([channel('t1', 'twitter')], 10, {});

    const stored = settings.get('sync.platformCooldown') as Record<string, unknown>;
    expect(stored.douyin).toBeDefined();
  });
});
