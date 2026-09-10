import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pacing and cool-down after platform rate limits.
 *
 * The defect this exists for: `batchSync` recorded a platform's timestamp
 * *before* awaiting its request, so the spacing between two requests on that
 * platform was `interval - duration`. For any request slower than the interval
 * that is zero — and Douyin's requests take seconds, so three page loads fired
 * back to back until the platform answered with a verification wall.
 *
 * Every assertion here is about behaviour a user can observe: how long we wait,
 * and whether we contact a platform at all.
 */

const settings = new Map<string, unknown>();

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

vi.mock('../src/platform/registry', () => ({
  // The floor is declared by each adapter; these tests only need the lookup to
  // resolve, and the real Douyin value is asserted through the adapter itself.
  getAdapter: (platform: string) =>
    platform === 'douyin' ? { platform, minRequestIntervalMs: 15_000 } : { platform },
}));

import {
  DEFAULT_MIN_INTERVAL_MS,
  RATE_LIMIT_BASE_MS,
  RATE_LIMIT_MAX_MS,
  backoffForStrike,
  clearRateLimit,
  formatCooldown,
  noteRateLimit,
  platformMinInterval,
  readCooldowns,
  remainingCooldown,
} from '../src/sync/rateLimit';

beforeEach(() => {
  settings.clear();
});

describe('platformMinInterval', () => {
  it('gives Douyin far more spacing than the default', () => {
    // A Douyin request is a page load in a tab, not an API call, so it needs a
    // gap that reflects how loud it is rather than the generic floor.
    expect(platformMinInterval('douyin')).toBeGreaterThan(DEFAULT_MIN_INTERVAL_MS * 5);
  });

  it('uses the default floor for every other platform', () => {
    expect(platformMinInterval('twitter')).toBe(DEFAULT_MIN_INTERVAL_MS);
    expect(platformMinInterval('rss')).toBe(DEFAULT_MIN_INTERVAL_MS);
  });
});

describe('backoffForStrike', () => {
  it('starts at the base and doubles per consecutive signal', () => {
    expect(backoffForStrike(1)).toBe(RATE_LIMIT_BASE_MS);
    expect(backoffForStrike(2)).toBe(RATE_LIMIT_BASE_MS * 2);
    expect(backoffForStrike(3)).toBe(RATE_LIMIT_BASE_MS * 4);
  });

  it('caps, so a hostile platform cannot lock itself out for hours', () => {
    expect(backoffForStrike(20)).toBe(RATE_LIMIT_MAX_MS);
    expect(backoffForStrike(100)).toBe(RATE_LIMIT_MAX_MS);
  });

  it('treats a nonsensical strike count as the first', () => {
    // Defensive: strike counts come back out of storage.
    expect(backoffForStrike(0)).toBe(RATE_LIMIT_BASE_MS);
    expect(backoffForStrike(-5)).toBe(RATE_LIMIT_BASE_MS);
  });
});

describe('readCooldowns', () => {
  it('returns nothing when never written', async () => {
    expect(await readCooldowns()).toEqual({});
  });

  it('drops a non-finite `until` instead of never expiring', async () => {
    // A cool-down is a wall-clock time. `NaN` compares false against every
    // clock, so keeping it would mean a platform that can never be contacted
    // again — silently, with no way to see why.
    settings.set('sync.platformCooldown', {
      douyin: { until: Number.NaN, strikes: 2 },
      twitter: { until: 5_000, strikes: 1 },
      weibo: { until: Number.POSITIVE_INFINITY, strikes: 1 },
    });

    const map = await readCooldowns();

    expect(Object.keys(map)).toEqual(['twitter']);
  });

  it('drops malformed entries and survives a bad container', async () => {
    settings.set('sync.platformCooldown', { douyin: null, weibo: 'soon', rss: { strikes: 3 } });
    expect(await readCooldowns()).toEqual({});

    settings.set('sync.platformCooldown', 'not an object');
    expect(await readCooldowns()).toEqual({});
  });

  it('defaults a missing strike count to one', async () => {
    settings.set('sync.platformCooldown', { douyin: { until: 9_999 } });
    expect((await readCooldowns()).douyin).toEqual({ until: 9_999, strikes: 1 });
  });
});

