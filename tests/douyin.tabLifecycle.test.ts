import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDouyinSnapshot } from '../src/infrastructure/chrome/messages/douyinSnapshot';
import { awaitDouyinGrid } from '../src/adapters/douyin/collector';

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
/** What the injected grid probe reports. */
let gridResult: boolean;
/** When set, the tab reports this URL instead of the profile it was sent to. */
let navigatedAwayTo: string | null;
/** How many grid-probe injections reject before one runs. */
let probeRejections: number;

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
  gridResult = true;
  navigatedAwayTo = null;
  probeRejections = 0;

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
        if (!tab) return null;
        return { id: tab.id, url: navigatedAwayTo ?? tab.url };
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
      executeScript: async (opts: { func: unknown; args?: unknown[] }) => {
        // Two injections happen per scrape: the grid probe, then the collector.
        // Telling them apart is what lets the ordering of wait-then-scrape be
        // asserted at all.
        if (opts.func === awaitDouyinGrid) {
          events.push('await-grid');
          // A destroyed frame surfaces as a rejected injection, not as a false
          // result -- see `probeDouyinGrid`.
          if (probeRejections > 0) {
            probeRejections--;
            throw new Error('Frame with ID 0 was removed.');
          }
          return [{ result: gridResult }];
        }
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

describe('douyin snapshot — grid readiness', () => {
  it('waits for the grid in the page before scraping', async () => {
    // The tab's load event is not the grid being on screen. A cold page yields an
    // empty grid, and the collector can then only report "no works" for a creator
    // that has them — which is how two of three channels failed while a third,
    // loading more slowly, succeeded.
    await run();

    expect(events).toContain('await-grid');
    // The wait must happen before the scrape, or it cannot help.
    expect(events.indexOf('await-grid')).toBeLessThan(events.indexOf('inject'));
  });

  it('still scrapes when the grid never appears, so captcha/auth are detected', async () => {
    // A captcha or an auth wall means the grid will never render; a timeout must
    // not hide the more useful diagnosis the collector produces.
    gridResult = false;

    const res = await run();

    expect(events).toContain('inject');
    expect(res.success).toBe(true);
  });
});

describe('douyin snapshot — a destroyed frame during the grid probe', () => {
  it('retries a failed probe instead of abandoning the wait', async () => {
    // Douyin is a single-page app and can replace the frame after `load`, which
    // kills an injection already running in it. Conflating that with "the grid
    // did not appear" cost us the entire wait: a single `.catch(() => false)`
    // made a destroyed frame look like the 10s deadline expiring, when the probe
    // had actually answered in 1.4s.
    probeRejections = 1;

    const res = await run();

    expect(res.success).toBe(true);
    // Two probe attempts: the rejected one, then the retry that ran.
    expect(events.filter((e) => e === 'await-grid')).toHaveLength(2);
    expect(events).toContain('inject');
  });

  it('gives up after bounded attempts and still scrapes', async () => {
    // A frame that keeps dying must not spin forever, and must not be reported as
    // a rate limit while the tab is still sitting on the creator's profile.
    probeRejections = 99;

    const res = await run();

    expect(res.success).toBe(true);
    expect(events.filter((e) => e === 'await-grid')).toHaveLength(4);
    expect(events).toContain('inject');
  });

  it('never leaves its temporary tab open when the probe keeps failing', async () => {
    probeRejections = 99;

    await run();

    expect(createdTabs).toHaveLength(0);
    expect(events).toContain('remove:900');
  });
});

describe('douyin snapshot — a redirect away from the profile', () => {
  it('reports a rate limit when the tab is no longer on the creator', async () => {
    // Douyin answers a burst of requests with a verification redirect. The tab
    // then never renders a grid, and the in-flight injection dies with a frame
    // error -- which the adapter classified as `network`, telling the user
    // nothing and, worse, suppressing the rate-limit signal the sync layer needs
    // in order to back off.
    gridResult = false;
    navigatedAwayTo = 'https://www.douyin.com/verify';

    const res = await run();

    expect(res.success).toBe(false);
    expect(res.code).toBe('rate_limit');
  });

  it('does not mistake a slow page for a redirect', async () => {
    // The tab is still where we sent it; the grid is just not painted yet. That
    // must stay a scrape attempt, not a false accusation of rate limiting.
    gridResult = false;
    navigatedAwayTo = null;

    const res = await run();

    expect(res.success).toBe(true);
    expect(events).toContain('inject');
  });

  it('still closes its temporary tab after detecting the redirect', async () => {
    // Leaving a verification page open in the user's tab strip is the failure
    // mode the tab lifecycle work already fixed once; a new early return must
    // not reintroduce it.
    gridResult = false;
    navigatedAwayTo = 'https://www.douyin.com/verify';

    await run();

    expect(createdTabs).toHaveLength(0);
    expect(events).toContain('remove:900');
  });
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
