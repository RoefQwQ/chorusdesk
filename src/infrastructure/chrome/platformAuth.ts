export interface PlatformAuthStatus {
  [platform: string]: boolean;
}

/**
 * Session-status check per platform, mirroring the exact rules the dashboard
 * used to run inline (its `checkPlatformLogins`):
 *
 * - `twitter` checks cookies on `x.com` AND `twitter.com`; when neither has
 *   an auth cookie it falls back to an open x/twitter tab counting as a
 *   usable session (anti-rate-limit same-origin fetching).
 * - `youtube` (public RSS) is reported ready without any lookup; remaining
 *   platforms are checked against the cookie names they actually required,
 *   on their actual domain.
 *
 * No cookie rules are invented beyond what the dashboard queried. A key is
 * left absent (falsy in the UI) for platforms the dashboard never probed.
 */
export async function checkPlatformCookieLogins(): Promise<PlatformAuthStatus> {
  const result: PlatformAuthStatus = {};
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return result;

  // YouTube official RSS is publicly accessible without login.
  result['youtube'] = true;

  // Platform -> auth cookie names as queried by the dashboard login detector.
  const platformsToCheck: Array<{ key: string; domain: string; authCookieNames: string[] }> = [
    { key: 'bilibili', domain: 'bilibili.com', authCookieNames: ['DedeUserID', 'SESSDATA', 'bili_jct'] },
    { key: 'twitter', domain: 'x.com', authCookieNames: ['auth_token', 'ct0'] },
    { key: 'pixiv', domain: 'pixiv.net', authCookieNames: ['PHPSESSID'] },
    { key: 'fantia', domain: 'fantia.jp', authCookieNames: ['_session_id'] },
    { key: 'withny', domain: 'withny.fun', authCookieNames: ['withny_session', 'token', 'remember_web'] },
    { key: 'xiaohongshu', domain: 'xiaohongshu.com', authCookieNames: ['web_session', 'a1', 'webId'] },
    { key: 'weibo', domain: 'weibo.com', authCookieNames: ['SUB', 'SUBP', '_T_WM'] },
  ];

  await Promise.all(platformsToCheck.map(async ({ key, domain, authCookieNames }) => {
    if (key === 'twitter') {
      try {
        const xCookies = await chrome.cookies.getAll({ domain: 'x.com' });
        const twCookies = await chrome.cookies.getAll({ domain: 'twitter.com' });
        const allCookies = [...xCookies, ...twCookies];
        let hasAuth = allCookies.some(c => authCookieNames.includes(c.name));
        // Fallback: an open logged-in tab also counts as a usable session.
        if (!hasAuth && chrome.tabs) {
          const tabs = await chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] });
          if (tabs.length > 0) hasAuth = true;
        }
        result[key] = hasAuth;
      } catch {
        result[key] = false;
      }
      return;
    }

    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const hasAuth = cookies.some(c => authCookieNames.includes(c.name));
      result[key] = hasAuth;
    } catch {
      result[key] = false;
    }
  }));

  return result;
}

