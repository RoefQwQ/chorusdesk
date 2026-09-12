import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../src/types';

/**
 * `reloadData` must not pay the media repair on every call.
 *
 * The repair is a migration: a full `posts.toArray()` plus a
 * `toSecureMediaUrl` per row, run to fix URLs an older build wrote. It used to
 * run at the TOP of `reloadData`, which is the dashboard's hot path — every
 * sync, every filter change, every write — so the cost was paid on each of them
 * and grew with the library, to find nothing after the first time.
 *
 * The property that matters is a CALL COUNT: how many times the table scan is
 * performed across reloads. Asserting "it is called" would pass on the old code.
 */

let healCalls = 0;
let healImpl: () => Promise<number>;

const settings: AppSettings = {
  theme: 'system',
  itemsPerFetch: 10,
  requestDelayMs: 600,
  autoOpenOriginalUrl: false,
};

/** A minimal in-memory db stand-in: the composable only reads three tables. */
function fakeDb() {
  const table = (rows: unknown[]) => ({
    toArray: async () => [...rows],
    orderBy: () => ({ reverse: () => ({ toArray: async () => [...rows] }) }),
  });
  return {
    creators: table([{ id: 'c1' }]),
    channels: table([{ id: 'ch1' }]),
    posts: table([{ id: 'p1' }]),
  } as never;
}

async function freshComposable() {
  // Module state (the once-per-page flag) is real, so each case needs its own
  // module registry — otherwise the first test would consume the single run.
  vi.resetModules();
  const { useDashboardData } = await import('../entrypoints/dashboard/composables/useDashboardData');
  return useDashboardData({
    db: fakeDb(),
    getSettings: async () => settings,
    getDatabaseStats: async () => ({
      creatorsCount: 0,
      channelsCount: 0,
      totalPostsCount: 0,
      bookmarkedPostsCount: 0,
      storageUsageBytes: 0,
      storageQuotaBytes: 0,
    }),
    healBrokenPostMedia: () => {
      healCalls++;
      return healImpl();
    },
  });
}

beforeEach(() => {
  healCalls = 0;
  healImpl = async () => 0;
});

describe('reloadData and the media repair', () => {
  it('runs the repair once, not on every reload', async () => {
    const state = await freshComposable();

    await state.reloadData();
    await state.reloadData();
    await state.reloadData();

    expect(healCalls).toBe(1);
  });

  it('still runs it on the FIRST reload, so an upgrading user is repaired', async () => {
    // The complement, and the reason this is a once-flag rather than a deletion:
    // rows written by an older build still need fixing.
    const state = await freshComposable();

    await state.reloadData();

    expect(healCalls).toBe(1);
  });

  it('retries after a failure instead of abandoning the repair', async () => {
    // A torn-down worker or a quota error must not leave the library unrepaired
    // forever: the flag flips only on success.
    healImpl = async () => {
      throw new Error('Worker was terminated');
    };
    const state = await freshComposable();

    await state.reloadData();
    expect(healCalls).toBe(1);

    healImpl = async () => 3;
    await state.reloadData();

    expect(healCalls).toBe(2);
  });

  it('loads the feed even when the repair throws', async () => {
    // The repair is maintenance; it must never prevent the feed from rendering.
    healImpl = async () => {
      throw new Error('boom');
    };
    const state = await freshComposable();

    await state.reloadData();

    expect(state.posts.value).toHaveLength(1);
    expect(state.creators.value).toHaveLength(1);
  });
});
