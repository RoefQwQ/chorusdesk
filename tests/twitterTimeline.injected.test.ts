import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleTwitterTimeline } from '../src/infrastructure/chrome/messages/twitterTimeline';

/**
 * Coverage for the INJECTED path of the Twitter timeline.
 *
 * Why this file exists: `twitter.ts` (the parser) is well covered by
 * `twitter.emptyTimeline.test.ts`, but `twitterTimeline.ts` — the injected page
 * script and the tab/session fallback — had no coverage at all, and it is the
 * half that talks to X. It is also the half that carried two verbatim copies of
 * the GraphQL `features`/`fieldToggles` objects (one for the direct fetch, one
 * for the injected script), 200 lines apart in the same file.
 *
 * Without a request-level test, deduplicating those copies would be unverifiable:
 * the injected function is serialized with `Function.prototype.toString()` and
 * cannot close over module scope, so the constants have to travel through
 * `executeScript`'s `args`, and a mistake there changes the request silently —
 * the same class of bug as the doubled-nesting parser lookup that shipped green.
 *
 * The technique: stub `chrome.scripting.executeScript` to capture the injected
 * function AND its args, then CALL that function here with a fake `document` and
 * a fake `fetch`. That exercises the real code that runs in the page, with no
 * network, no session and no browser. It is the "extract the injected function
 * and assert the request it builds" approach the maintainability audit
 * recommended for exactly this reason.
 */

// Constants the injected script must send. Pinned here deliberately: these values
// are X's client configuration, so a change to them is a product decision, not a
// refactor detail, and this test is where that decision becomes visible.
const USER_OPERATION = 'Gb-d6r0vxPOADdG62OEBpQ/UserByScreenName';
const TWEET_OPERATION = 'eviprbEPLvNG88V3smUngQ/UserTweets';

interface CapturedInjection {
  func: unknown;
  args: unknown[];
}

let captured: CapturedInjection | null = null;
let fetchedUrls: string[] = [];
let respondWith: (url: string) => { ok: boolean; status: number; json: () => Promise<unknown> };

/** Runs the handler with the page path forced (no cookies → direct path yields null). */
async function runHandler(
  message: Record<string, unknown> = { username: 'artist', limit: 10 },
): Promise<Record<string, unknown>> {
  return await new Promise((resolve) => {
    const returned = handleTwitterTimeline(
      { type: 'FETCH_TWITTER_TIMELINE', ...message } as never,
      (response) => resolve(response as Record<string, unknown>),
    );
    // The listener contract: the channel must stay open for an async reply.
    expect(returned).toBe(true);
  });
}

/** Invokes the captured injected function through its SERIALIZED source — no
 * closure, exactly as `chrome.scripting.executeScript` runs it in the page. */
async function callInjectedSerialized(): Promise<Record<string, unknown>> {
  if (!captured) throw new Error('no injection captured');
  const source = (captured.func as (...a: unknown[]) => unknown).toString();
  const isolated = new Function(`return (${source})`)() as (...a: unknown[]) => Promise<Record<string, unknown>>;
  return await isolated(...captured.args);
}

beforeEach(() => {
  captured = null;
  fetchedUrls = [];
  respondWith = (url) => {
    if (url.includes('UserByScreenName')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { user: { result: { rest_id: '12345' } } } }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          user: {
            result: {
              timeline_v2: { timeline: { instructions: [], metadata: { cursor: 'BOTTOM' } } },
            },
          },
        },
      }),
    };
  };

  vi.stubGlobal('chrome', {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: 'https://x.com/home' }]),
      create: vi.fn(),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn(async (opts: CapturedInjection) => {
        captured = { func: opts.func, args: opts.args };
        // Run the injected function IMMEDIATELY, i.e. what the page would do —
        // this is what the real injection does, in the real page.
        const func = opts.func as (...a: unknown[]) => Promise<unknown>;
        return [{ result: await func(...opts.args) }];
      }),
    },
    cookies: { get: vi.fn(async () => null) },
    runtime: { lastError: undefined },
  });

  vi.stubGlobal('document', {
    // The page path reads the CSRF token from the page's own cookie string.
    get cookie() {
      return 'ct0=csrf-token-in-page';
    },
  });

  vi.stubGlobal('fetch', async (url: string) => {
    fetchedUrls.push(String(url));
    return respondWith(String(url));
  });
});

