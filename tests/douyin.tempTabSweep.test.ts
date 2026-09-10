import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sweepOrphanDouyinTempTab } from '../src/infrastructure/chrome/messages/douyinSnapshot';

/**
 * Backstop for the Douyin throwaway tab.
 *
 * The in-line cleanup in the handler closes the tab on every path it controls.
 * The gap it cannot control is a service worker torn down mid-scrape: the
 * in-memory tab id and its `setTimeout` go with the worker, leaving the tab open
 * with nothing left to close it. The sweep runs at every worker startup and
 * reclaims a tab recorded by a previous, dead run.
 *
 * Two properties matter: a stale leftover is closed, and a tab belonging to a
 * scrape that is still running is not touched.
 */

const KEY = 'douyin.tempTabId';

let session: Map<string, unknown>;
let openTabs: Array<{ id: number; url: string; active?: boolean }>;
const removed: number[] = [];

function installChrome() {
  session = new Map();
  openTabs = [];
  removed.length = 0;
  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) session.set(k, v);
        },
        remove: async (key: string) => { session.delete(key); },
      },
    },
    tabs: {
      get: async (id: number) => openTabs.find((t) => t.id === id) ?? null,
      remove: async (id: number) => {
        removed.push(id);
        openTabs = openTabs.filter((t) => t.id !== id);
      },
    },
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  installChrome();
});

describe('sweepOrphanDouyinTempTab', () => {
  it('closes a Douyin tab left by a run whose worker died', async () => {
    // Recorded long ago (>60s): no scrape can still be running against it.
    session.set(KEY, { id: 77, at: Date.now() - 5 * 60_000 });
    openTabs = [{ id: 77, url: 'https://www.douyin.com/user/someone' }];

    await sweepOrphanDouyinTempTab();

    expect(removed).toEqual([77]);
    expect(session.has(KEY)).toBe(false);
  });

  it('leaves a tab whose scrape may still be running', async () => {
    session.set(KEY, { id: 78, at: Date.now() - 2_000 });
    openTabs = [{ id: 78, url: 'https://www.douyin.com/user/someone' }];

    await sweepOrphanDouyinTempTab();

    expect(removed).toEqual([]);
    // The record stays so a later startup can still reclaim it if that run died.
    expect(session.has(KEY)).toBe(true);
  });

  it('does nothing when no temporary tab was recorded', async () => {
    await sweepOrphanDouyinTempTab();
    expect(removed).toEqual([]);
  });

  it('does not close a tab that has since navigated away from Douyin', async () => {
    // The user followed a link in that tab: it is theirs now, not ours.
    session.set(KEY, { id: 79, at: Date.now() - 5 * 60_000 });
    openTabs = [{ id: 79, url: 'https://example.com/something' }];

    await sweepOrphanDouyinTempTab();

    expect(removed).toEqual([]);
    expect(session.has(KEY)).toBe(false);
  });

  it('clears the record when the tab is already gone', async () => {
    session.set(KEY, { id: 80, at: Date.now() - 5 * 60_000 });

    await sweepOrphanDouyinTempTab();

    expect(removed).toEqual([]);
    expect(session.has(KEY)).toBe(false);
  });

  it('never closes the tab the user is currently viewing', async () => {
    // The one case id bookkeeping cannot rule out: our throwaway tab adopted as
    // someone's browsing tab. It becomes the active tab, so it is off limits.
    session.set(KEY, { id: 81, at: Date.now() - 5 * 60_000 });
    openTabs = [{ id: 81, url: 'https://www.douyin.com/user/someone', active: true }];

    await sweepOrphanDouyinTempTab();

    expect(removed).toEqual([]);
    expect(session.has(KEY)).toBe(false);
  });

  it('keeps the record when removal fails, so a later startup retries', async () => {
    // Clearing the record after a failed remove would strand the tab forever:
    // nothing would be left for the sweep to find. (This was the actual bug that
    // let a leftover survive the previous fix.)
    session.set(KEY, { id: 82, at: Date.now() - 5 * 60_000 });
    openTabs = [{ id: 82, url: 'https://www.douyin.com/user/someone' }];
    (chrome.tabs as unknown as { remove: () => Promise<void> }).remove = async () => {
      throw new Error('Tabs cannot be edited right now');
    };

    await sweepOrphanDouyinTempTab();

    expect(session.has(KEY)).toBe(true);
  });

  it('ignores a record for a tab id that no longer exists', async () => {
    session.set(KEY, { id: 83, at: Date.now() - 5 * 60_000 });
    // No open tabs at all: nothing to close, record dropped.
    await sweepOrphanDouyinTempTab();
    expect(removed).toEqual([]);
    expect(session.has(KEY)).toBe(false);
  });
});