describe('noteRateLimit', () => {
  it('records a cool-down that outlasts the process that detected it', async () => {
    // Persisted, not in module scope: an MV3 worker is torn down between syncs,
    // and the user clicking sync again is exactly when the memory matters.
    await noteRateLimit('douyin', 1_000);

    expect(await readCooldowns()).toEqual({
      douyin: { until: 1_000 + RATE_LIMIT_BASE_MS, strikes: 1 },
    });
  });

  it('escalates while the platform keeps pushing back', async () => {
    const first = await noteRateLimit('douyin', 1_000);
    const second = await noteRateLimit('douyin', 1_000);
    const third = await noteRateLimit('douyin', 1_000);

    expect(first.strikes).toBe(1);
    expect(second.strikes).toBe(2);
    expect(third.strikes).toBe(3);
    expect(second.until - 1_000).toBeGreaterThan(first.until - 1_000);
    expect(third.until - 1_000).toBeGreaterThan(second.until - 1_000);
  });

  it('tracks platforms independently', async () => {
    await noteRateLimit('douyin', 1_000);

    const map = await readCooldowns();
    expect(map.douyin).toBeDefined();
    expect(map.twitter).toBeUndefined();
  });
});

describe('clearRateLimit', () => {
  it('lifts the cool-down after a clean request', async () => {
    await noteRateLimit('douyin', 1_000);
    await clearRateLimit('douyin');

    expect(await readCooldowns()).toEqual({});
  });

  it('resets the escalation, not just the timer', async () => {
    // Otherwise a long session would creep toward the maximum cool-down for
    // reasons that stopped being true hours earlier.
    await noteRateLimit('douyin', 1_000);
    await noteRateLimit('douyin', 1_000);
    await clearRateLimit('douyin');
    await noteRateLimit('douyin', 1_000);

    expect((await readCooldowns()).douyin.strikes).toBe(1);
  });

  it('is harmless for a platform with no cool-down', async () => {
    await clearRateLimit('weibo');
    expect(await readCooldowns()).toEqual({});
  });
});

describe('remainingCooldown', () => {
  it('reports the time left, and zero once it has passed', () => {
    const map = { douyin: { until: 61_000, strikes: 1 } };

    expect(remainingCooldown(map, 'douyin', 1_000)).toBe(60_000);
    expect(remainingCooldown(map, 'douyin', 61_000)).toBe(0);
    expect(remainingCooldown(map, 'douyin', 99_000)).toBe(0);
  });

  it('is zero for a platform with no entry', () => {
    expect(remainingCooldown({}, 'douyin', 1_000)).toBe(0);
  });
});

describe('formatCooldown', () => {
  it('reads as a duration a user can act on', () => {
    expect(formatCooldown(45_000)).toBe('45 秒');
    expect(formatCooldown(3 * 60_000 + 20_000)).toBe('3 分 20 秒');
    expect(formatCooldown(60_000)).toBe('1 分 0 秒');
  });

  it('rounds up, so a message never says zero seconds', () => {
    expect(formatCooldown(1)).toBe('1 秒');
    expect(formatCooldown(1_001)).toBe('2 秒');
  });
});

describe('the real adapters declare their own floors', () => {
  it('gives Douyin a floor far above the generic default', async () => {
    // Read from the adapter, not the mocked registry, so the production value is
    // actually pinned. The mocked lookup above makes `platformMinInterval` agree
    // with whatever the test wants; this is what keeps that from hiding a
    // regression in the adapter itself.
    const { douyinAdapter } = await import('../src/adapters/douyin');

    expect(douyinAdapter.minRequestIntervalMs).toBe(15_000);
    expect(douyinAdapter.minRequestIntervalMs!).toBeGreaterThan(DEFAULT_MIN_INTERVAL_MS * 5);
  });

  it('leaves other platforms on the generic default', async () => {
    const { rssAdapter } = await import('../src/adapters/rss');
    const { twitterAdapter } = await import('../src/adapters/twitter');

    expect(rssAdapter.minRequestIntervalMs).toBeUndefined();
    expect(twitterAdapter.minRequestIntervalMs).toBeUndefined();
  });
});
