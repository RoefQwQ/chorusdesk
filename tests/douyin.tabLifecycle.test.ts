import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDouyinSnapshot } from '../src/infrastructure/chrome/messages/douyinSnapshot';

/**
 * Tab lifecycle for the page-driven Douyin path.
 *
 * A real user session ended with a leftover Douyin tab: the handler had opened
 * one because no douyin.com tab existed, scraped it, called `sendResponse` and
 * only then ran its `finally`. `sendResponse` closes the message channel, after
 * which the service worker may be torn down immediately — so the async
 * `tabs.remove` in that `finally` was not guaranteed to finish.
 *
 * The contract these tests pin: the temporary tab is closed BEFORE the response
 * is sent, on every exit path (success and failure), and a tab we did not open
 * is never closed.
 */

const SEC_UID = 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000';

const events: string[] = [];
let existingTabs: Array<{ id: number; url: string }> = [];
let createdTabs: Array<{ id: number; url: string }>;
let snapshotResult: unknown;

let updateListeners: Array<(id: number, info: { status?: string }) => void>;
/** Session storage behind `chrome.storage.session`, for reclaim-record assertions. */
let sessionStore: Map<string, unknown>;

/** Tell the handler the tab finished loading, as the browser would. */
function signalTabLoaded(tabId: number) {
  for (const listener of [...updateListeners]) listener(tabId, { status: 'complete' });
}

function installChrome() {
  events.length = 0;
  existingTabs = [];
  createdTabs = [];
  updateListeners = [];
  sessionStore = new Map();
  snapshotResult = { items: [], authorName: '作者', authorAvatar: '', statedTotal: 3 };

  vi.stubGlobal('chrome', {
    storage: {
      session: {
        get: async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
        },
        remove: async (key: string) => { sessionStore.delete(key); },
      },
    },
    tabs: {
      query: async () => {
        events.push('query');
        return existingTabs;
      },
      get: async (id: number) => {
        const tab = existingTabs.find((t) => t.id === id) ?? createdTabs.find((t) => t.id === id);
        return tab ? { id: tab.id, url: tab.url } : null;
      },
      create: async ({ url }: { url: string }) => {
        const tab = { id: 900 + createdTabs.length, url };
        createdTabs.push(tab);
        events.push(`create:${tab.id}`);
        // The page finishes loading on the next tick, without real elapsed time.
        queueMicrotask(() => signalTabLoaded(tab.id));
        return tab;
      },
      update: async (id: number, info: { url?: string }) => {
        const tab = existingTabs.find((t) => t.id === id);
        if (tab && info.url) tab.url = info.url;
        events.push(`update:${id}`);
        queueMicrotask(() => signalTabLoaded(id));
        return tab;
      },
      remove: async (id: number) => {
        events.push(`remove:${id}`);
        createdTabs = createdTabs.filter((t) => t.id !== id);
      },
      onUpdated: {
        addListener: (fn: (id: number, info: { status?: string }) => void) => {
          updateListeners.push(fn);
        },
        removeListener: (fn: (id: number, info: { status?: string }) => void) => {
          updateListeners = updateListeners.filter((l) => l !== fn);
        },
      },
    },
    scripting: {
      executeScript: async () => {
        events.push('inject');
        return [{ result: snapshotResult }];
      },
    },
  });
}

/**
 * Run the handler and resolve with what it responded.
 *
 * `waitForTabLoad` holds a bounded wait for the page to finish plus a fixed
 * paint delay; the fake clock is advanced past both rather than waited on. (The
 * fake fires `onUpdated` too, but when it wins the race the fallback path is
 * what resolves — either way the assertion is about cleanup ordering.)
 */
async function run(message: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
  handleDouyinSnapshot(
    { type: 'FETCH_DOUYIN_SNAPSHOT', secUid: SEC_UID, limit: 10, ...message } as never,
    (response) => {
      events.push('respond');
      resolve((response ?? {}) as Record<string, unknown>);
    },
  );
  await vi.advanceTimersByTimeAsync(20_000);
  return promise;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers();
  installChrome();
});

describe('douyin snapshot — temporary tab lifecycle', () => {
  it('closes the tab it opened, and does so before responding', async () => {
    // No douyin tab open: the handler must create one…
    const res = await run();

    expect(res.success).toBe(true);
    expect(createdTabs).toHaveLength(0); // …and it must be gone afterwards
    expect(events).toContain(`remove:900`);
    // Ordering is the whole fix: a worker torn down by the response can no
    // longer be trusted to finish cleanup.
    expect(events.indexOf('remove:900')).toBeLessThan(events.indexOf('respond'));
  });

  it('closes the temporary tab when the scrape fails', async () => {
    snapshotResult = { items: [], authorName: '', authorAvatar: '', requiresAuth: true };

    const res = await run();

    expect(res.success).toBe(false);
    expect(res.code).toBe('auth');
    expect(events).toContain('remove:900');
    expect(events.indexOf('remove:900')).toBeLessThan(events.indexOf('respond'));
  });

  it('closes the temporary tab when the page returns nothing parseable', async () => {
    snapshotResult = undefined;

    const res = await run();

    expect(res.code).toBe('parse');
    expect(events.indexOf('remove:900')).toBeLessThan(events.indexOf('respond'));
  });

  it('leaves a tab the user already had open completely alone', async () => {
    // A douyin tab on some OTHER creator belongs to the user. The handler must
    // neither navigate it (which would move the page out from under them) nor
    // close it — it opens its own throwaway tab instead. The earlier behaviour
    // reused and navigated the user's tab, which is what the user objected to.
    existingTabs = [{ id: 42, url: 'https://www.douyin.com/user/otherCreator' }];

    const res = await run();

    expect(res.success).toBe(true);
    // Their tab is untouched: no navigation, no removal.
    expect(events).not.toContain('update:42');
    expect(events).not.toContain('remove:42');
    // And a throwaway tab was used and closed instead.
    expect(events).toContain('create:900');
    expect(events).toContain('remove:900');
  });

  it('scrapes an already-open tab without navigating it', async () => {
    existingTabs = [{ id: 7, url: `https://www.douyin.com/user/${SEC_UID}` }];

    const res = await run();

    expect(res.success).toBe(true);
    expect(events).toContain('inject');
    expect(events.some((e) => e.startsWith('update:'))).toBe(false);
    expect(events.some((e) => e.startsWith('create:'))).toBe(false);
    expect(events.some((e) => e.startsWith('remove:'))).toBe(false);
  });

  it('always responds exactly once', async () => {
    await run();
    expect(events.filter((e) => e === 'respond')).toHaveLength(1);
  });

  it('keeps the reclaim record when the tab could not be closed', async () => {
    // The bug that let a leftover survive: the record was cleared even when
    // `tabs.remove` failed, so nothing was left for the startup sweep to find and
    // the tab was stranded for good. The record must survive a failed removal.
    let removeAttempts = 0;
    (chrome.tabs as unknown as { remove: (id: number) => Promise<void> }).remove = async (id: number) => {
      removeAttempts++;
      events.push(`remove-attempt:${id}`);
      throw new Error('Tabs cannot be edited right now');
    };

    const res = await run();

    expect(res.success).toBe(true);
    expect(removeAttempts).toBe(1);
    // Recorded for the next startup to retry.
    expect(sessionStore.has('douyin.tempTabId')).toBe(true);
    // And the failure is reported rather than silently swallowed.
    expect(events).toContain('respond');
  });

  it('drops the record once the tab is really gone', async () => {
    const res = await run();

    expect(res.success).toBe(true);
    expect(sessionStore.has('douyin.tempTabId')).toBe(false);
  });
});
