import { afterEach, describe, expect, it } from 'vitest';
import { checkPlatformCookieLogins } from '../src/infrastructure/chrome/platformAuth';

/**
 * `platformAuth` was the only place left that decided "is the user signed in",
 * after the three dead `checkAuthStatus` adapter methods were deleted — and it
 * had no test.
 *
 * The decision it drives is not cosmetic: the dashboard's login indicators read
 * it, so a wrong `false` tells a signed-in user to log in, and a wrong `true`
 * hides the one hint that explains a failed sync.
 *
 * Two details are easy to break and are pinned here:
 *  - `twitter` must look at BOTH `x.com` and `twitter.com` (the session lives on
 *    one or the other depending on when the user last authenticated);
 *  - the tab fallback counts an open x/twitter tab as a usable session, which is
 *    what the anti-rate-limit same-origin path relies on.
 */

interface FakeCookie {
  name: string;
}

function installChrome(options: {
  cookies?: Record<string, FakeCookie[]>;
  tabs?: Array<{ url: string }>;
  withTabsApi?: boolean;
  cookiesThrow?: boolean;
}) {
  const queried: string[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    cookies: {
      getAll: async ({ domain }: { domain: string }) => {
        if (options.cookiesThrow) throw new Error('cookie store unavailable');
        queried.push(domain);
        return options.cookies?.[domain] ?? [];
      },
    },
    ...(options.withTabsApi === false
      ? {}
      : {
          tabs: {
            query: async () => options.tabs ?? [],
          },
        }),
  };
  return queried;
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('checkPlatformCookieLogins', () => {
  it('reports youtube ready without any lookup (public RSS needs no session)', async () => {
    installChrome({ cookies: {} });
    const status = await checkPlatformCookieLogins();
    expect(status.youtube).toBe(true);
  });

  it('detects a signed-in platform by any one of its auth cookie names', async () => {
    installChrome({
      cookies: {
        'bilibili.com': [{ name: 'bili_jct' }],
        'pixiv.net': [{ name: 'PHPSESSID' }],
        'weibo.com': [{ name: 'SUB' }],
      },
    });
    const status = await checkPlatformCookieLogins();
    expect(status.bilibili).toBe(true);
    expect(status.pixiv).toBe(true);
    expect(status.weibo).toBe(true);
  });

  it('reports a platform with no matching cookie as signed out', async () => {
    installChrome({
      cookies: { 'bilibili.com': [{ name: 'buvid3' }, { name: 'b_nut' }] },
    });
    const status = await checkPlatformCookieLogins();
    // Non-auth cookies present, but none of the ones that mean "signed in".
    expect(status.bilibili).toBe(false);
  });

  it('checks BOTH x.com and twitter.com for the twitter session', async () => {
    const queried = installChrome({
      cookies: { 'twitter.com': [{ name: 'auth_token' }] },
    });
    const status = await checkPlatformCookieLogins();
    expect(queried).toContain('x.com');
    expect(queried).toContain('twitter.com');
    // The session was on the legacy domain, which must still count.
    expect(status.twitter).toBe(true);
  });

  it('counts an open x/twitter tab as a usable session when cookies are absent', async () => {
    installChrome({
      cookies: {},
      tabs: [{ url: 'https://x.com/home' }],
    });
    const status = await checkPlatformCookieLogins();
    expect(status.twitter).toBe(true);
  });

  it('does not invent a twitter session from an unrelated open tab', async () => {
    // The tab fallback must not be "any tab exists": a user with no x.com cookie
    // and only, say, a bilibili tab open is not signed in to Twitter.
    const queried = installChrome({
      cookies: {},
      tabs: [],
    });
    const status = await checkPlatformCookieLogins();
    expect(status.twitter).toBe(false);
    // And the fallback only ran because the cookie check found nothing.
    expect(queried.filter((d) => d === 'x.com')).toHaveLength(1);
  });

  it('still answers when the tabs API is missing entirely', async () => {
    // `activeTab`/`tabs` absence must not break the whole status — the other
    // platforms are independent, and a throw here used to be indistinguishable
    // from "signed out".
    installChrome({ cookies: { 'bilibili.com': [{ name: 'SESSDATA' }] }, withTabsApi: false });
    const status = await checkPlatformCookieLogins();
    expect(status.bilibili).toBe(true);
    expect(status.twitter).toBe(false);
  });

  it('fails closed per platform when the cookie store throws', async () => {
    installChrome({ cookiesThrow: true });
    const status = await checkPlatformCookieLogins();
    // All probed platforms report signed-out; youtube stays true (no lookup).
    expect(status.bilibili).toBe(false);
    expect(status.twitter).toBe(false);
    expect(status.youtube).toBe(true);
  });

  it('returns an empty status where the cookies API is absent', async () => {
    // The dashboard and unit-test environments have no `chrome.cookies`.
    (globalThis as { chrome?: unknown }).chrome = {};
    expect(await checkPlatformCookieLogins()).toEqual({});
  });
});