describe('twitter timeline — the injected page path', () => {
  it('injects a function that performs the user lookup and the timeline request', async () => {
    const response = await runHandler();
    expect(response.success).toBe(true);
    expect(captured).not.toBeNull();

    // The injected function runs in the page, so it must reach the SAME endpoints
    // through a relative URL (absolute would need the page origin hardcoded).
    const userUrl = fetchedUrls.find((u) => u.includes('UserByScreenName'));
    const tweetUrl = fetchedUrls.find((u) => u.includes('UserTweets'));
    expect(userUrl, 'the injected script must call UserByScreenName').toBeDefined();
    expect(tweetUrl, 'the injected script must call UserTweets').toBeDefined();
    expect(userUrl!.startsWith('/i/api/graphql/')).toBe(true);
  });

  it('sends the operation ids the x.com web client expects', async () => {
    await runHandler();
    expect(fetchedUrls.some((u) => u.includes(USER_OPERATION))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes(TWEET_OPERATION))).toBe(true);
  });

  it('encodes variables, features and fieldToggles into the query string', async () => {
    await runHandler({ username: 'artist', limit: 10 });
    const tweetUrl = fetchedUrls.find((u) => u.includes('UserTweets'))!;
    const query = new URLSearchParams(tweetUrl.split('?')[1]);

    // Variables carry the resolved rest_id — the reason the user lookup must run
    // first, and the thing a refactor could silently drop.
    const variables = JSON.parse(query.get('variables')!);
    expect(variables.userId).toBe('12345');
    expect(variables.includePromotedContent).toBe(false);
    expect(variables.withV2Timeline).toBe(true);

    // Features/fieldToggles must be present and non-trivial; their exact contents
    // are asserted below so a dedup cannot quietly empty them.
    const features = JSON.parse(query.get('features')!);
    const fieldToggles = JSON.parse(query.get('fieldToggles')!);
    expect(Object.keys(features).length).toBeGreaterThan(10);
    expect(Object.keys(fieldToggles).length).toBeGreaterThan(3);
  });

  it('keeps the feature flags the parser depends on', async () => {
    await runHandler();
    const userUrl = fetchedUrls.find((u) => u.includes('UserByScreenName'))!;
    const userFeatures = JSON.parse(new URLSearchParams(userUrl.split('?')[1]).get('features')!);
    const tweetUrl = fetchedUrls.find((u) => u.includes('UserTweets'))!;
    const tweetFeatures = JSON.parse(new URLSearchParams(tweetUrl.split('?')[1]).get('features')!);

    // A sample big enough that an accidentally-empty or truncated copy fails.
    expect(userFeatures.responsive_web_graphql_timeline_navigation_enabled).toBe(true);
    expect(tweetFeatures.longform_notetweets_consumption_enabled).toBe(true);
    expect(tweetFeatures.view_counts_everywhere_api_enabled).toBe(true);
    expect(tweetFeatures.responsive_web_enhance_cards_enabled).toBe(false);
    // The two feature sets are distinct objects, not the same one reused.
    expect(Object.keys(userFeatures).length).not.toBe(Object.keys(tweetFeatures).length);
  });

  it('forwards the cursor so a history dig continues from where it stopped', async () => {
    await runHandler({ username: 'artist', limit: 10, cursor: 'CURSOR_FROM_LAST_PAGE' });
    const tweetUrl = fetchedUrls.find((u) => u.includes('UserTweets'))!;
    const variables = JSON.parse(new URLSearchParams(tweetUrl.split('?')[1]).get('variables')!);
    expect(variables.cursor).toBe('CURSOR_FROM_LAST_PAGE');
  });

  it('widens the sample window when only originals are wanted', async () => {
    await runHandler({ username: 'artist', limit: 10, onlyOriginal: true });
    const tweetUrl = fetchedUrls.find((u) => u.includes('UserTweets'))!;
    const variables = JSON.parse(new URLSearchParams(tweetUrl.split('?')[1]).get('variables')!);
    // Retweets would otherwise squeeze originals out of the page; the window is
    // widened rather than the filter applied late.
    expect(variables.count).toBeGreaterThan(10);
  });

  it('survives being serialized, because that is how Chrome runs it', async () => {
    // THE regression this file exists for. `chrome.scripting.executeScript`
    // serializes the function with `Function.prototype.toString()`, so it carries
    // NO closure: a module-scope reference compiles, passes any test that calls the
    // function object, and then throws in the real page. `Bearer
    // ${TWITTER_BEARER_TOKEN}` did exactly that — the injected function's own
    // try/catch turned it into `{ success: false, error: 'TWITTER_BEARER_TOKEN is
    // not defined' }`, so the timeline quietly fell through to the direct fetch and
    // the page path never ran. Evaluating the SOURCE with no closure is the only
    // check that can see this.
    await runHandler();
    if (!captured) throw new Error('no injection captured');

    const result = await callInjectedSerialized();

    // Assert on the RESULT, not on "it did not throw": the injected function catches
    // its own errors, so a ReferenceError comes back as a failed result — which is
    // precisely how this shipped unnoticed.
    expect(result.success, `injected function failed when serialized: ${String(result.error)}`).toBe(true);
    // And it must have actually reached the network from inside that isolated copy.
    const after = fetchedUrls.filter((u) => u.includes('UserTweets'));
    expect(after.length).toBeGreaterThan(0);
  });

  it('sends the same graphql configuration through both paths', async () => {
    // The file carried two hand-maintained copies of the features/fieldToggles
    // objects, and they had DRIFTED — the direct copy carried a key the injected
    // copy lacked. Both paths hit the same endpoint, so divergence is a defect
    // whichever copy is "right"; this test is what stops it recurring.
    await runHandler(); // page path
    const pageUrl = fetchedUrls.find((u) => u.includes('UserTweets'))!;
    fetchedUrls = [];
    await runHandlerWithCookiesOnly(); // direct path
    const directUrl = fetchedUrls.find((u) => u.includes('UserTweets'))!;

    const params = (u: string) => new URLSearchParams(u.split('?')[1]);
    expect(JSON.parse(params(directUrl).get('features')!)).toEqual(JSON.parse(params(pageUrl).get('features')!));
    expect(JSON.parse(params(directUrl).get('fieldToggles')!)).toEqual(
      JSON.parse(params(pageUrl).get('fieldToggles')!),
    );
    expect(params(directUrl).get('variables')).toBe(params(pageUrl).get('variables'));
  });
});

/** Drives the handler down the direct path: page path unavailable, cookies present. */
async function runHandlerWithCookiesOnly(): Promise<Record<string, unknown>> {
  vi.stubGlobal('chrome', {
    tabs: { query: vi.fn(async () => []), create: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
    scripting: {
      executeScript: vi.fn(async () => {
        throw new Error('frame was removed');
      }),
    },
    cookies: { get: vi.fn(async () => ({ value: 'cookie-token' })) },
    runtime: { lastError: undefined },
  });
  return await runHandler();
}
